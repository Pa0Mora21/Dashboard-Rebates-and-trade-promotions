/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Suitelet para carga masiva de liquidaciones mediante archivo CSV.
 *
 *              DISEÑO EN 2 FASES:
 *                Fase 1 — Validación completa del CSV sin crear ningún WORK.
 *                         Si hay cualquier error → mostrar pantalla de resultado y abortar.
 *                Fase 2 — Solo si Fase 1 es 100% limpia: crear WORKs y disparar Map/Reduce.
 *                         WORKs de Error solo se crean en esta fase por fallas de runtime
 *                         (e.g. error al guardar en NetSuite), nunca por errores de validación.
 */
define([
    'N/ui/serverWidget',
    'N/file',
    'N/task',
    'N/redirect',
    'N/log',
    'N/runtime',
    '../lib/giv_rebate_validator',
    '../lib/giv_rebate_transaction_builder',
    '../lib/giv_rebate_dao'
], (serverWidget, file, task, redirect, log, runtime, validator, txnBuilder, dao) => {

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
                    <tr><td style="padding:4px;">Cliente</td><td style="padding:4px;">Nombre, entityid o Internal ID del cliente</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Agreement</td><td style="padding:4px;">Nombre o Internal ID del acuerdo de reembolso</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Tipo de liquidación</td><td style="padding:4px;">Estándar | Consolidada | Específica (por SKU) | Cobro en exceso | Agrupación</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Factura Origen</td><td style="padding:4px;">Número de transacción (tranid) o Internal ID de la factura</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Artículo</td><td style="padding:4px;">Código (itemid), nombre o Internal ID del artículo</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Monto a Liquidar</td><td style="padding:4px;">Importe antes de impuestos</td><td style="padding:4px;">Sí</td></tr>
                    <tr><td style="padding:4px;">Factura Destino</td><td style="padding:4px;">Número de transacción (tranid) o Internal ID — dejar vacío si es Vendor Bill</td><td style="padding:4px;">Según método</td></tr>
                    <tr><td style="padding:4px;">Monto a Aplicar</td><td style="padding:4px;">Monto sin impuestos a aplicar — dejar vacío si es Vendor Bill</td><td style="padding:4px;">Según método</td></tr>
                </table>
            </div>
        `;

        form.addSubmitButton({ label: 'Cargar y Procesar CSV' });

        context.response.writePage(form);
    };

    /**
     * Procesa el archivo CSV cargado.
     *
     * DISEÑO EN 2 FASES:
     *   Fase 1 — Validación completa sin crear ningún WORK.
     *            Si hay cualquier error → mostrar pantalla de resultado y abortar.
     *   Fase 2 — Solo si Fase 1 es 100% limpia: crear WORKs y disparar M/R.
     *            WORKs de Error solo se crean aquí por fallas de runtime (no de validación).
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

            // ── Pre-scan: recopilar valores únicos por columna ────────────────────────────
            // Una sola búsqueda batch por tipo de entidad en vez de una por fila.
            const _custSet      = new Set();
            const _agrSet       = new Set();
            const _invSet       = new Set();
            const _itemSet      = new Set();
            const _extIdTracker = {};   // { externalId: [{ scenario, rowNum }] }

            for (let s = 1; s < rows.length; s++) {
                const sc = rows[s].split(',').map(c => c.trim().replace(/"/g, ''));
                if (sc[1]) _custSet.add(sc[1]);
                if (sc[2]) _agrSet.add(sc[2]);
                if (sc[4]) _invSet.add(sc[4]);
                if (sc[5]) _itemSet.add(sc[5]);
                if (sc[7]) _invSet.add(sc[7]);   // Factura Destino comparte mapa con Origen
                const extId   = (sc[0] || '').trim();
                const scenRaw = (sc[3] || '').trim();
                if (extId) {
                    if (!_extIdTracker[extId]) _extIdTracker[extId] = [];
                    _extIdTracker[extId].push({ scenario: scenRaw, rowNum: s });
                }
            }

            // Detectar External IDs duplicados en escenarios que no los permiten.
            // Solo Consolidada y Agrupación pueden tener múltiples filas con el mismo External ID.
            const GROUP_SCENARIOS = new Set(['Consolidada', 'Agrupación']);
            const _invalidExtIds  = new Set();
            const preScanErrors   = [];

            Object.entries(_extIdTracker).forEach(([extId, entries]) => {
                if (entries.length <= 1) return;
                const scenarios = [...new Set(entries.map(e => e.scenario))];

                if (scenarios.length > 1) {
                    preScanErrors.push(
                        `External ID "${extId}" aparece en filas ${entries.map(e => e.rowNum).join(', ')} ` +
                        `con escenarios distintos (${scenarios.join(', ')}). ` +
                        `Todas las filas con el mismo External ID deben usar el mismo escenario.`
                    );
                    _invalidExtIds.add(extId);
                }

                if (scenarios.length === 1 && !GROUP_SCENARIOS.has(scenarios[0])) {
                    preScanErrors.push(
                        `External ID "${extId}" aparece ${entries.length} veces en filas ` +
                        `${entries.map(e => e.rowNum).join(', ')} con escenario "${scenarios[0]}". ` +
                        `Solo Consolidada y Agrupación permiten múltiples filas con el mismo External ID.`
                    );
                    _invalidExtIds.add(extId);
                }
            });

            // ── Resolución batch: nombres → Internal IDs ──────────────────────────────────
            let idMaps = { customers: {}, agreements: {}, invoices: {}, items: {} };
            try {
                idMaps = dao.resolveCsvIdentifiers({
                    customerValues:  [..._custSet],
                    agreementValues: [..._agrSet],
                    invoiceValues:   [..._invSet],
                    itemValues:      [..._itemSet]
                });
            } catch (resolveErr) {
                log.error({ title: `${MODULE}.processUpload.resolve`, details: resolveErr.message || resolveErr });
                renderResultPage(context, 0, 0, [`Error resolviendo entidades del CSV: ${resolveErr.message}`]);
                return;
            }

            /**
             * Traduce un valor CSV (nombre o ID) a su Internal ID usando el mapa resuelto.
             * Lanza un Error descriptivo si el valor no se encontró.
             */
            const resolveId = (value, map, label) => {
                if (!value) return '';
                const resolved = map[value];
                if (resolved === undefined) {
                    throw new Error(`No se encontró "${value}" en NetSuite (${label}). Verifique el nombre o use el Internal ID numérico.`);
                }
                return resolved;
            };

            /**
             * Construye un enlace HTML clickeable a un registro de NetSuite.
             * Se renderiza en INLINEHTML de renderResultPage.
             */
            const nsLink = (id, label, nsPath) => {
                if (!id) return label || '';
                const display = label || id;
                return `<a href="${nsPath}?id=${id}" target="_blank" style="color:#0070d2;font-weight:bold;">${display}</a>`;
            };

            // ════════════════════════════════════════════════════════════════════════
            // FASE 1 — VALIDACIÓN COMPLETA (sin crear ningún WORK)
            // Se recorre todo el CSV y se acumulan TODOS los errores.
            // Si al final hay cualquier error → mostrar resultado y abortar.
            // ════════════════════════════════════════════════════════════════════════
            const validationErrors = [...preScanErrors];
            const validRows = [];   // Filas 100% válidas, listas para Fase 2

            // Acumulador de montos comprometidos por accrual dentro de este mismo lote CSV.
            // El check de concurrencia existente (getLockedAccrualAmounts) solo detecta WORKs
            // ya guardados en BD — no puede ver otras filas del mismo CSV que aún no son WORKs.
            // Este mapa cubre ese hueco: si dos filas del mismo CSV tocan el mismo accrual,
            // su suma no puede superar el saldo disponible (excepto en Cobro en exceso).
            // Clave: sourceAccrualId | Valor: suma de amountToSettle ya comprometido en Fase 1.
            const batchAccrualUsage = {};

            for (let i = 1; i < rows.length; i++) {
                try {
                    const cols      = rows[i].split(',').map(c => c.trim().replace(/"/g, ''));
                    const _rowExtId    = (cols[0] || '').trim();
                    const _hasExtIdErr = _invalidExtIds.has(_rowExtId);

                    const resolvedInvoiceTo = cols[7]
                        ? resolveId(cols[7], idMaps.invoices, 'Factura Destino')
                        : '';

                    const rowData = {
                        externalId:          cols[0] || '',
                        customerId:          resolveId(cols[1], idMaps.customers,  'Cliente'),
                        agreementId:         resolveId(cols[2], idMaps.agreements, 'Agreement'),
                        scenario:            cols[3] || '',
                        sourceInvoiceId:     resolveId(cols[4], idMaps.invoices,   'Factura Origen'),
                        itemId:              resolveId(cols[5], idMaps.items,       'Artículo'),
                        amountToSettle:      cols[6] || '',
                        invoiceTo:           resolvedInvoiceTo,
                        invoiceToCustomerId: resolvedInvoiceTo
                            ? (idMaps.invoiceCustomers[resolvedInvoiceTo] || '')
                            : '',
                        applyAmount:         cols[8] || ''
                    };

                    const rowLabels = {
                        sourceInvoice: nsLink(
                            rowData.sourceInvoiceId,
                            idMaps.invoiceLabels[rowData.sourceInvoiceId],
                            '/app/accounting/transactions/custinvc.nl'
                        ),
                        invoiceTo: nsLink(
                            rowData.invoiceTo,
                            idMaps.invoiceLabels[rowData.invoiceTo],
                            '/app/accounting/transactions/custinvc.nl'
                        ),
                        item: nsLink(
                            rowData.itemId,
                            idMaps.itemLabels[rowData.itemId],
                            '/app/common/item/item.nl'
                        ),
                        agreement: idMaps.agreementLabels[rowData.agreementId]
                            || `Acuerdo ${rowData.agreementId}`
                    };

                    // Obtener método de liquidación del acuerdo
                    let settlementMethod = '';
                    try {
                        const agreementDetails = dao.getAgreementDetails(rowData.agreementId);
                        settlementMethod = agreementDetails.settlementMethod;
                        rowData.settlementMethod = settlementMethod;
                    } catch (agErr) {
                        validationErrors.push(`Fila ${i}: No se pudo obtener el ${rowLabels.agreement}. ${agErr.message || agErr}`);
                        continue;
                    }

                    // Validación estructural y de datos del CSV (sin BD)
                    const rowValidation = validator.validateCsvRow(rowData, i, rowLabels);

                    // Acumular errores: External ID duplicado + errores de validateCsvRow.
                    // El mensaje del External ID ya está en preScanErrors; aquí se agregan
                    // solo los errores de datos de la fila.
                    if (_hasExtIdErr || !rowValidation.valid) {
                        rowValidation.errors.forEach(err => validationErrors.push(err));
                        continue;
                    }

                    // Validación contra BD — solo si los datos básicos son válidos
                    const accruals = dao.getAvailableAccruals({
                        agreementId:      rowData.agreementId,
                        sourceInvoiceIds: [rowData.sourceInvoiceId],
                        itemId:           rowData.itemId
                    });

                    if (!accruals || accruals.length === 0) {
                        validationErrors.push(
                            `Fila ${i}: No se encontró provisión disponible para ` +
                            `Factura ${rowLabels.sourceInvoice} / Artículo ${rowLabels.item} ` +
                            `en el ${rowLabels.agreement}.`
                        );
                        continue;
                    }

                    const accrual         = accruals[0];
                    const sourceAccrualId = accrual.accrualId;
                    const originalAmount  = accrual.accrualAmount;
                    const availableAmount = accrual.availableAmount;

                    // Validación de disponibilidad individual (excepto Cobro en exceso)
                    if (rowData.scenario !== 'Cobro en exceso') {
                        const availCheck = validator.validateAvailableAmount(
                            sourceAccrualId,
                            rowData.itemId,
                            parseFloat(rowData.amountToSettle) || 0,
                            rowData.scenario,
                            availableAmount
                        );
                        if (!availCheck.valid) {
                            validationErrors.push(`Fila ${i}: ${availCheck.message}`);
                            continue;
                        }

                        // Validación acumulada dentro del mismo lote CSV.
                        // El check de concurrencia (getLockedAccrualAmounts) no detecta otras filas
                        // del mismo CSV porque los WORKs aún no existen en BD en este momento.
                        // Si dos filas apuntan al mismo accrual, la suma no puede superar el disponible.
                        const alreadyCommitted  = batchAccrualUsage[sourceAccrualId] || 0;
                        const rowAmount         = parseFloat(rowData.amountToSettle) || 0;
                        const totalInBatch      = Math.round((alreadyCommitted + rowAmount) * 100) / 100;
                        const roundedAvailable  = Math.round(availableAmount * 100) / 100;

                        if (totalInBatch > roundedAvailable + 0.001) {
                            validationErrors.push(
                                `Fila ${i}: El monto acumulado para ` +
                                `Factura ${rowLabels.sourceInvoice} / Artículo ${rowLabels.item} ` +
                                `en este lote ($${totalInBatch.toFixed(2)}) supera el saldo disponible ` +
                                `($${roundedAvailable.toFixed(2)}). ` +
                                `Filas anteriores en este CSV ya comprometieron $${alreadyCommitted.toFixed(2)} ` +
                                `de esta provisión.`
                            );
                            continue;
                        }
                    }

                    // Validación coherencia applyAmount vs amountToSettle (Credit Memo)
                    if (settlementMethod === '3') {
                        const _settle = parseFloat(rowData.amountToSettle) || 0;
                        const _apply  = parseFloat(rowData.applyAmount)    || 0;
                        if (_apply > Math.round(_settle * 100) / 100 + 0.001) {
                            validationErrors.push(
                                `Fila ${i}: El Monto a Aplicar ($${_apply.toFixed(2)}) ` +
                                `no puede ser mayor al Monto a Liquidar ($${_settle.toFixed(2)}). ` +
                                `El CM se genera por el monto liquidado; solo puede aplicarse hasta ese importe.`
                            );
                            continue;
                        }
                    }

                    // Fila 100% válida — registrar en acumulador de lote y guardar para Fase 2.
                    // El acumulador se actualiza SOLO cuando la fila pasa todas las validaciones,
                    // para no contar filas rechazadas como monto comprometido.
                    if (rowData.scenario !== 'Cobro en exceso') {
                        const rowAmt = parseFloat(rowData.amountToSettle) || 0;
                        batchAccrualUsage[sourceAccrualId] = (batchAccrualUsage[sourceAccrualId] || 0) + rowAmt;
                    }

                    const taxInfo = dao.getTaxInfoFromInvoiceLine(rowData.sourceInvoiceId, rowData.itemId);
                    validRows.push({
                        rowIndex:         i,
                        rowData:          rowData,
                        settlementMethod: settlementMethod,
                        sourceAccrualId:  sourceAccrualId,
                        originalAmount:   originalAmount,
                        availableAmount:  availableAmount,
                        taxInfo:          taxInfo
                    });

                } catch (rowErr) {
                    validationErrors.push(`Fila ${i}: Error inesperado — ${rowErr.message || rowErr}`);
                }
            }

            // ── Si hay cualquier error → mostrar pantalla y abortar (sin WORKs) ──────────
            if (validationErrors.length > 0) {
                log.audit({
                    title: `${MODULE}.processUpload`,
                    details: `Pre-carga abortada. Errores: ${validationErrors.length}, Filas válidas: ${validRows.length}. Batch: ${batchId}`
                });
                renderResultPage(context, 0, validationErrors.length, validationErrors);
                return;
            }

            // ════════════════════════════════════════════════════════════════════════
            // FASE 2 — CREACIÓN DE WORKs (solo si Fase 1 fue 100% exitosa)
            // Aquí sí se crean WORKs de Error, pero solo por fallas de runtime
            // al guardar en NetSuite, no por errores de validación de datos.
            // ════════════════════════════════════════════════════════════════════════
            let successCount     = 0;
            let runtimeErrorCount = 0;
            const runtimeErrors  = [];

            validRows.forEach(({ rowIndex, rowData, settlementMethod, sourceAccrualId, originalAmount, availableAmount, taxInfo }) => {
                try {
                    txnBuilder.createWorkRecord({
                        customerId:       rowData.customerId,
                        agreementId:      rowData.agreementId,
                        settlementMethod: settlementMethod,
                        scenario:         rowData.scenario,
                        sourceInvoiceId:  rowData.sourceInvoiceId,
                        sourceAccrualId:  sourceAccrualId,
                        sourceItemId:     rowData.itemId,
                        originalAmount:   originalAmount,
                        availableAmount:  availableAmount,
                        amountToSettle:   rowData.amountToSettle,
                        invoiceTo:        rowData.invoiceTo,
                        applyAmount:      rowData.applyAmount,
                        taxCodeId:        taxInfo.taxCodeId,
                        taxBasis:         rowData.amountToSettle,
                        excessFlag:       rowData.scenario === 'Cobro en exceso',
                        csvBatchId:       batchId
                    }, 'CSV');
                    successCount++;
                } catch (wErr) {
                    // Error de runtime al guardar — este SÍ genera WORK de Error para trazabilidad
                    const runtimeMsg = `Fila ${rowIndex}: Error al crear registro de trabajo — ${wErr.message || wErr}`;
                    runtimeErrors.push(runtimeMsg);
                    runtimeErrorCount++;
                    log.error({ title: `${MODULE}.processUpload`, details: runtimeMsg });

                    try {
                        const errWorkId = txnBuilder.createWorkRecord({
                            customerId:       rowData.customerId,
                            agreementId:      rowData.agreementId,
                            settlementMethod: settlementMethod,
                            scenario:         rowData.scenario,
                            sourceInvoiceId:  rowData.sourceInvoiceId,
                            sourceAccrualId:  sourceAccrualId,
                            sourceItemId:     rowData.itemId,
                            originalAmount:   originalAmount,
                            availableAmount:  availableAmount,
                            amountToSettle:   parseFloat(rowData.amountToSettle) || 0,
                            csvBatchId:       batchId
                        }, 'CSV');
                        txnBuilder.updateWorkRecord(errWorkId, { status: 'Error', errorMessage: runtimeMsg });
                    } catch (ewErr) {
                        log.error({ title: `${MODULE}.processUpload`, details: `[Fila=${rowIndex+1}] No se pudo crear WORK de error runtime: ${ewErr.message || ewErr}` });
                    }
                }
            });

            // Disparar Map/Reduce si hay WORKs creados exitosamente
            let mrTaskId = '';
            if (successCount > 0) {
                const mrTask = task.create({
                    taskType:     task.TaskType.MAP_REDUCE,
                    scriptId:     'customscript_giv_mr_liquidation',
                    deploymentId: 'customdeploy_giv_mr_liquidation',
                    params: {
                        custscript_giv_mr_csv_batch_id: batchId
                    }
                });
                mrTaskId = mrTask.submit();
            }

            log.audit({
                title: `${MODULE}.processUpload`,
                details: `Batch: ${batchId}. WORKs creados: ${successCount}, Errores runtime: ${runtimeErrorCount}. M/R: ${mrTaskId}`
            });

            if (successCount > 0) {
                redirect.toSuitelet({
                    scriptId:     'customscript_giv_sl_rebate_status',
                    deploymentId: 'customdeploy_giv_sl_status',
                    parameters: {
                        custpage_mr_task_id:  mrTaskId,
                        custpage_batch_id:    batchId,
                        custpage_work_count:  successCount,
                        custpage_error_count: runtimeErrorCount
                    }
                });
            } else {
                // Todos fallaron por runtime — mostrar errores en pantalla de resultado
                renderResultPage(context, 0, runtimeErrorCount, runtimeErrors);
            }

        } catch (e) {
            log.error({ title: `${MODULE}.processUpload`, details: e.message || e });
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
