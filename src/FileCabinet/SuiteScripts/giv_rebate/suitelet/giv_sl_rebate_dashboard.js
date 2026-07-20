/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Dashboard principal de liquidación de rebates.
 *              Interfaz centralizada para consultar provisiones, seleccionar montos,
 *              facturas destino y procesar liquidaciones.
 *              Las etiquetas se adaptan al idioma del usuario en NetSuite.
 */
define([
    'N/ui/serverWidget',
    'N/runtime',
    'N/task',
    'N/redirect',
    'N/log',
    '../lib/giv_rebate_constants',
    '../lib/giv_rebate_dao',
    '../lib/giv_rebate_validator',
    '../lib/giv_rebate_transaction_builder'
], (serverWidget, runtime, task, redirect, log, CONST, dao, validator, txnBuilder) => {

    const MODULE = 'giv_sl_rebate_dashboard';

    const onRequest = (context) => {
        if (context.request.method === 'GET') {
            renderDashboard(context);
        } else {
            processSubmission(context);
        }
    };

    /**
     * Renderiza el formulario principal del Dashboard.
     * Las etiquetas se obtienen dinámicamente según el idioma del usuario.
     */
    const renderDashboard = (context) => {
        try {
            const LBL = CONST.getLabels(runtime);

            const form = serverWidget.createForm({ title: LBL.FORM_TITLE });
            form.clientScriptModulePath = '../client/giv_cs_rebate_dashboard.js';

            // ── Filtros de Búsqueda ──
            form.addFieldGroup({ id: 'custpage_filter_group', label: LBL.FILTER_GROUP });

            form.addField({
                id: 'custpage_customer',
                type: serverWidget.FieldType.MULTISELECT,
                label: LBL.CUSTOMER,
                source: 'customer',
                container: 'custpage_filter_group'
            });

            form.addField({
                id: 'custpage_agreement',
                type: serverWidget.FieldType.MULTISELECT,
                label: LBL.AGREEMENT,
                source: 'customrecord_rm_sales_transaction',
                container: 'custpage_filter_group'
            });

            form.addField({
                id: 'custpage_source_invoice',
                type: serverWidget.FieldType.MULTISELECT,
                label: LBL.SOURCE_INVOICE,
                source: 'transaction',
                container: 'custpage_filter_group'
            });

            form.addField({
                id: 'custpage_item',
                type: serverWidget.FieldType.MULTISELECT,
                label: LBL.ITEM,
                source: 'item',
                container: 'custpage_filter_group'
            });

            form.addField({
                id: 'custpage_date_from',
                type: serverWidget.FieldType.DATE,
                label: LBL.DATE_FROM,
                container: 'custpage_filter_group'
            });

            form.addField({
                id: 'custpage_date_to',
                type: serverWidget.FieldType.DATE,
                label: LBL.DATE_TO,
                container: 'custpage_filter_group'
            });

            const scenarioField = form.addField({
                id: 'custpage_scenario',
                type: serverWidget.FieldType.SELECT,
                label: LBL.SCENARIO,
                container: 'custpage_filter_group'
            });
            scenarioField.addSelectOption({ value: '', text: '' });
            scenarioField.addSelectOption({ value: 'Estándar', text: LBL.SCENARIO_STANDARD });
            scenarioField.addSelectOption({ value: 'Consolidada', text: LBL.SCENARIO_CONSOLIDATED });
            scenarioField.addSelectOption({ value: 'Específica', text: LBL.SCENARIO_SPECIFIC });
            scenarioField.addSelectOption({ value: 'Cobro en exceso', text: LBL.SCENARIO_EXCESS });
            scenarioField.addSelectOption({ value: 'Agrupación', text: LBL.SCENARIO_GROUPED });
            scenarioField.isMandatory = true;

            // Botones
            form.addButton({ id: 'custpage_search_btn', label: LBL.BTN_SEARCH, functionName: 'searchAccruals' });
            form.addSubmitButton({ label: LBL.BTN_PROCESS });

            // ── Badge de total seleccionado (se actualiza dinámicamente via JS) ──
            const totalBadgeField = form.addField({
                id:   'custpage_selected_total',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            totalBadgeField.defaultValue = `
                <style>
                    #giv_total_badge {
                        display: inline-block;
                        background: #777;
                        color: #fff;
                        font-weight: 600;
                        font-size: 13px;
                        padding: 5px 16px;
                        border-radius: 20px;
                        margin: 4px 0 8px 0;
                        letter-spacing: 0.3px;
                        transition: background 0.3s;
                    }
                </style>
                <span id="giv_total_badge">Total seleccionado: 0.00</span>`;

            // ── Sublista: Reembolsos Disponibles ──
            const sourceSublist = form.addSublist({
                id: 'custpage_source_sublist',
                type: serverWidget.SublistType.LIST,
                label: LBL.SRC_TITLE
            });

            sourceSublist.addField({ id: 'custpage_src_select', type: serverWidget.FieldType.CHECKBOX, label: LBL.SELECT });
            sourceSublist.addField({ id: 'custpage_src_agreement', type: serverWidget.FieldType.TEXT, label: LBL.SRC_AGREEMENT });
            sourceSublist.addField({ id: 'custpage_src_invoice', type: serverWidget.FieldType.TEXT, label: LBL.SRC_INVOICE });
            sourceSublist.addField({ id: 'custpage_src_item', type: serverWidget.FieldType.TEXT, label: LBL.SRC_ITEM });
            sourceSublist.addField({ id: 'custpage_src_date', type: serverWidget.FieldType.TEXT, label: LBL.SRC_DATE });
            sourceSublist.addField({ id: 'custpage_src_original', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_ORIGINAL });
            sourceSublist.addField({ id: 'custpage_src_settled', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_SETTLED });
            sourceSublist.addField({ id: 'custpage_src_returns', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_RETURNS });
            sourceSublist.addField({ id: 'custpage_src_available', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_AVAILABLE });
            sourceSublist.addField({ id: 'custpage_src_amount', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_AMOUNT })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.ENTRY });
            sourceSublist.addField({ id: 'custpage_src_currency', type: serverWidget.FieldType.TEXT, label: LBL.CURRENCY });

            // ── Botones de selección masiva (dentro del toolbar de la sublista) ──
            sourceSublist.addButton({ id: 'custpage_select_all',   label: LBL.BTN_SELECT_ALL   || 'Seleccionar Todas', functionName: 'selectAllProvisions'   });
            sourceSublist.addButton({ id: 'custpage_deselect_all', label: LBL.BTN_DESELECT_ALL || 'Desmarcar Todas',   functionName: 'deselectAllProvisions' });

            // Campos ocultos
            sourceSublist.addField({ id: 'custpage_src_accrual_id', type: serverWidget.FieldType.TEXT, label: 'Accrual ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_agreement_id', type: serverWidget.FieldType.TEXT, label: 'Agreement ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_invoice_id', type: serverWidget.FieldType.TEXT, label: 'Invoice ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_item_id', type: serverWidget.FieldType.TEXT, label: 'Item ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_sett_method', type: serverWidget.FieldType.TEXT, label: 'Method' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_payer_id', type: serverWidget.FieldType.TEXT, label: 'Payer ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_acct_item', type: serverWidget.FieldType.TEXT, label: 'Acct Item' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });


            // ── Sublista: Facturas Destino ──
            // DRD: Solo se agrega al formulario si el método del acuerdo es Credit Memo.
            // Para Vendor Bill el panel completo (encabezados, montos, checkbox) no se renderiza.
            // Se declara null aquí y se inicializa más abajo, tras conocer el método.
            let destSublist = null;


            const params = context.request.parameters;
            log.debug({ title: `${MODULE}.renderDashboard - PARAMS RECEIVED`, details: JSON.stringify(params) });

            // ── Modal emergente de error de validación (viene del redirect POST) ──
            if (params.custpage_validation_error) {
                try {
                    const errMessages = decodeURIComponent(params.custpage_validation_error).split('||').filter(Boolean);
                    const errListHtml = errMessages.map(m => `<li style="margin:5px 0;line-height:1.4">${m}</li>`).join('');
                    const errPopup = form.addField({ id: 'custpage_err_banner', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
                    errPopup.defaultValue = `
                        <style>
                            @keyframes giv_slideDown {
                                from { opacity:0; transform:translateY(-30px); }
                                to   { opacity:1; transform:translateY(0);     }
                            }
                            #giv_err_modal {
                                position:fixed; top:18px; left:50%; transform:translateX(-50%);
                                z-index:99999; width:min(680px,92vw);
                                background:#fff8f8; border:1px solid #c62828; border-top:5px solid #c62828;
                                border-radius:8px; padding:18px 48px 18px 20px;
                                box-shadow:0 8px 32px rgba(0,0,0,0.22);
                                font-family:inherit; font-size:13px; color:#3b0000;
                                animation:giv_slideDown 0.28s ease;
                            }
                            #giv_err_modal strong { font-size:14px; }
                            #giv_err_modal ul { margin:8px 0 0 18px; padding:0; }
                            #giv_err_close {
                                position:absolute; top:10px; right:12px;
                                background:none; border:none; font-size:20px; line-height:1;
                                cursor:pointer; color:#c62828; padding:0 4px;
                            }
                            #giv_err_close:hover { color:#7f0000; }
                        </style>
                        <div id="giv_err_modal">
                            <button id="giv_err_close" onclick="document.getElementById('giv_err_modal').style.display='none'" title="Cerrar">&#10005;</button>
                            <strong>&#9888;&nbsp;Error de validaci&oacute;n</strong>
                            <ul>${errListHtml}</ul>
                        </div>`;
                } catch (_) { /* Si el decode falla, omitir el modal */ }
            }


            const hasFilters = params.custpage_agreement
                || params.custpage_customer
                || params.custpage_source_invoice
                || params.custpage_item;

            // ── Detectar método de liquidación del acuerdo seleccionado ──
            let settlementMethod = null;
            if (params.custpage_agreement) {
                // Si hay múltiples acuerdos, usar el primero para determinar el método
                const firstAgreementId = params.custpage_agreement.split('\u0005')[0];
                const agreement = dao.getAgreement(firstAgreementId);
                settlementMethod = agreement ? parseInt(agreement.settlement_method) : null;
                log.debug({ title: `${MODULE}.renderDashboard - Settlement Method`, details: `Agreement ${firstAgreementId} → method=${settlementMethod}` });
            }

            // Campo hidden para que el client script conozca el método
            const settlementMethodField = form.addField({
                id: 'custpage_settlement_method',
                type: serverWidget.FieldType.INTEGER,
                label: 'Settlement Method'
            });
            settlementMethodField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            if (settlementMethod) settlementMethodField.defaultValue = settlementMethod;

            // DRD: Agregar sublista destino SOLO si el método es Credit Memo
            if (settlementMethod === CONST.SETTLEMENT_METHOD.CREDIT_MEMO || settlementMethod === null) {
                destSublist = form.addSublist({
                    id: 'custpage_dest_sublist',
                    type: serverWidget.SublistType.LIST,
                    label: LBL.DST_TITLE
                });
                destSublist.addField({ id: 'custpage_dst_select', type: serverWidget.FieldType.CHECKBOX, label: LBL.SELECT });
                destSublist.addField({ id: 'custpage_dst_invoice_id', type: serverWidget.FieldType.TEXT, label: 'Invoice ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                destSublist.addField({ id: 'custpage_dst_invoice', type: serverWidget.FieldType.TEXT, label: LBL.DST_INVOICE });
                destSublist.addField({ id: 'custpage_dst_customer', type: serverWidget.FieldType.TEXT, label: LBL.DST_CUSTOMER });
                destSublist.addField({ id: 'custpage_dst_date', type: serverWidget.FieldType.TEXT, label: LBL.DST_DATE });
                destSublist.addField({ id: 'custpage_dst_total', type: serverWidget.FieldType.CURRENCY, label: LBL.DST_TOTAL });
                destSublist.addField({ id: 'custpage_dst_open', type: serverWidget.FieldType.CURRENCY, label: LBL.DST_OPEN });
                destSublist.addField({ id: 'custpage_dst_amount', type: serverWidget.FieldType.CURRENCY, label: LBL.DST_AMOUNT })
                    .updateDisplayType({ displayType: serverWidget.FieldDisplayType.ENTRY });
                destSublist.addField({ id: 'custpage_dst_currency', type: serverWidget.FieldType.TEXT, label: LBL.CURRENCY });
            }

            if (hasFilters) {
                const defaults = {};
                if (params.custpage_agreement)      defaults.custpage_agreement      = params.custpage_agreement;
                if (params.custpage_customer)        defaults.custpage_customer        = params.custpage_customer;
                if (params.custpage_source_invoice)  defaults.custpage_source_invoice  = params.custpage_source_invoice;
                if (params.custpage_scenario)        defaults.custpage_scenario        = params.custpage_scenario;
                if (params.custpage_date_from)       defaults.custpage_date_from       = params.custpage_date_from;
                if (params.custpage_date_to)         defaults.custpage_date_to         = params.custpage_date_to;
                if (params.custpage_item)            defaults.custpage_item            = params.custpage_item;
                form.updateDefaultValues(defaults);

                populateSourceSublist(sourceSublist, params);
                populateDestSublist(destSublist, params, settlementMethod);
            }

            // Campo hidden para acción POST
            const actionField = form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.TEXT,
                label: 'Action'
            });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

            context.response.writePage(form);

        } catch (e) {
            log.error({ title: `${MODULE}.renderDashboard`, details: e.message || e });
            throw e;
        }
    };

    /**
     * Puebla la sublista de provisiones disponibles.
     */
    const populateSourceSublist = (sublist, params) => {
        try {
            log.debug('Dashboard Params', params);
            const filters = {};
            if (params.custpage_agreement) {
                filters.agreementId = params.custpage_agreement.split('\u0005').filter(Boolean);
                log.debug('Filter Agreements', filters.agreementId);
            }
            if (params.custpage_customer) {
                filters.customerIds = params.custpage_customer.split('\u0005').filter(Boolean);
                log.debug('Filter Customers', filters.customerIds);
            }
            if (params.custpage_source_invoice) {
                filters.sourceInvoiceIds = params.custpage_source_invoice.split('\u0005').filter(Boolean);
            }
            if (params.custpage_item) {
                const itemParts = params.custpage_item.split('\u0005').filter(Boolean);
                if (itemParts.length > 1) {
                    filters.itemIds = itemParts;       // MULTISELECT: múltiples artículos
                } else if (itemParts.length === 1) {
                    filters.itemId = itemParts[0];     // un solo artículo
                }
            }
            if (params.custpage_date_from) filters.dateFrom = params.custpage_date_from;
            if (params.custpage_date_to) filters.dateTo = params.custpage_date_to;

            const accruals = dao.getAvailableAccruals(filters);
            log.debug('Accruals Found', accruals.length);

            sublist.label = 'Provisiones Disponibles (' + accruals.length + ')';

            accruals.forEach((accrual, index) => {
                // Función helper para valores seguros
                const safeValue = (val, defaultVal = 'N/A') => {
                    if (val === null || val === undefined || val === '') return defaultVal;
                    return String(val);
                };

                const safeNumber = (val) => {
                    const num = parseFloat(val) || 0;
                    return num.toFixed(2);
                };

                try {
                    sublist.setSublistValue({ id: 'custpage_src_select', line: index, value: 'F' });
                    sublist.setSublistValue({ id: 'custpage_src_agreement', line: index, value: safeValue(accrual.agreementText, 'Sin nombre') });
                    sublist.setSublistValue({ id: 'custpage_src_invoice', line: index, value: safeValue(accrual.invoiceNumber) });
                    sublist.setSublistValue({ id: 'custpage_src_item', line: index, value: safeValue(accrual.itemText) });
                    sublist.setSublistValue({ id: 'custpage_src_date', line: index, value: safeValue(accrual.accrualDate) });
                    sublist.setSublistValue({ id: 'custpage_src_original', line: index, value: safeNumber(accrual.accrualAmount) });
                    // Settled = Claim SuiteApp + WORK GIV Completados (ambas fuentes)
                    const totalSettled = (parseFloat(accrual.settledAmount) || 0) + (parseFloat(accrual.givSettledAmount) || 0);
                    sublist.setSublistValue({ id: 'custpage_src_settled', line: index, value: totalSettled.toFixed(2) });

                    sublist.setSublistValue({ id: 'custpage_src_returns',   line: index, value: safeNumber(accrual.returnsAmount) });
                    sublist.setSublistValue({ id: 'custpage_src_available',  line: index, value: safeNumber(accrual.availableAmount) });
                    // Pre-poblar "Monto a Liquidar" con el saldo disponible (editable por el usuario)
                    sublist.setSublistValue({ id: 'custpage_src_amount',     line: index, value: safeNumber(accrual.availableAmount) });
                    sublist.setSublistValue({ id: 'custpage_src_currency',   line: index, value: safeValue(accrual.currencyText, 'MXN') });

                    // Campos ocultos - SIEMPRE deben tener valor
                    sublist.setSublistValue({ id: 'custpage_src_accrual_id', line: index, value: safeValue(accrual.accrualId, '0') });
                    sublist.setSublistValue({ id: 'custpage_src_agreement_id', line: index, value: safeValue(accrual.agreementId, '0') });
                    sublist.setSublistValue({ id: 'custpage_src_invoice_id', line: index, value: safeValue(accrual.invoiceId, '0') });
                    sublist.setSublistValue({ id: 'custpage_src_item_id', line: index, value: safeValue(accrual.itemId, '0') });
                    // [FIX] Fallback era '2' — incorrecto. '0' fuerza al script a leer el método
                    // del header (custpage_settlement_method) si el accrual no trae el dato.
                    sublist.setSublistValue({ id: 'custpage_src_sett_method', line: index, value: safeValue(accrual.settlementMethod, '0') });
                    sublist.setSublistValue({ id: 'custpage_src_payer_id', line: index, value: safeValue(accrual.payerId, '0') });
                    sublist.setSublistValue({ id: 'custpage_src_acct_item', line: index, value: safeValue(accrual.accountingItem, '0') });
                } catch (lineError) {
                    log.error({
                        title: `${MODULE}.populateSourceSublist.line`,
                        details: `[Line=${index}] ${lineError.message || lineError}. Accrual: ${JSON.stringify(accrual)}`
                    });
                }
            });

            log.debug({ title: `${MODULE}.populateSourceSublist`, details: `Populated ${accruals.length} source lines` });

        } catch (e) {
            log.error({ title: `${MODULE}.populateSourceSublist`, details: e.message || e });
        }
    };

    /**
     * Puebla la sublista de facturas destino.
     * Solo se ejecuta cuando el método de liquidación del acuerdo es Credit Memo.
     *
     * @param {Object} sublist
     * @param {Object} params
     * @param {number|null} settlementMethod  - Valor numérico de custrecord_rm_settlement_method
     */
    const populateDestSublist = (sublist, params, settlementMethod) => {
        try {
            if (!params.custpage_agreement) return;

            // DRD Punto 4: Solo mostrar facturas destino cuando el método sea Credit Memo
            if (settlementMethod !== null && settlementMethod !== CONST.SETTLEMENT_METHOD.CREDIT_MEMO) {
                log.debug({
                    title: `${MODULE}.populateDestSublist`,
                    details: `Método de liquidación (${settlementMethod}) no es Credit Memo. Sublista destino no se pobla.`
                });
                return;
            }

            // Parsear multiselect de acuerdos (\u0005 es el delimitador de NetSuite multiselect)
            const agreementIds = (params.custpage_agreement || '').split('\u0005').map(s => s.trim()).filter(Boolean);
            if (agreementIds.length === 0) return;

            const customerIds = dao.getCustomersByAgreement(agreementIds);
            if (customerIds.length === 0) {
                log.debug({ title: `${MODULE}.populateDestSublist`, details: `No customers found for agreements: [${agreementIds.join(',')}]` });
                return;
            }


            const invoices = dao.getOpenInvoices(customerIds);

            invoices.forEach((inv, index) => {
                sublist.setSublistValue({ id: 'custpage_dst_invoice_id', line: index, value: inv.invoiceId });
                sublist.setSublistValue({ id: 'custpage_dst_invoice', line: index, value: inv.tranId || '' });
                sublist.setSublistValue({ id: 'custpage_dst_customer', line: index, value: inv.customerText || '' });
                sublist.setSublistValue({ id: 'custpage_dst_date', line: index, value: inv.date || '' });
                sublist.setSublistValue({ id: 'custpage_dst_total', line: index, value: inv.total.toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_dst_open', line: index, value: inv.amountRemaining.toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_dst_amount', line: index, value: inv.amountRemaining.toFixed(2) }); // pre-populated, editable
                sublist.setSublistValue({ id: 'custpage_dst_currency', line: index, value: inv.currencyText || '' });
            });

            log.debug({ title: `${MODULE}.populateDestSublist`, details: `Populated ${invoices.length} destination lines` });

        } catch (e) {
            log.error({ title: `${MODULE}.populateDestSublist`, details: e.message || e });
        }
    };

    /**
     * Procesa la selección: crea WORK records y dispara Map/Reduce.
     */
    const processSubmission = (context) => {
        try {
            const request = context.request;
            const scenario = request.parameters.custpage_scenario;

            // Recolectar líneas origen seleccionadas
            const sourceCount = request.getLineCount({ group: 'custpage_source_sublist' });
            const sourceLines = [];
            for (let i = 0; i < sourceCount; i++) {
                const selected = request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_select', line: i });
                if (selected === 'T') {
                    sourceLines.push({
                        accrualId: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_accrual_id', line: i }),
                        agreementId: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_agreement_id', line: i }),
                        sourceInvoiceId: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_invoice_id', line: i }),
                        sourceItemId: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_item_id', line: i }),
                        originalAmount: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_original', line: i }),
                        availableAmount: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_available', line: i }),
                        amountToSettle: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_amount', line: i }),
                        settledAmount: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_settled', line: i }),
                        returnsAmount: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_returns', line: i }),
                        settlementMethod: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_sett_method', line: i }),
                        payerId: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_payer_id', line: i }),
                        accountingItem: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_acct_item', line: i }),
                        currency: request.getSublistValue({ group: 'custpage_source_sublist', name: 'custpage_src_currency', line: i })
                    });
                }
            }

            // Recolectar líneas destino seleccionadas
            const destCount = request.getLineCount({ group: 'custpage_dest_sublist' });
            const destLines = [];
            for (let j = 0; j < destCount; j++) {
                const selected = request.getSublistValue({ group: 'custpage_dest_sublist', name: 'custpage_dst_select', line: j });
                if (selected === 'T') {
                    destLines.push({
                        invoiceId: request.getSublistValue({ group: 'custpage_dest_sublist', name: 'custpage_dst_invoice_id', line: j }),
                        applyAmount: request.getSublistValue({ group: 'custpage_dest_sublist', name: 'custpage_dst_amount', line: j })
                    });
                }
            }

            // [FIX] Fuente autoritativa del settlement method: si la línea trae '0'/vacío
            // (por el fallback corregido), se toma del campo header que SÍ lo leeó del acuerdo.
            const headerSettlementMethod = request.parameters.custpage_settlement_method || '';
            const rawLineMethod = sourceLines.length > 0 ? sourceLines[0].settlementMethod : '';
            const settlementMethod = (rawLineMethod && rawLineMethod !== '0')
                ? rawLineMethod
                : headerSettlementMethod;


            /**
             * Helper interno: redirige al dashboard GET con el error en la URL.
             * Preserva los filtros activos para que el usuario no tenga que reseleccionarlos.
             */
            const redirectWithError = (errors) => {
                const errParam = encodeURIComponent(errors.join('||'));
                redirect.toSuitelet({
                    scriptId:     'customscript_giv_sl_rebate_dashboard',
                    deploymentId: 'customdeploy_giv_sl_dashboard',
                    parameters: {
                        custpage_validation_error:  errParam,
                        custpage_agreement:         request.parameters.custpage_agreement         || '',
                        custpage_customer:           request.parameters.custpage_customer           || '',
                        custpage_source_invoice:    request.parameters.custpage_source_invoice    || '',
                        custpage_item:              request.parameters.custpage_item              || '',
                        custpage_scenario:          request.parameters.custpage_scenario          || '',
                        custpage_date_from:         request.parameters.custpage_date_from         || '',
                        custpage_date_to:           request.parameters.custpage_date_to           || ''
                    }
                });
            };

            // Validaciones
            const scenarioValidation = validator.validateScenarioRules(scenario, sourceLines, destLines, settlementMethod);
            if (!scenarioValidation.valid) {
                redirectWithError(scenarioValidation.errors);
                return;
            }

            if (settlementMethod === '3') {  // Credit Memo: validar balance origen = destino
                const sourceTotal = sourceLines.reduce((sum, l) => sum + (parseFloat(l.amountToSettle) || 0), 0);
                const destTotal = destLines.reduce((sum, l) => sum + (parseFloat(l.applyAmount) || 0), 0);
                const balanceValidation = validator.validateAmountBalance(sourceTotal, destTotal, scenario);
                if (!balanceValidation.valid) {
                    redirectWithError([balanceValidation.message]);
                    return;
                }
            }

            // Validación de concurrencia + bloqueo de monto > disponible en tiempo real
            for (const srcLine of sourceLines) {
                const concurrencyCheck = validator.validateAvailableAmount(
                    srcLine.accrualId,
                    srcLine.sourceItemId,
                    parseFloat(srcLine.amountToSettle) || 0,
                    scenario,
                    parseFloat(srcLine.availableAmount) || 0   // [FIX] pasar el saldo disponible
                );
                if (!concurrencyCheck.valid) {
                    redirectWithError([concurrencyCheck.message]);
                    return;
                }
            }

            // Obtener cliente del acuerdo
            const agreementId = sourceLines.length > 0 ? sourceLines[0].agreementId : '';
            const customerIds = dao.getCustomersByAgreement(agreementId);
            const customerId = customerIds.length > 0 ? customerIds[0] : '';

            // Crear registros WORK
            const workIds = [];
            const isEstandardCM = settlementMethod === '3' && scenario === 'Estándar';

            // ── DRD Escenario 1 "uno a uno": emparejamiento posicional ──
            // Para Estándar+CM cada origen[i] se empareja con destino[i].
            // La validación del client script garantiza que ambas listas tienen
            // el mismo número de elementos antes de llegar aquí.

            sourceLines.forEach((srcLine, srcIndex) => {
                let taxInfo = { taxCodeId: '', taxRate: 0 };
                if (srcLine.sourceInvoiceId && srcLine.sourceItemId) {
                    taxInfo = dao.getTaxInfoFromInvoiceLine(srcLine.sourceInvoiceId, srcLine.sourceItemId);
                }

                // Para Estándar + CM: el reduce procesa cada WORK de forma individual
                // (key única). invoiceTo y applyAmount deben ir embebidos en el mismo
                // registro fuente para que el CM se aplique en el mismo reduce call.
                // Para Consolidada/Agrupación/Exceso: los registros destino van separados
                // (el reduce los agrupa todos bajo la misma key).
                const pairedDest = isEstandardCM ? (destLines[srcIndex] || null) : null;

                const workData = {
                    customerId:       customerId,
                    agreementId:      srcLine.agreementId,
                    settlementMethod: settlementMethod,
                    scenario:         scenario,
                    sourceInvoiceId:  srcLine.sourceInvoiceId,
                    sourceAccrualId:  srcLine.accrualId,
                    sourceItemId:     srcLine.sourceItemId,
                    originalAmount:   srcLine.originalAmount,
                    returnsAmount:    srcLine.returnsAmount  || '0',
                    settledAmount:    srcLine.settledAmount  || '0',
                    availableAmount:  srcLine.availableAmount,
                    amountToSettle:   srcLine.amountToSettle,
                    taxCodeId:        taxInfo.taxCodeId,
                    taxBasis:         srcLine.amountToSettle,
                    excessFlag:       scenario === 'Cobro en exceso',
                    // Estándar: origen[i] ↔ destino[i] (emparejamiento posicional)
                    invoiceTo:   pairedDest ? pairedDest.invoiceId   || '' : '',
                    applyAmount: pairedDest ? pairedDest.applyAmount || '0' : '0'
                };

                const workId = txnBuilder.createWorkRecord(workData, 'Suitelet');
                workIds.push(workId);
            });

            // Consolidada / Agrupación / Cobro en exceso + Credit Memo:
            // crear UN registro de aplicación por factura destino (M total).
            // El reduce los agrupa todos bajo la misma key de acuerdo y los procesa juntos.
            // NO aplica a Estándar (ya lleva el destino embebido en el registro fuente).
            if (settlementMethod === '3' && destLines.length > 0 && !isEstandardCM) {
                const firstSrc = sourceLines[0];
                destLines.forEach((dst) => {
                    const dstWorkData = {
                        customerId:       customerId,
                        agreementId:      firstSrc.agreementId,
                        settlementMethod: settlementMethod,
                        scenario:         scenario,
                        // Campos de fuente vacíos — este registro solo define la aplicación
                        sourceInvoiceId:  '',
                        sourceAccrualId:  '',
                        sourceItemId:     '',
                        originalAmount:   '0',
                        returnsAmount:    '0',
                        settledAmount:    '0',
                        availableAmount:  '0',
                        amountToSettle:   '0',   // ← no genera línea en el CM
                        taxCodeId:        '',
                        taxBasis:         '0',
                        excessFlag:       false,
                        invoiceTo:    dst.invoiceId   || '',
                        applyAmount:  dst.applyAmount || ''
                    };
                    const workId = txnBuilder.createWorkRecord(dstWorkData, 'Suitelet', { ignoreMandatoryFields: true });
                    workIds.push(workId);
                });
            }


            // Disparar Map/Reduce
            const mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: 'customscript_giv_mr_liquidation',
                deploymentId: 'customdeploy_giv_mr_liquidation'
            });
            const mrTaskId = mrTask.submit();

            log.audit({
                title: `${MODULE}.processSubmission`,
                details: `Created ${workIds.length} WORK records. M/R task: ${mrTaskId}`
            });

            // Redirect a pantalla de estado
            redirect.toSuitelet({
                scriptId: 'customscript_giv_sl_rebate_status',
                deploymentId: 'customdeploy_giv_sl_status',
                parameters: {
                    custpage_mr_task_id: mrTaskId,
                    custpage_work_count: workIds.length
                }
            });

        } catch (e) {
            log.error({ title: `${MODULE}.processSubmission`, details: e.message || e });
            renderErrorPage(context, [e.message]);
        }
    };

    /**
     * Renderiza página de error con etiquetas localizadas.
     */
    const renderErrorPage = (context, errors) => {
        const LBL = CONST.getLabels(runtime);
        const form = serverWidget.createForm({ title: LBL.ERROR_TITLE });

        const errorField = form.addField({
            id: 'custpage_errors',
            type: serverWidget.FieldType.LONGTEXT,
            label: LBL.ERROR_LABEL
        });
        errorField.defaultValue = errors.join('\n');
        errorField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

        form.addButton({
            id: 'custpage_back',
            label: LBL.BTN_BACK,
            functionName: 'history.back()'
        });

        context.response.writePage(form);
    };

    return { onRequest };
});
