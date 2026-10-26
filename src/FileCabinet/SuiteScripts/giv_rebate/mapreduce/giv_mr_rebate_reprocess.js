/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * @description Reprocesamiento masivo de provisiones de Rebates.
 *              1. Resuelve el árbol de versiones de RADs (RAD padre -> RAD activo más reciente).
 *              2. Protege las líneas cuyos Rebate Transactions (RT) ya tienen liquidación (Claim / Pro Forma).
 *              3. Recalcula y actualiza directamente en la factura los 8 campos de línea y los 3 de cabecera,
 *                 además de recuperar líneas cuyos JSONs hayan sido limpiados previamente.
 *              4. Vacía custcol_rm_rebate_rcrd_link en las líneas modificadas y elimina en cascada
 *                 (Accrual -> RTD -> RT) los registros auxiliares anteriores usando custrecord_rm_rebatetran.
 *              5. En summarize, dispara customscript_rm_mr_rebate_transactions (customdeploy_rm_mr_rebate_transactions1)
 *                 con custscript_rm_submitted_invid para recrear los RT y RTD con los nuevos montos.
 */
define([
    'N/search',
    'N/record',
    'N/runtime',
    'N/task',
    'N/query',
    'N/log'
], (search, record, runtime, task, query, log) => {

    const MODULE = 'giv_mr_rebate_reprocess';

    // Caché en memoria por instancia para no repetir la búsqueda de RADs en cada ejecución de map()
    let cachedAgreementId = null;
    let cachedRadDetails = null;

    /**
     * Verifica de forma ligera si una línea de factura contiene al menos un RAD perteneciente al acuerdo.
     */
    const lineContainsAgreementRad = (radIdSet, txnRebatesRaw, selectedRebatesRaw, selecRebIdRaw, applicableRadRaw) => {
        if (!radIdSet || radIdSet.size === 0) return false;

        const checkJsonStr = (rawStr) => {
            if (!rawStr) return false;
            try {
                const parsed = JSON.parse(rawStr);
                if (Array.isArray(parsed)) {
                    return parsed.some(item => item && item.id !== undefined && radIdSet.has(String(item.id)));
                }
            } catch (e) { /* ignore parse errors */ }
            return false;
        };

        if (checkJsonStr(txnRebatesRaw) || checkJsonStr(selectedRebatesRaw)) {
            return true;
        }

        const csvRaw = selecRebIdRaw || applicableRadRaw;
        if (csvRaw) {
            const parts = String(csvRaw).split(',').map(s => s.trim()).filter(Boolean);
            if (parts.some(idStr => radIdSet.has(idStr))) {
                return true;
            }
        }

        return false;
    };

    /**
     * Búsqueda de facturas únicas a reprocesar en el rango de fechas.
     * Pre-filtra a nivel línea únicamente las facturas que contienen al menos un RAD del acuerdo objetivo,
     * evitando cargar en map() facturas que no pertenecen al acuerdo.
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

            const radDetails = getAgreementRadDetails(agreementId);
            const radIdSet = new Set(Object.keys(radDetails));
            if (radIdSet.size === 0) {
                log.audit({
                    title: `${MODULE}.getInputData | SIN REGLAS RAD`,
                    details: `El acuerdo ${agreementId} no tiene RADs asociados.`
                });
                return [];
            }

            const lineSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['mainline', 'is', 'F'],
                    'AND', ['taxline', 'is', 'F'],
                    'AND', ['trandate', 'within', dateFrom, dateTo],
                    'AND', ['status', 'noneof', 'CustInvc:V']
                ],
                columns: [
                    'internalid',
                    'tranid',
                    'trandate',
                    'custcol_rm_applicable_txn_rebates',
                    'custcol_rm_selected_rebates',
                    'custcol_rm_selecrebid',
                    'custcol_rm_applicable_rad'
                ]
            });

            const eligibleInvoicesMap = new Map();
            const scannedInvoicesSet = new Set();
            const pagedData = lineSearch.runPaged({ pageSize: 1000 });

            pagedData.pageRanges.forEach((pageRange) => {
                const page = pagedData.fetch({ index: pageRange.index });
                page.data.forEach((row) => {
                    const invId = String(row.id);
                    scannedInvoicesSet.add(invId);
                    if (eligibleInvoicesMap.has(invId)) return;

                    const hasTargetRad = lineContainsAgreementRad(
                        radIdSet,
                        row.getValue('custcol_rm_applicable_txn_rebates'),
                        row.getValue('custcol_rm_selected_rebates'),
                        row.getValue('custcol_rm_selecrebid'),
                        row.getValue('custcol_rm_applicable_rad')
                    );

                    if (hasTargetRad) {
                        eligibleInvoicesMap.set(invId, {
                            id: invId,
                            values: {
                                tranid: row.getValue('tranid'),
                                trandate: row.getValue('trandate')
                            }
                        });
                    }
                });
            });

            const eligibleInvoices = Array.from(eligibleInvoicesMap.values());
            log.audit({
                title: `${MODULE}.getInputData | FACTURAS ÚNICAS ENCONTRADAS`,
                details: `Se encontraron ${eligibleInvoices.length} Facturas con el acuerdo (de ${scannedInvoicesSet.size} facturas en el rango) para procesar.`
            });

            return eligibleInvoices;

        } catch (e) {
            log.error({ title: `${MODULE}.getInputData | ERROR`, details: e.message });
            return [];
        }
    };

    /**
     * Consulta las reglas de cálculo (tasa, método y pass-through) para todos los RADs del acuerdo.
     * Agrupa todos los RADs (incluyendo padres inactivos) por su raíz común (custrecord_rm_rad_parent)
     * y asigna la regla de la versión activa más reciente (MAX internalid) a todos los miembros de la familia.
     */
    const getAgreementRadDetails = (agreementId) => {
        const radMap = {};
        if (!agreementId) return radMap;

        if (cachedAgreementId === String(agreementId) && cachedRadDetails) {
            return cachedRadDetails;
        }

        try {
            const radSearch = search.create({
                type: 'customrecord_rebate_agreement_details',
                filters: [
                    ['custrecord_rm_rebate_agreement', 'anyof', agreementId]
                ],
                columns: [
                    'internalid',
                    'isinactive',
                    'custrecord_aggr_detail_cal_amount',
                    'custrecord_agreementdetail_cal_method',
                    'custrecord_rm_rad_parent',
                    'custrecord_agreementdetail_passthrough',
                    'custrecord_detail_price_pass_value'
                ]
            });

            const allRads = {};

            radSearch.run().each((result) => {
                const radId = String(result.id);
                const isInactive = result.getValue('isinactive') === true || result.getValue('isinactive') === 'T';
                const parentRadVal = result.getValue('custrecord_rm_rad_parent');
                const parentRad = parentRadVal ? String(parentRadVal) : null;
                const calcAmount = parseFloat(result.getValue('custrecord_aggr_detail_cal_amount')) || 0;
                const calcMethod = result.getText('custrecord_agreementdetail_cal_method') || result.getValue('custrecord_agreementdetail_cal_method') || '';
                const passThroughType = result.getText('custrecord_agreementdetail_passthrough') || '';
                const passThroughVal = parseFloat(result.getValue('custrecord_detail_price_pass_value')) || 0;

                allRads[radId] = {
                    id: radId,
                    isInactive: isInactive,
                    parentId: parentRad,
                    calcAmount: calcAmount,
                    calcMethod: calcMethod,
                    passThroughType: passThroughType,
                    passThroughVal: passThroughVal
                };

                return true;
            });

            const getRootId = (id) => {
                let curr = id;
                const visited = new Set();
                while (curr && allRads[curr] && allRads[curr].parentId && !visited.has(curr)) {
                    visited.add(curr);
                    curr = allRads[curr].parentId;
                }
                return curr;
            };

            const families = {};
            for (const radId in allRads) {
                const rootId = getRootId(radId);
                if (!families[rootId]) {
                    families[rootId] = [];
                }
                families[rootId].push(allRads[radId]);
            }

            for (const rootId in families) {
                const familyMembers = families[rootId];
                // Preferir miembros activos al buscar el más reciente
                const activeMembers = familyMembers.filter(m => !m.isInactive);
                const candidates = activeMembers.length > 0 ? activeMembers : familyMembers;

                let latestRad = candidates[0];
                for (let i = 1; i < candidates.length; i++) {
                    if (parseInt(candidates[i].id, 10) > parseInt(latestRad.id, 10)) {
                        latestRad = candidates[i];
                    }
                }

                const familyRule = {
                    newRadId: latestRad.id,
                    calcAmount: latestRad.calcAmount,
                    calcMethod: latestRad.calcMethod,
                    passThroughType: latestRad.passThroughType,
                    passThroughVal: latestRad.passThroughVal
                };

                familyMembers.forEach((member) => {
                    radMap[member.id] = familyRule;
                });
                radMap[rootId] = familyRule;
            }

            cachedAgreementId = String(agreementId);
            cachedRadDetails = radMap;

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
     * Obtiene los IDs de Rebate Transactions (customrecord_rm_transactions) asociados a la factura
     * que ya tienen una liquidación (Claim) o Pro Forma generada, replicando populateClaimedRTs de RM_CS_RebateAccrual.
     */
    const getClaimedRtIds = (invoiceId) => {
        const claimedSet = new Set();
        if (!invoiceId) return claimedSet;

        try {
            const sql = `
                SELECT DISTINCT rt.id AS id
                FROM customrecord_rm_transactions rt,
                     customrecord_rm_transaction_details rtd
                WHERE rt.custrecord_rm_rebate_transaction = ?
                  AND (rtd.custrecord_rm_rtd_claim IS NOT NULL OR rtd.custrecord_rm_rtd_pro_forma_rec IS NOT NULL)
                  AND rtd.custrecord_rm_rebatetran = rt.id
            `;
            const results = query.runSuiteQL({
                query: sql,
                params: [invoiceId]
            }).asMappedResults();

            results.forEach((row) => {
                if (row.id) {
                    claimedSet.add(Number(row.id));
                }
            });
        } catch (e) {
            log.error({ title: `${MODULE}.getClaimedRtIds | ERROR`, details: `Factura ID ${invoiceId}: ${e.message}` });
        }

        return claimedSet;
    };

    /**
     * Carga la factura, recalcula los 8 campos de línea y los 3 de cabecera con la nueva regla del acuerdo,
     * limpia custcol_rm_rebate_rcrd_link, borra en cascada los registros viejos (Accrual -> RTD -> RT) y guarda.
     */
    const map = (context) => {
        const searchResult = JSON.parse(context.value);
        try {
            const vals = searchResult.values || {};
            const invoiceId = searchResult.id;
            const tranId = vals.tranid ? (vals.tranid.value || vals.tranid) : 'N/A';

            if (!invoiceId) return;

            const script = runtime.getCurrentScript();
            const agreementId = script.getParameter({ name: 'custscript_giv_reproc_agreement' });

            const radDetails = getAgreementRadDetails(agreementId);

            // Consulta perezosa (lazy) de RTs liquidados: solo se ejecuta cuando realmente se requiere
            let claimedRtIds = null;
            const ensureClaimedRtIds = () => {
                if (!claimedRtIds) {
                    claimedRtIds = getClaimedRtIds(invoiceId);
                    if (claimedRtIds.size > 0) {
                        log.audit({
                            title: `${MODULE}.map | RTs LIQUIDADOS DETECTADOS`,
                            details: `Factura ID ${invoiceId} tiene RTs liquidados que no se modificarán: ${Array.from(claimedRtIds).join(', ')}`
                        });
                    }
                }
                return claimedRtIds;
            };

            const invoiceRec = record.load({
                type: record.Type.INVOICE,
                id: invoiceId,
                isDynamic: false
            });

            const docNumber = invoiceRec.getValue({ fieldId: 'tranid' }) || tranId;
            const lineCount = invoiceRec.getLineCount({ sublistId: 'item' });

            let headerTotalImpact = 0;
            let headerTotalEstGrossProfit = 0;
            let headerTotalAdjustedSaleAmt = 0;
            const headerRadIdsSet = new Set();
            let linesUpdatedCount = 0;

            for (let i = 0; i < lineCount; i++) {
                const lineItemId = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const lineAmount = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i }) || 0);
                const lineQty = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0);
                const rateVal = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i }) || 0);
                const costEstimate = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'costestimate', line: i }) || 0);
                const estGrossProfitVal = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'estgrossprofit', line: i }));
                const lineEstGrossProfit = isNaN(estGrossProfitVal) ? (lineAmount - costEstimate) : estGrossProfitVal;

                const existingRtLink = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_rebate_rcrd_link', line: i });
                const txnRebatesRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_applicable_txn_rebates', line: i });
                const selectedRebatesRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_selected_rebates', line: i });
                const hiddenRmaRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_so_hidden_rma', line: i });
                const hiddenItemObjRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_so_hidden_item_obj', line: i });
                const selecRebIdRaw = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_selecrebid', line: i }) ||
                                      invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_applicable_rad', line: i });

                let txnRebates = [];
                let selectedRebates = [];
                let hiddenRma = { bo: 0, l: 0, p: 0, c: 1, rad: [] };
                let hiddenItemObj = { ac: 0, id: Number(lineItemId) || 0, lp: rateVal, md: 0, pv: 0, tp: lineAmount, pp: 0 };

                try { if (txnRebatesRaw) txnRebates = JSON.parse(txnRebatesRaw); } catch (e) { }
                try { if (selectedRebatesRaw) selectedRebates = JSON.parse(selectedRebatesRaw); } catch (e) { }
                try { if (hiddenRmaRaw) hiddenRma = JSON.parse(hiddenRmaRaw); } catch (e) { }
                try { if (hiddenItemObjRaw) hiddenItemObj = JSON.parse(hiddenItemObjRaw); } catch (e) { }
                if (!hiddenItemObj.id || hiddenItemObj.id === 0) {
                    hiddenItemObj.id = Number(lineItemId) || 0;
                }

                // Si selectedRebates conserva más RADs únicos que txnRebates (ej. si txnRebates fue colapsado en corrida previa), restaurar desde selectedRebates
                let restoredFromSelected = false;
                if (Array.isArray(selectedRebates) && selectedRebates.length > 0) {
                    const uniqueTxnIds = new Set(txnRebates.map(r => String(r.id)));
                    const uniqueSelIds = new Set(selectedRebates.map(r => String(r.id)));
                    if (uniqueSelIds.size > uniqueTxnIds.size) {
                        txnRebates = JSON.parse(JSON.stringify(selectedRebates));
                        restoredFromSelected = true;
                    }
                }

                // Si txnRebates estaba vacío (ej. limpiado en corrida previa), reconstruirlo desde custcol_rm_selecrebid
                if (txnRebates.length === 0 && selecRebIdRaw) {
                    String(selecRebIdRaw).split(',').map(s => s.trim()).filter(Boolean).forEach((radIdStr) => {
                        txnRebates.push({ id: isNaN(Number(radIdStr)) ? radIdStr : Number(radIdStr), a: 0, p: 0 });
                    });
                    restoredFromSelected = true;
                }

                const existingAccrual = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_accrual_amount', line: i }) || 0);
                const existingAdjSale = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_adjustedsaleamount', line: i }) || lineAmount);
                const existingPptAmount = parseFloat(invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_rm_pricepassthrough', line: i }) || 0);

                // Si la línea tiene un RT ya liquidado (Claim/Proforma), conservar sus valores intactos
                if (existingRtLink && ensureClaimedRtIds().has(Number(existingRtLink))) {
                    headerTotalImpact += existingAccrual;
                    headerTotalEstGrossProfit += lineEstGrossProfit;
                    headerTotalAdjustedSaleAmt += existingAdjSale;
                    txnRebates.forEach((item) => { if (item.id) headerRadIdsSet.add(item.id); });
                    log.audit({
                        title: `${MODULE}.map | LÍNEA PROTEGIDA POR CLAIM`,
                        details: `Factura ID ${invoiceId} | Línea ${i + 1} | RT ID: ${existingRtLink}`
                    });
                    continue;
                }

                // Si no hay ningún rebate aplicable en la línea, continuar
                if (txnRebates.length === 0) {
                    headerTotalEstGrossProfit += lineEstGrossProfit;
                    headerTotalAdjustedSaleAmt += lineAmount;
                    continue;
                }

                let linePptAmount = existingPptAmount;
                let lineHasTargetAgreement = false;
                let lineHasActualChanges = restoredFromSelected || !existingRtLink;

                // RECÁLCULO: Actualizar ÚNICAMENTE el rebate que pertenece al acuerdo modificado, conservando intactos los demás rebates de la línea
                txnRebates.forEach((item) => {
                    const oldRadId = String(item.id);
                    const oldItemA = parseFloat(item.a) || 0;
                    const oldItemP = parseFloat(item.p) || 0;
                    const rule = radDetails[oldRadId];

                    if (rule) {
                        lineHasTargetAgreement = true;
                        const targetRadId = rule.newRadId
                            ? (isNaN(Number(rule.newRadId)) ? rule.newRadId : Number(rule.newRadId))
                            : item.id;

                        // Calcular Price Pass-Through si está configurado en la regla
                        if (rule.passThroughVal > 0) {
                            if (String(rule.passThroughType).includes('%')) {
                                linePptAmount = Math.abs(lineAmount * (rule.passThroughVal / 100));
                            } else {
                                linePptAmount = Math.abs(lineQty * rule.passThroughVal);
                            }
                        }

                        const calcBaseAmount = lineAmount - linePptAmount;
                        let newItemA = oldItemA;
                        let newItemP = oldItemP;

                        if (String(rule.calcMethod).includes('%')) {
                            newItemA = -1 * Math.abs(calcBaseAmount * (rule.calcAmount / 100));
                            newItemP = rule.calcAmount;
                        } else {
                            newItemA = -1 * Math.abs(lineQty * rule.calcAmount);
                            newItemP = 0;
                        }

                        // Verificar si cambió el RAD ID, el monto, el porcentaje o el Price Pass-Through
                        if (
                            String(item.id) !== String(targetRadId) ||
                            Math.abs(oldItemA - newItemA) > 0.005 ||
                            Math.abs(oldItemP - newItemP) > 0.0001 ||
                            Math.abs(existingPptAmount - linePptAmount) > 0.005
                        ) {
                            lineHasActualChanges = true;
                        }

                        item.id = targetRadId;
                        item.a = newItemA;
                        item.p = newItemP;
                    }

                    if (item.id) {
                        headerRadIdsSet.add(item.id);
                    }
                });

                const newAccrualAmount = txnRebates.reduce((sum, item) => sum + (parseFloat(item.a) || 0), 0);
                if (lineHasTargetAgreement && Math.abs(existingAccrual - newAccrualAmount) > 0.005) {
                    lineHasActualChanges = true;
                }

                // Si esta línea no tiene ningún RAD del acuerdo reprocesado, o si sus valores no cambiaron en absoluto, conservarla sin tocar su RT
                if (!lineHasTargetAgreement || !lineHasActualChanges) {
                    if (existingRtLink) {
                        ensureClaimedRtIds().add(Number(existingRtLink));
                    }
                    headerTotalImpact += existingAccrual;
                    headerTotalEstGrossProfit += lineEstGrossProfit;
                    headerTotalAdjustedSaleAmt += existingAdjSale;
                    continue;
                }

                // Vaciar custcol_rm_rebate_rcrd_link en la línea para que R&TP genere el nuevo RT
                if (existingRtLink) {
                    invoiceRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_rebate_rcrd_link',
                        line: i,
                        value: ''
                    });
                }

                const adjustedSaleAmount = lineAmount - linePptAmount;
                const gpAfterRebate = lineEstGrossProfit + newAccrualAmount;
                const gpPctAfterRebate = adjustedSaleAmount !== 0 ? (gpAfterRebate / adjustedSaleAmount) * 100 : 0;
                const adjustedUnitCost = lineQty > 0 ? (costEstimate - newAccrualAmount) / lineQty : 0;

                headerTotalImpact += newAccrualAmount;
                headerTotalEstGrossProfit += lineEstGrossProfit;
                headerTotalAdjustedSaleAmt += adjustedSaleAmount;

                hiddenRma.rad = txnRebates.map(r => ({ id: r.id, a: parseFloat(Number(r.a).toFixed(2)), p: r.p || 0 }));
                hiddenRma.bo = parseFloat(newAccrualAmount.toFixed(2));
                hiddenRma.p = parseFloat(linePptAmount.toFixed(2));
                hiddenItemObj.tp = lineAmount;

                // 1. JSONs de View Applicable Rebates (manteniendo todos los rebates de la línea)
                const updatedTxnRebatesJson = JSON.stringify(txnRebates);
                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_applicable_txn_rebates',
                    line: i,
                    value: updatedTxnRebatesJson
                });

                try {
                    invoiceRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_selected_rebates',
                        line: i,
                        value: updatedTxnRebatesJson
                    });
                } catch (eSel) { }

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

                // 2. Los 7 campos numéricos visibles de la línea
                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_accrual_amount',
                    line: i,
                    value: parseFloat(newAccrualAmount.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_actual_gross_amount',
                    line: i,
                    value: parseFloat(lineAmount.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_pricepassthrough',
                    line: i,
                    value: parseFloat(linePptAmount.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_adjustedsaleamount',
                    line: i,
                    value: parseFloat(adjustedSaleAmount.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_adjustedunitcost',
                    line: i,
                    value: parseFloat(adjustedUnitCost.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_gp_amount_aftr_rebate',
                    line: i,
                    value: parseFloat(gpAfterRebate.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_gp_per_after_rebat',
                    line: i,
                    value: parseFloat(gpPctAfterRebate.toFixed(2))
                });

                invoiceRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_last_modified_date',
                    line: i,
                    value: new Date()
                });

                linesUpdatedCount++;
            }

            if (linesUpdatedCount === 0) {
                log.audit({
                    title: `${MODULE}.map | FACTURA OMITIDA`,
                    details: `Factura ${docNumber} (ID: ${invoiceId}) no tiene líneas elegibles para actualizar.`
                });
                return;
            }

            // Eliminar en cascada (Accrual -> RTD -> RT) los registros de rebate viejos NO liquidados de esta factura
            try {
                const rtSearch = search.create({
                    type: 'customrecord_rm_transactions',
                    filters: [
                        ['custrecord_rm_rebate_transaction', 'anyof', invoiceId]
                    ],
                    columns: ['internalid']
                });

                const activeClaimedRtIds = ensureClaimedRtIds();
                const unclaimedRtIds = [];
                rtSearch.run().each((rtRes) => {
                    const rtId = rtRes.id;
                    if (rtId && !activeClaimedRtIds.has(Number(rtId))) {
                        unclaimedRtIds.push(String(rtId));
                    }
                    return true;
                });

                if (unclaimedRtIds.length > 0) {
                    const rtdIdsToDelete = [];
                    const accrualIdsToProcess = new Set();

                    try {
                        const rtdSearch = search.create({
                            type: 'customrecord_rm_transaction_details',
                            filters: [
                                ['custrecord_rm_rebatetran', 'anyof', unclaimedRtIds],
                                'AND', ['custrecord_rm_rtd_claim', 'anyof', '@NONE@']
                            ],
                            columns: ['internalid', 'custrecord_rm_rtd_accrual']
                        });

                        rtdSearch.run().each((rtdRes) => {
                            const rtdId = rtdRes.id;
                            const accrualId = rtdRes.getValue('custrecord_rm_rtd_accrual');
                            if (rtdId) rtdIdsToDelete.push(String(rtdId));
                            if (accrualId) accrualIdsToProcess.add(String(accrualId));
                            return true;
                        });
                    } catch (eRtdSearch) {
                        log.debug({ title: `${MODULE}.map | RTD SEARCH NOTE`, details: eRtdSearch.message });
                    }

                    // 1. Reversar las pólizas contables (Journal Entries) de los Accruals ANTES de eliminar los Accruals
                    //    (si se elimina primero el Accrual, NetSuite limpia custbody_rm_accrual_journal en el JE y se pierde el vínculo)
                    if (accrualIdsToProcess.size > 0) {
                        try {
                            const jeSearch = search.create({
                                type: 'journalentry',
                                filters: [
                                    ['mainline', 'is', 'T'],
                                    'AND',
                                    ['custbody_rm_accrual_journal', 'anyof', Array.from(accrualIdsToProcess)]
                                ],
                                columns: [
                                    'internalid',
                                    'tranid',
                                    'custbody_rm_accrual_journal',
                                    'custbody_rm_rebate_claim_journal'
                                ]
                            });

                            const processedJeIds = new Set();
                            jeSearch.run().each((jeRes) => {
                                const jeId = String(jeRes.id);
                                if (!jeId || processedJeIds.has(jeId)) return true;
                                processedJeIds.add(jeId);

                                const claimJnl = jeRes.getValue('custbody_rm_rebate_claim_journal');
                                if (claimJnl) return true; // Ignorar JEs de liquidación/Claim

                                const jeTranId = jeRes.getValue('tranid') || jeId;
                                const linkedAccrualId = jeRes.getValue('custbody_rm_accrual_journal');

                                try {
                                    const jeRec = record.load({
                                        type: 'journalentry',
                                        id: jeId,
                                        isDynamic: false
                                    });
                                    const existingRevDate = jeRec.getValue({ fieldId: 'reversaldate' });
                                    const existingRevEntry = jeRec.getValue({ fieldId: 'reversalentry' });

                                    if (!existingRevDate && !existingRevEntry) {
                                        jeRec.setValue({
                                            fieldId: 'reversaldate',
                                            value: new Date()
                                        });
                                        jeRec.save({
                                            enableSourcing: false,
                                            ignoreMandatoryFields: true
                                        });
                                        log.audit({
                                            title: `${MODULE}.map | JE DE ACCRUAL REVERSADO`,
                                            details: `JE ${jeTranId} (ID: ${jeId}) reversado automáticamente con reversaldate hoy (Accrual ID: ${linkedAccrualId})`
                                        });
                                    } else {
                                        log.debug({
                                            title: `${MODULE}.map | JE YA REVERSADO`,
                                            details: `JE ${jeTranId} (ID: ${jeId}) ya tenía reversa asignada (Reversal Entry: ${existingRevEntry || 'N/A'})`
                                        });
                                    }
                                } catch (eJeRev) {
                                    log.error({
                                        title: `${MODULE}.map | ERROR REVERSANDO JE`,
                                        details: `No se pudo reversar JE ${jeTranId} (ID: ${jeId}, Accrual: ${linkedAccrualId}): ${eJeRev.message}`
                                    });
                                }
                                return true;
                            });
                        } catch (eJeSearch) {
                            log.error({
                                title: `${MODULE}.map | ERROR BUSCANDO JEs DE ACCRUAL`,
                                details: eJeSearch.message
                            });
                        }

                        // 2. Eliminar los registros de Accrual viejos
                        accrualIdsToProcess.forEach((accrualId) => {
                            try {
                                record.delete({ type: 'customrecord_rm_accruals', id: accrualId });
                                log.audit({ title: `${MODULE}.map | ACCRUAL ELIMINADO`, details: `Accrual ID ${accrualId}` });
                            } catch (eAcc) {
                                log.debug({ title: `${MODULE}.map | ACCRUAL DELETE NOTE`, details: eAcc.message });
                            }
                        });
                    }

                    // 3. Eliminar los registros RTD viejos
                    rtdIdsToDelete.forEach((rtdId) => {
                        try {
                            record.delete({ type: 'customrecord_rm_transaction_details', id: rtdId });
                            log.audit({ title: `${MODULE}.map | RTD ELIMINADO`, details: `RTD ID ${rtdId} (RT Padre: ${unclaimedRtIds.join(',')})` });
                        } catch (eRtd) {
                            log.debug({ title: `${MODULE}.map | RTD DELETE NOTE`, details: eRtd.message });
                        }
                    });

                    // 4. Eliminar los registros RT viejos
                    unclaimedRtIds.forEach((rtId) => {
                        try {
                            record.delete({ type: 'customrecord_rm_transactions', id: rtId });
                            log.audit({ title: `${MODULE}.map | RT ELIMINADO DIRECTO`, details: `RT ID ${rtId} para Factura ID ${invoiceId}` });
                        } catch (eRt) {
                            log.debug({ title: `${MODULE}.map | RT DELETE NOTE`, details: eRt.message });
                        }
                    });
                }
            } catch (eCascade) {
                log.error({ title: `${MODULE}.map | ERROR BORRADO EN CASCADA`, details: eCascade.message });
            }

            // Actualizar los 3 campos de Rebate / Gross Profit en cabecera
            const headerGpAfterRebate = headerTotalEstGrossProfit + headerTotalImpact;
            const headerGpPctAfterRebate = headerTotalAdjustedSaleAmt !== 0
                ? (headerGpAfterRebate / headerTotalAdjustedSaleAmt) * 100
                : 0;

            invoiceRec.setValue({
                fieldId: 'custbody_rm_rebate_impact_so',
                value: parseFloat(headerTotalImpact.toFixed(2))
            });

            try {
                invoiceRec.setValue({
                    fieldId: 'custbody_rm_gp_amt_sales_ord',
                    value: parseFloat(headerGpAfterRebate.toFixed(2))
                });
                invoiceRec.setValue({
                    fieldId: 'custbody_rm_gp_perc_sales_order',
                    value: parseFloat(headerGpPctAfterRebate.toFixed(2))
                });
            } catch (headerGpErr) {
                log.debug({ title: `${MODULE}.map | HEADER GP NOTE`, details: headerGpErr.message });
            }

            // Limpiar custbody_hidden_rebate_tran_fields ya que borramos los RTs viejos directamente
            try {
                invoiceRec.setValue({
                    fieldId: 'custbody_hidden_rebate_tran_fields',
                    value: ''
                });
            } catch (hiddenErr) {
                log.debug({ title: `${MODULE}.map | HIDDEN TRAN FIELDS NOTE`, details: hiddenErr.message });
            }

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

            // Guardar factura
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
                details: `Factura: ${docNumber} (ID: ${savedId}) | Impacto Header: $${headerTotalImpact.toFixed(2)} | GP After Rebate: $${headerGpAfterRebate.toFixed(2)} | Líneas: ${linesUpdatedCount}`
            });

            context.write({
                key: String(invoiceId),
                value: JSON.stringify({
                    tranId: docNumber,
                    status: 'OK',
                    linesUpdated: linesUpdatedCount
                })
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.map | ERROR [Factura ID: ${context.key || (searchResult && searchResult.id)}]`,
                details: e.message
            });
        }
    };

    /**
     * Resumen y disparo de la tarea nativa customscript_rm_mr_rebate_transactions (customdeploy_rm_mr_rebate_transactions1)
     * para regenerar los registros RT y RTD de las facturas actualizadas.
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

        if (invoiceIds.length > 0) {
            const submittedInvIdStr = invoiceIds.join(',');

            // 1. Disparar tarea nativa RM MR Rebate Transactions para crear los nuevos RT y RTD y poblar custcol_rm_rebate_rcrd_link
            try {
                const mrCreateRtTask = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: 'customscript_rm_mr_rebate_transactions',
                    deploymentId: 'customdeploy_rm_mr_rebate_transactions1',
                    params: {
                        custscript_rm_submitted_invid: submittedInvIdStr
                    }
                });
                const createRtTaskId = mrCreateRtTask.submit();
                log.audit({
                    title: `${MODULE}.summarize | TAREA NATIVA CREATE RT DISPARADA`,
                    details: `Tarea customscript_rm_mr_rebate_transactions enviada con éxito. Task ID: ${createRtTaskId} | Facturas: ${submittedInvIdStr}`
                });
            } catch (rtTaskErr) {
                log.audit({
                    title: `${MODULE}.summarize | AVISO TAREA NATIVA CREATE RT`,
                    details: `customdeploy_rm_mr_rebate_transactions1 ya en ejecución o no disponible: ${rtTaskErr.message}`
                });
            }
        }
    };

    return { getInputData, map, summarize };
});
