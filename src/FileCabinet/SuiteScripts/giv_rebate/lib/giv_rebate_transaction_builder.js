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
                currency
            } = params;

            const cmRec = record.create({
                type: record.Type.CREDIT_MEMO,
                isDynamic: true,
                defaultValues: {
                    entity: customerId
                }
            });

            if (currency) {
                cmRec.setValue({ fieldId: 'currency', value: currency });
            }

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

            // Aplicación automática contra facturas destino
            if (invoiceApplications && invoiceApplications.length > 0) {
                const applyCount = cmRec.getLineCount({ sublistId: 'apply' });
                for (let i = 0; i < applyCount; i++) {
                    const applyInvoiceId = cmRec.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: i });

                    const matchedApp = invoiceApplications.find(app => String(app.invoiceId) === String(applyInvoiceId));
                    if (matchedApp) {
                        cmRec.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: true });
                        cmRec.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i, value: Math.round(parseFloat(matchedApp.amount) * 100) / 100 });
                    }
                }
            }

            const creditMemoId = cmRec.save({ enableSourcing: true, ignoreMandatoryFields: false });

            log.audit({
                title: `${MODULE}.createCreditMemo`,
                details: `Created CM ${creditMemoId} for customer ${customerId}, scenario ${scenario}, ${lines.length} lines`
            });

            return creditMemoId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createCreditMemo`,
                details: `Customer: ${params.customerId}, Scenario: ${params.scenario}. Error: ${e.message}`
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
            const { vendorId, lines, currency } = params;

            if (!vendorId) {
                throw new Error('El acuerdo de reembolso no tiene configurada la entidad pagadora (custrecord_hidden_payer).');
            }

            const vbRec = record.create({
                type: record.Type.VENDOR_BILL,
                isDynamic: true,
                defaultValues: {
                    entity: vendorId
                }
            });

            if (currency) {
                vbRec.setValue({ fieldId: 'currency', value: currency });
            }

            lines.forEach((line) => {
                vbRec.selectNewLine({ sublistId: 'item' });
                vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: line.itemId });
                vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: Math.round(parseFloat(line.amount) * 100) / 100 });

                if (line.taxCodeId) {
                    vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: line.taxCodeId });
                }
                if (line.description) {
                    vbRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: line.description });
                }
                vbRec.commitLine({ sublistId: 'item' });
            });

            const vendorBillId = vbRec.save({ enableSourcing: true, ignoreMandatoryFields: false });

            log.audit({
                title: `${MODULE}.createVendorBill`,
                details: `Created VB ${vendorBillId} for vendor ${vendorId}, ${lines.length} lines`
            });

            return vendorBillId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createVendorBill`,
                details: `VendorId: ${params.vendorId}. Error: ${e.message}`
            });
            throw e;
        }
    };

    /**
     * Crea un registro WORK a partir de datos de entrada.
     * Usa los field IDs cortos reales (custrecord_giv_lw_*).
     */
    const createWorkRecord = (data, createdFrom) => {
        try {
            const workRec = record.create({ type: 'customrecord_giv_rebate_liq_work', isDynamic: true });

            workRec.setValue({ fieldId: 'custrecord_giv_lw_customer', value: data.customerId });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_agreement', value: data.agreementId });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_settle_method', value: data.settlementMethod });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_scenario', value: data.scenario });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_source_accrual', value: data.sourceAccrualId });
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
                workRec.setValue({ fieldId: 'custrecord_giv_lw_excess_flag', value: 'T' });
            }
            if (data.csvBatchId) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_csv_batch_id', value: data.csvBatchId });
            }

            const workId = workRec.save({ enableSourcing: false, ignoreMandatoryFields: false });

            log.debug({
                title: `${MODULE}.createWorkRecord`,
                details: `Created WORK ${workId} from ${createdFrom}, agreement ${data.agreementId}`
            });

            return workId;

        } catch (e) {
            log.error({
                title: `${MODULE}.createWorkRecord`,
                details: `Agreement: ${data.agreementId}. Error: ${e.message}`
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
                details: `Agreement: ${data.agreementId}. Error: ${e.message}`
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

            if (updates.status) values['custrecord_giv_lw_proc_status'] = updates.status;
            if (updates.errorMessage !== undefined) values['custrecord_giv_lw_error_message'] = updates.errorMessage;
            if (updates.processedTransaction) values['custrecord_giv_lw_processed_tran'] = updates.processedTransaction;

            record.submitFields({
                type: 'customrecord_giv_rebate_liq_work',
                id: workId,
                values: values
            });

            log.debug({
                title: `${MODULE}.updateWorkRecord`,
                details: `Updated WORK ${workId}: ${JSON.stringify(updates)}`
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.updateWorkRecord`,
                details: `WorkId: ${workId}. Error: ${e.message}`
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
