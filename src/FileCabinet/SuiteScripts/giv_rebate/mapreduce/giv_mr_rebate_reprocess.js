/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * @description Reprocesamiento masivo de provisiones (Escenario 8 — DRD).
 *
 *              Cuando un Rebate Agreement Detail se edita retroactivamente
 *              (ej. cambio de porcentaje), R&TP crea una nueva versión del RAD
 *              (con custrecord_rm_rad_parent apuntando al anterior), pero las
 *              facturas ya emitidas siguen referenciando el RAD viejo.
 *
 *              Este M/R:
 *              1. Construye un "swap map" de RADs viejos → nuevos (versión hoja)
 *              2. Para cada factura afectada, reemplaza los RAD IDs viejos
 *                 por los nuevos en todos los campos ocultos de R&TP
 *              3. Al guardar, el afterSubmit nativo de R&TP detecta el cambio
 *                 y recalcula los Accruals con los datos actualizados
 *
 *              Flujo:
 *              getInputData → Valida swap map, busca facturas con RTDs del acuerdo
 *              map          → Pasa invoice ID al reduce (deduplicación por key)
 *              reduce       → buildSwapMap() + swapLineRadIds() + save()
 *              summarize    → Reporta resultados
 *
 * Parámetros de Script:
 * - custscript_giv_reproc_agreement:  Internal ID del Rebate Agreement
 * - custscript_giv_reproc_date_from:  Fecha inicio
 * - custscript_giv_reproc_date_to:    Fecha fin
 */
define([
    'N/search',
    'N/record',
    'N/runtime',
    'N/query',
    'N/log'
], (search, record, runtime, query, log) => {

    const MODULE = 'giv_mr_rebate_reprocess';

    // ──────────────────────────────────────────────
    //  SWAP MAP — Versiones de RAD
    // ──────────────────────────────────────────────

    /**
     * Construye un mapa de RAD IDs viejos → RAD ID más reciente (hoja del árbol).
     * Maneja cadenas de versiones: RAD 3 → 4 → 5 se resuelve como {3: "5", 4: "5"}.
     *
     * El campo custrecord_rm_rad_parent en el RAD nuevo apunta al RAD que reemplaza.
     *
     * @param {string|number} agreementId  Internal ID del Rebate Agreement
     * @returns {Object} swapMap  { "oldRadId": "newRadId", ... }
     */
    const buildSwapMap = (agreementId) => {
        const sql = `
            SELECT id, custrecord_rm_rad_parent AS parent_id
            FROM customrecord_rebate_agreement_details
            WHERE custrecord_rm_rebate_agreement = ?
              AND isinactive = 'F'
            ORDER BY id
        `;

        const rows = query.runSuiteQL({ query: sql, params: [agreementId] }).asMappedResults();

        // Construir lookup parent: id → parent_id (null si es raíz)
        const parentOf = {};
        rows.forEach(r => {
            parentOf[String(r.id)] = r.parent_id ? String(r.parent_id) : null;
        });

        // Encontrar el ancestro raíz de un RAD (seguir padres hasta null)
        const findRoot = (id) => {
            let current = id;
            const visited = new Set();
            while (parentOf[current] && !visited.has(current)) {
                visited.add(current);
                current = parentOf[current];
            }
            return current;
        };

        // Agrupar todos los RADs por su raíz
        // Ej: RAD 3 (root), RAD 4 (parent=3), RAD 5 (parent=3)
        //     → groups = { "3": ["3", "4", "5"] }
        const groups = {};
        rows.forEach(r => {
            const radId = String(r.id);
            const root = findRoot(radId);
            if (!groups[root]) groups[root] = [];
            groups[root].push(radId);
        });

        // Para cada grupo con más de 1 versión, mapear TODOS los viejos al más reciente
        // Ej: group ["3","4","5"] → latest="5" → swapMap = {3:"5", 4:"5"}
        const swapMap = {};
        for (const root of Object.keys(groups)) {
            const versions = groups[root];
            if (versions.length <= 1) continue;

            // El más reciente = el ID más alto
            const latest = versions.reduce((max, id) =>
                parseInt(id, 10) > parseInt(max, 10) ? id : max
            );

            versions.forEach(id => {
                if (id !== latest) {
                    swapMap[id] = latest;
                }
            });
        }

        log.audit({
            title: `${MODULE}.buildSwapMap`,
            details: `Agreement ${agreementId} | Swap: ${JSON.stringify(swapMap)}`
        });

        return swapMap;
    };

    // ──────────────────────────────────────────────
    //  LINE SWAP — Actualizar campos R&TP de una línea
    // ──────────────────────────────────────────────

    /**
     * Aplica el swap de RAD IDs en todos los campos ocultos de R&TP de una línea
     * de la sublista item de la factura.
     *
     * Campos actualizados:
     * - custcol_rm_applicable_rad       (string: RAD ID o IDs separados por coma)
     * - custcol_rm_selecrebid           (string: RAD ID seleccionado)
     * - custcol_rm_applicable_txn_rebates (JSON: [{id, a, p}, ...])
     * - custcol_rm_so_hidden_rma        (JSON: {bo, l, p, c, rad: [{id, a, p}]})
     * - custcol_rm_last_modified_date   (DateTime: marca de cambio para R&TP)
     *
     * @param {Record} invoiceRec  Registro de factura cargado (standard mode)
     * @param {number} lineIndex   Índice de la línea en sublista 'item'
     * @param {Object} swapMap     { "oldRadId": "newRadId" }
     * @returns {boolean} true si al menos un campo fue modificado
     */
    const swapLineRadIds = (invoiceRec, lineIndex, swapMap) => {
        let swapped = false;

        // ── 1. custcol_rm_applicable_rad ──
        // Puede contener un solo ID o múltiples separados por coma
        const applicableRad = String(invoiceRec.getSublistValue({
            sublistId: 'item', fieldId: 'custcol_rm_applicable_rad', line: lineIndex
        }) || '');

        if (applicableRad) {
            const newRad = applicableRad.split(',').map(id => {
                const trimmed = id.trim();
                return swapMap[trimmed] || trimmed;
            }).join(',');

            if (newRad !== applicableRad) {
                invoiceRec.setSublistValue({
                    sublistId: 'item', fieldId: 'custcol_rm_applicable_rad',
                    line: lineIndex, value: newRad
                });
                swapped = true;
            }
        }

        // ── 2. custcol_rm_selecrebid ──
        const selecRebId = String(invoiceRec.getSublistValue({
            sublistId: 'item', fieldId: 'custcol_rm_selecrebid', line: lineIndex
        }) || '');

        if (selecRebId && swapMap[selecRebId]) {
            invoiceRec.setSublistValue({
                sublistId: 'item', fieldId: 'custcol_rm_selecrebid',
                line: lineIndex, value: swapMap[selecRebId]
            });
            swapped = true;
        }

        // ── 3. custcol_rm_applicable_txn_rebates ──
        // JSON array: [{"id": 3, "a": -2, "p": 0}]
        const txnRebatesRaw = invoiceRec.getSublistValue({
            sublistId: 'item', fieldId: 'custcol_rm_applicable_txn_rebates', line: lineIndex
        });

        if (txnRebatesRaw) {
            try {
                const txnRebates = JSON.parse(txnRebatesRaw);
                let jsonChanged = false;

                txnRebates.forEach(r => {
                    const oldId = String(r.id);
                    if (swapMap[oldId]) {
                        r.id = parseInt(swapMap[oldId], 10);
                        jsonChanged = true;
                    }
                });

                if (jsonChanged) {
                    invoiceRec.setSublistValue({
                        sublistId: 'item', fieldId: 'custcol_rm_applicable_txn_rebates',
                        line: lineIndex, value: JSON.stringify(txnRebates)
                    });
                    swapped = true;
                }
            } catch (e) {
                log.debug({
                    title: `${MODULE}.swapLineRadIds`,
                    details: `Error parsing txn_rebates L${lineIndex}: ${e.message}`
                });
            }
        }

        // ── 4. custcol_rm_so_hidden_rma ──
        // JSON object: {"bo": -2, "l": 0, "p": 0, "c": 3, "rad": [{"id": 3, "a": -2, "p": 0}]}
        const hiddenRmaRaw = invoiceRec.getSublistValue({
            sublistId: 'item', fieldId: 'custcol_rm_so_hidden_rma', line: lineIndex
        });

        if (hiddenRmaRaw) {
            try {
                const hiddenRma = JSON.parse(hiddenRmaRaw);
                let jsonChanged = false;

                if (hiddenRma.rad && Array.isArray(hiddenRma.rad)) {
                    hiddenRma.rad.forEach(r => {
                        const oldId = String(r.id);
                        if (swapMap[oldId]) {
                            r.id = parseInt(swapMap[oldId], 10);
                            jsonChanged = true;
                        }
                    });
                }

                if (jsonChanged) {
                    invoiceRec.setSublistValue({
                        sublistId: 'item', fieldId: 'custcol_rm_so_hidden_rma',
                        line: lineIndex, value: JSON.stringify(hiddenRma)
                    });
                    swapped = true;
                }
            } catch (e) {
                log.debug({
                    title: `${MODULE}.swapLineRadIds`,
                    details: `Error parsing hidden_rma L${lineIndex}: ${e.message}`
                });
            }
        }

        // ── 5. Marcar fecha de modificación si hubo cambio ──
        if (swapped) {
            invoiceRec.setSublistValue({
                sublistId: 'item', fieldId: 'custcol_rm_last_modified_date',
                line: lineIndex, value: new Date()
            });
        }

        return swapped;
    };

    // ──────────────────────────────────────────────
    //  BODY SWAP — Campo body-level multi-select
    // ──────────────────────────────────────────────

    /**
     * Actualiza custbody_rm_rebate_agg_detail_ids reemplazando RAD IDs viejos
     * por sus versiones más recientes.
     *
     * @param {Record} invoiceRec  Registro de factura cargado
     * @param {Object} swapMap     { "oldRadId": "newRadId" }
     * @returns {boolean} true si hubo cambio
     */
    const swapBodyRadIds = (invoiceRec, swapMap) => {
        try {
            const currentIds = invoiceRec.getValue({ fieldId: 'custbody_rm_rebate_agg_detail_ids' });
            if (!currentIds || (Array.isArray(currentIds) && currentIds.length === 0)) return false;

            const idsArray = Array.isArray(currentIds) ? currentIds : [currentIds];
            let changed = false;

            const newIds = idsArray.map(id => {
                const strId = String(id);
                if (swapMap[strId]) {
                    changed = true;
                    return swapMap[strId];
                }
                return strId;
            });

            if (changed) {
                invoiceRec.setValue({
                    fieldId: 'custbody_rm_rebate_agg_detail_ids',
                    value: newIds
                });
            }

            return changed;
        } catch (e) {
            log.debug({ title: `${MODULE}.swapBodyRadIds`, details: e.message });
            return false;
        }
    };

    // ──────────────────────────────────────────────
    //  ENTRY POINTS
    // ──────────────────────────────────────────────

    const getInputData = () => {
        const script = runtime.getCurrentScript();
        const agreementId = script.getParameter({ name: 'custscript_giv_reproc_agreement' });
        const dateFrom = script.getParameter({ name: 'custscript_giv_reproc_date_from' });
        const dateTo = script.getParameter({ name: 'custscript_giv_reproc_date_to' });

        if (!agreementId || !dateFrom || !dateTo) {
            log.error({ title: `${MODULE}.getInputData`, details: 'Parámetros faltantes' });
            return [];
        }

        log.audit({
            title: `${MODULE}.getInputData | INICIO`,
            details: JSON.stringify({ agreementId, dateFrom, dateTo })
        });

        // Verificar que existen versiones nuevas de RADs
        const swapMap = buildSwapMap(agreementId);
        if (Object.keys(swapMap).length === 0) {
            log.audit({
                title: `${MODULE}.getInputData | SIN VERSIONES NUEVAS`,
                details: `No se encontraron versiones nuevas de RADs para el acuerdo ${agreementId}. Nada que reprocesar.`
            });
            return [];
        }

        // Obtener cliente del acuerdo
        const agreementLookup = search.lookupFields({
            type: 'customrecord_rm_sales_transaction',
            id: agreementId,
            columns: ['custrecord_hidden_payer']
        });
        const customerId = agreementLookup.custrecord_hidden_payer?.[0]?.value
            || agreementLookup.custrecord_hidden_payer?.value || '';

        if (!customerId) {
            log.error({
                title: `${MODULE}.getInputData`,
                details: `Sin cliente para acuerdo ${agreementId}`
            });
            return [];
        }

        log.audit({
            title: `${MODULE}.getInputData | BÚSQUEDA`,
            details: `Cliente: ${customerId} | Acuerdo: ${agreementId} | Rango: ${dateFrom} — ${dateTo} | SwapMap: ${JSON.stringify(swapMap)}`
        });

        // Buscar facturas con RTDs vinculados a este acuerdo en el rango de fechas.
        // El map deduplicará por invoice ID al escribir con key = invoiceId.
        return search.create({
            type: 'customrecord_rm_transaction_details',
            filters: [
                ['custrecord_rm_source_transaction.type', 'anyof', 'CustInvc'],
                'AND', ['custrecord_rm_source_transaction.trandate', 'within', dateFrom, dateTo],
                'AND', ['custrecord_rm_source_transaction.entity', 'anyof', customerId],
                'AND', ['custrecord_rm_rtd_accrual.custrecord_rm_accru_ra', 'anyof', agreementId],
                'AND', ['isinactive', 'is', 'F']
            ],
            columns: [
                search.createColumn({
                    name: 'internalid',
                    join: 'custrecord_rm_source_transaction'
                }),
                search.createColumn({
                    name: 'tranid',
                    join: 'custrecord_rm_source_transaction'
                })
            ]
        });
    };


    const map = (context) => {
        try {
            const searchResult = JSON.parse(context.value);
            const vals = searchResult.values;

            // Join columns pueden venir en diferentes formatos
            const idField = vals['internalid.custrecord_rm_source_transaction']
                || vals['custrecord_rm_source_transaction.internalid'];
            const tranIdField = vals['tranid.custrecord_rm_source_transaction']
                || vals['custrecord_rm_source_transaction.tranid'];

            const invoiceId = idField?.value || idField || '';
            const tranId = tranIdField?.value || tranIdField || 'N/A';

            if (!invoiceId) return;

            // El reduce agrupa por key, así que duplicados se fusionan
            context.write({ key: String(invoiceId), value: String(tranId) });
        } catch (e) {
            log.error({ title: `${MODULE}.map`, details: e.message });
        }
    };


    /**
     * reduce — Reprocesamiento de cada factura.
     *
     * 1. Construye el swap map (RAD viejo → RAD nuevo) para el acuerdo
     * 2. Carga la factura (con retry si está bloqueada por workflow)
     * 3. Para cada línea, reemplaza los RAD IDs viejos en los campos
     *    ocultos de R&TP por los nuevos
     * 4. Actualiza el campo body-level custbody_rm_rebate_agg_detail_ids
     * 5. Guarda la factura — el afterSubmit nativo de R&TP detecta el
     *    cambio de RAD y recalcula los Accruals con los datos actualizados
     */
    const reduce = (context) => {
        const invoiceId = context.key;

        try {
            if (runtime.getCurrentScript().getRemainingUsage() < 1000) {
                log.audit({
                    title: `${MODULE}.reduce | GOVERNANCE BAJA`,
                    details: `Skipping factura ${invoiceId}. Usage: ${runtime.getCurrentScript().getRemainingUsage()}`
                });
                return;
            }

            const tranId = context.values[0] || 'N/A';
            const agreementId = runtime.getCurrentScript().getParameter({
                name: 'custscript_giv_reproc_agreement'
            });

            // 1. Construir swap map
            const swapMap = buildSwapMap(agreementId);
            if (Object.keys(swapMap).length === 0) {
                log.audit({
                    title: `${MODULE}.reduce | SIN SWAP [${tranId}]`,
                    details: `No hay versiones nuevas para el acuerdo ${agreementId}`
                });
                return;
            }

            // 2. Cargar factura con retry
            const MAX_RETRIES = 3;
            const RETRY_DELAY_MS = 5000;
            let invoiceRec = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    invoiceRec = record.load({
                        type: record.Type.INVOICE,
                        id: invoiceId,
                        isDynamic: false
                    });
                    break;
                } catch (loadErr) {
                    if (loadErr.name === 'RCRD_LOCKED_BY_WF' && attempt < MAX_RETRIES) {
                        log.audit({
                            title: `${MODULE}.reduce | LOCKED [${tranId}]`,
                            details: `Intento ${attempt}/${MAX_RETRIES}. Esperando ${RETRY_DELAY_MS}ms...`
                        });
                        const waitUntil = Date.now() + RETRY_DELAY_MS;
                        while (Date.now() < waitUntil) { /* busy wait */ }
                    } else {
                        throw loadErr;
                    }
                }
            }

            // 3. Procesar cada línea — swap de RAD IDs
            const lineCount = invoiceRec.getLineCount({ sublistId: 'item' });
            let linesSwapped = 0;

            for (let i = 0; i < lineCount; i++) {
                if (swapLineRadIds(invoiceRec, i, swapMap)) {
                    linesSwapped++;
                }
            }

            // 4. Actualizar campo body-level
            const bodySwapped = swapBodyRadIds(invoiceRec, swapMap);

            // 5. Activar el flag nativo de R&TP para que el afterSubmit
            // procese la línea: elimine RTDs/Accruals/RM Transactions viejos
            // y recree todo con el RAD nuevo.
            // Esto replica lo que hace el botón "Submit" del popup Applicable Rebates.
            if (linesSwapped > 0) {
                for (let i = 0; i < lineCount; i++) {
                    const radVal = String(invoiceRec.getSublistValue({
                        sublistId: 'item', fieldId: 'custcol_rm_applicable_rad', line: i
                    }) || '');
                    // Solo activar en líneas que tienen un RAD aplicable
                    if (radVal) {
                        invoiceRec.setSublistValue({
                            sublistId: 'item', fieldId: 'custcol_rm_rebselection',
                            line: i, value: true
                        });
                    }
                }
            }

            // 6. Guardar — el afterSubmit nativo de R&TP se encarga de:
            //    - Eliminar RTDs, Accruals y RM Transactions viejos
            //    - Recrear todo con el RAD nuevo y montos recalculados
            if (linesSwapped > 0 || bodySwapped) {
                invoiceRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit({
                    title: `${MODULE}.reduce | COMPLETADO [${tranId}]`,
                    details: `Factura ${invoiceId} | ${linesSwapped} líneas swap | Body: ${bodySwapped} | Swap: ${JSON.stringify(swapMap)} | Governance: ${runtime.getCurrentScript().getRemainingUsage()}`
                });
            } else {
                log.audit({
                    title: `${MODULE}.reduce | SIN CAMBIOS [${tranId}]`,
                    details: `Factura ${invoiceId} — ninguna línea tenía RADs para swap`
                });
            }

            context.write({
                key: invoiceId,
                value: JSON.stringify({ tranId, linesSwapped, bodySwapped, status: 'OK' })
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.reduce | ERROR [${invoiceId}]`,
                details: `${e.message}\n${e.stack || ''}`
            });
        }
    };


    const summarize = (summary) => {
        // Input errors
        if (summary.inputSummary.error) {
            log.error({
                title: `${MODULE}.summarize | INPUT ERROR`,
                details: summary.inputSummary.error
            });
        }

        // Map errors
        let mapErrors = 0;
        if (summary.mapSummary.errors) {
            summary.mapSummary.errors.iterator().each((key, error) => {
                log.error({
                    title: `${MODULE}.summarize | MAP ERROR`,
                    details: `${key}: ${error}`
                });
                mapErrors++;
                return true;
            });
        }

        // Reduce errors
        let reduceErrors = 0;
        if (summary.reduceSummary.errors) {
            summary.reduceSummary.errors.iterator().each((key, error) => {
                log.error({
                    title: `${MODULE}.summarize | REDUCE ERROR`,
                    details: `${key}: ${error}`
                });
                reduceErrors++;
                return true;
            });
        }

        // Count successes
        let success = 0;
        let totalLinesSwapped = 0;
        summary.output.iterator().each((key, value) => {
            try {
                const data = JSON.parse(value);
                totalLinesSwapped += (data.linesSwapped || 0);
            } catch (e) { /* skip */ }
            success++;
            return true;
        });

        log.audit({
            title: `${MODULE}.summarize | RESULTADO FINAL`,
            details: JSON.stringify({
                facturasReprocesadas: success,
                totalLineasActualizadas: totalLinesSwapped,
                erroresMap: mapErrors,
                erroresReduce: reduceErrors,
                governance: summary.usage,
                concurrency: summary.concurrency
            })
        });
    };

    return { getInputData, map, reduce, summarize };
});
