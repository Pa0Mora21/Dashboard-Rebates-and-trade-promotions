/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * @description Motor de liquidación de rebates. Procesa registros WORK en estado Capturado,
 *              genera Settlements, Credit Memos con aplicación automática y Tax Details Override,
 *              o Vendor Bills según el escenario y método de liquidación.
 *
 * Flujo:
 * 1. getInputData → Busca registros WORK con estado "Capturado"
 * 2. map → Valida y agrupa por Agreement+Scenario+Customer (key)
 * 3. reduce → Genera transacciones (CM/VB), crea History, actualiza WORK
 * 4. summarize → Log de resultados
 */
define([
    'N/record',
    'N/search',
    'N/runtime',
    'N/log',
    '../lib/giv_rebate_dao',
    '../lib/giv_rebate_validator',
    '../lib/giv_rebate_tax_utils',
    '../lib/giv_rebate_transaction_builder'
], (record, search, runtime, log, dao, validator, taxUtils, txnBuilder) => {

    const MODULE = 'giv_mr_rebate_liquidation';

    /**
     * getInputData — Busca registros WORK con estado "Capturado".
     */
    const getInputData = () => {
        log.audit({ title: `${MODULE}.getInputData`, details: 'Starting liquidation M/R' });

        return search.create({
            type: 'customrecord_giv_rebate_liq_work',
            filters: [
                ['custrecord_giv_lw_proc_status', 'is', 'Capturado']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'custrecord_giv_lw_customer' }),
                search.createColumn({ name: 'custrecord_giv_lw_agreement' }),
                search.createColumn({ name: 'custrecord_giv_lw_settle_method' }),
                search.createColumn({ name: 'custrecord_giv_lw_scenario' }),
                search.createColumn({ name: 'custrecord_giv_lw_source_invoice' }),
                search.createColumn({ name: 'custrecord_giv_lw_source_accrual' }),
                search.createColumn({ name: 'custrecord_giv_lw_source_item' }),
                search.createColumn({ name: 'custrecord_giv_lw_original_amt' }),
                search.createColumn({ name: 'custrecord_giv_lw_available_amt' }),
                search.createColumn({ name: 'custrecord_giv_lw_amt_to_settle' }),
                search.createColumn({ name: 'custrecord_giv_lw_invoice_to' }),
                search.createColumn({ name: 'custrecord_giv_lw_apply_amount' }),
                search.createColumn({ name: 'custrecord_giv_lw_taxcode' }),
                search.createColumn({ name: 'custrecord_giv_lw_tax_basis' }),
                search.createColumn({ name: 'custrecord_giv_lw_excess_flag' }),
                search.createColumn({ name: 'custrecord_giv_lw_csv_batch_id' })
            ]
        });
    };

    /**
     * map — Valida cada registro WORK y lo agrupa por key de procesamiento.
     * Key = Agreement_Scenario_Customer para agrupar en reduce.
     */
    const map = (context) => {
        try {
            const searchResult = JSON.parse(context.value);
            const values = searchResult.values;
            const workId = searchResult.id;

            // Actualizar a "Procesando"
            txnBuilder.updateWorkRecord(workId, { status: 'Procesando' });

            const scenario = values['custrecord_giv_lw_scenario']?.value || values['custrecord_giv_lw_scenario'] || '';
            const customerId = values['custrecord_giv_lw_customer']?.value || values['custrecord_giv_lw_customer'] || '';
            const agreementId = values['custrecord_giv_lw_agreement']?.value || values['custrecord_giv_lw_agreement'] || '';

            const groupKey = `${agreementId}_${scenario}_${customerId}`;

            const payload = {
                workId: workId,
                customerId: customerId,
                agreementId: agreementId,
                settlementMethod: values['custrecord_giv_lw_settle_method']?.value || values['custrecord_giv_lw_settle_method'] || '',
                scenario: scenario,
                sourceInvoiceId: values['custrecord_giv_lw_source_invoice']?.value || values['custrecord_giv_lw_source_invoice'] || '',
                sourceAccrualId: values['custrecord_giv_lw_source_accrual']?.value || values['custrecord_giv_lw_source_accrual'] || '',
                sourceItemId: values['custrecord_giv_lw_source_item']?.value || values['custrecord_giv_lw_source_item'] || '',
                originalAmount: values['custrecord_giv_lw_original_amt'] || '0',
                availableAmount: values['custrecord_giv_lw_available_amt'] || '0',
                amountToSettle: values['custrecord_giv_lw_amt_to_settle'] || '0',
                invoiceTo: values['custrecord_giv_lw_invoice_to']?.value || values['custrecord_giv_lw_invoice_to'] || '',
                applyAmount: values['custrecord_giv_lw_apply_amount'] || '0',
                taxCodeId: values['custrecord_giv_lw_taxcode']?.value || values['custrecord_giv_lw_taxcode'] || '',
                taxBasis: values['custrecord_giv_lw_tax_basis'] || '0',
                excessFlag: values['custrecord_giv_lw_excess_flag'] || false,
                csvBatchId: values['custrecord_giv_lw_csv_batch_id'] || ''
            };

            // Para escenarios que se procesan individualmente (Estándar)
            if (scenario === 'Estándar') {
                context.write({ key: `${groupKey}_${workId}`, value: JSON.stringify(payload) });
            } else {
                context.write({ key: groupKey, value: JSON.stringify(payload) });
            }

        } catch (e) {
            log.error({
                title: `${MODULE}.map`,
                details: `Context key: ${context.key}. Error: ${e.message}`
            });

            try {
                const searchResult = JSON.parse(context.value);
                txnBuilder.updateWorkRecord(searchResult.id, {
                    status: 'Error',
                    errorMessage: `Error en map: ${e.message}`
                });
            } catch (ue) {
                log.error({ title: `${MODULE}.map.updateError`, details: ue.message });
            }
        }
    };

    /**
     * reduce — Genera la transacción financiera para el grupo de WORK records.
     */
    const reduce = (context) => {
        const workRecords = context.values.map(v => JSON.parse(v));
        const workIds = workRecords.map(wr => wr.workId);

        try {
            if (workRecords.length === 0) return;

            const firstRecord = workRecords[0];
            const scenario = firstRecord.scenario;
            const settlementMethod = firstRecord.settlementMethod;
            const customerId = firstRecord.customerId;
            const agreementId = firstRecord.agreementId;

            // Checar governance
            const remainingUsage = runtime.getCurrentScript().getRemainingUsage();
            if (remainingUsage < 500) {
                log.audit({ title: `${MODULE}.reduce`, details: `Low governance: ${remainingUsage}. Skipping group ${context.key}` });
                workIds.forEach(id => txnBuilder.updateWorkRecord(id, {
                    status: 'Capturado',
                    errorMessage: 'Pospuesto por governance insuficiente. Se reprocesará en la siguiente ejecución.'
                }));
                return;
            }

            // Obtener detalles del acuerdo
            const agreement = dao.getAgreement(agreementId);

            let generatedTxnId = '';
            let transactionType = '';

            // ── Procesar según método de liquidación ──
            if (settlementMethod === '3') {
                // ── VENDOR BILL ──
                if (!agreement || !agreement.payer_id) {
                    throw new Error('El acuerdo de reembolso no tiene configurada la entidad pagadora (custrecord_hidden_payer).');
                }

                const vbLines = workRecords.map(wr => ({
                    itemId: agreement.accounting_item,
                    amount: parseFloat(wr.amountToSettle) || 0,
                    taxCodeId: wr.taxCodeId,
                    description: `Liquidación rebate - Acuerdo ${agreementId}`
                }));

                generatedTxnId = txnBuilder.createVendorBill({
                    vendorId: agreement.payer_id,
                    lines: vbLines
                });
                transactionType = 'Vendor Bill';

            } else {
                // ── CREDIT MEMO ──
                let cmLines = [];
                let invoiceApplications = [];
                let accountingItemId = '';
                let taxDetailsLines = [];

                if (scenario === 'Agrupación') {
                    // Escenario 9 — Agrupación
                    if (!agreement || !agreement.accounting_item) {
                        throw new Error('El acuerdo de reembolso no tiene configurado el artículo contable (custrecord_rm_accounting_item).');
                    }

                    accountingItemId = agreement.accounting_item;

                    const enriched = taxUtils.enrichWithTaxInfo(workRecords);
                    taxDetailsLines = taxUtils.buildTaxDetailsOverride(enriched);

                    cmLines = workRecords.map(wr => ({
                        itemId: agreement.accounting_item,
                        amount: parseFloat(wr.amountToSettle) || 0
                    }));

                } else if (scenario === 'Cobro en exceso') {
                    // Escenario 4 — Prorrateo del excedente entre líneas
                    const totalRequested = workRecords.reduce((sum, wr) => sum + (parseFloat(wr.amountToSettle) || 0), 0);

                    const linesForProration = workRecords.map(wr => ({
                        ...wr,
                        provisionAmount: parseFloat(wr.availableAmount) || 0
                    }));

                    const proratedLines = validator.calculateExcessProration(linesForProration, totalRequested);

                    cmLines = proratedLines.map(wr => ({
                        itemId: agreement.accounting_item,
                        amount: wr.finalAmount,
                        taxCodeId: wr.taxCodeId,
                        description: `Liquidación rebate (exceso) - Acuerdo ${agreementId}`
                    }));

                    // Actualizar amountToSettle en cada WORK con el monto prorrateado
                    proratedLines.forEach(wr => {
                        txnBuilder.updateWorkRecord(wr.workId, {
                            proratedAmount: wr.finalAmount
                        });
                    });

                } else {
                    // Escenarios 1, 2, 3
                    cmLines = workRecords.map(wr => ({
                        itemId: agreement.accounting_item,
                        amount: parseFloat(wr.amountToSettle) || 0,
                        taxCodeId: wr.taxCodeId,
                        description: `Liquidación rebate - Acuerdo ${agreementId}`
                    }));
                }

                // Preparar aplicación de facturas destino
                const invoiceMap = {};
                workRecords.forEach(wr => {
                    if (wr.invoiceTo) {
                        if (!invoiceMap[wr.invoiceTo]) {
                            invoiceMap[wr.invoiceTo] = 0;
                        }
                        invoiceMap[wr.invoiceTo] += parseFloat(wr.applyAmount) || 0;
                    }
                });

                invoiceApplications = Object.entries(invoiceMap).map(([invoiceId, amount]) => ({
                    invoiceId: invoiceId,
                    amount: Math.round(amount * 100) / 100
                }));

                generatedTxnId = txnBuilder.createCreditMemo({
                    customerId: customerId,
                    lines: cmLines,
                    invoiceApplications: invoiceApplications,
                    scenario: scenario,
                    accountingItemId: accountingItemId,
                    taxDetailsLines: taxDetailsLines
                });
                transactionType = 'Credit Memo';
            }

            // ── Actualizar WORK a Completado y crear History ──
            workRecords.forEach(wr => {
                txnBuilder.updateWorkRecord(wr.workId, {
                    status: 'Completado',
                    processedTransaction: generatedTxnId,
                    errorMessage: ''
                });

                const settledAmt  = parseFloat(wr.amountToSettle) || 0;
                const availAmt    = parseFloat(wr.availableAmount) || 0;
                // Diferencia solo aplica en Cobro en exceso
                const difference  = scenario === 'Cobro en exceso'
                    ? Math.round((settledAmt - availAmt) * 100) / 100
                    : 0;

                txnBuilder.createHistoryRecord({
                    customerId:            wr.customerId,
                    agreementId:           wr.agreementId,
                    scenario:              scenario,
                    transactionType:       transactionType,
                    generatedTransactionId: generatedTxnId,
                    sourceAccrualId:       wr.sourceAccrualId,
                    sourceInvoiceId:       wr.sourceInvoiceId,
                    sourceItemId:          wr.sourceItemId,
                    invoiceTo:             wr.invoiceTo,
                    accrualAmount:         parseFloat(wr.originalAmount) || 0,
                    settledAmount:         settledAmt,
                    appliedAmount:         parseFloat(wr.applyAmount) || 0,
                    difference:            difference,
                    taxCodeId:             wr.taxCodeId,
                    taxBasis:              parseFloat(wr.taxBasis) || 0,
                    csvBatchId:            wr.csvBatchId
                });
            });

            log.audit({
                title: `${MODULE}.reduce`,
                details: `Group ${context.key}: Generated ${transactionType} ${generatedTxnId} for ${workRecords.length} WORK records`
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.reduce`,
                details: `Group ${context.key}. Error: ${e.message}`
            });

            workIds.forEach(id => {
                try {
                    txnBuilder.updateWorkRecord(id, {
                        status: 'Error',
                        errorMessage: e.message
                    });
                } catch (ue) {
                    log.error({ title: `${MODULE}.reduce.updateError`, details: `WorkId: ${id}. ${ue.message}` });
                }
            });
        }
    };

    /**
     * summarize — Log de resultados finales.
     */
    const summarize = (summary) => {
        log.audit({
            title: `${MODULE}.summarize`,
            details: `Completed. Input: ${summary.inputSummary.error || 'OK'}. Map errors: ${summary.mapSummary.errors?.length || 0}. Reduce errors: ${summary.reduceSummary.errors?.length || 0}`
        });

        if (summary.mapSummary.errors) {
            summary.mapSummary.errors.iterator().each((key, error) => {
                log.error({ title: `${MODULE}.summarize.mapError`, details: `Key: ${key}. Error: ${error}` });
                return true;
            });
        }

        if (summary.reduceSummary.errors) {
            summary.reduceSummary.errors.iterator().each((key, error) => {
                log.error({ title: `${MODULE}.summarize.reduceError`, details: `Key: ${key}. Error: ${error}` });
                return true;
            });
        }

        log.audit({
            title: `${MODULE}.summarize`,
            details: `Usage consumed: ${summary.usage}. Concurrency: ${summary.concurrency}. Yields: ${summary.yields}`
        });
    };

    return { getInputData, map, reduce, summarize };
});
