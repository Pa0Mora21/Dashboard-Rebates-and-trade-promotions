/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Reprocesamiento masivo de provisiones (Escenario 8) — UI.
 *
 *              Presenta formulario para seleccionar acuerdo y rango de fechas.
 *              Toda la lógica pesada se delega al Map/Reduce
 *              giv_mr_rebate_reprocess.js.
 */
define([
    'N/ui/serverWidget',
    'N/task',
    'N/runtime',
    'N/url',
    'N/search',
    'N/redirect',
    'N/log'
], (serverWidget, task, runtime, url, search, redirect, log) => {

    const MODULE = 'giv_sl_rebate_reprocess';
    const MR_SCRIPT_ID = 'customscript_giv_mr_reprocess';
    const MR_DEPLOY_ID = 'customdeploy_giv_mr_reprocess';

    // ──────────────────────────────────────────────
    //  FORMULARIO
    // ──────────────────────────────────────────────


    const renderForm = (context) => {
        const form = serverWidget.createForm({
            title: 'Reprocesamiento Masivo de Provisiones'
        });

        form.addField({
            id: 'custpage_agreement',
            type: serverWidget.FieldType.SELECT,
            label: 'Acuerdo de Reembolso',
            source: 'customrecord_rm_sales_transaction'
        }).isMandatory = true;

        form.addField({
            id: 'custpage_date_from',
            type: serverWidget.FieldType.DATE,
            label: 'Fecha Desde'
        }).isMandatory = true;

        form.addField({
            id: 'custpage_date_to',
            type: serverWidget.FieldType.DATE,
            label: 'Fecha Hasta'
        }).isMandatory = true;

        form.addSubmitButton({ label: 'Ejecutar Reprocesamiento' });
        context.response.writePage(form);
    };

    // ──────────────────────────────────────────────
    //  LANZAR MAP/REDUCE
    // ──────────────────────────────────────────────

    const handleSubmit = (context) => {
        try {
            const agreementId = context.request.parameters.custpage_agreement;
            const dateFrom = context.request.parameters.custpage_date_from;
            const dateTo = context.request.parameters.custpage_date_to;

            if (!agreementId || !dateFrom || !dateTo) {
                writeMessage(context, 'warning',
                    'Todos los campos son obligatorios.');
                return;
            }

            // Crear tarea Map/Reduce
            const mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: MR_SCRIPT_ID,
                deploymentId: MR_DEPLOY_ID,
                params: {
                    custscript_giv_reproc_agreement: agreementId,
                    custscript_giv_reproc_date_from: dateFrom,
                    custscript_giv_reproc_date_to: dateTo
                }
            });

            const taskId = mrTask.submit();

            // Obtener nombre del acuerdo
            let agreementName = agreementId;
            try {
                const agLookup = search.lookupFields({
                    type: 'customrecord_rm_sales_transaction',
                    id: agreementId,
                    columns: ['name']
                });
                agreementName = agLookup.name || agreementId;
            } catch (ignore) { /* si falla, usa el ID */ }

            log.audit({
                title: `${MODULE} | M/R LAUNCHED`,
                details: JSON.stringify({ taskId, agreementId, agreementName, dateFrom, dateTo })
            });

            // Redirigir a GET con parámetros para mostrar estatus con auto-refresh
            const statusUrl = url.resolveScript({
                scriptId: runtime.getCurrentScript().id,
                deploymentId: runtime.getCurrentScript().deploymentId,
                returnExternalUrl: false
            }) + '&taskId=' + taskId
              + '&agName=' + encodeURIComponent(agreementName)
              + '&dateFrom=' + encodeURIComponent(dateFrom)
              + '&dateTo=' + encodeURIComponent(dateTo);

            redirect.redirect({ url: statusUrl });

        } catch (e) {
            log.error({
                title: `${MODULE} | ERROR`,
                details: e.message || e
            });

            if (e.name === 'MAP_REDUCE_ALREADY_RUNNING') {
                writeMessage(context, 'warning',
                    'Ya hay un reprocesamiento en ejecución. Espere a que termine antes de lanzar otro.');
            } else {
                writeMessage(context, 'error', `Error: ${e.message}`);
            }
        }
    };

    // ──────────────────────────────────────────────
    //  PÁGINA DE ESTATUS (auto-refresh)
    // ──────────────────────────────────────────────

    const renderStatus = (context) => {
        const params = context.request.parameters;
        const taskId = params.taskId;
        const agreementName = params.agName || '';
        const dateFrom = params.dateFrom || '';
        const dateTo = params.dateTo || '';

        // Consultar estatus actual
        let taskStatus = 'PENDING';
        try {
            taskStatus = task.checkStatus({ taskId }).status;
        } catch (ignore) { }

        const statusConfig = {
            'PENDING':    { label: 'Pendiente',    color: '#ff9800', bg: '#fff3e0', icon: '\u23f3' },
            'PROCESSING': { label: 'Procesando',   color: '#1976d2', bg: '#e3f2fd', icon: '\ud83d\udd04' },
            'COMPLETE':   { label: 'Completado',   color: '#4caf50', bg: '#e8f5e9', icon: '\u2705' },
            'FAILED':     { label: 'Error',        color: '#f44336', bg: '#ffebee', icon: '\u274c' }
        };
        const sc = statusConfig[taskStatus] || statusConfig['PENDING'];
        const isRunning = (taskStatus === 'PENDING' || taskStatus === 'PROCESSING');

        const suiteletUrl = url.resolveScript({
            scriptId: runtime.getCurrentScript().id,
            deploymentId: runtime.getCurrentScript().deploymentId,
            returnExternalUrl: false
        });

        const title = isRunning ? 'Reprocesamiento en Progreso' : 'Reprocesamiento Finalizado';
        const heading = isRunning
            ? sc.icon + ' Proceso en ejecuci\u00f3n...'
            : (taskStatus === 'COMPLETE'
                ? sc.icon + ' Proceso completado exitosamente'
                : sc.icon + ' El proceso fall\u00f3');

        // Auto-refresh solo mientras corre
        const autoRefresh = isRunning
            ? '<meta http-equiv="refresh" content="10">'
            : '';

        const refreshNote = isRunning
            ? '<p style="color:#888;font-size:12px;margin-top:10px;">\ud83d\udd04 Esta p\u00e1gina se actualiza autom\u00e1ticamente cada 10 segundos</p>'
            : '';

        context.response.write(`
            <!DOCTYPE html>
            <html><head>${autoRefresh}</head><body>
            <div style="max-width:700px;margin:30px auto;padding:25px;
                        background:${sc.bg};border-left:4px solid ${sc.color};
                        border-radius:8px;font-family:Arial,sans-serif;">
                <h2 style="color:${sc.color};margin-top:0;">
                    ${heading}
                </h2>

                <table style="margin:15px 0;border-collapse:collapse;width:100%;">
                    <tr>
                        <td style="padding:8px 15px 8px 0;font-weight:bold;width:120px;">Acuerdo:</td>
                        <td style="padding:8px 0;">${agreementName}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 15px 8px 0;font-weight:bold;">Rango:</td>
                        <td style="padding:8px 0;">${dateFrom} \u2014 ${dateTo}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 15px 8px 0;font-weight:bold;">Estatus:</td>
                        <td style="padding:8px 0;">
                            <span style="display:inline-block;padding:4px 12px;
                                         background:${sc.color};color:white;
                                         border-radius:12px;font-size:13px;font-weight:600;">
                                ${sc.icon} ${sc.label}
                            </span>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:8px 15px 8px 0;font-weight:bold;">Task ID:</td>
                        <td style="padding:8px 0;font-family:monospace;font-size:12px;color:#666;">${taskId}</td>
                    </tr>
                </table>

                ${refreshNote}

                <div style="margin-top:20px;">
                    <a href="${suiteletUrl}"
                       style="padding:10px 20px;background:#1976d2;color:white;
                              text-decoration:none;border-radius:6px;
                              display:inline-block;font-weight:600;">
                        \u2190 Nuevo Reprocesamiento
                    </a>
                </div>
            </div>
            </body></html>
        `);
    };

    // ──────────────────────────────────────────────
    //  UI HELPERS
    // ──────────────────────────────────────────────

    const writeMessage = (context, type, message) => {
        const colors = {
            warning: { bg: '#fff3e0', border: '#ff9800', icon: '\u26a0\ufe0f' },
            error: { bg: '#ffebee', border: '#f44336', icon: '\u274c' },
            success: { bg: '#e8f5e9', border: '#4caf50', icon: '\u2705' }
        };
        const c = colors[type] || colors.warning;

        const suiteletUrl = url.resolveScript({
            scriptId: runtime.getCurrentScript().id,
            deploymentId: runtime.getCurrentScript().deploymentId,
            returnExternalUrl: false
        });

        context.response.write(`
            <div style="max-width:600px;margin:40px auto;padding:20px;
                        background:${c.bg};border-left:4px solid ${c.border};
                        border-radius:6px;font-family:Arial,sans-serif;">
                <h2>${c.icon} ${message}</h2>
                <div style="margin-top:15px;">
                    <a href="${suiteletUrl}"
                       style="padding:10px 20px;background:#1976d2;color:white;
                              text-decoration:none;border-radius:6px;
                              display:inline-block;">
                        \u2190 Volver
                    </a>
                </div>
            </div>
        `);
    };

    // ──────────────────────────────────────────────
    //  ENTRY POINT
    // ──────────────────────────────────────────────

    const onRequest = (context) => {
        if (context.request.method === 'GET') {
            // Si viene con taskId, mostrar página de estatus
            if (context.request.parameters.taskId) {
                renderStatus(context);
            } else {
                renderForm(context);
            }
        } else {
            handleSubmit(context);
        }
    };

    return { onRequest };
});
