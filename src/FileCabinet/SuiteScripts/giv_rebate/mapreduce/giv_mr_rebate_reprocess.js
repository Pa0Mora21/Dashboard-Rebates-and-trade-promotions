/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * @description Reprocesamiento masivo de provisiones (Escenario 8).
 *              Realiza Load/Save de facturas asociadas a un Rebate Agreement
 *              dentro de un rango de fechas para forzar el recálculo nativo de Accruals
 *              cuando las condiciones del acuerdo han cambiado retroactivamente.
 *
 * Parámetros de Script:
 * - custscript_giv_reprocess_agreement: Internal ID del Rebate Agreement
 * - custscript_giv_reprocess_date_from: Fecha inicio
 * - custscript_giv_reprocess_date_to: Fecha fin
 */
define([
    'N/search',
    'N/record',
    'N/runtime',
    'N/log'
], (search, record, runtime, log) => {

    const MODULE = 'giv_mr_rebate_reprocess';

    /**
     * getInputData — Busca facturas de venta vinculadas al Rebate Agreement
     * en el rango de fechas especificado.
     */
    const getInputData = () => {
        const script = runtime.getCurrentScript();
        const agreementId = script.getParameter({ name: 'custscript_giv_reprocess_agreement' });
        const dateFrom = script.getParameter({ name: 'custscript_giv_reprocess_date_from' });
        const dateTo = script.getParameter({ name: 'custscript_giv_reprocess_date_to' });

        log.audit({
            title: `${MODULE}.getInputData`,
            details: `Agreement: ${agreementId}, Range: ${dateFrom} - ${dateTo}`
        });

        if (!agreementId || !dateFrom || !dateTo) {
            log.error({
                title: `${MODULE}.getInputData`,
                details: 'Faltan parámetros obligatorios: acuerdo, fecha desde o fecha hasta'
            });
            return [];
        }

        // Buscar facturas que tienen provisiones (Accruals) para este acuerdo
        return search.create({
            type: 'customtransaction_rm_rebate_accrual',
            filters: [
                ['custbody_rm_rebate_agreement', 'anyof', agreementId],
                'AND',
                ['trandate', 'within', dateFrom, dateTo],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'custbody_rm_source_transaction' }),
                search.createColumn({ name: 'internalid' })
            ]
        });
    };

    /**
     * map — Extrae el ID de la factura origen para evitar duplicados.
     * Key = invoiceId (deduplicación natural en reduce).
     */
    const map = (context) => {
        try {
            const searchResult = JSON.parse(context.value);
            const invoiceId = searchResult.values?.custbody_rm_source_transaction?.value
                || searchResult.values?.custbody_rm_source_transaction
                || '';

            if (invoiceId) {
                context.write({
                    key: invoiceId,
                    value: JSON.stringify({
                        invoiceId: invoiceId,
                        accrualId: searchResult.id
                    })
                });
            }

        } catch (e) {
            log.error({
                title: `${MODULE}.map`,
                details: `[Key=${context.key}] ${e.message || e}`
            });
        }
    };

    /**
     * reduce — Realiza Load/Save de cada factura para forzar el recálculo nativo.
     * Una factura puede tener múltiples accruals, pero solo se hace Load/Save una vez.
     */
    const reduce = (context) => {
        const invoiceId = context.key;

        try {
            // Verificar governance
            const remainingUsage = runtime.getCurrentScript().getRemainingUsage();
            if (remainingUsage < 200) {
                log.audit({
                    title: `${MODULE}.reduce`,
                    details: `Low governance (${remainingUsage}). Skipping invoice ${invoiceId}`
                });
                return;
            }

            // Load/Save de la factura — esto dispara el User Event nativo de R&TP
            // que recalcula los Accruals con las condiciones actuales del acuerdo
            const invoiceRec = record.load({
                type: record.Type.INVOICE,
                id: invoiceId,
                isDynamic: true
            });

            invoiceRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.audit({
                title: `${MODULE}.reduce`,
                details: `Reprocessed invoice ${invoiceId}. Accruals should recalculate.`
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.reduce`,
                details: `[Invoice=${invoiceId}] ${e.message || e}`
            });
        }
    };

    /**
     * summarize — Log de resultados del reprocesamiento.
     */
    const summarize = (summary) => {
        let processedCount = 0;
        let errorCount = 0;

        summary.output.iterator().each(() => {
            processedCount++;
            return true;
        });

        if (summary.reduceSummary.errors) {
            summary.reduceSummary.errors.iterator().each((key, error) => {
                log.error({ title: `${MODULE}.summarize.reduceError`, details: `Invoice: ${key}. Error: ${error}` });
                errorCount++;
                return true;
            });
        }

        log.audit({
            title: `${MODULE}.summarize`,
            details: `Reprocessing complete. Invoices processed: ${processedCount}. Errors: ${errorCount}. Usage: ${summary.usage}`
        });
    };

    return { getInputData, map, reduce, summarize };
});
