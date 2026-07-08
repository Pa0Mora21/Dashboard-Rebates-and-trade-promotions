/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Suitelet para carga masiva de liquidaciones mediante archivo CSV.
 *              Valida cada fila, crea registros WORK y dispara Map/Reduce.
 *              Aplica regla de Partial Success (errores individuales no detienen el lote).
 */
define([
    'N/ui/serverWidget',
    'N/file',
    'N/task',
    'N/redirect',
    'N/log',
    '../lib/giv_rebate_validator',
    '../lib/giv_rebate_transaction_builder',
    '../lib/giv_rebate_dao'
], (serverWidget, file, task, redirect, log, validator, txnBuilder, dao) => {

    const MODULE = 'giv_sl_rebate_csv_upload';

    const onRequest = (context) => {
        if (context.request.method === 'GET') {
            renderUploadForm(context);
        } else {
            processUpload(context);
        }
    };

    /**
     * Renderiza el formulario de carga de CSV.
     */
    const renderUploadForm = (context) => {
        const form = serverWidget.createForm({ title: 'Carga Masiva de Liquidaciones — CSV' });

        form.addField({
            id: 'custpage_csv_file',
            type: serverWidget.FieldType.FILE,
            label: 'Archivo CSV'
        }).isMandatory = true;

        // Instrucciones inline
        const instructionsField = form.addField({
            id: 'custpage_instructions',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });
        instructionsField.defaultValue = `
            <div style="margin: 10px 0; padding: 15px; background: #f0f4f8; border-radius: 6px; border-left: 4px solid #0070d2;">
                <h3 style="margin-top:0;">Formato del CSV</h3>
                <p>El archivo debe contener las siguientes columnas (separadas por coma):</p>
                <table style="border-collapse: collapse; width: 100%;">
                    <tr style="background: #e0e7ef;"><th style="padding:6px; text-align:left;">Columna</th><th style="padding:6px; text-align:left;">Descripción</th><th style="padding:6px; text-align:left;">Obligatorio</th></tr>
                    <tr><td style="padding:4px;">External ID</td><td style="padding:4px;">Identificador de agrupación de la liquidación</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Cliente (Internal ID)</td><td style="padding:4px;">ID del cliente</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Agreement (Internal ID)</td><td style="padding:4px;">ID del acuerdo de reembolso</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Tipo de liquidación</td><td style="padding:4px;">1=Estándar, 2=Consolidada, 3=Específica, 4=Cobro en exceso, 5=Agrupación</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Factura Origen (Internal ID)</td><td style="padding:4px;">Factura que genera la provisión</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Artículo (Internal ID)</td><td style="padding:4px;">Material del reembolso</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Monto a Liquidar</td><td style="padding:4px;">Importe antes de impuestos</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Factura Destino (Internal ID)</td><td style="padding:4px;">Factura para aplicar CM</td><td style="padding:4px;">Según método</td></tr>
                    <tr><td style="padding:4px;">Monto a Aplicar</td><td style="padding:4px;">Monto sin impuestos a aplicar</td><td style="padding:4px;">Según método</td></tr>
                </table>
            </div>
        `;

        form.addSubmitButton({ label: 'Cargar y Procesar CSV' });

        context.response.writePage(form);
    };

    /**
     * Procesa el archivo CSV cargado.
     * Regla de Partial Success: errores individuales no detienen el lote.
     */
    const processUpload = (context) => {
        try {
            const csvFile = context.request.files.custpage_csv_file;
            if (!csvFile) {
                renderResultPage(context, 0, 0, ['No se recibió archivo CSV.']);
                return;
            }

            const csvContent = csvFile.getContents();
            const rows = csvContent.split('\n').filter(r => r.trim().length > 0);

            if (rows.length < 2) {
                renderResultPage(context, 0, 0, ['El archivo CSV está vacío o solo contiene encabezados.']);
                return;
            }

            const batchId = `CSV_${new Date().getTime()}_${runtime.getCurrentUser().id}`;
            let successCount = 0;
            let errorCount = 0;
            const errors = [];

            // Saltar header (fila 0)
            for (let i = 1; i < rows.length; i++) {
                try {
                    const cols = rows[i].split(',').map(c => c.trim().replace(/"/g, ''));

                    const rowData = {
                        externalId: cols[0] || '',
                        customerId: cols[1] || '',
                        agreementId: cols[2] || '',
                        scenario: cols[3] || '',
                        sourceInvoiceId: cols[4] || '',
                        itemId: cols[5] || '',
                        amountToSettle: cols[6] || '',
                        invoiceTo: cols[7] || '',
                        applyAmount: cols[8] || ''
                    };

                    // Obtener método de liquidación del acuerdo
                    let settlementMethod = '';
                    try {
                        const agreementDetails = dao.getAgreementDetails(rowData.agreementId);
                        settlementMethod = agreementDetails.settlementMethod;
                        rowData.settlementMethod = settlementMethod;
                    } catch (agErr) {
                        errors.push(`Fila ${i + 1}: No se pudo obtener el acuerdo ${rowData.agreementId}. ${agErr.message}`);
                        errorCount++;
                        continue;
                    }

                    // Validar fila
                    const rowValidation = validator.validateCsvRow(rowData, i);
                    if (!rowValidation.valid) {
                        rowValidation.errors.forEach(err => errors.push(err));
                        errorCount++;

                        // Crear WORK con estado Error para trazabilidad
                        try {
                            const errorWorkData = {
                                customerId: rowData.customerId || '0',
                                agreementId: rowData.agreementId || '0',
                                settlementMethod: settlementMethod,
                                scenario: rowData.scenario || 'Estándar',
                                sourceInvoiceId: rowData.sourceInvoiceId || '0',
                                sourceAccrualId: '0',
                                sourceItemId: rowData.itemId || '0',
                                originalAmount: 0,
                                availableAmount: 0,
                                amountToSettle: parseFloat(rowData.amountToSettle) || 0,
                                csvBatchId: batchId
                            };
                            const errorWorkId = txnBuilder.createWorkRecord(errorWorkData, 'CSV');
                            txnBuilder.updateWorkRecord(errorWorkId, {
                                status: 'Error',
                                errorMessage: rowValidation.errors.join(' | ')
                            });
                        } catch (wErr) {
                            log.error({ title: `${MODULE}.processUpload`, details: `Error creating error WORK record: ${wErr.message}` });
                        }
                        continue;
                    }

                    // Obtener información fiscal
                    const taxInfo = dao.getTaxInfoFromInvoiceLine(rowData.sourceInvoiceId, rowData.itemId);

                    // Crear registro WORK
                    const workData = {
                        customerId: rowData.customerId,
                        agreementId: rowData.agreementId,
                        settlementMethod: settlementMethod,
                        scenario: rowData.scenario,
                        sourceInvoiceId: rowData.sourceInvoiceId,
                        sourceAccrualId: '0', // Se resolverá en el Map/Reduce
                        sourceItemId: rowData.itemId,
                        originalAmount: 0,
                        availableAmount: 0,
                        amountToSettle: rowData.amountToSettle,
                        invoiceTo: rowData.invoiceTo,
                        applyAmount: rowData.applyAmount,
                        taxScheduleId: taxInfo.taxScheduleId,
                        taxBasis: rowData.amountToSettle,
                        excessFlag: rowData.scenario === 'Cobro en exceso',
                        csvBatchId: batchId
                    };

                    txnBuilder.createWorkRecord(workData, 'CSV');
                    successCount++;

                } catch (rowErr) {
                    errors.push(`Fila ${i + 1}: Error inesperado — ${rowErr.message}`);
                    errorCount++;
                }
            }

            // Disparar Map/Reduce si hay registros exitosos
            let mrTaskId = '';
            if (successCount > 0) {
                const mrTask = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: '_giv_mr_rebate_liquidation',
                    deploymentId: '_giv_dep_mr_liquidation'
                });
                mrTaskId = mrTask.submit();
            }

            log.audit({
                title: `${MODULE}.processUpload`,
                details: `Batch: ${batchId}. Success: ${successCount}, Errors: ${errorCount}. M/R: ${mrTaskId}`
            });

            // Redirect a pantalla de estado
            if (successCount > 0) {
                redirect.toSuitelet({
                    scriptId: '_giv_sl_rebate_status',
                    deploymentId: '_giv_dep_rebate_status',
                    parameters: {
                        custpage_mr_task_id: mrTaskId,
                        custpage_batch_id: batchId,
                        custpage_work_count: successCount,
                        custpage_error_count: errorCount
                    }
                });
            } else {
                renderResultPage(context, successCount, errorCount, errors);
            }

        } catch (e) {
            log.error({ title: `${MODULE}.processUpload`, details: e.message });
            renderResultPage(context, 0, 0, [e.message]);
        }
    };

    /**
     * Renderiza la página de resultado de la carga.
     */
    const renderResultPage = (context, success, errorCount, errors) => {
        const form = serverWidget.createForm({ title: 'Resultado de Carga CSV' });

        const summaryField = form.addField({
            id: 'custpage_summary',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });

        let html = `<div style="padding: 15px;">`;
        html += `<p><strong>Registros exitosos:</strong> ${success}</p>`;
        html += `<p><strong>Registros con error:</strong> ${errorCount}</p>`;

        if (errors.length > 0) {
            html += `<h3>Detalle de Errores:</h3><ul>`;
            errors.forEach(err => { html += `<li style="color: #c23934;">${err}</li>`; });
            html += `</ul>`;
        }
        html += `</div>`;

        summaryField.defaultValue = html;

        context.response.writePage(form);
    };

    return { onRequest };
});
