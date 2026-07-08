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
                type: serverWidget.FieldType.SELECT,
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
            sourceSublist.addField({ id: 'custpage_src_locked', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_LOCKED });
            sourceSublist.addField({ id: 'custpage_src_available', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_AVAILABLE });
            sourceSublist.addField({ id: 'custpage_src_amount', type: serverWidget.FieldType.CURRENCY, label: LBL.SRC_AMOUNT })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.ENTRY });
            sourceSublist.addField({ id: 'custpage_src_currency', type: serverWidget.FieldType.TEXT, label: LBL.CURRENCY });

            // Campos ocultos
            sourceSublist.addField({ id: 'custpage_src_accrual_id', type: serverWidget.FieldType.TEXT, label: 'Accrual ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_agreement_id', type: serverWidget.FieldType.TEXT, label: 'Agreement ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_invoice_id', type: serverWidget.FieldType.TEXT, label: 'Invoice ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_item_id', type: serverWidget.FieldType.TEXT, label: 'Item ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_sett_method', type: serverWidget.FieldType.TEXT, label: 'Method' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_payer_id', type: serverWidget.FieldType.TEXT, label: 'Payer ID' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            sourceSublist.addField({ id: 'custpage_src_acct_item', type: serverWidget.FieldType.TEXT, label: 'Acct Item' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

            // ── Sublista: Facturas Destino ──
            const destSublist = form.addSublist({
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
            destSublist.addField({ id: 'custpage_dst_amount', type: serverWidget.FieldType.CURRENCY, label: LBL.DST_AMOUNT });
            destSublist.addField({ id: 'custpage_dst_currency', type: serverWidget.FieldType.TEXT, label: LBL.CURRENCY });

            // ── Poblar sublistas si hay filtros en la URL ──
            const params = context.request.parameters;
            if (params.custpage_agreement || params.custpage_customer) {
                const defaults = {};
                if (params.custpage_agreement) defaults.custpage_agreement = params.custpage_agreement;
                if (params.custpage_scenario) defaults.custpage_scenario = params.custpage_scenario;
                if (params.custpage_date_from) defaults.custpage_date_from = params.custpage_date_from;
                if (params.custpage_date_to) defaults.custpage_date_to = params.custpage_date_to;
                if (params.custpage_item) defaults.custpage_item = params.custpage_item;
                form.updateDefaultValues(defaults);

                populateSourceSublist(sourceSublist, params);
                populateDestSublist(destSublist, params);
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
            log.error({ title: `${MODULE}.renderDashboard`, details: e.message });
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
                filters.agreementId = params.custpage_agreement.split('\u0005');
                log.debug('Filter Agreements', filters.agreementId);
            }
            if (params.custpage_customer) filters.customerIds = params.custpage_customer.split('\u0005');
            if (params.custpage_source_invoice) filters.sourceInvoiceIds = params.custpage_source_invoice.split('\u0005');
            if (params.custpage_item) filters.itemId = params.custpage_item;
            if (params.custpage_date_from) filters.dateFrom = params.custpage_date_from;
            if (params.custpage_date_to) filters.dateTo = params.custpage_date_to;

            const accruals = dao.getAvailableAccruals(filters);
            log.debug('Accruals Found', accruals.length);
            
            sublist.label = 'Provisiones Disponibles (' + accruals.length + ')';

            accruals.forEach((accrual, index) => {
                sublist.setSublistValue({ id: 'custpage_src_select', line: index, value: 'F' });
                sublist.setSublistValue({ id: 'custpage_src_agreement', line: index, value: accrual.agreementText || ' ' });
                sublist.setSublistValue({ id: 'custpage_src_invoice', line: index, value: accrual.invoiceNumber || ' ' });
                sublist.setSublistValue({ id: 'custpage_src_item', line: index, value: accrual.itemText || ' ' });
                sublist.setSublistValue({ id: 'custpage_src_date', line: index, value: accrual.accrualDate || ' ' });
                sublist.setSublistValue({ id: 'custpage_src_original', line: index, value: (accrual.accrualAmount || 0).toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_src_settled', line: index, value: (accrual.settledAmount || 0).toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_src_returns', line: index, value: (accrual.returnsAmount || 0).toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_src_locked', line: index, value: (accrual.lockedAmount || 0).toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_src_available', line: index, value: (accrual.availableAmount || 0).toFixed(2) });
                sublist.setSublistValue({ id: 'custpage_src_currency', line: index, value: accrual.currencyText || ' ' });

                // Campos ocultos
                sublist.setSublistValue({ id: 'custpage_src_accrual_id', line: index, value: accrual.accrualId });
                sublist.setSublistValue({ id: 'custpage_src_agreement_id', line: index, value: accrual.agreementId || '' });
                sublist.setSublistValue({ id: 'custpage_src_invoice_id', line: index, value: accrual.invoiceId || '' });
                sublist.setSublistValue({ id: 'custpage_src_item_id', line: index, value: accrual.itemId || '' });
                sublist.setSublistValue({ id: 'custpage_src_sett_method', line: index, value: accrual.settlementMethod || '' });
                sublist.setSublistValue({ id: 'custpage_src_payer_id', line: index, value: accrual.payerId || '' });
                sublist.setSublistValue({ id: 'custpage_src_acct_item', line: index, value: accrual.accountingItem || '' });
            });

            log.debug({ title: `${MODULE}.populateSourceSublist`, details: `Populated ${accruals.length} source lines` });

        } catch (e) {
            log.error({ title: `${MODULE}.populateSourceSublist`, details: e.message });
        }
    };

    /**
     * Puebla la sublista de facturas destino.
     */
    const populateDestSublist = (sublist, params) => {
        try {
            if (!params.custpage_agreement) return;

            const customerIds = dao.getCustomersByAgreement(params.custpage_agreement);
            if (customerIds.length === 0) {
                log.debug({ title: `${MODULE}.populateDestSublist`, details: 'No customers found for agreement' });
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
                sublist.setSublistValue({ id: 'custpage_dst_currency', line: index, value: inv.currencyText || '' });
            });

            log.debug({ title: `${MODULE}.populateDestSublist`, details: `Populated ${invoices.length} destination lines` });

        } catch (e) {
            log.error({ title: `${MODULE}.populateDestSublist`, details: e.message });
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

            const settlementMethod = sourceLines.length > 0 ? sourceLines[0].settlementMethod : '';

            // Validaciones
            const scenarioValidation = validator.validateScenarioRules(scenario, sourceLines, destLines, settlementMethod);
            if (!scenarioValidation.valid) {
                renderErrorPage(context, scenarioValidation.errors);
                return;
            }

            if (settlementMethod === '2') {
                const sourceTotal = sourceLines.reduce((sum, l) => sum + (parseFloat(l.amountToSettle) || 0), 0);
                const destTotal = destLines.reduce((sum, l) => sum + (parseFloat(l.applyAmount) || 0), 0);
                const balanceValidation = validator.validateAmountBalance(sourceTotal, destTotal, scenario);
                if (!balanceValidation.valid) {
                    renderErrorPage(context, [balanceValidation.message]);
                    return;
                }
            }

            // Validación de concurrencia en tiempo real
            for (const srcLine of sourceLines) {
                const concurrencyCheck = validator.validateAvailableAmount(
                    srcLine.accrualId,
                    srcLine.sourceItemId,
                    parseFloat(srcLine.amountToSettle) || 0,
                    scenario
                );
                if (!concurrencyCheck.valid) {
                    renderErrorPage(context, [concurrencyCheck.message]);
                    return;
                }
            }

            // Obtener cliente del acuerdo
            const agreementId = sourceLines.length > 0 ? sourceLines[0].agreementId : '';
            const customerIds = dao.getCustomersByAgreement(agreementId);
            const customerId = customerIds.length > 0 ? customerIds[0] : '';

            // Crear registros WORK
            const workIds = [];
            sourceLines.forEach((srcLine) => {
                let taxInfo = { taxCodeId: '', taxRate: 0 };
                if (srcLine.sourceInvoiceId && srcLine.sourceItemId) {
                    taxInfo = dao.getTaxInfoFromInvoiceLine(srcLine.sourceInvoiceId, srcLine.sourceItemId);
                }

                const workData = {
                    customerId: customerId,
                    agreementId: srcLine.agreementId,
                    settlementMethod: settlementMethod,
                    scenario: scenario,
                    sourceInvoiceId: srcLine.sourceInvoiceId,
                    sourceAccrualId: srcLine.accrualId,
                    sourceItemId: srcLine.sourceItemId,
                    originalAmount: srcLine.originalAmount,
                    returnsAmount: srcLine.returnsAmount || '0',
                    settledAmount: srcLine.settledAmount || '0',
                    availableAmount: srcLine.availableAmount,
                    amountToSettle: srcLine.amountToSettle,
                    taxCodeId: taxInfo.taxCodeId,
                    taxBasis: srcLine.amountToSettle,
                    excessFlag: scenario === 'Cobro en exceso'
                };

                if (settlementMethod === '2' && destLines.length > 0) {
                    destLines.forEach((dst) => {
                        const workWithDest = Object.assign({}, workData, {
                            invoiceTo: dst.invoiceId || '',
                            applyAmount: dst.applyAmount || ''
                        });
                        const workId = txnBuilder.createWorkRecord(workWithDest, 'Suitelet');
                        workIds.push(workId);
                    });
                } else {
                    const workId = txnBuilder.createWorkRecord(workData, 'Suitelet');
                    workIds.push(workId);
                }
            });

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
            log.error({ title: `${MODULE}.processSubmission`, details: e.message });
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
