/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @description Client Script para el Dashboard de Liquidación de Rebates.
 *              Maneja la búsqueda de provisiones (redirect GET) y validación antes de procesar (saveRecord).
 *
 *              DRD Sección 2: Los filtros de búsqueda deben incluir Cliente, Acuerdo,
 *              Factura Origen, Artículo, Fechas y Escenario.
 *
 *              Mejoras UX v2:
 *              - [FIX] getSublistValue(line) antes de selectLine para leer available correctamente.
 *              - [NUEVO] recalcTotals: actualiza badge de total seleccionado y auto-distribuye destino.
 *              - [NUEVO] selectAllProvisions / deselectAllProvisions: selección masiva en sublista.
 */
define(['N/url', 'N/currentRecord'], (url, currentRecord) => {

    const MODULE      = 'giv_cs_rebate_dashboard';
    const SRC_SUBLIST = 'custpage_source_sublist';
    const DST_SUBLIST = 'custpage_dest_sublist';

    // Valores internos del campo custpage_scenario (deben coincidir con los del Suitelet)
    const SCENARIOS = {
        STANDARD:  'Est\u00e1ndar',
        CONSOLIDATED: 'Consolidada',
        SPECIFIC:  'Espec\u00edfica',
        EXCESS:    'Cobro en exceso',
        GROUPED:   'Agrupaci\u00f3n'
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  HELPER: Sugiere el escenario óptimo basado en las líneas seleccionadas.
    //          Auto-selecciona el campo custpage_scenario y muestra un badge.
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Reglas de prioridad (de mayor a menor):
     *  1. Vendor Bill      → método del acuerdo !== 3 (no hay elección)
     *  2. Cobro en exceso  → amountToSettle > availableAmount en alguna línea
     *  3. Agrupación       → 2+ taxCodeId distintos entre las líneas
     *  4. Consolidada      → 2+ sourceInvoiceId distintos
     *  5. Específica       → filtro de artículo activo + 1 factura origen
     *  6. Estándar         → default
     *
     * @param {Object} rec - currentRecord
     */
    const suggestScenario = (rec) => {
        try {
            const CREDIT_MEMO = 3;
            const settlementMethod = parseInt(rec.getValue({ fieldId: 'custpage_settlement_method' })) || null;

            // Si el método no es Credit Memo no hay escenario que sugerir
            // (Vendor Bill no tiene escenarios, el campo se ignora en el proceso)
            if (settlementMethod !== null && settlementMethod !== CREDIT_MEMO) {
                _renderSuggestionBadge(null, null);
                return;
            }

            const count = rec.getLineCount({ sublistId: SRC_SUBLIST });
            const selectedLines = [];

            for (let i = 0; i < count; i++) {
                const isSelected = rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select',   line: i });
                if (!isSelected) continue;

                selectedLines.push({
                    invoiceId:  rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_invoice_id', line: i }),
                    itemId:     rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_item_id',    line: i }),
                    taxCode:    rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_taxcode',    line: i }) || '',
                    amount:     parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_amount',    line: i })) || 0,
                    available:  parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_available', line: i })) || 0
                });
            }

            if (selectedLines.length === 0) {
                _renderSuggestionBadge(null, null);
                return;
            }

            // ── Regla 1: Cobro en exceso ──────────────────────────────────────────
            const hasExcess = selectedLines.some(l => l.amount > l.available + 0.001);
            if (hasExcess) {
                _renderSuggestionBadge(
                    SCENARIOS.EXCESS,
                    'El monto a liquidar supera el saldo disponible en alguna línea.'
                );
                return;
            }

            // ── Regla 2: Agrupación (múltiples códigos de impuesto) ─────────────
            const taxCodes = [...new Set(selectedLines.map(l => l.taxCode).filter(Boolean))];
            if (taxCodes.length > 1) {
                _renderSuggestionBadge(
                    SCENARIOS.GROUPED,
                    `Hay ${taxCodes.length} códigos de impuesto distintos. Se generará una sola línea con Tax Details Override.`
                );
                return;
            }

            // ── Regla 3: Consolidada (múltiples facturas origen) ─────────────────
            const invoices = [...new Set(selectedLines.map(l => l.invoiceId).filter(Boolean))];
            if (invoices.length > 1) {
                _renderSuggestionBadge(
                    SCENARIOS.CONSOLIDATED,
                    `${invoices.length} facturas origen distintas. Se generará un solo Credit Memo consolidado.`
                );
                return;
            }

            // ── Regla 4: Específica (filtro de artículo activo) ──────────────────
            const itemFilter = rec.getValue({ fieldId: 'custpage_item' });
            const hasItemFilter = Array.isArray(itemFilter)
                ? itemFilter.filter(Boolean).length > 0
                : !!itemFilter;
            if (hasItemFilter && invoices.length === 1) {
                _renderSuggestionBadge(
                    SCENARIOS.SPECIFIC,
                    'Filtro de artículo activo con una sola factura origen.'
                );
                return;
            }

            // ── Regla 5: Estándar (default) ──────────────────────────────────────
            _renderSuggestionBadge(
                SCENARIOS.STANDARD,
                'Una provisión, relación directa con factura destino.'
            );

        } catch (e) {
            console.error(`[suggestScenario] ${e.message}`);
        }
    };

    /**
     * Renderiza el badge de sugerencia y auto-selecciona el escenario si el
     * usuario no lo ha modificado manualmente (o si coincide con la sugerencia).
     *
     * @param {string|null} suggested   - Valor del escenario sugerido (null = limpiar badge)
     * @param {string|null} reason      - Texto explicativo para el tooltip
     */
    const _renderSuggestionBadge = (suggested, reason) => {
        // ── Crear/reutilizar el badge ──────────────────────────────────────────
        let badge = document.getElementById('giv_scenario_suggestion');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'giv_scenario_suggestion';
            Object.assign(badge.style, {
                display:      'inline-block',
                marginLeft:   '10px',
                padding:      '3px 10px',
                borderRadius: '12px',
                fontSize:     '12px',
                fontWeight:   'bold',
                verticalAlign: 'middle',
                cursor:       'help',
                transition:   'all 0.3s ease'
            });

            // Insertar junto al campo de escenario
            const scenarioField = document.getElementById('custpage_scenario_fs')  // NetSuite field container
                || document.querySelector('[data-field-id="custpage_scenario"]')
                || document.getElementById('custpage_scenario')?.parentElement;
            if (scenarioField) {
                scenarioField.appendChild(badge);
            } else {
                // Fallback: append al body cerca del form
                document.body.appendChild(badge);
            }
        }

        if (!suggested) {
            badge.style.display = 'none';
            return;
        }

        badge.style.display = 'inline-block';
        badge.title = reason || '';

        // ── Color según tipo de escenario ────────────────────────────────────
        const colors = {
            [SCENARIOS.STANDARD]:    { bg: '#1a7f4b', text: '#fff' },  // verde
            [SCENARIOS.CONSOLIDATED]:{ bg: '#2e6da4', text: '#fff' },  // azul
            [SCENARIOS.SPECIFIC]:    { bg: '#7e5bc7', text: '#fff' },  // morado
            [SCENARIOS.EXCESS]:      { bg: '#c0392b', text: '#fff' },  // rojo
            [SCENARIOS.GROUPED]:     { bg: '#d68910', text: '#fff' }   // amarillo oscuro
        };
        const c = colors[suggested] || { bg: '#555', text: '#fff' };
        badge.style.background = c.bg;
        badge.style.color      = c.text;
        badge.textContent      = `💡 ${suggested}`;

        // ── Auto-seleccionar el escenario si no ha sido modificado manualmente ──
        try {
            const rec = currentRecord.get();
            const current = rec.getValue({ fieldId: 'custpage_scenario' });

            if (!current || current === suggested) {
                rec.setValue({ fieldId: 'custpage_scenario', value: suggested, ignoreFieldChange: true });
                badge.textContent = `✅ ${suggested}`;
            } else {
                // El usuario eligió otro escenario — respetar su decisión, solo avisar
                badge.textContent = `💡 Sugerido: ${suggested}`;
                badge.title       = `${reason} (Tienes seleccionado: ${current})`;
                badge.style.background = '#888';
            }
        } catch (_) { /* campo no editable en este contexto */ }
    };

    const recalcTotals = (rec) => {
        try {
            const srcCount = rec.getLineCount({ sublistId: SRC_SUBLIST });
            let totalSelectedNet = 0;
            let totalEstimatedTax = 0;

            for (let i = 0; i < srcCount; i++) {
                const isSelected = rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', line: i });
                if (isSelected) {
                    const net   = parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_amount',      line: i })) || 0;
                    const gross = parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_total_gross', line: i })) || net;
                    totalSelectedNet  += net;
                    totalEstimatedTax += gross - net;
                }
            }

            const totalGrossNC = totalSelectedNet + totalEstimatedTax;

            // ── Actualizar badge visual con desglose de impuestos ──
            const badge = document.getElementById('giv_total_badge');
            if (badge) {
                const fmtNet   = totalSelectedNet.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const fmtTax   = totalEstimatedTax.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const fmtGross = totalGrossNC.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                badge.innerHTML = `Subtotal: <strong>$${fmtNet}</strong> | Impuestos: <strong>$${fmtTax}</strong> | Total: <strong>$${fmtGross}</strong>`;
                badge.style.background = totalSelectedNet > 0 ? '#1a7f4b' : '#777';
            }

            const scenario = rec.getValue({ fieldId: 'custpage_scenario' });
            const settlementMethod = parseInt(rec.getValue({ fieldId: 'custpage_settlement_method' })) || null;

            // ── Estándar: la redistribución posicional la maneja redistributeStandardDest ──
            if (scenario !== SCENARIOS.STANDARD && settlementMethod === 3) {
                // ── Auto-distribuir si hay exactamente 1 factura destino seleccionada ──
                const dstCount = rec.getLineCount({ sublistId: DST_SUBLIST });
                const selectedDstLines = [];
                for (let j = 0; j < dstCount; j++) {
                    if (rec.getSublistValue({ sublistId: DST_SUBLIST, fieldId: 'custpage_dst_select', line: j })) {
                        selectedDstLines.push(j);
                    }
                }

                if (selectedDstLines.length === 1) {
                    rec.selectLine({ sublistId: DST_SUBLIST, line: selectedDstLines[0] });
                    rec.setCurrentSublistValue({ sublistId: DST_SUBLIST, fieldId: 'custpage_dst_amount', value: totalSelectedNet.toFixed(2), ignoreFieldChange: true });
                    rec.commitLine({ sublistId: DST_SUBLIST });
                }
            }

            // ── Sugerir escenario basado en las líneas seleccionadas ──
            suggestScenario(rec);

        } catch (e) {
            console.error(`[recalcTotals] ${e.message}`);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  redistributeStandardDest — Solo Escenario Estándar + Credit Memo
    //  Asigna automáticamente el monto subtotal (sin IVA) de cada provisión seleccionada
    //  a la factura destino seleccionada en la misma posición.
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @param {Object} rec - currentRecord
     */
    const redistributeStandardDest = (rec) => {
        try {
            const scenario        = rec.getValue({ fieldId: 'custpage_scenario' });
            const settlementMethod = parseInt(rec.getValue({ fieldId: 'custpage_settlement_method' })) || null;

            // Solo aplica en Estándar + Credit Memo
            if (scenario !== SCENARIOS.STANDARD || settlementMethod !== 3) return;

            // ── Recolectar montos neto y bruto de orígenes seleccionados ──
            const srcCount = rec.getLineCount({ sublistId: SRC_SUBLIST });
            const selectedSrcNetAmounts = [];
            let totalSrcNetAmount = 0;
            for (let i = 0; i < srcCount; i++) {
                if (rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', line: i })) {
                    const net = parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_amount', line: i })) || 0;
                    selectedSrcNetAmounts.push(net);
                    totalSrcNetAmount += net;
                }
            }

            // ── Distribuir a destinos seleccionados ──
            const dstCount = rec.getLineCount({ sublistId: DST_SUBLIST });
            const selectedDstLines = [];
            for (let j = 0; j < dstCount; j++) {
                if (rec.getSublistValue({ sublistId: DST_SUBLIST, fieldId: 'custpage_dst_select', line: j })) {
                    selectedDstLines.push(j);
                }
            }

            if (selectedDstLines.length === 1) {
                const dstLine = selectedDstLines[0];
                rec.selectLine({ sublistId: DST_SUBLIST, line: dstLine });
                rec.setCurrentSublistValue({ sublistId: DST_SUBLIST, fieldId: 'custpage_dst_amount', value: totalSrcNetAmount.toFixed(2), ignoreFieldChange: true });
                rec.commitLine({ sublistId: DST_SUBLIST });
            } else if (selectedDstLines.length > 1) {
                selectedDstLines.forEach((dstLine, pairIndex) => {
                    const netAmount = selectedSrcNetAmounts[pairIndex] !== undefined ? selectedSrcNetAmounts[pairIndex] : 0;
                    rec.selectLine({ sublistId: DST_SUBLIST, line: dstLine });
                    rec.setCurrentSublistValue({ sublistId: DST_SUBLIST, fieldId: 'custpage_dst_amount', value: netAmount.toFixed(2), ignoreFieldChange: true });
                    rec.commitLine({ sublistId: DST_SUBLIST });
                });
            }

        } catch (e) {
            console.error(`[redistributeStandardDest] ${e.message}`);
        }
    };



    // ─────────────────────────────────────────────────────────────────────────
    //  fieldChanged — Maneja cambios en campos del formulario
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Automatiza el llenado del monto a liquidar cuando se selecciona una línea.
     *
     * [FIX v2] Se lee custpage_src_available con getSublistValue(line) ANTES de
     * llamar selectLine. Esto garantiza la lectura correcta en sublistas tipo LIST,
     * donde getCurrentSublistValue puede devolver '' para campos no enfocados.
     */
    const fieldChanged = (context) => {
        const rec       = context.currentRecord;
        const sublistId = context.sublistId;
        const fieldId   = context.fieldId;

        // ── Checkbox de selección en la sublista de provisiones ──
        if (sublistId === SRC_SUBLIST && fieldId === 'custpage_src_select') {
            const line = context.line;

            // [FIX] Leer available ANTES de selectLine (getSublistValue es confiable aquí)
            const isSelected = rec.getSublistValue({ sublistId, fieldId: 'custpage_src_select',   line });
            const available  = parseFloat(rec.getSublistValue({ sublistId, fieldId: 'custpage_src_available', line })) || 0;

            rec.selectLine({ sublistId, line });

            if (isSelected) {
                rec.setCurrentSublistValue({ sublistId, fieldId: 'custpage_src_amount', value: available, ignoreFieldChange: true });
            } else {
                rec.setCurrentSublistValue({ sublistId, fieldId: 'custpage_src_amount', value: 0,         ignoreFieldChange: true });
            }

            // commitLine: necesario para que saveRecord/getSublistValue lean el valor actualizado
            rec.commitLine({ sublistId });
            recalcTotals(rec);
            // Estándar: al cambiar un origen, redistribuir montos a destinos emparejados
            redistributeStandardDest(rec);
        }

        // ── Ajuste manual del monto de provisión → recalcular total y redistribuir ──
        if (sublistId === SRC_SUBLIST && fieldId === 'custpage_src_amount') {
            recalcTotals(rec);
            // Estándar: si el usuario ajusta manualmente el monto, reflejar en el destino par
            redistributeStandardDest(rec);
        }

        // ── Selección / deselección de factura destino ──
        if (sublistId === DST_SUBLIST && fieldId === 'custpage_dst_select') {
            const line = context.line;
            const isSelected = rec.getSublistValue({ sublistId, fieldId: 'custpage_dst_select', line });

            if (!isSelected) {
                // Al desmarcar → restaurar el monto al saldo abierto original
                const openBalance = parseFloat(rec.getSublistValue({ sublistId, fieldId: 'custpage_dst_open', line })) || 0;
                rec.selectLine({ sublistId, line });
                rec.setCurrentSublistValue({
                    sublistId,
                    fieldId:           'custpage_dst_amount',
                    value:             openBalance.toFixed(2),
                    ignoreFieldChange: true
                });
                rec.commitLine({ sublistId });
            }

            recalcTotals(rec);
            // Estándar: reasignar montos a los destinos que siguen seleccionados
            redistributeStandardDest(rec);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  pageInit — Ejecutar al cargar la página
    // ─────────────────────────────────────────────────────────────────────────
    const pageInit = (context) => {
        // Calcular total inicial (por si hubiera líneas pre-seleccionadas en GET)
        recalcTotals(context.currentRecord);
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  Selección masiva — Expuestas a los botones dentro de la sublista
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Selecciona TODAS las provisiones y llena el monto con el available de cada línea.
     * Enlazado al botón "Seleccionar Todas" de la sublista de provisiones.
     */
    const selectAllProvisions = () => {
        try {
            const rec   = currentRecord.get();
            const count = rec.getLineCount({ sublistId: SRC_SUBLIST });

            for (let i = 0; i < count; i++) {
                const available = parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_available', line: i })) || 0;
                rec.selectLine({ sublistId: SRC_SUBLIST, line: i });
                rec.setCurrentSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', value: true,      ignoreFieldChange: true });
                rec.setCurrentSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_amount', value: available, ignoreFieldChange: true });
                rec.commitLine({ sublistId: SRC_SUBLIST });
            }

            recalcTotals(rec);
        } catch (e) {
            console.error(`[selectAllProvisions] ${e.message}`);
            alert(e.message);
        }
    };

    /**
     * Desmarca TODAS las provisiones y pone el monto a liquidar en 0.
     * Enlazado al botón "Desmarcar Todas" de la sublista de provisiones.
     */
    const deselectAllProvisions = () => {
        try {
            const rec   = currentRecord.get();
            const count = rec.getLineCount({ sublistId: SRC_SUBLIST });

            for (let i = 0; i < count; i++) {
                rec.selectLine({ sublistId: SRC_SUBLIST, line: i });
                rec.setCurrentSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', value: false, ignoreFieldChange: true });
                rec.setCurrentSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_amount', value: 0,     ignoreFieldChange: true });
                rec.commitLine({ sublistId: SRC_SUBLIST });
            }

            recalcTotals(rec);
        } catch (e) {
            console.error(`[deselectAllProvisions] ${e.message}`);
            alert(e.message);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  searchAccruals — Redirect GET con filtros
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Busca provisiones: redirige al mismo Suitelet con los filtros como parámetros GET.
     * DRD: Al dar click en "Buscar Provisiones", el DAO busca Accruals con los filtros seleccionados.
     */
    const searchAccruals = () => {
        try {
            const rec = currentRecord.get();

            // Leer valores — MULTISELECT retorna array de internal IDs
            const customerValue = rec.getValue({ fieldId: 'custpage_customer' });
            const agreementId   = rec.getValue({ fieldId: 'custpage_agreement' });
            const scenario      = rec.getValue({ fieldId: 'custpage_scenario' });
            const dateFrom      = rec.getText({ fieldId: 'custpage_date_from' });
            const dateTo        = rec.getText({ fieldId: 'custpage_date_to' });
            const itemValue     = rec.getValue({ fieldId: 'custpage_item' });
            const invoiceValue  = rec.getValue({ fieldId: 'custpage_source_invoice' });

            // DRD: Escenario es obligatorio
            if (!scenario) {
                alert('Debe seleccionar un Escenario de Liquidación.');
                return;
            }

            // Debe haber al menos un filtro: acuerdo, cliente o factura origen
            const hasAgreement = !!agreementId;
            const hasCustomer  = Array.isArray(customerValue) ? customerValue.filter(Boolean).length > 0 : !!customerValue;
            const hasInvoice   = Array.isArray(invoiceValue)  ? invoiceValue.filter(Boolean).length  > 0 : !!invoiceValue;
            const hasItem      = Array.isArray(itemValue)     ? itemValue.filter(Boolean).length     > 0 : !!itemValue;

            if (!hasAgreement && !hasCustomer && !hasInvoice && !hasItem) {
                alert('Debe seleccionar al menos un filtro: Acuerdo de Reembolso, Cliente o Factura Origen.');
                return;
            }

            // Serializar arrays con separador U+0005 (convención NetSuite para MULTISELECT en URL)
            const toParam = (val) => {
                if (!val) return '';
                return Array.isArray(val) ? val.filter(Boolean).join('\u0005') : String(val);
            };

            const params = {
                custpage_customer:       toParam(customerValue),
                custpage_agreement:      toParam(agreementId),
                custpage_date_from:      dateFrom || '',
                custpage_date_to:        dateTo   || '',
                custpage_scenario:       scenario,
                custpage_item:           toParam(itemValue),
                custpage_source_invoice: toParam(invoiceValue)
            };

            const suiteletUrl = url.resolveScript({
                scriptId:     'customscript_giv_sl_rebate_dashboard',
                deploymentId: 'customdeploy_giv_sl_dashboard',
                params:       params
            });

            window.location.href = suiteletUrl;

        } catch (e) {
            console.error(`[searchAccruals] ${e.message}`);
            alert(e.message);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  saveRecord — Validación antes de enviar el formulario
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Valida antes de enviar el formulario para procesar liquidación.
     * DRD Sección 4 y 5: Validaciones antes de crear WORK records.
     */
    const saveRecord = (context) => {
        const CREDIT_MEMO_METHOD = 3;  // Valor nativo NetSuite — Credit Memo
        const rec = currentRecord.get();

        // Leer el método de liquidación del acuerdo (hidden field)
        const settlementMethod = parseInt(rec.getValue({ fieldId: 'custpage_settlement_method' })) || null;
        const isCreditMemo = (settlementMethod === CREDIT_MEMO_METHOD);

        // ── Validar sublista ORIGEN ──
        const srcCount = rec.getLineCount({ sublistId: SRC_SUBLIST });
        let hasSelected = false;
        for (let i = 0; i < srcCount; i++) {
            if (rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', line: i })) {
                hasSelected = true;
                break;
            }
        }

        if (!hasSelected) {
            alert('Debe seleccionar al menos una provisión para liquidar.');
            return false;
        }

        // Verificar montos en origen
        for (let i = 0; i < srcCount; i++) {
            const selected = rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', line: i });
            if (selected) {
                const amount = parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_amount', line: i })) || 0;
                if (amount <= 0) {
                    alert(`La línea ${i + 1} seleccionada no tiene monto a liquidar.`);
                    return false;
                }
            }
        }

        // ── DRD Punto 4: Validar sublista DESTINO según método ──
        // Excepción: Cobro en exceso con CM no requiere factura destino (el CM se emite
        // sin aplicar a una factura específica — el excedente se reconoce globalmente).
        const scenario = rec.getValue({ fieldId: 'custpage_scenario' });
        const isExcess  = (scenario === 'Cobro en exceso');

        const dstCount = rec.getLineCount({ sublistId: DST_SUBLIST });
        let hasDstSelected = false;
        for (let j = 0; j < dstCount; j++) {
            if (rec.getSublistValue({ sublistId: DST_SUBLIST, fieldId: 'custpage_dst_select', line: j })) {
                hasDstSelected = true;
                break;
            }
        }

        if (isCreditMemo && !hasDstSelected && !isExcess) {
            alert('El acuerdo utiliza Credit Memo. Debe seleccionar al menos una factura destino.');
            return false;
        }

        if (!isCreditMemo && settlementMethod !== null && hasDstSelected) {
            alert('El acuerdo utiliza Vendor Bill. No debe seleccionar facturas destino.');
            return false;
        }

        // ── DRD Escenario 1 — Estándar ──────────────────────────────────────────
        // Permite múltiples líneas de provisión siempre y cuando pertenezcan a la misma factura origen.
        if (isCreditMemo && scenario === 'Estándar') {
            const selectedSourceInvoices = new Set();
            for (let i = 0; i < srcCount; i++) {
                if (rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_select', line: i })) {
                    const invId = rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId: 'custpage_src_invoice_id', line: i });
                    if (invId) selectedSourceInvoices.add(invId);
                }
            }

            if (selectedSourceInvoices.size > 1) {
                alert(
                    `En el escenario Estándar, todas las líneas de provisión seleccionadas deben pertenecer a la misma factura origen.\n` +
                    `Ha seleccionado provisiones de ${selectedSourceInvoices.size} facturas origen distintas.\n\n` +
                    `Si necesita liquidar provisiones de múltiples facturas origen en un solo Credit Memo, utilice el escenario "Consolidada".`
                );
                return false;
            }
        }

        return true;
    };

    /**
     * Exporta todas las provisiones mostradas en la sublista a un archivo CSV/Excel.
     */
    const exportToExcel = () => {
        try {
            const rec = currentRecord.get();
            const srcCount = rec.getLineCount({ sublistId: SRC_SUBLIST });

            if (srcCount === 0) {
                alert('No hay provisiones en pantalla para exportar.');
                return;
            }

            const headers = [
                'Acuerdo',
                'Factura Origen',
                'Artículo',
                'Fecha Provisión',
                'Provisión Original',
                'Monto Liquidado',
                'Devoluciones',
                'Saldo Disponible',
                'Monto a Liquidar',
                'Tasa Impuesto (%)',
                'Monto Impuesto',
                'Total Bruto',
                'Moneda'
            ];

            const rows = [headers];

            for (let i = 0; i < srcCount; i++) {
                const safeStr = (fieldId) => {
                    const val = rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId, line: i });
                    return val !== null && val !== undefined ? String(val) : '';
                };

                const safeNum = (fieldId) => {
                    const val = parseFloat(rec.getSublistValue({ sublistId: SRC_SUBLIST, fieldId, line: i })) || 0;
                    return val.toFixed(2);
                };

                rows.push([
                    safeStr('custpage_src_agreement'),
                    safeStr('custpage_src_invoice'),
                    safeStr('custpage_src_item'),
                    safeStr('custpage_src_date'),
                    safeNum('custpage_src_original'),
                    safeNum('custpage_src_settled'),
                    safeNum('custpage_src_returns'),
                    safeNum('custpage_src_available'),
                    safeNum('custpage_src_amount'),
                    safeNum('custpage_src_tax_rate'),
                    safeNum('custpage_src_tax_amt'),
                    safeNum('custpage_src_total_gross'),
                    safeStr('custpage_src_currency')
                ]);
            }

            // Formatear CSV con UTF-8 BOM (\uFEFF) para apertura perfecta en Microsoft Excel
            const csvContent = '\uFEFF' + rows.map(row => 
                row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')
            ).join('\r\n');

            // Crear Blob y activar descarga
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const today = new Date().toISOString().slice(0, 10);
            const fileName = `Reporte_Provisiones_Rebates_${today}.csv`;

            if (navigator.msSaveBlob) {
                navigator.msSaveBlob(blob, fileName);
            } else {
                link.href = URL.createObjectURL(blob);
                link.setAttribute('download', fileName);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }

        } catch (e) {
            console.error(`[exportToExcel] ${e.message || e}`);
            alert('Ocurrió un error al generar el archivo de Excel.');
        }
    };

    return {
        pageInit,
        fieldChanged,
        searchAccruals,
        saveRecord,
        selectAllProvisions,
        deselectAllProvisions,
        exportToExcel
    };
});
