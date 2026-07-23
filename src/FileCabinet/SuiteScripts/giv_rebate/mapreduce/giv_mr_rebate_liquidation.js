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
    'N/query',
    '../lib/giv_rebate_dao',
    '../lib/giv_rebate_validator',
    '../lib/giv_rebate_tax_utils',
    '../lib/giv_rebate_transaction_builder'
], (record, search, runtime, log, nsQuery, dao, validator, taxUtils, txnBuilder) => {

    const MODULE = 'giv_mr_rebate_liquidation';

    /**
     * getInputData — Busca registros WORK con estado "Capturado".
     */
    const getInputData = () => {
        // FIX 5: leer el parámetro de lote CSV (si el M/R fue disparado desde giv_sl_rebate_csv_upload).
        // Si está presente, filtrar solo los WORK de ese lote para evitar mezclar
        // WORKs manuales concurrentes con WORKs de CSV en el mismo ciclo.
        const csvBatchId = runtime.getCurrentScript().getParameter({ name: 'custscript_giv_mr_csv_batch_id' }) || '';

        log.audit({
            title:   `${MODULE}.getInputData`,
            details: `Starting liquidation M/R${csvBatchId ? ` | CSV Batch: ${csvBatchId}` : ' | Suitelet manual (todos los Capturado)'}`
        });

        const filters = [['custrecord_giv_lw_proc_status', 'is', 'Capturado']];

        if (csvBatchId) {
            // Solo procesar el lote CSV específico
            filters.push('AND', ['custrecord_giv_lw_csv_batch_id', 'is', csvBatchId]);
        }

        return search.create({
            type: 'customrecord_giv_rebate_liq_work',
            filters: filters,
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
                details: `[Key=${context.key}] ${e.message || e}`
            });

            try {
                const searchResult = JSON.parse(context.value);
                txnBuilder.updateWorkRecord(searchResult.id, {
                    status: 'Error',
                    errorMessage: `Error en map: ${e.message || e}`
                });
            } catch (ue) {
                log.error({ title: `${MODULE}.map.updateError`, details: `[WorkId=${searchResult.id}] ${ue.message || ue}` });
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

            // ── Location: DESHABILITADO ─────────────────────────────────────────────────
            // La resolución de location (lookupFields → SuiteQL → Script Parameter) ya no
            // es necesaria. El CM usa agreement.accounting_item (tipo OthCharge), que no
            // requiere location a nivel de línea ni en el header del formulario 589.
            // Se deja comentado como referencia por si en el futuro se usan otros ítems
            // o formularios que sí requieran location.
            //
            // let locationId = '';
            // const firstSourceRecord = workRecords.find(wr => wr.sourceInvoiceId) || null;
            // if (firstSourceRecord) {
            //     try {
            //         const invFields = search.lookupFields({
            //             type:    search.Type.INVOICE,
            //             id:      firstSourceRecord.sourceInvoiceId,
            //             columns: ['location']
            //         });
            //         locationId = invFields.location?.[0]?.value || '';
            //     } catch (le) {
            //         log.debug({ title: `${MODULE}.reduce.location`, details: `No se pudo leer location de invoice ${firstSourceRecord.sourceInvoiceId}: ${le.message}` });
            //     }
            //
            //     // Fallback SuiteQL: en cuentas AT México la location está en las líneas, no en el header.
            //     if (!locationId) {
            //         try {
            //             const sqlResult = nsQuery.runSuiteQL({
            //                 query: `SELECT TOP 1 tl.location FROM transactionLine tl WHERE tl.transaction = ${firstSourceRecord.sourceInvoiceId} AND tl.mainline = 'F' AND tl.location IS NOT NULL`
            //             });
            //             if (sqlResult.results.length > 0) {
            //                 const locValue = sqlResult.results[0].values[0];
            //                 if (locValue) {
            //                     locationId = String(locValue);
            //                     log.audit({ title: `${MODULE}.reduce.location`, details: `Location leída vía SuiteQL de líneas de factura ${firstSourceRecord.sourceInvoiceId}: ${locationId}` });
            //                 }
            //             }
            //         } catch (sqlErr) {
            //             log.error({ title: `${MODULE}.reduce.location`, details: `Error SuiteQL leyendo location de líneas de factura ${firstSourceRecord.sourceInvoiceId}: ${sqlErr.message}` });
            //         }
            //     }
            // }
            //
            // // Fallback: Script Parameter "Default Location"
            // if (!locationId) {
            //     locationId = runtime.getCurrentScript().getParameter({ name: 'custscript_giv_mr_default_location' }) || '';
            //     if (locationId) {
            //         log.debug({ title: `${MODULE}.reduce.location`, details: `Usando Default Location del Script Parameter: ${locationId}` });
            //     } else {
            //         log.audit({ title: `${MODULE}.reduce.location`, details: 'ADVERTENCIA: No se encontró Location en la factura origen ni en el Script Parameter. Si Location es obligatoria, el CM/VB fallará.' });
            //     }
            // }
            const locationId = '';   // no requerida con accounting_item (OthCharge) + form 589


            let generatedTxnId = '';
            let transactionType = '';

            // ── Procesar según método de liquidación ──
            // Credit Memo = '3' | Bill (Vendor Bill) = '4'  (ver SETTLEMENT_METHOD en giv_rebate_constants.js)
            if (settlementMethod === '3') {
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

                    // Solo registros de fuente (amountToSettle > 0) contribuyen al CM
                    cmLines = workRecords
                        .filter(wr => parseFloat(wr.amountToSettle) > 0)
                        .map(wr => ({
                            itemId: agreement.accounting_item,
                            amount: parseFloat(wr.amountToSettle) || 0
                        }));

                } else if (scenario === 'Cobro en exceso') {
                    // Escenario 4 — Prorrateo del excedente entre líneas de fuente
                    // DRD: Monto Final Línea = Provisión Línea + ((Provisión Línea / Total Provisión) × Excedente)
                    // totalRequested = suma de amountToSettle del usuario (puede ser > totalAvailable)
                    // provisionAmount = availableAmount por línea (base del prorrateo)
                    const sourceWorkRecords = workRecords.filter(wr => parseFloat(wr.amountToSettle) > 0);

                    // El total solicitado proviene de los WORK records (lo que el usuario capturó)
                    const totalRequested = sourceWorkRecords.reduce((sum, wr) => sum + (parseFloat(wr.amountToSettle) || 0), 0);

                    const linesForProration = sourceWorkRecords.map(wr => ({
                        ...wr,
                        provisionAmount: parseFloat(wr.availableAmount) || 0  // peso = saldo disponible
                    }));

                    const proratedLines = validator.calculateExcessProration(linesForProration, totalRequested);

                    cmLines = proratedLines.map(wr => ({
                        itemId:      agreement.accounting_item,
                        amount:      wr.finalAmount,
                        taxCodeId:   wr.taxCodeId,
                        description: `Liquidación rebate (exceso) - Acuerdo ${agreementId}`
                    }));

                    // [FIX 1] Actualizar cada WORK con el monto prorrateado real del CM
                    // Antes este updateWorkRecord era un no-op (proratedAmount no estaba mapeado)
                    proratedLines.forEach(wr => {
                        txnBuilder.updateWorkRecord(wr.workId, {
                            proratedAmount: wr.finalAmount   // → custrecord_giv_lw_amt_to_settle
                        });
                    });

                } else {
                    // Escenarios 1, 2, 3 — solo registros de fuente (amountToSettle > 0) al CM

                    // Consolidada: descripción enriquecida con nombre de acuerdo + tranid de factura origen.
                    // Se hace un lookup por lote de las facturas únicas para no multiplicar llamadas a la API.
                    let invoiceTranIdMap = {};
                    if (scenario === 'Consolidada') {
                        const uniqueInvoiceIds = [...new Set(
                            workRecords
                                .filter(wr => parseFloat(wr.amountToSettle) > 0 && wr.sourceInvoiceId)
                                .map(wr => wr.sourceInvoiceId)
                        )];

                        uniqueInvoiceIds.forEach(invId => {
                            try {
                                const fields = search.lookupFields({
                                    type:    search.Type.INVOICE,
                                    id:      invId,
                                    columns: ['tranid']
                                });
                                invoiceTranIdMap[invId] = fields.tranid || invId;
                            } catch (le) {
                                log.error({
                                    title:   `${MODULE}.reduce.invoiceLookup`,
                                    details: `No se pudo obtener tranid de factura ${invId}: ${le.message || le}`
                                });
                                invoiceTranIdMap[invId] = invId; // fallback: usar el ID interno
                            }
                        });
                    }

                    const agreementName = agreement.name || `Acuerdo ${agreementId}`;

                    if (scenario === 'Específica (por SKU)') {
                        // Agrupar por sourceItemId: 1 línea en el CM por SKU único.
                        // Si varias provisiones comparten el mismo artículo, sus montos se suman.
                        const skuMap = {};
                        workRecords
                            .filter(wr => parseFloat(wr.amountToSettle) > 0)
                            .forEach(wr => {
                                const skuKey = wr.sourceItemId || '__sin_sku__';
                                if (!skuMap[skuKey]) {
                                    skuMap[skuKey] = {
                                        sourceItemId: wr.sourceItemId,           // para lookup de nombre y descripción
                                        itemId:       agreement.accounting_item,  // ítem contable del acuerdo (OthCharge)
                                        amount:       0,
                                        taxCodeId:    wr.taxCodeId               // taxCode del primer WORK del SKU
                                    };
                                }
                                skuMap[skuKey].amount += parseFloat(wr.amountToSettle) || 0;
                            });

                        // Lookup por lote de los nombres de artículo (campo 'itemid' = código/nombre en NS)
                        // Patrón idéntico al lookup de tranid en Consolidada — una llamada por SKU único.
                        const skuNameMap = {};
                        Object.values(skuMap).forEach(sku => {
                            if (!sku.sourceItemId) return;
                            try {
                                const itemFields = search.lookupFields({
                                    type:    search.Type.ITEM,
                                    id:      sku.sourceItemId,
                                    columns: ['itemid', 'displayname']
                                });
                                skuNameMap[sku.sourceItemId] = itemFields.displayname || itemFields.itemid || String(sku.sourceItemId);
                            } catch (ile) {
                                log.error({
                                    title:   `${MODULE}.reduce.itemLookup`,
                                    details: `No se pudo obtener nombre del artículo ${sku.sourceItemId}: ${ile.message || ile}`
                                });
                                skuNameMap[sku.sourceItemId] = String(sku.sourceItemId); // fallback: usar el ID
                            }
                        });

                        cmLines = Object.values(skuMap).map(sku => ({
                            itemId:      sku.itemId,                                                  // accounting_item del acuerdo
                            amount:      Math.round(sku.amount * 100) / 100,
                            taxCodeId:   sku.taxCodeId,
                            description: `Liquidación rebate por SKU ${skuNameMap[sku.sourceItemId] || sku.sourceItemId || ''} - Acuerdo ${agreementId}`
                        }));

                        log.debug({
                            title:   `${MODULE}.reduce.skuGrouping`,
                            details: `Escenario SKU: ${Object.keys(skuMap).length} SKUs únicos → ${cmLines.length} líneas en CM | Acuerdo ${agreementId}`
                        });

                    } else {
                        cmLines = workRecords
                            .filter(wr => parseFloat(wr.amountToSettle) > 0)
                            .map(wr => {
                                let description;
                                if (scenario === 'Consolidada') {
                                    const invoiceName = invoiceTranIdMap[wr.sourceInvoiceId] || wr.sourceInvoiceId;
                                    description = `${agreementName} - ${invoiceName}`;
                                } else {
                                    description = `Liquidación rebate - Acuerdo ${agreementId}`;
                                }
                                return {
                                    itemId:      agreement.accounting_item,
                                    amount:      parseFloat(wr.amountToSettle) || 0,
                                    taxCodeId:   wr.taxCodeId,
                                    description: description
                                };
                            });
                    }
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
                    customerId:          customerId,
                    lines:               cmLines,
                    invoiceApplications: invoiceApplications,
                    scenario:            scenario,
                    accountingItemId:    accountingItemId,
                    taxDetailsLines:     taxDetailsLines,
                    location:            locationId,
                    formId:              589  // RM Credit Memo Disbursement (confirmado vía CM80 en Sandbox)
                    // settlementHistoryId se añade en Fase posterior (post-Claim)
                });
                transactionType = 'Credit Memo';

            } else {
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

                const today      = new Date();
                const startDate  = today;   // fecha de la transacción (igual al VB nativo)
                const endDate    = today;   // fecha de cierre

                generatedTxnId = txnBuilder.createVendorBill({
                    vendorId:    agreement.payer_id,
                    lines:       vbLines,
                    location:    locationId,
                    agreementId: agreementId,
                    startDate:   startDate,
                    endDate:     endDate
                });
                transactionType = 'Vendor Bill';
            }

            // ── Actualizar WORK a Completado y crear History ──
            // [FIX 2] Calcular la diferencia GLOBAL antes del loop para Cobro en exceso.
            // DRD: la diferencia es el excedente total del lote, no una diferencia por línea individual.
            const totalAvailableInGroup = workRecords.reduce((s, wr) => s + (parseFloat(wr.availableAmount) || 0), 0);
            const totalSettledInGroup   = workRecords.reduce((s, wr) => s + (parseFloat(wr.amountToSettle)  || 0), 0);
            const globalDiff = scenario === 'Cobro en exceso'
                ? Math.round((totalSettledInGroup - totalAvailableInGroup) * 100) / 100
                : 0;

            workRecords.forEach(wr => {
                txnBuilder.updateWorkRecord(wr.workId, {
                    status:               'Completado',
                    processedTransaction: generatedTxnId,
                    errorMessage:         ''
                });

                // WORK de destino (amountToSettle = 0): solo actualizar estado,
                // no generar History porque no representan un accrual real.
                // Aplica a Consolidada, Agrupación y Cobro en exceso cuando
                // hay registros destino separados (en Estándar todos son > 0).
                if (parseFloat(wr.amountToSettle) <= 0) return;

                txnBuilder.createHistoryRecord({
                    customerId:             wr.customerId,
                    agreementId:            wr.agreementId,
                    scenario:               scenario,
                    transactionType:        transactionType,
                    generatedTransactionId: generatedTxnId,
                    sourceAccrualId:        wr.sourceAccrualId,
                    sourceInvoiceId:        wr.sourceInvoiceId,
                    sourceItemId:           wr.sourceItemId,
                    invoiceTo:              wr.invoiceTo,
                    accrualAmount:          parseFloat(wr.originalAmount) || 0,
                    settledAmount:          parseFloat(wr.amountToSettle) || 0,
                    appliedAmount:          parseFloat(wr.applyAmount) || 0,
                    // [FIX 2] globalDiff = excedente total del lote, no diferencia por línea
                    difference:             globalDiff,
                    taxCodeId:              wr.taxCodeId,
                    taxBasis:               parseFloat(wr.taxBasis) || 0,
                    csvBatchId:             wr.csvBatchId
                });
            });

            // ── Crear el Claim nativo del RM SuiteApp (no-bloqueante) ──────────────
            // Flujo en 4 fases:
            //   Fase 1: marca custrecord_rm_td_rebateselected = true en RTDs
            //   Fase 2: crea el Claim
            //   Fase 3: vincula RTDs al Claim (custrecord_rm_rtd_claim)
            //   Fase 4: crea JE de reversa del Accrual (el Bundle no lo hace vía SuiteScript)
            const accrualIds = [...new Set(workRecords.map(wr => wr.sourceAccrualId).filter(Boolean))];

            // Monto liquidado por accrual (para la Fase 4 — JE de reversa)
            const accrualAmounts = {};
            workRecords.forEach(wr => {
                const acId = wr.sourceAccrualId;
                if (acId) accrualAmounts[acId] = (accrualAmounts[acId] || 0) + (parseFloat(wr.amountToSettle) || 0);
            });

            const claimId = txnBuilder.createNativeClaim({
                agreementId:    agreementId,
                customerId:     customerId,
                totalAmount:    totalSettledInGroup,
                transactionId:  generatedTxnId,
                accrualIds:     accrualIds,
                accrualAmounts: accrualAmounts
            });

            // ── Vincular Claim al Credit Memo (custbody_rm_tran_settlement_his_rel) ────────
            // El campo se llena DESPUÉS de crear el Claim porque su ID no estaba
            // disponible durante la creación del CM (FASE 3 retroactiva).
            if (claimId && settlementMethod === '3') {
                try {
                    record.submitFields({
                        type:   record.Type.CREDIT_MEMO,
                        id:     generatedTxnId,
                        values: { custbody_rm_tran_settlement_his_rel: parseInt(claimId, 10) }
                    });

                    log.audit({
                        title:   `${MODULE}.reduce`,
                        details: `Linked CM ${generatedTxnId} → Claim ${claimId} (custbody_rm_tran_settlement_his_rel)`
                    });
                } catch (linkErr) {
                    log.error({
                        title:   `${MODULE}.reduce.linkClaim`,
                        details: `No se pudo vincular CM ${generatedTxnId} al Claim ${claimId}: ${linkErr.message || linkErr}`
                    });
                }
            }

            log.audit({
                title:   `${MODULE}.reduce`,
                details: `Group ${context.key}: ${transactionType} ${generatedTxnId} | ${workRecords.length} WORKs | Accruals: [${accrualIds.join(', ')}] | Claim: ${claimId || 'N/A'}`
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.reduce`,
                details: `[Group=${context.key}] ${e.message || e}`
            });

            workIds.forEach(id => {
                try {
                    txnBuilder.updateWorkRecord(id, {
                        status: 'Error',
                        errorMessage: e.message
                    });
                } catch (ue) {
                    log.error({ title: `${MODULE}.reduce.updateError`, details: `[WorkId=${id}] ${ue.message || ue}` });
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
