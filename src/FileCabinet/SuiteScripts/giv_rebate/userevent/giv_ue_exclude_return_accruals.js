/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @description Exclusión Automática de Provisiones Negativas.
 *              En Return Authorization y Credit Memo, si el acuerdo de reembolso
 *              tiene custrecord_giv_exclude_returns = T:
 *                1) Desmarca el acuerdo del array custcol_rm_applicable_txn_rebates
 *                   (línea de ítem).
 *                2) Recalcula custcol_rm_accrual_amount (línea) con la suma de
 *                   los acuerdos que SÍ quedaron aplicados.
 *                3) Recalcula custbody_rm_rebate_impact_so (header) con la suma
 *                   de custcol_rm_accrual_amount de todas las líneas.
 *  .
 *
 * Deploy: Return Authorization y Credit Memo (beforeSubmit - CREATE)
 */
define(['N/search', 'N/log'], (search, log) => {

    const MODULE = 'giv_ue_exclude_return_accruals';

    /**
     * Verifica si un acuerdo tiene el flag de exclusión de devoluciones activo.
     * @param {string} agreementDetailId
     * @returns {boolean}
     */
    const isExcluded = (agreementDetailId) => {
        try {
            const detail = search.lookupFields({
                type: 'customrecord_rebate_agreement_details',
                id: agreementDetailId,
                columns: ['custrecord_rm_rebate_agreement']
            });
            const agreementId = detail.custrecord_rm_rebate_agreement?.[0]?.value;
            //log.audit({ title: `${MODULE}.isExcluded`, details: { agreementDetailId, agreementId } });
            if (!agreementId) return false;

            const fields = search.lookupFields({
                type: 'customrecord_rm_sales_transaction',
                id: agreementId,
                columns: ['custrecord_giv_exclude_returns']
            });
            //log.audit({ title: `${MODULE}.isExcluded.field`, details: fields });
            return fields.custrecord_giv_exclude_returns === true;
        } catch (e) {
            log.error({ title: `${MODULE}.isExcluded`, details: e.message || e });
            return false;
        }
    };

    const beforeSubmit = (context) => {
        if (context.type !== context.UserEventType.CREATE) return;

        try {
            const rec = context.newRecord;

            const lineCount = rec.getLineCount({ sublistId: 'item' });
            //log.audit({ title: `${MODULE}.beforeSubmit lineCount`, details: lineCount });
            if (!lineCount || lineCount < 1) return;

            const cache = {};
            let anyLineChanged = false;

            for (let i = 0; i < lineCount; i++) {
                const txnRebatesRaw = rec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_applicable_txn_rebates',
                    line: i
                });
                //log.audit({ title: `${MODULE}.beforeSubmit txnRebatesRaw line ${i}`, details: txnRebatesRaw });
                if (!txnRebatesRaw) continue;

                let txnRebates;
                try {
                    txnRebates = JSON.parse(txnRebatesRaw); } catch { continue; }

                const filtered = txnRebates.filter(rebate => {
                    const detailId = String(rebate.id);
                    cache[detailId] ??= isExcluded(detailId);
                    return !cache[detailId];
                });

                //log.audit({ title: `${MODULE}.beforeSubmit filtered line ${i}`, details: { original: txnRebates, filtered } });

                if (filtered.length !== txnRebates.length) {
                    anyLineChanged = true;

                    const excludedIds = txnRebates
                        .filter(r => cache[String(r.id)])
                        .map(r => r.id);

                    rec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_applicable_txn_rebates',
                        line: i,
                        value: JSON.stringify(filtered)
                    });

                    // Recalcular el monto real de la línea con los acuerdos
                    // que sobrevivieron al filtro. Sin esto, custcol_rm_accrual_amount
                    // se queda con el monto viejo (incluyendo el acuerdo excluido).
                    const newLineAmount = filtered.reduce((sum, r) => sum + (r.a || 0), 0);
                    rec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_accrual_amount',
                        line: i,
                        value: newLineAmount
                    });


                    const hiddenRmaRaw = rec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_so_hidden_rma',
                        line: i
                    });
                    //log.audit({ title: `${MODULE}.beforeSubmit hiddenRmaRaw line ${i}`, details: hiddenRmaRaw });

                    if (hiddenRmaRaw) {
                        const hiddenRma = JSON.parse(hiddenRmaRaw);
                        hiddenRma.rad = (hiddenRma.rad || []).filter(r => !excludedIds.includes(r.id));
                        hiddenRma.bo  = hiddenRma.rad.reduce((sum, r) => sum + (r.a || 0), 0);

                        rec.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_rm_so_hidden_rma',
                            line: i,
                            value: JSON.stringify(hiddenRma)
                        });
                        //log.audit({ title: `${MODULE}.beforeSubmit hiddenRma updated line ${i}`, details: hiddenRma });
                    }
                }
            }

            // Recalcular el total del header sumando custcol_rm_accrual_amount
            // de TODAS las líneas (no solo las que cambiaron), porque
            // custbody_rm_rebate_impact_so representa el total consolidado.
            if (anyLineChanged) {
                let headerTotal = 0;
                for (let i = 0; i < lineCount; i++) {
                    const lineAmount = rec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_accrual_amount',
                        line: i
                    });
                    headerTotal += parseFloat(lineAmount || 0);
                }

                rec.setValue({ fieldId: 'custbody_rm_rebate_impact_so', value: headerTotal });


            }


        } catch (e) {
            log.error({ title: `${MODULE}.beforeSubmit`, details: e.message || e });
        }
    };

    return { beforeSubmit };
});