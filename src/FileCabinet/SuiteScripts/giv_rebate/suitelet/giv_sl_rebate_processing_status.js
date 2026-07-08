/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Pantalla de monitoreo del estado de procesamiento de liquidaciones.
 *              Muestra registros WORK con su estado actual y avance del lote.
 */
define([
    'N/ui/serverWidget',
    'N/search',
    'N/task',
    'N/log'
], (serverWidget, search, task, log) => {

    const MODULE = 'giv_sl_rebate_processing_status';

    const onRequest = (context) => {
        try {
            const params = context.request.parameters;
            const mrTaskId = params.custpage_mr_task_id || '';
            const batchId = params.custpage_batch_id || '';

            const form = serverWidget.createForm({ title: 'Estado de Procesamiento de Liquidaciones' });

            // ── Información del lote ──
            const infoGroup = form.addFieldGroup({ id: 'custpage_info_group', label: 'Información del Lote' });

            const taskIdField = form.addField({
                id: 'custpage_task_id_display',
                type: serverWidget.FieldType.TEXT,
                label: 'Task ID',
                container: 'custpage_info_group'
            });
            taskIdField.defaultValue = mrTaskId;
            taskIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

            let taskStatus = 'N/A';
            if (mrTaskId) {
                try {
                    const mrStatus = task.checkStatus({ taskId: mrTaskId });
                    taskStatus = mrStatus.status;
                } catch (tsErr) {
                    taskStatus = 'No disponible';
                }
            }

            const statusField = form.addField({
                id: 'custpage_task_status',
                type: serverWidget.FieldType.TEXT,
                label: 'Estado del Proceso',
                container: 'custpage_info_group'
            });
            statusField.defaultValue = taskStatus;
            statusField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

            // ── Resumen de contadores ──
            const counters = getStatusCounters(batchId);

            const summaryField = form.addField({
                id: 'custpage_summary',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });

            summaryField.defaultValue = `
                <div style="display: flex; gap: 20px; margin: 15px 0;">
                    <div style="padding: 15px; background: #e8f4fd; border-radius: 8px; text-align: center; min-width: 120px;">
                        <div style="font-size: 24px; font-weight: bold; color: #0070d2;">${counters.captured}</div>
                        <div>Capturados</div>
                    </div>
                    <div style="padding: 15px; background: #fff8e1; border-radius: 8px; text-align: center; min-width: 120px;">
                        <div style="font-size: 24px; font-weight: bold; color: #ff9800;">${counters.processing}</div>
                        <div>Procesando</div>
                    </div>
                    <div style="padding: 15px; background: #e8f5e9; border-radius: 8px; text-align: center; min-width: 120px;">
                        <div style="font-size: 24px; font-weight: bold; color: #4caf50;">${counters.completed}</div>
                        <div>Completados</div>
                    </div>
                    <div style="padding: 15px; background: #ffebee; border-radius: 8px; text-align: center; min-width: 120px;">
                        <div style="font-size: 24px; font-weight: bold; color: #f44336;">${counters.error}</div>
                        <div>Errores</div>
                    </div>
                </div>
            `;

            // ── Sublista de registros WORK ──
            const workSublist = form.addSublist({
                id: 'custpage_work_sublist',
                type: serverWidget.SublistType.LIST,
                label: 'Detalle de Registros'
            });

            workSublist.addField({ id: 'custpage_wk_id', type: serverWidget.FieldType.TEXT, label: 'Work ID' });
            workSublist.addField({ id: 'custpage_wk_status', type: serverWidget.FieldType.TEXT, label: 'Estado' });
            workSublist.addField({ id: 'custpage_wk_customer', type: serverWidget.FieldType.TEXT, label: 'Cliente' });
            workSublist.addField({ id: 'custpage_wk_agreement', type: serverWidget.FieldType.TEXT, label: 'Acuerdo' });
            workSublist.addField({ id: 'custpage_wk_invoice', type: serverWidget.FieldType.TEXT, label: 'Factura Origen' });
            workSublist.addField({ id: 'custpage_wk_item', type: serverWidget.FieldType.TEXT, label: 'Artículo' });
            workSublist.addField({ id: 'custpage_wk_amount', type: serverWidget.FieldType.CURRENCY, label: 'Monto' });
            workSublist.addField({ id: 'custpage_wk_transaction', type: serverWidget.FieldType.TEXT, label: 'Transacción Generada' });
            workSublist.addField({ id: 'custpage_wk_error', type: serverWidget.FieldType.TEXT, label: 'Error' });

            populateWorkSublist(workSublist, batchId);

            form.addButton({
                id: 'custpage_refresh',
                label: 'Actualizar Estado',
                functionName: `window.location.reload()`
            });

            form.addButton({
                id: 'custpage_back_dashboard',
                label: 'Regresar al Dashboard',
                functionName: `window.location.href = '/app/site/hosting/scriptlet.nl?script=_giv_sl_rebate_dashboard&deploy=_giv_dep_rebate_dashboard'`
            });

            context.response.writePage(form);

        } catch (e) {
            log.error({ title: `${MODULE}.onRequest`, details: e.message });
            throw e;
        }
    };

    /**
     * Obtiene contadores agrupados por estado.
     */
    const getStatusCounters = (batchId) => {
        const counters = { captured: 0, validated: 0, processing: 0, completed: 0, error: 0 };

        try {
            const filters = [];
            if (batchId) {
                filters.push(['custrecord_giv_liq_work_csv_batch_id', 'is', batchId]);
            }

            const counterSearch = search.create({
                type: 'customrecord_giv_rebate_liq_work',
                filters: filters.length > 0 ? filters : [],
                columns: [
                    search.createColumn({ name: 'custrecord_giv_liq_work_processing_status', summary: search.Summary.GROUP }),
                    search.createColumn({ name: 'internalid', summary: search.Summary.COUNT })
                ]
            });

            counterSearch.run().each((result) => {
                const status = result.getValue({ name: 'custrecord_giv_liq_work_processing_status', summary: search.Summary.GROUP });
                const count = parseInt(result.getValue({ name: 'internalid', summary: search.Summary.COUNT })) || 0;

                switch (status) {
                    case 'Capturado': counters.captured = count; break;
                    case 'Validado': counters.validated = count; break;
                    case 'Procesando': counters.processing = count; break;
                    case 'Completado': counters.completed = count; break;
                    case 'Error': counters.error = count; break;
                }
                return true;
            });

        } catch (e) {
            log.error({ title: `${MODULE}.getStatusCounters`, details: e.message });
        }

        return counters;
    };

    /**
     * Puebla la sublista con registros WORK recientes.
     */
    const populateWorkSublist = (sublist, batchId) => {
        try {
            const filters = [];
            if (batchId) {
                filters.push(['custrecord_giv_liq_work_csv_batch_id', 'is', batchId]);
            }

            const workSearch = search.create({
                type: 'customrecord_giv_rebate_liq_work',
                filters: filters.length > 0 ? filters : [],
                columns: [
                    search.createColumn({ name: 'internalid', sort: search.Sort.DESC }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_processing_status' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_customer' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_agreement' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_source_invoice' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_source_item' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_amount_to_settle' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_processed_transaction' }),
                    search.createColumn({ name: 'custrecord_giv_liq_work_error_message' })
                ]
            });

            let lineIndex = 0;
            workSearch.run().each((result) => {
                if (lineIndex >= 500) return false;

                sublist.setSublistValue({ id: 'custpage_wk_id', line: lineIndex, value: result.getValue('internalid') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_status', line: lineIndex, value: result.getText('custrecord_giv_liq_work_processing_status') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_customer', line: lineIndex, value: result.getText('custrecord_giv_liq_work_customer') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_agreement', line: lineIndex, value: result.getText('custrecord_giv_liq_work_agreement') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_invoice', line: lineIndex, value: result.getText('custrecord_giv_liq_work_source_invoice') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_item', line: lineIndex, value: result.getText('custrecord_giv_liq_work_source_item') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_amount', line: lineIndex, value: result.getValue('custrecord_giv_liq_work_amount_to_settle') || '0.00' });
                sublist.setSublistValue({ id: 'custpage_wk_transaction', line: lineIndex, value: result.getText('custrecord_giv_liq_work_processed_transaction') || '' });
                sublist.setSublistValue({ id: 'custpage_wk_error', line: lineIndex, value: result.getValue('custrecord_giv_liq_work_error_message') || '' });

                lineIndex++;
                return true;
            });

        } catch (e) {
            log.error({ title: `${MODULE}.populateWorkSublist`, details: e.message });
        }
    };

    return { onRequest };
});
