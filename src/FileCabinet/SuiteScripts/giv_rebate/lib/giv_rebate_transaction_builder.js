/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Generador de transacciones financieras para liquidación de rebates.
 *              Crea Settlement, Credit Memo (con aplicación automática y Tax Details Override),
 *              y Vendor Bill.
 */
define(['N/record', 'N/log', 'N/runtime'], (record, log, runtime) => {

    const MODULE = 'giv_rebate_transaction_builder';

    /**
     * Crea un Credit Memo con aplicación automática contra facturas destino.
     * Soporta Escenario 9 (Agrupación) con Tax Details Override.
     */
    const createCreditMemo = (params) => {
        try {
            const {
                customerId,
                lines,
                invoiceApplications,
                scenario,
                accountingItemId,
                taxDetailsLines,
                currency,
                location
            } = params;

            const cmRec = record.create({
                type: record.Type.CREDIT_MEMO,
                isDynamic: true,
                defaultValues: {
                    entity: customerId
                }
            });

            if (currency) cmRec.setValue({ fieldId: 'currency', value: currency });
            if (location) cmRec.setValue({ fieldId: 'location', value: location });

            // Escenario 9 (Agrupación): una sola línea con artículo contable genérico
            if (scenario === 'Agrupación' && accountingItemId) {
                const totalAmount = lines.reduce((sum, l) => sum + parseFloat(l.amount || 0), 0);

                cmRec.selectNewLine({ sublistId: 'item' });
                cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: accountingItemId });
                cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: Math.round(totalAmount * 100) / 100 });
                cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: 'Liquidación de reembolso comercial - Agrupación' });
                cmRec.commitLine({ sublistId: 'item' });

                // Tax Details Override
                if (taxDetailsLines && taxDetailsLines.length > 0) {
                    cmRec.setValue({ fieldId: 'taxdetailsoverride', value: true });

                    taxDetailsLines.forEach((taxLine) => {
                        cmRec.selectNewLine({ sublistId: 'taxdetails' });
                        cmRec.setCurrentSublistValue({ sublistId: 'taxdetails', fieldId: 'taxcode', value: taxLine.taxCodeId });
                        cmRec.setCurrentSublistValue({ sublistId: 'taxdetails', fieldId: 'taxbasis', value: taxLine.taxBasis });
                        cmRec.setCurrentSublistValue({ sublistId: 'taxdetails', fieldId: 'taxamount', value: taxLine.taxAmount });
                        cmRec.setCurrentSublistValue({ sublistId: 'taxdetails', fieldId: 'linenumber', value: 1 });
                        cmRec.commitLine({ sublistId: 'taxdetails' });
                    });
                }
            } else {
                // Escenarios 1-4: una línea por cada provisión/item
                lines.forEach((line) => {
                    cmRec.selectNewLine({ sublistId: 'item' });
                    cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: line.itemId });
                    cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: Math.round(parseFloat(line.amount) * 100) / 100 });

                    if (line.taxCodeId) {
                        cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: line.taxCodeId });
                    }
                    if (line.description) {
                        cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: line.description });
                    }
                    cmRec.commitLine({ sublistId: 'item' });
                });
            }

            // ── FASE 1: Guardar el CM SIN aplicar a facturas ──────────────────────────
            // La localización AT Mexico requiere que los impuestos estén calculados
            // ANTES de poder asignar montos en el sublist 'apply'. El save() dispara
            // ese cálculo internamente (equivalente al botón "Preview Tax" en la UI).
            const creditMemoId = cmRec.save({ enableSourcing: true, ignoreMandatoryFields: false });

            log.audit({
                title: `${MODULE}.createCreditMemo`,
                details: `Phase 1 — Created CM ${creditMemoId} for customer ${customerId}, scenario ${scenario}, ${lines.length} lines`
            });

            // ── FASE 2: Cargar el CM guardado y aplicar contra facturas destino ───────
            // Solo si hay facturas destino. El reload garantiza que los impuestos
            // AT ya están calculados y el sublist 'apply' acepta los montos.
            if (invoiceApplications && invoiceApplications.length > 0) {
                const cmToApply = record.load({
                    type: record.Type.CREDIT_MEMO,
                    id: creditMemoId,
                    isDynamic: true
                });

                const applyCount = cmToApply.getLineCount({ sublistId: 'apply' });
                let appliedCount = 0;

                for (let i = 0; i < applyCount; i++) {
                    const applyInvoiceId = cmToApply.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: i });
                    const matchedApp = invoiceApplications.find(app => String(app.invoiceId) === String(applyInvoiceId));

                    if (matchedApp) {
                        cmToApply.selectLine({ sublistId: 'apply', line: i });
                        cmToApply.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
                        cmToApply.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount', value: Math.round(parseFloat(matchedApp.amount) * 100) / 100 });
                        cmToApply.commitLine({ sublistId: 'apply' });
                        appliedCount++;
                    }
                }

                cmToApply.save({ enableSourcing: true, ignoreMandatoryFields: false });

                log.audit({
                    title: `${MODULE}.createCreditMemo`,
                    details: `Phase 2 — Applied CM ${creditMemoId} to ${appliedCount} invoice(s)`
                });
            }

            return creditMemoId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createCreditMemo`,
                details: `[Customer=${params.customerId}, Scenario=${params.scenario}] ${e.message || e}`
            });
            throw e;
        }

    };

    /**
     * Crea un Vendor Bill para liquidación de rebates.
     * El Vendor se obtiene de custrecord_hidden_payer del Rebate Agreement.
     */
    const createVendorBill = (params) => {
        try {
            const { vendorId, lines, currency, location,
                    agreementId, startDate, endDate } = params;

            if (!vendorId) {
                throw new Error('El acuerdo de reembolso no tiene configurada la entidad pagadora (custrecord_hidden_payer).');
            }

            const vbRec = record.create({
                type: record.Type.VENDOR_BILL,
                isDynamic: true,
                defaultValues: {
                    entity:     vendorId,
                    customform: 592   // Form "Rebates" — verificado en VB nativo 10793
                }
            });

            if (currency) vbRec.setValue({ fieldId: 'currency', value: currency });
            if (location) vbRec.setValue({ fieldId: 'location', value: location });

            // ── Campos de cabecera para paridad con el VB nativo ──────────────
            // Verificado el 2026-07-20: el VB nativo (ID 10793) los contiene.
            // Los valores se loggean para poder diagnosticar si el RM SuiteApp los sobreescribe.
            if (agreementId) {
                const agId = parseInt(agreementId, 10);
                vbRec.setValue({ fieldId: 'custbody_rm_tran_bf_rebate_agr', value: agId });
                log.debug({
                    title: `${MODULE}.createVendorBill`,
                    details: `Set custbody_rm_tran_bf_rebate_agr = ${agId} → readback = ${vbRec.getValue({ fieldId: 'custbody_rm_tran_bf_rebate_agr' })}`
                });
            }
            if (startDate) {
                const sd = startDate instanceof Date
                    ? startDate.toISOString().slice(0, 10)   // 'YYYY-MM-DD'
                    : String(startDate);
                vbRec.setValue({ fieldId: 'custbody_rm_tran_startdate', value: new Date(sd) });
                log.debug({
                    title: `${MODULE}.createVendorBill`,
                    details: `Set custbody_rm_tran_startdate = ${sd} → readback = ${vbRec.getValue({ fieldId: 'custbody_rm_tran_startdate' })}`
                });
            }
            if (endDate) {
                const ed = endDate instanceof Date
                    ? endDate.toISOString().slice(0, 10)
                    : String(endDate);
                vbRec.setValue({ fieldId: 'custbody_rm_tran_enddate', value: new Date(ed) });
                log.debug({
                    title: `${MODULE}.createVendorBill`,
                    details: `Set custbody_rm_tran_enddate = ${ed} → readback = ${vbRec.getValue({ fieldId: 'custbody_rm_tran_enddate' })}`
                });
            }
            // Marcar como recibida y aprobada automáticamente (el nativo tiene approvalstatus=2)
            vbRec.setValue({ fieldId: 'approvalstatus', value: 2 });  // 2 = Approved
            vbRec.setValue({ fieldId: 'received',        value: true });

            // ── Líneas de artículo ────────────────────────────────────────────
            // FIX: en modo dinámico, setear 'amount' directamente hace que NS
            // recalcule quantity = amount / item_rate (tasa del catálogo = 2.40)
            // resultando en un monto final distinto al solicitado.
            // Solución: fijar quantity=1 y rate=monto deseado → amount = 1×rate = correcto.
            lines.forEach((line) => {
                const targetAmount = Math.round(parseFloat(line.amount) * 100) / 100;

                vbRec.selectNewLine({ sublistId: 'item' });
                vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',     value: line.itemId });
                vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
                vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',     value: targetAmount });

                if (line.taxCodeId) {
                    vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: line.taxCodeId });
                }
                if (line.description) {
                    vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: line.description });
                }
                vbRec.commitLine({ sublistId: 'item' });
            });

            const vendorBillId = vbRec.save({ enableSourcing: true, ignoreMandatoryFields: true });

            log.audit({
                title: `${MODULE}.createVendorBill`,
                details: `Created VB ${vendorBillId} for vendor ${vendorId}, ${lines.length} lines`
            });

            return vendorBillId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createVendorBill`,
                details: `[VendorId=${params.vendorId}] ${e.message || e}`
            });
            throw e;
        }
    };

    /**
     * Crea un registro WORK a partir de datos de entrada.
     * Usa los field IDs cortos reales (custrecord_giv_lw_*).
     */
    const createWorkRecord = (data, createdFrom, options = {}) => {
        try {
            const workRec = record.create({ type: 'customrecord_giv_rebate_liq_work', isDynamic: true });

            workRec.setValue({ fieldId: 'custrecord_giv_lw_customer', value: data.customerId });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_agreement', value: data.agreementId });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_settle_method', value: data.settlementMethod });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_scenario', value: data.scenario });
            if (data.sourceAccrualId) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_source_accrual', value: data.sourceAccrualId });
            }

            workRec.setValue({ fieldId: 'custrecord_giv_lw_original_amt', value: parseFloat(data.originalAmount) || 0 });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_available_amt', value: parseFloat(data.availableAmount) || 0 });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_amt_to_settle', value: parseFloat(data.amountToSettle) || 0 });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_proc_status', value: 'Capturado' });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_created_from', value: createdFrom });

            // Campos opcionales
            if (data.sourceInvoiceId) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_source_invoice', value: data.sourceInvoiceId });
            }
            if (data.sourceItemId) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_source_item', value: data.sourceItemId });
            }
            if (data.returnsAmount) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_returns_amt', value: parseFloat(data.returnsAmount) || 0 });
            }
            if (data.settledAmount) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_settled_amt', value: parseFloat(data.settledAmount) || 0 });
            }
            if (data.invoiceTo) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_invoice_to', value: data.invoiceTo });
            }
            if (data.applyAmount) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_apply_amount', value: parseFloat(data.applyAmount) || 0 });
            }
            if (data.taxCodeId) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_taxcode', value: data.taxCodeId });
            }
            if (data.taxBasis) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_tax_basis', value: parseFloat(data.taxBasis) || 0 });
            }
            if (data.excessFlag) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_excess_flag', value: true });
            }
            if (data.csvBatchId) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_csv_batch_id', value: data.csvBatchId });
            }

            const workId = workRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: options.ignoreMandatoryFields === true
            });


            log.debug({
                title: `${MODULE}.createWorkRecord`,
                details: `Created WORK ${workId} from ${createdFrom}, agreement ${data.agreementId}`
            });

            return workId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createWorkRecord`,
                details: `[Agreement=${data.agreementId}] ${e.message || e}`
            });
            throw e;
        }
    };

    /**
     * Crea un registro HISTORY para trazabilidad permanente.
     * Usa los field IDs cortos reales (custrecord_giv_lh_*).
     */
    const createHistoryRecord = (data) => {
        try {
            const histRec = record.create({ type: 'customrecord_giv_rebate_liq_history', isDynamic: true });

            histRec.setValue({ fieldId: 'custrecord_giv_lh_customer', value: data.customerId });
            histRec.setValue({ fieldId: 'custrecord_giv_lh_agreement', value: data.agreementId });
            histRec.setValue({ fieldId: 'custrecord_giv_lh_scenario', value: data.scenario });
            histRec.setValue({ fieldId: 'custrecord_giv_lh_src_accr_amt', value: parseFloat(data.accrualAmount) || 0 });
            histRec.setValue({ fieldId: 'custrecord_giv_lh_user', value: runtime.getCurrentUser().id });
            histRec.setValue({ fieldId: 'custrecord_giv_lh_date', value: new Date() });

            // Campos opcionales
            if (data.settlementId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_settlement', value: data.settlementId });
            }
            if (data.transactionType) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_tran_type', value: data.transactionType });
            }
            if (data.generatedTransactionId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_generated_tran', value: data.generatedTransactionId });
            }
            if (data.sourceAccrualId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_src_accrual', value: data.sourceAccrualId });
            }
            if (data.sourceInvoiceId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_src_invoice', value: data.sourceInvoiceId });
            }
            if (data.sourceItemId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_src_item', value: data.sourceItemId });
            }
            if (data.invoiceTo) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_invoiceto', value: data.invoiceTo });
            }
            if (data.settledAmount) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_src_settl_amt', value: parseFloat(data.settledAmount) || 0 });
            }
            if (data.returnCreditsImpact) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_ret_credits', value: parseFloat(data.returnCreditsImpact) || 0 });
            }
            if (data.appliedAmount) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_applied_amt', value: parseFloat(data.appliedAmount) || 0 });
            }
            if (data.difference) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_difference', value: parseFloat(data.difference) || 0 });
            }
            if (data.taxCodeId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_taxcode', value: data.taxCodeId });
            }
            if (data.taxBasis) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_tax_basis', value: parseFloat(data.taxBasis) || 0 });
            }
            if (data.csvBatchId) {
                histRec.setValue({ fieldId: 'custrecord_giv_lh_csv_batch_id', value: data.csvBatchId });
            }

            const historyId = histRec.save({ enableSourcing: false, ignoreMandatoryFields: false });

            log.audit({
                title: `${MODULE}.createHistoryRecord`,
                details: `Created HISTORY ${historyId} for agreement ${data.agreementId}`
            });

            return historyId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createHistoryRecord`,
                details: `[Agreement=${data.agreementId}] ${e.message || e}`
            });
            throw e;
        }
    };

    /**
     * Actualiza el estado y datos de un registro WORK.
     */
    const updateWorkRecord = (workId, updates) => {
        try {
            const values = {};

            if (updates.status)                       values['custrecord_giv_lw_proc_status']     = updates.status;
            if (updates.errorMessage !== undefined)   values['custrecord_giv_lw_error_message']   = updates.errorMessage;
            if (updates.processedTransaction)         values['custrecord_giv_lw_processed_tran']  = updates.processedTransaction;
            // [FIX] Monto prorrateado real usado en el Credit Memo (Cobro en exceso)
            if (updates.proratedAmount !== undefined) values['custrecord_giv_lw_amt_to_settle']   = parseFloat(updates.proratedAmount) || 0;

            record.submitFields({
                type: 'customrecord_giv_rebate_liq_work',
                id:   workId,
                values: values
            });

            log.debug({
                title:   `${MODULE}.updateWorkRecord`,
                details: `Updated WORK ${workId}: ${JSON.stringify(updates)}`
            });

        } catch (e) {
            log.error({
                title:   `${MODULE}.updateWorkRecord`,
                details: `[WorkId=${workId}] ${e.message || e}`
            });
            throw e;
        }
    };

    return {
        createCreditMemo,
        createVendorBill,
        createWorkRecord,
        createHistoryRecord,
        updateWorkRecord
    };
});
