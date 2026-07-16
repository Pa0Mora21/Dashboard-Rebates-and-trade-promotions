/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @description Client Script para el Dashboard de Liquidación de Rebates.
 *              Maneja la búsqueda de provisiones (redirect GET) y validación antes de procesar (saveRecord).
 *
 *              DRD Sección 2: Los filtros de búsqueda deben incluir Cliente, Acuerdo,
 *              Factura Origen, Artículo, Fechas y Escenario.
 */
define(['N/url', 'N/currentRecord'], (url, currentRecord) => {

    const MODULE = 'giv_cs_rebate_dashboard';

    /**
     * fieldChanged — Maneja cambios en campos del formulario.
     * Automatiza el llenado del monto a liquidar cuando se selecciona una línea.
     */
    const fieldChanged = (context) => {
        const rec = context.currentRecord;
        const sublistId = context.sublistId;
        const fieldId = context.fieldId;

        // Si cambia el checkbox de selección en la sublista de provisiones
        if (sublistId === 'custpage_source_sublist' && fieldId === 'custpage_src_select') {
            const line = context.line;
            const isSelected = rec.getSublistValue({ sublistId, fieldId, line });

            // Seleccionar la línea para poder editarla
            rec.selectLine({ sublistId, line });

            if (isSelected) {
                // Si se selecciona, copiar el saldo disponible al monto a liquidar
                let available = rec.getCurrentSublistValue({ sublistId, fieldId: 'custpage_src_available' });
                available = parseFloat(available) || 0;
                rec.setCurrentSublistValue({ sublistId, fieldId: 'custpage_src_amount', value: available, ignoreFieldChange: true });
            } else {
                // Si se deselecciona, limpiar el monto
                rec.setCurrentSublistValue({ sublistId, fieldId: 'custpage_src_amount', value: 0, ignoreFieldChange: true });
            }

            // commitLine es necesario para que getSublistValue en saveRecord lea el valor actualizado.
            // Sin commitLine, el valor queda uncommitted y la validación lee 0.
            rec.commitLine({ sublistId });
        }
    };

    /**
     * pageInit — Se ejecuta al cargar la página.
     */
    const pageInit = (context) => {
        // Nada especial por ahora
    };

    /**
     * Busca provisiones: redirige al mismo Suitelet con los filtros como parámetros GET.
     * DRD: Al dar click en "Buscar Provisiones", el DAO busca Accruals con los filtros seleccionados.
     */
    const searchAccruals = () => {
        try {
            const rec = currentRecord.get();

            // Leer valores — MULTISELECT retorna array de internal IDs
            const customerValue = rec.getValue({ fieldId: 'custpage_customer' });
            const agreementId = rec.getValue({ fieldId: 'custpage_agreement' });
            const scenario = rec.getValue({ fieldId: 'custpage_scenario' });
            const dateFrom = rec.getText({ fieldId: 'custpage_date_from' });
            const dateTo = rec.getText({ fieldId: 'custpage_date_to' });
            const itemValue = rec.getValue({ fieldId: 'custpage_item' });
            const invoiceValue = rec.getValue({ fieldId: 'custpage_source_invoice' });

            // DRD: Escenario es obligatorio
            if (!scenario) {
                alert('Debe seleccionar un Escenario de Liquidación.');
                return;
            }

            // Debe haber al menos un filtro: acuerdo, cliente o factura origen
            const hasAgreement = !!agreementId;
            const hasCustomer = Array.isArray(customerValue) ? customerValue.filter(Boolean).length > 0 : !!customerValue;
            const hasInvoice = Array.isArray(invoiceValue) ? invoiceValue.filter(Boolean).length > 0 : !!invoiceValue;
            const hasItem = Array.isArray(itemValue) ? itemValue.filter(Boolean).length > 0 : !!itemValue;

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
                custpage_customer: toParam(customerValue),
                custpage_agreement: toParam(agreementId),
                custpage_date_from: dateFrom || '',
                custpage_date_to: dateTo || '',
                custpage_scenario: scenario,
                custpage_item: toParam(itemValue),
                custpage_source_invoice: toParam(invoiceValue)
            };

            const suiteletUrl = url.resolveScript({
                scriptId: 'customscript_giv_sl_rebate_dashboard',
                deploymentId: 'customdeploy_giv_sl_dashboard',
                params: params
            });

            window.location.href = suiteletUrl;

        } catch (e) {
            console.error(`${MODULE}.searchAccruals: ${e.message}`);
            alert(e.message);
        }
    };

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
        const srcCount = rec.getLineCount({ sublistId: 'custpage_source_sublist' });
        let hasSelected = false;
        for (let i = 0; i < srcCount; i++) {
            if (rec.getSublistValue({ sublistId: 'custpage_source_sublist', fieldId: 'custpage_src_select', line: i })) {
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
            const selected = rec.getSublistValue({ sublistId: 'custpage_source_sublist', fieldId: 'custpage_src_select', line: i });
            if (selected) {
                const amount = parseFloat(rec.getSublistValue({ sublistId: 'custpage_source_sublist', fieldId: 'custpage_src_amount', line: i })) || 0;
                if (amount <= 0) {
                    alert(`La línea ${i + 1} seleccionada no tiene monto a liquidar.`);
                    return false;
                }
            }
        }

        // ── DRD Punto 4: Validar sublista DESTINO según método ──
        const dstCount = rec.getLineCount({ sublistId: 'custpage_dest_sublist' });
        let hasDstSelected = false;
        for (let j = 0; j < dstCount; j++) {
            if (rec.getSublistValue({ sublistId: 'custpage_dest_sublist', fieldId: 'custpage_dst_select', line: j })) {
                hasDstSelected = true;
                break;
            }
        }

        if (isCreditMemo && !hasDstSelected) {
            alert('El acuerdo utiliza Credit Memo. Debe seleccionar al menos una factura destino.');
            return false;
        }

        if (!isCreditMemo && settlementMethod !== null && hasDstSelected) {
            alert('El acuerdo utiliza Vendor Bill. No debe seleccionar facturas destino.');
            return false;
        }

        return true;
    };

    return {
        pageInit,
        fieldChanged,
        searchAccruals,
        saveRecord
    };
});
