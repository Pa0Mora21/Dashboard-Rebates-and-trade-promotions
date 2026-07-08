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
                // Si se selecciona, copiar el saldo disponible al monto a liquidar (usar 0 si está vacío)
                let available = rec.getSublistValue({ sublistId, fieldId: 'custpage_src_available', line });
                available = parseFloat(available) || 0;
                rec.setCurrentSublistValue({ sublistId, fieldId: 'custpage_src_amount', value: available, ignoreFieldChange: true });
            } else {
                // Si se deselecciona, limpiar el monto
                rec.setCurrentSublistValue({ sublistId, fieldId: 'custpage_src_amount', value: 0, ignoreFieldChange: true });
            }
            
            // No hacemos commitLine porque es una sublista de tipo LIST (estática)
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

            const agreementId = rec.getValue({ fieldId: 'custpage_agreement' });
            const scenario = rec.getValue({ fieldId: 'custpage_scenario' });
            const dateFrom = rec.getText({ fieldId: 'custpage_date_from' });
            const dateTo = rec.getText({ fieldId: 'custpage_date_to' });
            const itemId = rec.getValue({ fieldId: 'custpage_item' });

            // DRD: Escenario es obligatorio
            if (!scenario) {
                alert('Debe seleccionar un Escenario de Liquidación.');
                return;
            }

            // Debe haber al menos un filtro (acuerdo o cliente)
            if (!agreementId) {
                alert('Debe seleccionar un Acuerdo de Reembolso.');
                return;
            }

            const params = {
                custpage_agreement: Array.isArray(agreementId) ? agreementId.join('\u0005') : agreementId,
                custpage_date_from: dateFrom || '',
                custpage_date_to: dateTo || '',
                custpage_scenario: scenario,
                custpage_item: itemId || ''
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
     * DRD Sección 5: Validaciones antes de crear WORK records.
     */
    const saveRecord = (context) => {
        const rec = currentRecord.get();

        // Verificar que haya al menos una línea seleccionada
        const lineCount = rec.getLineCount({ sublistId: 'custpage_source_sublist' });
        let hasSelected = false;
        for (let i = 0; i < lineCount; i++) {
            const selected = rec.getSublistValue({
                sublistId: 'custpage_source_sublist',
                fieldId: 'custpage_src_select',
                line: i
            });
            if (selected) {
                hasSelected = true;
                break;
            }
        }

        if (!hasSelected) {
            alert('Debe seleccionar al menos una provisión para liquidar.');
            return false;
        }

        // Verificar montos ingresados
        for (let i = 0; i < lineCount; i++) {
            const selected = rec.getSublistValue({
                sublistId: 'custpage_source_sublist',
                fieldId: 'custpage_src_select',
                line: i
            });
            if (selected) {
                const amount = parseFloat(rec.getSublistValue({
                    sublistId: 'custpage_source_sublist',
                    fieldId: 'custpage_src_amount',
                    line: i
                })) || 0;

                if (amount <= 0) {
                    alert(`La línea ${i + 1} seleccionada no tiene monto a liquidar.`);
                    return false;
                }
            }
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
