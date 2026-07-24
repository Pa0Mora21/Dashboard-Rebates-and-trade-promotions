/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Generador de transacciones financieras para liquidación de rebates.
 *              Crea Settlement, Credit Memo (con aplicación automática y Tax Details Override),
 *              y Vendor Bill.
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], (record, search, log, runtime) => {

    const MODULE = 'giv_rebate_transaction_builder';

    /**
     * Busca dinámicamente el ID interno de un formulario de transacción por su nombre.
     * Evita hardcodear IDs de formularios que varían entre ambientes (Sandbox / Production).
     *
     * @param {string} formName  - Nombre exacto del formulario (ej. 'RM Credit Memo Disbursement')
     * @returns {number|null}    - Internal ID del formulario, o null si no se encontró
     */
    const resolveFormIdByName = (formName) => {
        try {
            const formSearch = search.create({
                type: 'customform',
                filters: [['name', 'is', formName]],
                columns: [search.createColumn({ name: 'internalid' })]
            });

            let formId = null;
            formSearch.run().each((result) => {
                formId = parseInt(result.id, 10);
                return false; // solo el primero
            });

            if (!formId) {
                log.error({
                    title:   `${MODULE}.resolveFormIdByName`,
                    details: `No se encontró el formulario con nombre "${formName}". Se usará el formulario por defecto.`
                });
            }

            return formId;
        } catch (e) {
            log.error({
                title:   `${MODULE}.resolveFormIdByName`,
                details: `Error al buscar formulario "${formName}": ${e.message || e}`
            });
            return null;
        }
    };

    /**
     * Crea un Credit Memo con aplicación automática contra facturas destino.
     * Soporta Escenario 9 (Agrupación) con Tax Details Override.
     *
     * @param {Object}  params
     * @param {string}  [params.formName]             Nombre del formulario personalizado a aplicar (buscado dinámicamente)
     * @param {string}  [params.settlementHistoryId]  ID del registro de liquidación (custbody_rm_tran_settlement_his_rel)
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
                location,
                formName,
                formId,
                settlementHistoryId
            } = params;

            // Resolver el formulario: formId tiene prioridad (ID directo desde Script Parameter).
            // Si no, se intenta resolver por nombre. Si ninguno, se usa el formulario por defecto.
            let resolvedFormId = null;
            if (formId > 0) {
                resolvedFormId = formId;   // directo — sin búsqueda
            } else if (formName) {
                resolvedFormId = resolveFormIdByName(formName);
            }

            const cmRec = record.create({
                type: record.Type.CREDIT_MEMO,
                isDynamic: true,
                defaultValues: {
                    entity: customerId
                }
            });

            // Aplicar formulario personalizado si se resolvió correctamente
            if (resolvedFormId) {
                cmRec.setValue({ fieldId: 'customform', value: resolvedFormId });
            }

            if (currency) cmRec.setValue({ fieldId: 'currency', value: currency });
            if (location) cmRec.setValue({ fieldId: 'location', value: location });

            // Escenario 9 (Agrupación): una sola línea con artículo contable genérico
            if (scenario === 'Agrupación' && accountingItemId) {
                const totalAmount = lines.reduce((sum, l) => sum + parseFloat(l.amount || 0), 0);

                cmRec.selectNewLine({ sublistId: 'item' });
                cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: accountingItemId });
                cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: Math.round(totalAmount * 100) / 100 });
                cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: 'Liquidación de reembolso comercial - Agrupación' });
                if (location) cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: parseInt(location, 10) || location });
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

                    if (location) cmRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: parseInt(location, 10) || location });
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
                details: `Phase 1 — Created CM ${creditMemoId} for customer ${customerId}, scenario ${scenario}, ${lines.length} lines | Form: ${resolvedFormId || 'default'}`
            });

            // ── FASE 2: Cargar el CM guardado y aplicar contra facturas destino ───────
            // Solo si hay facturas destino. El reload garantiza que los impuestos
            // AT ya están calculados y el sublist 'apply' acepta los montos.
            // RETRY: si el RM Bundle modifica el CM de forma asíncrona entre la carga
            // y el save (causando "Record has been changed"), se recarga y reintenta.
            if (invoiceApplications && invoiceApplications.length > 0) {
                const MAX_APPLY_RETRIES = 3;
                let applied = false;

                for (let attempt = 1; attempt <= MAX_APPLY_RETRIES; attempt++) {
                    try {
                        const cmToApply = record.load({
                            type: record.Type.CREDIT_MEMO,
                            id:   creditMemoId,
                            isDynamic: true
                        });

                        const applyCount = cmToApply.getLineCount({ sublistId: 'apply' });
                        let appliedCount = 0;

                        for (let i = 0; i < applyCount; i++) {
                            const applyInvoiceId = cmToApply.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: i });
                            const matchedApp = invoiceApplications.find(app => String(app.invoiceId) === String(applyInvoiceId));

                            if (matchedApp) {
                                cmToApply.selectLine({ sublistId: 'apply', line: i });
                                cmToApply.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply',  value: true });
                                cmToApply.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount', value: Math.round(parseFloat(matchedApp.amount) * 100) / 100 });
                                cmToApply.commitLine({ sublistId: 'apply' });
                                appliedCount++;
                            }
                        }

                        cmToApply.save({ enableSourcing: true, ignoreMandatoryFields: false });

                        log.audit({
                            title:   `${MODULE}.createCreditMemo`,
                            details: `Phase 2 — Applied CM ${creditMemoId} to ${appliedCount} invoice(s)${attempt > 1 ? ` (attempt ${attempt})` : ''}`
                        });
                        applied = true;
                        break; // éxito — salir del loop

                    } catch (applyErr) {
                        const isStaleError = (applyErr.message || '').toLowerCase().includes('record has been changed');
                        if (isStaleError && attempt < MAX_APPLY_RETRIES) {
                            log.audit({
                                title:   `${MODULE}.createCreditMemo`,
                                details: `Phase 2 — "Record has been changed" en intento ${attempt}. Recargando CM ${creditMemoId} y reintentando...`
                            });
                            // continuar al siguiente intento con record.load() fresco
                        } else {
                            // Error no recuperable o máximo de reintentos alcanzado
                            throw applyErr;
                        }
                    }
                }

                if (!applied) {
                    throw new Error(`Phase 2 — No se pudo aplicar CM ${creditMemoId} a facturas destino tras ${MAX_APPLY_RETRIES} intentos.`);
                }
            }


            // ── FASE 3: Vincular CM a la liquidación (settlementHistoryId) ────────────
            // Se ejecuta siempre que haya un settlementHistoryId, independientemente
            // de si hubo aplicación de facturas. Usa submitFields para evitar recargar
            // el registro completo y ahorrar governance.
            if (settlementHistoryId) {
                try {
                    record.submitFields({
                        type:   record.Type.CREDIT_MEMO,
                        id:     creditMemoId,
                        values: { custbody_rm_tran_settlement_his_rel: parseInt(settlementHistoryId, 10) }
                    });

                    log.audit({
                        title:   `${MODULE}.createCreditMemo`,
                        details: `Phase 3 — Linked CM ${creditMemoId} to settlement ${settlementHistoryId} (custbody_rm_tran_settlement_his_rel)`
                    });
                } catch (linkErr) {
                    // No-bloqueante: el CM ya fue creado; solo se loguea el error
                    log.error({
                        title:   `${MODULE}.createCreditMemo`,
                        details: `Phase 3 — No se pudo vincular CM ${creditMemoId} al settlement ${settlementHistoryId}: ${linkErr.message || linkErr}`
                    });
                }
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

            // NOTA: custrecord_giv_rebate_liq_work tiene <includename>F</includename>
            // NetSuite auto-genera el campo 'name' con el Internal ID — no se debe setear.

            workRec.setValue({ fieldId: 'custrecord_giv_lw_customer', value: data.customerId });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_agreement', value: data.agreementId });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_settle_method', value: String(data.settlementMethod || '') });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_scenario', value: data.scenario });

            // Campos MANDATORY de tipo List/Record: NO se puede pasar 0 a un campo List/Record
            // (NetSuite lanza "Invalid Field Value 0" antes del save).
            // Solo se setean si el valor es un ID positivo válido.
            // Los WORKs de destino (Consolidada/Agrupación) usan ignoreMandatoryFields=true
            // en el save() para omitir la validación de obligatoriedad cuando no hay origen.
            const sourceAccrualVal = parseInt(data.sourceAccrualId, 10);
            if (sourceAccrualVal > 0) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_source_accrual', value: sourceAccrualVal });
            }

            workRec.setValue({ fieldId: 'custrecord_giv_lw_original_amt',  value: parseFloat(data.originalAmount)  || 0 });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_available_amt', value: parseFloat(data.availableAmount) || 0 });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_amt_to_settle', value: parseFloat(data.amountToSettle)  || 0 });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_proc_status',   value: 'Capturado' });
            workRec.setValue({ fieldId: 'custrecord_giv_lw_created_from',  value: createdFrom });

            // List/Record: solo setear si hay un ID positivo válido
            const sourceInvoiceVal = parseInt(data.sourceInvoiceId, 10);
            if (sourceInvoiceVal > 0) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_source_invoice', value: sourceInvoiceVal });
            }
            const sourceItemVal = parseInt(data.sourceItemId, 10);
            if (sourceItemVal > 0) {
                workRec.setValue({ fieldId: 'custrecord_giv_lw_source_item', value: sourceItemVal });
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

    /**
     * Crea el registro nativo de liquidación del RM SuiteApp (customrecord_rm_claim).
     *
     * FLUJO EN DOS FASES:
     *   FASE 1 — Marcar RTDs como “selected”:
     *     Antes de crear el Claim, actualiza custrecord_rm_td_rebateselected = true
     *     en los Transaction Details (RTDs) de cada Accrual liquidado.
     *     Esto le indica al afterSubmit del Bundle qué accruals debe revertir.
     *
     *   FASE 2 — Crear el Claim:
     *     Al guardarse, el afterSubmit del Bundle RM busca RTDs con
     *     rebateselected = true para este Agreement y ejecuta:
     *       · Generación del Journal Entry de reversa (custbody_rm_accrual_journal)
     *       · Actualización de custrecord_rm_rtd_claim en cada RTD procesado
     *       · Llenado de custbody_rm_tran_settlement_his_rel en el CM/VB
     *
     * ESTRATEGIA NO-BLOQUEANTE: cualquier fallo retorna null sin propagar el error.
     * El proceso continúa con GIV_REBATE_LIQ_HISTORY como fuente de trazabilidad.
     *
     * @param {Object}   params
     * @param {string}   params.agreementId     Internal ID del Rebate Agreement
     * @param {string}   params.customerId       Internal ID del cliente o vendor
     * @param {number}   params.totalAmount      Monto total liquidado
     * @param {string}   params.transactionId    Internal ID del CM o VB generado
     * @param {string[]} [params.accrualIds]     IDs de los Accruals a revertir
     * @param {Date}     [params.startDate]      Fecha inicio del período (default: hoy)
     * @param {Date}     [params.endDate]        Fecha fin del período (default: hoy)
     * @returns {string|null}  Internal ID del Claim creado, o null si falló
     */
    const createNativeClaim = (params) => {
        const {
            agreementId,
            customerId,
            totalAmount,
            transactionId,
            accrualIds     = [],
            accrualAmounts = {},   // { [accrualId]: settlementAmount }
            startDate,
            endDate
        } = params;

        const today      = new Date();
        const claimStart = startDate instanceof Date ? startDate : today;
        const claimEnd   = endDate   instanceof Date ? endDate   : today;

        // ── FASE 1: Marcar RTDs como selected ─────────────────────────────────────
        // El afterSubmit del Bundle lee esta marca para saber qué accruals revertir.
        if (accrualIds.length > 0) {
            try {
                const rtdSearch = search.create({
                    type: 'customrecord_rm_transaction_details',
                    filters: [
                        ['custrecord_rm_rtd_accrual', 'anyof', accrualIds],
                        'AND',
                        ['custrecord_rm_rtd_claim',   'isempty', ''],
                        'AND',
                        ['isinactive',                'is',       'F']
                    ],
                    columns: [search.createColumn({ name: 'internalid' })]
                });

                let rtdsMarked = 0;
                rtdSearch.run().each(result => {
                    const rtdId = result.getValue('internalid');
                    if (!rtdId) return true;
                    try {
                        record.submitFields({
                            type:   'customrecord_rm_transaction_details',
                            id:     rtdId,
                            values: { custrecord_rm_td_rebateselected: true }
                        });
                        rtdsMarked++;
                    } catch (ue) {
                        log.error({
                            title:   `${MODULE}.createNativeClaim.markRTD`,
                            details: `No se pudo marcar RTD ${rtdId}: ${ue.message || ue}`
                        });
                    }
                    return true;
                });

                log.audit({
                    title:   `${MODULE}.createNativeClaim`,
                    details: `Fase 1 completada: ${rtdsMarked} RTD(s) marcados como selected | Accruals: [${accrualIds.join(', ')}]`
                });

            } catch (se) {
                log.error({
                    title:   `${MODULE}.createNativeClaim.searchRTD`,
                    details: `Error buscando RTDs para marcar: ${se.message || se}`
                });
            }
        }

        // ── FASE 2: Crear el Claim ─────────────────────────────────────────────────
        // El afterSubmit del Bundle RM encuentra los RTDs marcados en Fase 1
        // y genera los JEs de reversa automáticamente.
        try {
            const claimRec = record.create({
                type:      'customrecord_rm_claim',
                isDynamic: false
            });

            claimRec.setValue({ fieldId: 'custrecord_rm_claim_rm_agreement',      value: parseInt(agreementId,   10) });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_credit_entity',      value: parseInt(customerId,    10) });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_total_claim_amount', value: Math.round(parseFloat(totalAmount) * 100) / 100 });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_tran_number',        value: parseInt(transactionId, 10) });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_date_gen',           value: today });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_tran_start_date',    value: claimStart });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_tran_end_date',      value: claimEnd });
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_gen_status',         value: 6 });     // Disbursement - Completed
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_mode',               value: 2 });     // CM y VB comparten valor
            claimRec.setValue({ fieldId: 'custrecord_rm_claim_is_auto',            value: false });  // creado por script

            const claimId = String(claimRec.save({
                enableSourcing:        false,
                ignoreMandatoryFields: true
            }));

            log.audit({
                title:   `${MODULE}.createNativeClaim`,
                details: `✅ Claim nativo creado: ${claimId} | Agreement: ${agreementId} | Txn: ${transactionId} | Monto: ${totalAmount}`
            });

            // ── FASE 3: Vincular RTDs al Claim recién creado ───────────────────────
            // El Bundle no actualiza custrecord_rm_rtd_claim automáticamente.
            // Lo hacemos nosotros sobre los RTDs que marcamos en Fase 1.
            if (accrualIds.length > 0) {
                try {
                    const rtdLinkSearch = search.create({
                        type: 'customrecord_rm_transaction_details',
                        filters: [
                            ['custrecord_rm_rtd_accrual',    'anyof', accrualIds],
                            'AND',
                            ['custrecord_rm_td_rebateselected', 'is', 'T'],
                            'AND',
                            ['custrecord_rm_rtd_claim',      'isempty', ''],
                            'AND',
                            ['isinactive',                   'is', 'F']
                        ],
                        columns: [search.createColumn({ name: 'internalid' })]
                    });

                    let rtdsLinked = 0;
                    rtdLinkSearch.run().each(result => {
                        const rtdId = result.getValue('internalid');
                        if (!rtdId) return true;
                        try {
                            record.submitFields({
                                type:   'customrecord_rm_transaction_details',
                                id:     rtdId,
                                values: {
                                    custrecord_rm_rtd_claim:        parseInt(claimId, 10),
                                    custrecord_rm_td_rebateselected: false   // resetear el flag
                                }
                            });
                            rtdsLinked++;
                        } catch (le) {
                            log.error({
                                title:   `${MODULE}.createNativeClaim.linkRTD`,
                                details: `No se pudo vincular RTD ${rtdId} al Claim ${claimId}: ${le.message || le}`
                            });
                        }
                        return true;
                    });

                    log.audit({
                        title:   `${MODULE}.createNativeClaim`,
                        details: `Fase 3 completada: ${rtdsLinked} RTD(s) vinculados al Claim ${claimId}`
                    });

                } catch (le) {
                    log.error({
                        title:   `${MODULE}.createNativeClaim.fase3`,
                        details: `Error en Fase 3 (vincular RTDs): ${le.message || le}`
                    });
                }
            }

            // ── FASE 4: Crear Journal Entries de reversa ───────────────────────────
            // El Bundle no los genera por SuiteScript, así que los creamos explícitamente.
            if (accrualIds.length > 0) {
                const jeIds = createReversalJournalEntries({
                    accrualIds,
                    accrualAmounts,
                    claimId
                });
                log.audit({
                    title:   `${MODULE}.createNativeClaim`,
                    details: `Fase 4 completada: ${jeIds.length} JE(s) de reversa creados: [${jeIds.join(', ')}]`
                });
            }

            return claimId;

        } catch (e) {
            log.audit({
                title:   `${MODULE}.createNativeClaim`,
                details: `⚠️ No se pudo crear el Claim nativo. ` +
                         `Agreement: ${agreementId} | Txn: ${transactionId} | Error: ${e.message || e}`
            });
            return null;
        }
    };

    /**
     * Crea los Journal Entries de settlement del Accrual.
     *
     * El Bundle del RM SuiteApp no genera JEs automáticamente cuando el Claim
     * se crea vía SuiteScript. Esta función replica ese comportamiento:
     *   1. Busca el JE original del Accrual (custbody_rm_rebate_claim_journal IS NULL)
     *   2. Carga sus líneas contables (cuentas, dimensiones)
     *   3. Crea un nuevo JE con las mismas líneas por el monto liquidado
     *   4. Vincula el JE al Journal original y al Claim vía custbody_rm_accrual_journal
     *      y custbody_rm_rebate_claim_journal
     *
     * @param {Object}   params
     * @param {string[]} params.accrualIds     IDs de los Accruals a revertir
     * @param {Object}   params.accrualAmounts Mapa { accrualId: montoLiquidado }
     * @param {string}   params.claimId        Internal ID del Claim
     * @returns {string[]} IDs de los JEs creados
     */
    const createReversalJournalEntries = (params) => {
        const { accrualIds, accrualAmounts, claimId } = params;
        const today   = new Date();
        const jeIds   = [];

        accrualIds.forEach(accrualId => {
            try {
                const settlementAmount = Math.round(parseFloat(accrualAmounts[accrualId] || 0) * 100) / 100;
                if (!settlementAmount) {
                    log.error({ title: `${MODULE}.createReversalJE`, details: `Sin monto para Accrual ${accrualId}` });
                    return;
                }

                // Buscar el JE original del Accrual (sin Claim = JE de Accrual, no de Settlement)
                let originalJEId = null;
                search.create({
                    type: 'transaction',
                    filters: [
                        ['type',                              'anyof',    ['Journal']],
                        'AND',
                        ['custbody_rm_accrual_journal',       'anyof',    [accrualId]],
                        'AND',
                        ['custbody_rm_rebate_claim_journal',  'isempty',  '']
                    ],
                    columns: [search.createColumn({ name: 'internalid' })]
                }).run().each(r => { originalJEId = r.getValue('internalid'); return false; });

                if (!originalJEId) {
                    log.error({ title: `${MODULE}.createReversalJE`, details: `No se encontró JE original para Accrual ${accrualId}` });
                    return;
                }

                // Cargar JE original para leer cuentas, dimensiones y campos RM
                const origJE      = record.load({ type: 'journalentry', id: originalJEId, isDynamic: false });
                const lineCount   = origJE.getLineCount({ sublistId: 'line' });
                const subId       = origJE.getValue({ fieldId: 'subsidiary' });
                // custbody_rm_rebate_id_journal: ID del Rebate Agreement — tomado del JE original
                const rebateIdJnl = origJE.getValue({ fieldId: 'custbody_rm_rebate_id_journal' });

                // Crear JE de settlement (sin reversaldate — poner reversaldate generaría un 2° JE automático no deseado)
                // isDynamic: false — requerido para poder usar submitFields después del save().
                // NOTA: reversalentry es read-only durante la creación del registro en NetSuite:
                // setValue() lo acepta en memoria pero lo descarta al save() sin lanzar excepción
                // (por eso el try/catch anterior nunca entraba al catch). Se setea con submitFields post-save.
                const revJE = record.create({ type: 'journalentry', isDynamic: true });
                revJE.setValue({ fieldId: 'subsidiary', value: subId });
                revJE.setValue({ fieldId: 'trandate',   value: today });

                // custbody_rm_accrual_journal apunta al Accrual Record del RM Bundle (customrecord_rm_accrual).
                // IMPORTANTE: este campo acepta IDs de customrecord_rm_accrual, NO de journalentry.
                revJE.setValue({ fieldId: 'custbody_rm_accrual_journal',      value: parseInt(accrualId,  10) });
                revJE.setValue({ fieldId: 'custbody_rm_rebate_claim_journal', value: parseInt(claimId,    10) });
                // custbody_rm_rebate_id_journal: mismo valor que el JE original del Accrual
                if (rebateIdJnl) revJE.setValue({ fieldId: 'custbody_rm_rebate_id_journal', value: rebateIdJnl });


                for (let i = 0; i < lineCount; i++) {
                    const acct   = origJE.getSublistValue({ sublistId: 'line', fieldId: 'account',     line: i });
                    const debit  = parseFloat(origJE.getSublistValue({ sublistId: 'line', fieldId: 'debit',   line: i }) || 0);
                    const cls    = origJE.getSublistValue({ sublistId: 'line', fieldId: 'class',       line: i });
                    const loc    = origJE.getSublistValue({ sublistId: 'line', fieldId: 'location',    line: i });
                    const dept   = origJE.getSublistValue({ sublistId: 'line', fieldId: 'department',  line: i });
                    const marca  = origJE.getSublistValue({ sublistId: 'line', fieldId: 'cseg_marcas_giv',  line: i });
                    const canal  = origJE.getSublistValue({ sublistId: 'line', fieldId: 'cseg_canal_distr', line: i });

                    if (!acct) continue;

                    revJE.selectNewLine({ sublistId: 'line' });
                    revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: acct });

                    // Dirección INVERTIDA respecto al JE original:
                    // si el accrual puso Débito → el settlement pone Crédito (signo negativo en accrual)
                    // si el accrual puso Crédito → el settlement pone Débito
                    if (debit > 0) {
                        revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: settlementAmount });
                    } else {
                        revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',  value: settlementAmount });
                    }

                    if (cls)   revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'class',           value: cls });
                    if (loc)   revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'location',        value: loc });
                    if (dept)  revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department',      value: dept });
                    if (marca) revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'cseg_marcas_giv',  value: marca });
                    if (canal) revJE.setCurrentSublistValue({ sublistId: 'line', fieldId: 'cseg_canal_distr', value: canal });

                    revJE.commitLine({ sublistId: 'line' });
                }

                const newJEId = String(revJE.save({ enableSourcing: false, ignoreMandatoryFields: true }));
                jeIds.push(newJEId);

                // reversalentry: vincula visualmente el JE de reversa al JE original del accrual.
                // Se setea con submitFields DESPUÉS del save porque durante la creación NetSuite
                // acepta el valor en memoria pero lo descarta silenciosamente (sin lanzar excepción).
                // Con submitFields el campo sí persiste y el JE aparece como "Reversal Approved for Posting".
                try {
                    record.submitFields({
                        type:   'journalentry',
                        id:     newJEId,
                        values: { reversalentry: parseInt(originalJEId, 10) }
                    });
                    log.audit({
                        title:   `${MODULE}.createReversalJE`,
                        details: `✅ JE de reversa creado: ${newJEId} | JE original (accrual): ${originalJEId} | Accrual: ${accrualId} | Claim: ${claimId} | Monto: ${settlementAmount} | reversalentry vinculado`
                    });
                } catch (re) {
                    log.error({
                        title:   `${MODULE}.createReversalJE`,
                        details: `JE ${newJEId} creado pero no se pudo vincular reversalentry al JE original ${originalJEId}: ${re.message || re}`
                    });
                    log.audit({
                        title:   `${MODULE}.createReversalJE`,
                        details: `⚠️ JE de reversa creado: ${newJEId} | JE original (accrual): ${originalJEId} | Accrual: ${accrualId} | Claim: ${claimId} | Monto: ${settlementAmount} | reversalentry NO vinculado`
                    });
                }

            } catch (e) {
                log.error({
                    title:   `${MODULE}.createReversalJE`,
                    details: `Error al crear JE de reversa para Accrual ${accrualId}: ${e.message || e}`
                });
            }
        });

        return jeIds;
    };

    return {
        resolveFormIdByName,
        createCreditMemo,
        createVendorBill,
        createNativeClaim,
        createReversalJournalEntries,
        createWorkRecord,
        createHistoryRecord,
        updateWorkRecord
    };
});

