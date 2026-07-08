/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @description Escenario 7 — Exclusión Automática de Provisiones Negativas.
 *              En Return Authorization y Credit Memo, si el acuerdo de reembolso
 *              tiene custrecord_giv_exclude_returns = T, desmarca automáticamente
 *              el acuerdo de la sublista de reembolsos aplicables antes de guardar.
 *
 * Deploy: Return Authorization y Credit Memo (beforeSubmit - CREATE)
 */
define(['N/search', 'N/log'], (search, log) => {

    const MODULE = 'giv_ue_exclude_return_accruals';

    /**
     * Verifica si un acuerdo tiene el flag de exclusión de devoluciones activo.
     * @param {string} agreementId
     * @returns {boolean}
     */
    const isExcluded = (agreementId) => {
        try {
            const fields = search.lookupFields({
                type: 'customrecord_rm_sales_transaction',
                id: agreementId,
                columns: ['custrecord_giv_exclude_returns']
            });
            return fields.custrecord_giv_exclude_returns === true;
        } catch (e) {
            log.error({ title: `${MODULE}.isExcluded`, details: e });
            return false;
        }
    };

    /**
     * beforeSubmit — Desmarca custcol_rm_rebselection en líneas cuyo acuerdo
     * tiene custrecord_giv_exclude_returns = T.
     */
    const beforeSubmit = (context) => {
        if (context.type !== context.UserEventType.CREATE) return;

        try {
            const rec = context.newRecord;
            const lineCount = rec.getLineCount({ sublistId: 'item' });

            if (!lineCount || lineCount < 1) return;

            const cache = {};

            for (let i = 0; i < lineCount; i++) {
                const agreementId = rec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_rm_selecrebid',
                    line: i
                });

                if (!agreementId) continue;

                if (cache[agreementId] === undefined) {
                    cache[agreementId] = isExcluded(agreementId);
                }

                if (cache[agreementId]) {
                    rec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_rm_rebselection',
                        line: i,
                        value: false
                    });

                    log.audit({
                        title: `${MODULE}.beforeSubmit`,
                        details: { line: i, agreementId, action: 'desmarcado', flag: 'custrecord_giv_exclude_returns=T' }
                    });
                }
            }

        } catch (e) {
            log.error({
                title: `${MODULE}.beforeSubmit`,
                details: e
            });
        }
    };

    return { beforeSubmit };
});
