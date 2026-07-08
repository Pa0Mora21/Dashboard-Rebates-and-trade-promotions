/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Interfaz para disparar el reprocesamiento masivo de provisiones (Escenario 8).
 *              Permite seleccionar un Acuerdo de Reembolso y rango de fechas,
 *              y ejecuta un Map/Reduce que hace Load/Save de facturas para forzar
 *              el recálculo nativo de Accruals.
 */
define([
    'N/ui/serverWidget',
    'N/task',
    'N/redirect',
    'N/log'
], (serverWidget, task, redirect, log) => {

    const MODULE = 'giv_sl_rebate_reprocess';

    const onRequest = (context) => {
        if (context.request.method === 'GET') {
            renderForm(context);
        } else {
            processReprocess(context);
        }
    };

    /**
     * Renderiza el formulario de reprocesamiento.
     */
    const renderForm = (context) => {
        const form = serverWidget.createForm({ title: 'Reprocesamiento Masivo de Provisiones' });

        const infoField = form.addField({
            id: 'custpage_info',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });
        infoField.defaultValue = `
            <div style="margin: 10px 0; padding: 15px; background: #fff3e0; border-radius: 6px; border-left: 4px solid #ff9800;">
                <h3 style="margin-top:0;">⚠️ Reprocesamiento de Provisiones</h3>
                <p>Esta utilería re-procesa facturas de venta para forzar el recálculo de provisiones de rebate (Accruals) 
                cuando las condiciones del acuerdo han cambiado retroactivamente.</p>
                <p><strong>Proceso:</strong> El sistema realizará un Load/Save de cada factura encontrada, 
                lo que disparará automáticamente la actualización de los Accruals con los nuevos porcentajes del acuerdo.</p>
            </div>
        `;

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

    /**
     * Dispara el Map/Reduce de reprocesamiento.
     */
    const processReprocess = (context) => {
        try {
            const agreementId = context.request.parameters.custpage_agreement;
            const dateFrom = context.request.parameters.custpage_date_from;
            const dateTo = context.request.parameters.custpage_date_to;

            const mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: '_giv_mr_rebate_reprocess',
                deploymentId: '_giv_dep_mr_reprocess',
                params: {
                    custscript_giv_reprocess_agreement: agreementId,
                    custscript_giv_reprocess_date_from: dateFrom,
                    custscript_giv_reprocess_date_to: dateTo
                }
            });

            const mrTaskId = mrTask.submit();

            log.audit({
                title: `${MODULE}.processReprocess`,
                details: `Started reprocess M/R. Task: ${mrTaskId}, Agreement: ${agreementId}, Range: ${dateFrom} - ${dateTo}`
            });

            // Mostrar confirmación
            const form = serverWidget.createForm({ title: 'Reprocesamiento Iniciado' });

            const confirmField = form.addField({
                id: 'custpage_confirm',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            confirmField.defaultValue = `
                <div style="padding: 20px; background: #e8f5e9; border-radius: 8px; margin: 15px 0;">
                    <h3 style="color: #2e7d32; margin-top: 0;">✅ Reprocesamiento iniciado exitosamente</h3>
                    <p><strong>Task ID:</strong> ${mrTaskId}</p>
                    <p><strong>Acuerdo:</strong> ${agreementId}</p>
                    <p><strong>Rango:</strong> ${dateFrom} — ${dateTo}</p>
                    <p>El proceso se ejecuta en segundo plano. Puede verificar el avance en la sección de Map/Reduce Scripts de NetSuite.</p>
                </div>
            `;

            context.response.writePage(form);

        } catch (e) {
            log.error({ title: `${MODULE}.processReprocess`, details: e.message });

            const form = serverWidget.createForm({ title: 'Error en Reprocesamiento' });
            const errorField = form.addField({
                id: 'custpage_error',
                type: serverWidget.FieldType.LONGTEXT,
                label: 'Error'
            });
            errorField.defaultValue = e.message;
            errorField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            context.response.writePage(form);
        }
    };

    return { onRequest };
});
