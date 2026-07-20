/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Pantalla de monitoreo del estado de procesamiento de liquidaciones.
 *              Muestra registros WORK con su estado actual, avance del lote, errores
 *              y transacciones generadas. Incluye auto-refresh mientras el MR corre.
 *              DRD Sección 5 – Generación de Liquidación / Estado de Procesamiento.
 */
define([
    'N/ui/serverWidget',
    'N/search',
    'N/task',
    'N/url',
    'N/log'
], (serverWidget, search, task, url, log) => {

    const MODULE = 'giv_sl_rebate_processing_status';

    const onRequest = (context) => {
        try {
            const params       = context.request.parameters;
            const mrTaskId     = params.custpage_mr_task_id || '';
            const batchId      = params.custpage_batch_id   || '';
            const filterErrors = params.custpage_only_errors === 'T';

            const form = serverWidget.createForm({ title: 'Estado de Procesamiento — Liquidación de Rebates' });

            // ── URL del Dashboard generada correctamente con N/url ──────────────
            const dashboardUrl = url.resolveScript({
                scriptId:          'customscript_giv_sl_rebate_dashboard',
                deploymentId:      'customdeploy_giv_sl_dashboard',
                returnExternalUrl: false
            });

            // ── Estado del MR Task ──────────────────────────────────────────────
            let taskStatus    = 'N/A';
            let taskIsPending = false;

            if (mrTaskId) {
                try {
                    const mrStatus = task.checkStatus({ taskId: mrTaskId });
                    taskStatus     = mrStatus.status;
                    taskIsPending  = ['PENDING', 'PROCESSING'].includes(taskStatus);
                } catch (tsErr) {
                    taskStatus = 'No disponible';
                }
            }

            // ── Auto-refresh cuando el MR sigue corriendo ──────────────────────
            if (taskIsPending) {
                const refreshUrl = url.resolveScript({
                    scriptId:          'customscript_giv_sl_rebate_status',
                    deploymentId:      'customdeploy_giv_sl_status',
                    params: { custpage_mr_task_id: mrTaskId, custpage_batch_id: batchId },
                    returnExternalUrl: false
                });
                const autoFld = form.addField({ id: 'custpage_autorefresh', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
                autoFld.defaultValue = `
                    <script>setTimeout(function(){ window.location.href='${refreshUrl}'; }, 8000);</script>
                    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 16px;margin:8px 0;font-size:13px;">
                        ⏳ <strong>El proceso está corriendo.</strong> Esta pantalla se actualizará automáticamente en 8 segundos...
                    </div>`;
            }

            // ── Grupo de información del lote ──────────────────────────────────
            form.addFieldGroup({ id: 'custpage_info_group', label: 'Información del Lote' });

            const taskIdFld = form.addField({ id: 'custpage_task_id_display', type: serverWidget.FieldType.TEXT, label: 'Task ID', container: 'custpage_info_group' });
            taskIdFld.defaultValue = mrTaskId || '—';
            taskIdFld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

            const statusFld = form.addField({ id: 'custpage_task_status', type: serverWidget.FieldType.TEXT, label: 'Estado del MR', container: 'custpage_info_group' });
            statusFld.defaultValue = taskStatus;
            statusFld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

            const batchFld = form.addField({ id: 'custpage_batch_display', type: serverWidget.FieldType.TEXT, label: 'Batch ID', container: 'custpage_info_group' });
            batchFld.defaultValue = batchId || '—';
            batchFld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

            // ── Contadores y barra de progreso ─────────────────────────────────
            const counters = getStatusCounters(batchId);
            const total    = counters.captured + counters.processing + counters.completed + counters.error + counters.validated;
            const pctDone  = total > 0 ? Math.round(((counters.completed + counters.error) / total) * 100) : 0;
            const pctOk    = total > 0 ? Math.round((counters.completed / total) * 100) : 0;

            const summaryFld = form.addField({ id: 'custpage_summary', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            summaryFld.defaultValue = `
                <style>
                    .giv-cards{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 8px 0}
                    .giv-card{padding:12px 18px;border-radius:4px;text-align:center;min-width:100px;
                              background:#f7f7f7;border:1px solid #ddd;}
                    .giv-card .num{font-size:26px;font-weight:600;color:#2c2c2c;line-height:1.2}
                    .giv-card .lbl{font-size:11px;color:#666;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
                    .giv-progress{margin:12px 0 4px 0}
                    .giv-bar-bg{background:#e8e8e8;border-radius:3px;height:10px;overflow:hidden;border:1px solid #d0d0d0}
                    .giv-bar-fill{height:100%;background:#555;border-radius:3px}
                    .giv-totals{font-size:12px;color:#555;margin-top:6px}
                </style>
                <div class="giv-cards">
                    <div class="giv-card"><div class="num">${counters.captured}</div><div class="lbl">Capturado</div></div>
                    <div class="giv-card"><div class="num">${counters.validated}</div><div class="lbl">Validado</div></div>
                    <div class="giv-card"><div class="num">${counters.processing}</div><div class="lbl">Procesando</div></div>
                    <div class="giv-card"><div class="num">${counters.completed}</div><div class="lbl">Completado</div></div>
                    <div class="giv-card"><div class="num">${counters.error}</div><div class="lbl">Error</div></div>
                    <div class="giv-card" style="background:#efefef"><div class="num">${total}</div><div class="lbl">Total</div></div>
                </div>
                <div class="giv-progress">
                    <div class="giv-bar-bg">
                        <div class="giv-bar-fill" style="width:${pctDone}%"></div>
                    </div>
                    <div class="giv-totals">
                        Progreso: <strong>${pctDone}%</strong> &nbsp;|&nbsp;
                        Completados: <strong>${pctOk}%</strong> &nbsp;|&nbsp;
                        Monto Completado: <strong>$${counters.completedAmt}</strong> &nbsp;|&nbsp;
                        Monto en Error: <strong>$${counters.errorAmt}</strong>
                    </div>
                </div>`;

            // ── Sublista de registros WORK ──────────────────────────────────────
            const workSublist = form.addSublist({
                id:    'custpage_work_sublist',
                type:  serverWidget.SublistType.LIST,
                label: 'Detalle de Registros' + (filterErrors ? ' — Solo Errores' : '')
            });

            workSublist.addField({ id: 'custpage_wk_id',         type: serverWidget.FieldType.TEXT,     label: 'Work ID' });
            workSublist.addField({ id: 'custpage_wk_status',      type: serverWidget.FieldType.TEXT,     label: 'Estado' });
            workSublist.addField({ id: 'custpage_wk_scenario',    type: serverWidget.FieldType.TEXT,     label: 'Escenario' });
            workSublist.addField({ id: 'custpage_wk_type',        type: serverWidget.FieldType.TEXT,     label: 'Tipo Liq.' });
            workSublist.addField({ id: 'custpage_wk_customer',    type: serverWidget.FieldType.TEXT,     label: 'Cliente' });
            workSublist.addField({ id: 'custpage_wk_agreement',   type: serverWidget.FieldType.TEXT,     label: 'Acuerdo' });
            workSublist.addField({ id: 'custpage_wk_invoice',     type: serverWidget.FieldType.TEXT,     label: 'Factura Origen' });
            workSublist.addField({ id: 'custpage_wk_item',        type: serverWidget.FieldType.TEXT,     label: 'Artículo' });
            workSublist.addField({ id: 'custpage_wk_amount',      type: serverWidget.FieldType.CURRENCY, label: 'Monto a Liquidar' });
            workSublist.addField({ id: 'custpage_wk_invoice_to',  type: serverWidget.FieldType.TEXT,     label: 'Factura Destino' });
            workSublist.addField({ id: 'custpage_wk_apply_amt',   type: serverWidget.FieldType.CURRENCY, label: 'Monto a Aplicar' });
            workSublist.addField({ id: 'custpage_wk_transaction', type: serverWidget.FieldType.TEXT,     label: 'Transacción Generada' });
            workSublist.addField({ id: 'custpage_wk_error',       type: serverWidget.FieldType.TEXT,     label: 'Mensaje de Error' });

            populateWorkSublist(workSublist, batchId, filterErrors);

            // ── Botones ─────────────────────────────────────────────────────────
            const currentPageUrl = url.resolveScript({
                scriptId:          'customscript_giv_sl_rebate_status',
                deploymentId:      'customdeploy_giv_sl_status',
                params:            { custpage_mr_task_id: mrTaskId, custpage_batch_id: batchId },
                returnExternalUrl: false
            });

            form.addButton({
                id:           'custpage_refresh',
                label:        '↻ Actualizar Estado',
                functionName: `window.location.href='${currentPageUrl}'`
            });

            if (counters.error > 0) {
                const errorsUrl = url.resolveScript({
                    scriptId:          'customscript_giv_sl_rebate_status',
                    deploymentId:      'customdeploy_giv_sl_status',
                    params:            { custpage_mr_task_id: mrTaskId, custpage_batch_id: batchId, custpage_only_errors: 'T' },
                    returnExternalUrl: false
                });
                form.addButton({
                    id:           'custpage_filter_errors',
                    label:        filterErrors ? 'Ver Todos' : `⚠ Ver Solo Errores (${counters.error})`,
                    functionName: filterErrors
                        ? `window.location.href='${currentPageUrl}'`
                        : `window.location.href='${errorsUrl}'`
                });
            }

            // ── Botón Regresar — URL correcta generada con N/url ───────────────
            form.addButton({
                id:           'custpage_back_dashboard',
                label:        '← Regresar al Dashboard',
                functionName: `window.location.href='${dashboardUrl}'`
            });

            context.response.writePage(form);

        } catch (e) {
            log.error({ title: `${MODULE}.onRequest`, details: e.message || e });
            throw e;
        }
    };

    /**
     * Contadores por estado + totales de monto (SUM).
     */
    const getStatusCounters = (batchId) => {
        const counters = { captured: 0, validated: 0, processing: 0, completed: 0, error: 0, completedAmt: '0.00', errorAmt: '0.00' };
        try {
            const filters = [['isinactive', 'is', 'F']];
            if (batchId) filters.push('AND', ['custrecord_giv_lw_csv_batch_id', 'is', batchId]);

            search.create({
                type:    'customrecord_giv_rebate_liq_work',
                filters: filters,
                columns: [
                    search.createColumn({ name: 'custrecord_giv_lw_proc_status',  summary: search.Summary.GROUP }),
                    search.createColumn({ name: 'internalid',                      summary: search.Summary.COUNT }),
                    search.createColumn({ name: 'custrecord_giv_lw_amt_to_settle', summary: search.Summary.SUM })
                ]
            }).run().each((result) => {
                const status = result.getValue({ name: 'custrecord_giv_lw_proc_status',  summary: search.Summary.GROUP });
                const count  = parseInt(result.getValue({ name: 'internalid',            summary: search.Summary.COUNT })) || 0;
                const amount = parseFloat(result.getValue({ name: 'custrecord_giv_lw_amt_to_settle', summary: search.Summary.SUM })) || 0;
                switch (status) {
                    case 'Capturado':  counters.captured   = count; break;
                    case 'Validado':   counters.validated  = count; break;
                    case 'Procesando': counters.processing = count; break;
                    case 'Completado': counters.completed  = count; counters.completedAmt = amount.toFixed(2); break;
                    case 'Error':      counters.error      = count; counters.errorAmt     = amount.toFixed(2); break;
                }
                return true;
            });
        } catch (e) {
            log.error({ title: `${MODULE}.getStatusCounters`, details: e.message || e });
        }
        return counters;
    };

    /**
     * Puebla la sublista con los campos del DRD:
     * Estado, Escenario, Tipo Liquidación (CM / VB), Cliente, Acuerdo,
     * Factura Origen, Artículo, Monto a Liquidar, Factura Destino,
     * Monto a Aplicar, Transacción Generada, Mensaje de Error.
     */
    const populateWorkSublist = (sublist, batchId, filterErrors) => {
        try {
            const filters = [['isinactive', 'is', 'F']];
            if (batchId)      filters.push('AND', ['custrecord_giv_lw_csv_batch_id', 'is', batchId]);
            if (filterErrors) filters.push('AND', ['custrecord_giv_lw_proc_status',  'is', 'Error']);

            const SETTLE_LABEL = { '1': 'Vendor Bill', '3': 'Credit Memo' };

            let lineIndex = 0;
            search.create({
                type:    'customrecord_giv_rebate_liq_work',
                filters: filters,
                columns: [
                    search.createColumn({ name: 'internalid',                       sort: search.Sort.DESC }),
                    search.createColumn({ name: 'custrecord_giv_lw_proc_status' }),
                    search.createColumn({ name: 'custrecord_giv_lw_scenario' }),
                    search.createColumn({ name: 'custrecord_giv_lw_settle_method' }),
                    search.createColumn({ name: 'custrecord_giv_lw_customer' }),
                    search.createColumn({ name: 'custrecord_giv_lw_agreement' }),
                    search.createColumn({ name: 'custrecord_giv_lw_source_invoice' }),
                    search.createColumn({ name: 'custrecord_giv_lw_source_item' }),
                    search.createColumn({ name: 'custrecord_giv_lw_amt_to_settle' }),
                    search.createColumn({ name: 'custrecord_giv_lw_invoice_to' }),
                    search.createColumn({ name: 'custrecord_giv_lw_apply_amount' }),
                    search.createColumn({ name: 'custrecord_giv_lw_processed_tran' }),
                    search.createColumn({ name: 'custrecord_giv_lw_error_message' })
                ]
            }).run().each((result) => {
                if (lineIndex >= 500) return false;

                const settleMethod = result.getValue('custrecord_giv_lw_settle_method') || '';
                const invTo        = result.getText('custrecord_giv_lw_invoice_to')     || '';
                const applyAmt     = result.getValue('custrecord_giv_lw_apply_amount')  || '';
                const txnText      = result.getText('custrecord_giv_lw_processed_tran') || '';
                const errMsg       = result.getValue('custrecord_giv_lw_error_message') || '';

                sublist.setSublistValue({ id: 'custpage_wk_id',        line: lineIndex, value: result.getValue('internalid')                        || '' });
                sublist.setSublistValue({ id: 'custpage_wk_status',    line: lineIndex, value: result.getText('custrecord_giv_lw_proc_status')       || '' });
                sublist.setSublistValue({ id: 'custpage_wk_scenario',  line: lineIndex, value: result.getValue('custrecord_giv_lw_scenario')         || '' });
                sublist.setSublistValue({ id: 'custpage_wk_type',      line: lineIndex, value: SETTLE_LABEL[settleMethod] || settleMethod });
                sublist.setSublistValue({ id: 'custpage_wk_customer',  line: lineIndex, value: result.getText('custrecord_giv_lw_customer')          || '' });
                sublist.setSublistValue({ id: 'custpage_wk_agreement', line: lineIndex, value: result.getText('custrecord_giv_lw_agreement')         || '' });
                sublist.setSublistValue({ id: 'custpage_wk_invoice',   line: lineIndex, value: result.getText('custrecord_giv_lw_source_invoice')    || '' });
                sublist.setSublistValue({ id: 'custpage_wk_item',      line: lineIndex, value: result.getText('custrecord_giv_lw_source_item')       || '' });
                sublist.setSublistValue({ id: 'custpage_wk_amount',    line: lineIndex, value: result.getValue('custrecord_giv_lw_amt_to_settle')    || '0' });

                if (invTo)    sublist.setSublistValue({ id: 'custpage_wk_invoice_to', line: lineIndex, value: invTo });
                if (applyAmt) sublist.setSublistValue({ id: 'custpage_wk_apply_amt',  line: lineIndex, value: applyAmt });
                if (txnText)  sublist.setSublistValue({ id: 'custpage_wk_transaction', line: lineIndex, value: txnText });
                if (errMsg)   sublist.setSublistValue({ id: 'custpage_wk_error',       line: lineIndex, value: errMsg.substring(0, 300) });

                lineIndex++;
                return true;
            });

        } catch (e) {
            log.error({ title: `${MODULE}.populateWorkSublist`, details: e.message || e });
        }
    };

    return { onRequest };
});
