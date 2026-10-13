/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * @description Reprocesamiento masivo de provisiones de Rebates.
 *              Aplica el recálculo nativo de Rebates al actualizar la tasa del acuerdo,
 *              resuelve el versionamiento de RADs (RAD padre -> RAD activo hoja)
 *              y actualiza tanto las líneas (custcol_rm_selecrebid) como la cabecera
 *              (custbody_rm_rebate_agg_detail_ids) para sincronizar automáticamente
 *              el motor nativo R&TP sin requerir acción manual en "View Applicable Rebates".
 */
define([
    'N/search',
    'N/record',
    'N/runtime',
    'N/task',
    'N/log'
], (search, record, runtime, task, log) => {

    const MODULE = 'giv_mr_rebate_reprocess';

    /**
     * Búsqueda de facturas únicas a reprocesar en el rango de fechas
     */
    const getInputData = () => {
        try {
            const script = runtime.getCurrentScript();
            const agreementId = script.getParameter({ name: 'custscript_giv_reproc_agreement' });
            const dateFrom = script.getParameter({ name: 'custscript_giv_reproc_date_from' });
            const dateTo = script.getParameter({ name: 'custscript_giv_reproc_date_to' });

            log.audit({
                title: `${MODULE}.getInputData | INICIO`,
                details: `Acuerdo: ${agreementId} | Rango: ${dateFrom} al ${dateTo}`
            });

            // Búsqueda directa de Facturas ÚNICAS (Mainline = T) para evitar duplicados
            const invSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['mainline', 'is', 'T'],
                    'AND', ['trandate', 'within', dateFrom, dateTo],
                    'AND', ['status', 'noneof', 'CustInvc:V']
                ],
                columns: ['internalid', 'tranid', 'trandate']
            });

            const invCount = invSearch.runPaged().count;
            log.audit({
                title: `${MODULE}.getInputData | FACTURAS ÚNICAS ENCONTRADAS`,
                details: `Se encontraron ${invCount} Facturas únicas para procesar.`
            });

            return invSearch;

        } catch (e) {
            log.error({ title: `${MODULE}.getInputData | ERROR`, details: e.message });
            return [];
        }
    };

    /**
     * Consulta las reglas de cálculo (tasa y método) para los RADs del acuerdo modificado.
     * Agrupa todos los RADs por su raíz común (custrecord_rm_rad_parent) y asigna
     * la regla de la versión activa más reciente (MAX internalid) a todos los miembros de la familia.
     */
    const getAgreementRadDetails = (agreementId) => {
        const radMap = {};
        if (!agreementId) return radMap;

        try {
            const radSearch = search.create({
                type: 'customrecord_rebate_agreement_details',
                filters: [
                    ['custrecord_rm_rebate_agreement', 'anyof', agreementId],
                    'AND', ['isinactive', 'is', 'F']
                ],
                columns: [
                    'internalid',
                    'custrecord_aggr_detail_cal_amount',
                    'custrecord_agreementdetail_cal_method',
                    'custrecord_rm_rad_parent'
                ]
            });

            const allRads = {};

            radSearch.run().each((result) => {
                const radId = String(result.id);
                const parentRadVal = result.getValue('custrecord_rm_rad_parent');
                const parentRad = parentRadVal ? String(parentRadVal) : null;
                const calcAmount = parseFloat(result.getValue('custrecord_aggr_detail_cal_amount')) || 0;
                const calcMethod = result.getText('custrecord_agreementdetail_cal_method') || result.getValue('custrecord_agreementdetail_cal_method') || '';

                allRads[radId] = {
                    id: radId,
                    parentId: parentRad,
                    calcAmount: calcAmount,
                    calcMethod: calcMethod
                };

                return true;
            });

            // Función para resolver el RAD raíz de cualquier RAD cargado
            const getRootId = (id) => {
                let curr = id;
                const visited = new Set();
                while (curr && allRads[curr] && allRads[curr].parentId && !visited.has(curr)) {
                    visited.add(curr);
                    curr = allRads[curr].parentId;
                }
                return curr;
            };

            // Agrupar los RADs por su raíz común (familia de versiones)
            const families = {};
            for (const radId in allRads) {
                const rootId = getRootId(radId);
                if (!families[rootId]) {
                    families[rootId] = [];
                }
                families[rootId].push(allRads[radId]);
            }

            // Para cada familia de versiones, encontrar la versión activa más reciente (MAX internalid)
            for (const rootId in families) {
                const familyMembers = families[rootId];
                let latestRad = familyMembers[0];

                for (let i = 1; i < familyMembers.length; i++) {
                    if (parseInt(familyMembers[i].id, 10) > parseInt(latestRad.id, 10)) {
                        latestRad = familyMembers[i];
                    }
                }

                const familyRule = {
                    newRadId: latestRad.id,
                    calcAmount: latestRad.calcAmount,
                    calcMethod: latestRad.calcMethod
                };

                // Asignar la regla más reciente a TODOS los miembros de la familia
                familyMembers.forEach((member) => {
                    radMap[member.id] = familyRule;
                });

                // Mapear también la raíz explícitamente
                radMap[rootId] = familyRule;
            }

            log.audit({
                title: `${MODULE}.getAgreementRadDetails | REGLAS CARGADAS`,
                details: `Acuerdo: ${agreementId} | RADs mapeados: ${Object.keys(radMap).length} | Contenido: ${JSON.stringify(radMap)}`
            });

        } catch (e) {
            log.error({ title: `${MODULE}.getAgreementRadDetails | ERROR`, details: e.message });
        }

        return radMap;
    };

    /**
     * Carga la factura, recalcula los valores según la regla del acuerdo modificado,
     * setea los valores en las líneas, actualiza la cabecera y guarda en 1 solo paso.
     */
    const map = (context) => {
        try {
            const searchResult = JSON.parse(context.value);
            log.debug({ title: `${MODULE}.map | SEARCH RESULT`, details: searchResult });
            const vals = searchResult.values || {};

            let invoiceId = searchResult.id;
            let tranId = 'N/A';

            const joinId = vals['internalid.custrecord_rm_source_transaction'] || vals['custrecord_rm_source_transaction.internalid'];
            const joinTranId = vals['tranid.custrecord_rm_source_transaction'] || vals['custrecord_rm_source_transaction.tranid'];

            if (joinId) invoiceId = joinId.value || joinId;
            if (joinTranId) {
                tranId = joinTranId.value || joinTranId;
            } else if (vals.tranid) {
                tranId = vals.tranid.value || vals.tranid;
            }

            if (!invoiceId) return;

            const script = runtime.getCurrentScript();
            const agreementId = script.getParameter({ name: 'custscript_giv_reproc_agreement' });

            // Obtener reglas del acuerdo modificado (RADs) resolviendo versiones por familias
            const radDetails = getAgreementRadDetails(agreementId);
            log.debug({ title: `${MODULE}.map | REGLAS ACUERDO`, details: JSON.stringify(radDetails) });

            // Cargar la factura en modo estándar (isDynamic: false) para preservar las opciones de artículos (item options) de las líneas
            const invoiceRec = record.load({
                type: record.Type.INVOICE,
                id: invoiceId,
                isDynamic: false
            });

            const docNumber = invoiceRec.getValue({ fieldId: 'tranid' }) || tranId || 'N/A';
            const lineCount = invoiceRec.getLineCount({ sublistId: 'item' });
            let headerTotalImpact = 0;

            // Conjunto de todos los RAD IDs aplicables a nivel de cabecera de la factura
            const headerRadIdsSet = new Set();
            const hiddenRebateTranFields = [];
            invoiceRec.setValue({ fieldId: 'custbody_rm_rebate_calc_status', value: 'Pending' });

            for (let i = 0; i < lineCount; i++) {
                const lineItemId = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const lineAmount = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i }) || 0);
                const lineQty = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0);
                const rateVal = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i }) || 0);

                const existingRtLink = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_rebate_rcrd_link', line: i });
                if (existingRtLink) {
                    hiddenRebateTranFields.push(String(existingRtLink));
                }

                const txnRebatesRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_applicable_txn_rebates', line: i });
                const hiddenRmaRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_so_hidden_rma', line: i });
                const hiddenItemObjRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_so_hidden_item_obj', line: i });

                let txnRebates = [];
                let hiddenRma = { bo: 0, l: 0, p: 0, c: 1, rad: [] };
                let hiddenItemObj = { ac: 0, id: Number(lineItemId) || 0, lp: rateVal, md: 0, pv: 0, tp: lineAmount, pp: 0 };

                try { if (txnRebatesRaw) txnRebates = JSON.parse(txnRebatesRaw); } catch (e) { }
                try { if (hiddenRmaRaw) hiddenRma = JSON.parse(hiddenRmaRaw); } catch (e) { }
                try { if (hiddenItemObjRaw) hiddenItemObj = JSON.parse(hiddenItemObjRaw); } catch (e) { }
                if (!hiddenItemObj.id || hiddenItemObj.id === 0) {
                    hiddenItemObj.id = Number(lineItemId) || 0;
                }

                // RE CÁLCULO: Aplicar la nueva tasa/monto del acuerdo modificado
                txnRebates.forEach((item) => {
                    const oldRadId = String(item.id);
                    if (radDetails[oldRadId]) {
                        const rule = radDetails[oldRadId];
                        log.debug({
                            title: `${MODULE}.map | RE-CÁLCULO RAD`,
                            details: `Línea ${i + 1} | RAD ID Viejo: ${oldRadId} | Nuevo RAD ID: ${rule.newRadId} | Regla: ${JSON.stringify(rule)}`
                        });

                        // Actualizar al nuevo RAD ID (ej. de 141 a 142)
                        if (rule.newRadId) {
                            item.id = isNaN(Number(rule.newRadId)) ? rule.newRadId : Number(rule.newRadId);
                        }

                        if (String(rule.calcMethod).includes('%')) {
                            // Porcentaje: -1 * (monto_línea * (porcentaje / 100))
                            item.a = -1 * Math.abs(lineAmount * (rule.calcAmount / 100));
                            item.p = rule.calcAmount;
                        } else {
                            // Monto fijo por unidad: -1 * (cantidad_línea * monto_fijo)
                            item.a = -1 * Math.abs(lineQty * rule.calcAmount);
                            item.p = 0;
                        }
                    }

                    // Acumular RAD IDs para la cabecera
                    headerRadIdsSet.add(item.id);
                });
                const newAccrualAmount = txnRebates.reduce((sum, item) => sum + (parseFloat(item.a) || 0), 0);
                headerTotalImpact += newAccrualAmount;

                hiddenRma.rad = txnRebates.map(r => ({ id: r.id, a: r.a, p: r.p || 0 }));
                hiddenRma.bo = newAccrualAmount;
                hiddenItemObj.tp = lineAmount;

                // SETEAR DIRECTAMENTE EN LA LÍNEA (ESTÁNDAR)
                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_applicable_txn_rebates',
                    line: i,
                    value: JSON.stringify(txnRebates)
                });

                // Actualizar custcol_rm_applicable_rad y custcol_rm_selecrebid con las nuevas versiones de RAD
                const updatedApplicableRads = txnRebates.map(r => r.id).join(',');
                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_applicable_rad',
                    line: i,
                    value: updatedApplicableRads
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_selecrebid',
                    line: i,
                    value: updatedApplicableRads
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_accrual_amount',
                    line: i,
                    value: parseFloat(newAccrualAmount.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_so_hidden_rma',
                    line: i,
                    value: JSON.stringify(hiddenRma)
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_so_hidden_item_obj',
                    line: i,
                    value: JSON.stringify(hiddenItemObj)
                });

                // Activar bandera nativa para que afterSubmit de R&TP reconozca la línea modificada
                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_rebselection',
                    line: i,
                    value: true
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_last_modified_date',
                    line: i,
                    value: new Date()
                });
            }

            // Eliminar explícitamente en cascada (Accruals -> RTD -> RT) todos los registros de rebate viejos para esta factura
            try {
                // 1. Eliminar RTD (Transaction Details) y sus Accruals vinculados buscando por custrecord_rm_source_transaction
                try {
                    const rtdSearch = search.create({
                        type: 'customrecord_rm_transaction_details',
                        filters: [
                            ['custrecord_rm_source_transaction', 'anyof', invoiceId]
                        ],
                        columns: ['internalid', 'custrecord_rm_rtd_accrual']
                    });

                    rtdSearch.run().each((rtdRes) => {
                        const rtdId = rtdRes.id;
                        const accrualId = rtdRes.getValue('custrecord_rm_rtd_accrual');

                        // 1a. Eliminar Accrual
                        if (accrualId) {
                            try {
                                record.delete({ type: 'customrecord_rm_accruals', id: accrualId });
                                log.audit({ title: `${MODULE}.map | ACCRUAL ELIMINADO`, details: `Accrual ID ${accrualId}` });
                            } catch (eAcc) {
                                log.debug({ title: `${MODULE}.map | ACCRUAL DELETE NOTE`, details: eAcc.message });
                            }
                        }

                        // 1b. Eliminar RTD
                        try {
                            record.delete({ type: 'customrecord_rm_transaction_details', id: rtdId });
                            log.audit({ title: `${MODULE}.map | RTD ELIMINADO`, details: `RTD ID ${rtdId}` });
                        } catch (eRtd) {
                            log.debug({ title: `${MODULE}.map | RTD DELETE NOTE`, details: eRtd.message });
                        }
                        return true;
                    });
                } catch (eRtdSearch) {
                    log.debug({ title: `${MODULE}.map | RTD SEARCH NOTE`, details: eRtdSearch.message });
                }

                // 2. Buscar RTs por custrecord_rm_rebate_transaction = invoiceId
                const rtSearch = search.create({
                    type: 'customrecord_rm_transactions',
                    filters: [
                        ['custrecord_rm_rebate_transaction', 'anyof', invoiceId]
                    ],
                    columns: ['internalid']
                });

                rtSearch.run().each((rtRes) => {
                    const rtId = rtRes.id;
                    if (rtId) {
                        hiddenRebateTranFields.push(String(rtId));
                    }

                    // 2a. Eliminar RT padre
                    try {
                        record.delete({ type: 'customrecord_rm_transactions', id: rtId });
                        log.audit({ title: `${MODULE}.map | RT ELIMINADO DIRECTO`, details: `RT ID ${rtId} para Factura ID ${invoiceId}` });
                    } catch (eRt) {
                        log.debug({ title: `${MODULE}.map | RT DELETE NOTE`, details: eRt.message });
                    }

                    return true;
                });
            } catch (eCascade) {
                log.error({ title: `${MODULE}.map | ERROR BORRADO EN CASCADA`, details: eCascade.message });
            }

            // Notificar a R&TP en cabecera para sincronizar el motor nativo
            const existingRtIdsSet = new Set(hiddenRebateTranFields);
            if (existingRtIdsSet.size > 0) {
                const combinedHidden = Array.from(existingRtIdsSet).join(',');
                invoiceRec.setValue({
                    fieldId: 'custbody_hidden_rebate_tran_fields',
                    value: combinedHidden
                });
                log.audit({
                    title: `${MODULE}.map | RTs EN CABECERA`,
                    details: `Factura ID ${invoiceId} | custbody_hidden_rebate_tran_fields: ${combinedHidden}`
                });
            }

            // Establecer estados en 'Pending' para notificar al motor nativo de R&TP que requiere procesamiento de borrado/cálcul


            // Actualizar impacto total consolidado en la cabecera
            invoiceRec.setValue({
                fieldId: 'custbody_rm_rebate_impact_so',
                value: headerTotalImpact
            });

            // Actualizar multi-select custbody_rm_rebate_agg_detail_ids en la cabecera con todos los RAD IDs activos
            if (headerRadIdsSet.size > 0) {
                const headerRadArray = Array.from(headerRadIdsSet).map(id => isNaN(Number(id)) ? id : Number(id));
                try {
                    invoiceRec.setValue({
                        fieldId: 'custbody_rm_rebate_agg_detail_ids',
                        value: headerRadArray
                    });
                } catch (headerErr) {
                    log.debug({ title: `${MODULE}.map | HEADER RAD IDS ERROR`, details: headerErr.message });
                }
            }

            // Guardar factura en modo estándar (enableSourcing: false)
            let savedId;
            try {
                savedId = invoiceRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
            } catch (saveErr) {
                log.audit({
                    title: `${MODULE}.map | RETRY SAVE CON enableSourcing:true`,
                    details: saveErr.message
                });
                savedId = invoiceRec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: true
                });
            }

            log.audit({
                title: `${MODULE}.map | FACTURA ACTUALIZADA Y GUARDADA`,
                details: `Factura: ${docNumber} (ID: ${savedId}) | Impacto Header: $${headerTotalImpact.toFixed(2)} | Líneas: ${lineCount}`
            });

            context.write({
                key: String(invoiceId),
                value: JSON.stringify({
                    tranId: docNumber,
                    status: 'OK',
                    linesUpdated: lineCount
                })
            });

        } catch (e) {
            log.error({ title: `${MODULE}.map | ERROR [Factura ID: ${context.key || searchResult.id}]`, details: e.message });
        }
    };

    /**
     * Resumen y reporte final: Invoca las tareas nativas del SuiteApp de Rebates (R&TP)
     */
    const summarize = (summary) => {
        let success = 0;
        const invoiceList = [];
        const invoiceIds = [];

        summary.output.iterator().each((key, value) => {
            if (key) {
                invoiceIds.push(key);
            }
            try {
                const data = JSON.parse(value);
                if (data.tranId) invoiceList.push(data.tranId);
            } catch (e) { /* skip */ }
            success++;
            return true;
        });

        log.audit({
            title: `${MODULE}.summarize | FACTURAS PROCESADAS EXITOSAMENTE`,
            details: `Total: ${success} | IDs: ${invoiceIds.join(', ')} | Folios: ${invoiceList.join(', ')}`
        });

        /*if (invoiceIds.length > 0) {
            const submittedInvIdStr = invoiceIds.join(',');

            // 1. Disparar tarea nativa RM MR Rebate Transaction Deletion para eliminar los RTs viejos acumulados en custbody_hidden_rebate_tran_fields
            try {
                const mrTaskDelete = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: 'customscript_rm_mr_rebate_txn_deletion',
                    deploymentId: 'customdeploy_rm_mr_rebate_txn_deletion',
                    params: {
                        custscript_rm_submitted_invid: submittedInvIdStr
                    }
                });
                const delTaskId = mrTaskDelete.submit();
                log.audit({
                    title: `${MODULE}.summarize | TAREA NATIVA REBATE TXN DELETION DISPARADA`,
                    details: `Tarea de borrado nativa enviada con éxito. Task ID: ${delTaskId} | Facturas: ${submittedInvIdStr}`
                });
            } catch (delErr) {
                log.error({
                    title: `${MODULE}.summarize | ERROR ENCOLANDO REBATE TXN DELETION`,
                    details: delErr.message
                });
            }
        }*/
    };

    return { getInputData, map, summarize };
});
