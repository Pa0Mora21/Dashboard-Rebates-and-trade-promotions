/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Constantes centralizadas para el módulo de liquidación de rebates.
 *              Todos los valores de enumeración se manejan en código — no se usan Custom Lists.
 *              Los campos en los Custom Records son Free-Form Text y almacenan estos valores.
 */
define([], () => {

    // ═══════════════════════════════════════════════════════════════
    //  Records del SuiteApp de Rebate Management
    // ═══════════════════════════════════════════════════════════════

    const RM_RECORDS = Object.freeze({
        ACCRUALS: 'customrecord_rm_accruals',
        AGREEMENT: 'customrecord_rm_sales_transaction',
        AGREEMENT_DETAILS: 'customrecord_rebate_agreement_details',
        TRANSACTIONS: 'customrecord_rm_transactions'
    });

    /**
     * Campos del record Accruals (customrecord_rm_accruals)
     */
    const RM_ACCRUAL_FIELDS = Object.freeze({
        AGREEMENT: 'custrecord_rm_accru_ra',
        AMOUNT: 'custrecord_rm_accrual_amount',
        DATE: 'custrecord_rm_accru_date',
        PERIOD_START: 'custrecord_rm_trans_start_date',
        PERIOD_END: 'custrecord_rm_trans_end_date',
        PAYABLE_ACCOUNT: 'custrecord_rm_accru_payable',
        EXPENSE_ACCOUNT: 'custrecord_rm_accru_expense',
        BASE_TRANSACTION: 'custrecord_rm_accrual_base_transaction',
        TYPE: 'custrecord_accru_rm_type',
        PERIOD: 'custrecord_rm_accru_period',
        SUBSIDIARY: 'custrecord_rm_accural_subsidiary'
    });

    /**
     * Campos del record Rebate Agreement (customrecord_rm_sales_transaction)
     */
    const RM_AGREEMENT_FIELDS = Object.freeze({
        NAME: 'custrecord_agreement_names',
        SETTLEMENT_METHOD: 'custrecord_rm_settlement_method',
        PAYER: 'custrecord_hidden_payer',
        SUBSIDIARY: 'custrecord_rm_subsidiary',
        ACCOUNTING_ITEM: 'custrecord_rm_accounting_item',
        STATUS: 'custrecord_status_field',
        REBATE_TYPE: 'custrecord_rebate_type',
        START_DATE: 'custrecord_start_date_field',
        END_DATE: 'custrecord_end_date_field',
        ACCRUAL_CREDIT_ACCOUNT: 'custrecord_rm_ra_accrual_credit_account',
        ACCRUAL_DEBIT_ACCOUNT: 'custrecord_rm_ra_accrual_debit_account',
        BASE_TRANSACTION: 'custrecord_rm_base_transaction',
        LAST_RUN: 'custrecord_rm_last_run',
        REF_NUM: 'custrecord_transactional_ref_num'
    });

    /**
     * Campos del record RM Transactions (customrecord_rm_transactions)
     */
    const RM_TRANSACTION_FIELDS = Object.freeze({
        INVOICE: 'custrecord_rm_rebate_transaction',
        ITEM: 'custrecord_rm_tran_item',
        LINE_ID: 'custrecord_rm_tran_lineid',
        ORIGIN_DATE: 'custrecord_rm_origin_tran_date',
        CURRENCY: 'custrecord_rebatetran_curr',
        SUBSIDIARY: 'custrecord_rebatetran_sub',
        LOCATION: 'custrecord_rm_location',
        CLASS: 'custrecord_rm_class',
        DEPARTMENT: 'custrecord_rm_dept',
        REFUND_TYPE: 'custrecord_refund_type'
    });

    /**
     * Campos del record Rebate Agreement Details (customrecord_rebate_agreement_details)
     */
    const RM_DETAIL_FIELDS = Object.freeze({
        AGREEMENT: 'custrecord_rm_rebate_agreement',
        CUSTOMER_INCLUDE_1: 'custrecord_custinc_v1',
        ITEM_INCLUDE_1: 'custrecord_iteminc_v1',
        CALC_METHOD: 'custrecord_agreementdetail_cal_method',
        CALC_AMOUNT: 'custrecord_aggr_detail_cal_amount',
        UOM: 'custrecord_rm_uom',
        PARENT: 'custrecord_rm_rad_parent'
    });

    // ═══════════════════════════════════════════════════════════════
    //  Records propios — GIV Liquidación
    // ═══════════════════════════════════════════════════════════════

    const GIV_RECORDS = Object.freeze({
        DEPLOYMENT_ID: 'customdeploy_giv_sl_dashboard',
        WORK: 'customrecord_giv_rebate_liq_work',
        HISTORY: 'customrecord_giv_rebate_liq_history'
    });

    /**
     * Campos del WORK record (customrecord_giv_rebate_liq_work).
     * IDs cortos creados por SDF (custrecord_giv_lw_*).
     */
    const WORK_FIELDS = Object.freeze({
        CUSTOMER: 'custrecord_giv_lw_customer',
        AGREEMENT: 'custrecord_giv_lw_agreement',
        SOURCE_INVOICE: 'custrecord_giv_lw_source_invoice',
        SOURCE_ACCRUAL: 'custrecord_giv_lw_source_accrual',
        SOURCE_ITEM: 'custrecord_giv_lw_source_item',
        INVOICE_TO: 'custrecord_giv_lw_invoice_to',
        TAX_CODE: 'custrecord_giv_lw_taxcode',
        PROCESSED_TRAN: 'custrecord_giv_lw_processed_tran',
        SETTLE_METHOD: 'custrecord_giv_lw_settle_method',
        SCENARIO: 'custrecord_giv_lw_scenario',
        PROC_STATUS: 'custrecord_giv_lw_proc_status',
        CREATED_FROM: 'custrecord_giv_lw_created_from',
        CSV_BATCH_ID: 'custrecord_giv_lw_csv_batch_id',
        ORIGINAL_AMT: 'custrecord_giv_lw_original_amt',
        RETURNS_AMT: 'custrecord_giv_lw_returns_amt',
        SETTLED_AMT: 'custrecord_giv_lw_settled_amt',
        AVAILABLE_AMT: 'custrecord_giv_lw_available_amt',
        AMT_TO_SETTLE: 'custrecord_giv_lw_amt_to_settle',
        APPLY_AMOUNT: 'custrecord_giv_lw_apply_amount',
        TAX_BASIS: 'custrecord_giv_lw_tax_basis',
        EXCESS_FLAG: 'custrecord_giv_lw_excess_flag',
        ERROR_MESSAGE: 'custrecord_giv_lw_error_message'
    });

    /**
     * Campos del HISTORY record (customrecord_giv_rebate_liq_history).
     * IDs cortos creados por SDF (custrecord_giv_lh_*).
     */
    const HISTORY_FIELDS = Object.freeze({
        CUSTOMER: 'custrecord_giv_lh_customer',
        AGREEMENT: 'custrecord_giv_lh_agreement',
        SETTLEMENT: 'custrecord_giv_lh_settlement',
        GENERATED_TRAN: 'custrecord_giv_lh_generated_tran',
        SRC_ACCRUAL: 'custrecord_giv_lh_src_accrual',
        SRC_INVOICE: 'custrecord_giv_lh_src_invoice',
        SRC_ITEM: 'custrecord_giv_lh_src_item',
        INVOICE_TO: 'custrecord_giv_lh_invoiceto',
        TAX_CODE: 'custrecord_giv_lh_taxcode',
        USER: 'custrecord_giv_lh_user',
        TRAN_TYPE: 'custrecord_giv_lh_tran_type',
        SCENARIO: 'custrecord_giv_lh_scenario',
        CSV_BATCH_ID: 'custrecord_giv_lh_csv_batch_id',
        SRC_ACCR_AMT: 'custrecord_giv_lh_src_accr_amt',
        SRC_SETTL_AMT: 'custrecord_giv_lh_src_settl_amt',
        RET_CREDITS: 'custrecord_giv_lh_ret_credits',
        APPLIED_AMT: 'custrecord_giv_lh_applied_amt',
        DIFFERENCE: 'custrecord_giv_lh_difference',
        TAX_BASIS: 'custrecord_giv_lh_tax_basis',
        DATE: 'custrecord_giv_lh_date'
    });

    // ═══════════════════════════════════════════════════════════════
    //  Enumeraciones de negocio
    // ═══════════════════════════════════════════════════════════════

    /**
     * Estados del registro WORK.
     */
    const STATUS = Object.freeze({
        CAPTURED: 'Capturado',
        VALIDATED: 'Validado',
        PROCESSING: 'Procesando',
        COMPLETED: 'Completado',
        ERROR: 'Error'
    });

    /**
     * Escenarios de liquidación.
     */
    const SCENARIOS = Object.freeze({
        STANDARD: 'Estándar',
        CONSOLIDATED: 'Consolidada',
        SPECIFIC_SKU: 'Específica',
        EXCESS: 'Cobro en exceso',
        GROUPED: 'Agrupación'
    });

    /**
     * Origen de creación del registro WORK.
     */
    const CREATED_FROM = Object.freeze({
        SUITELET: 'Suitelet',
        CSV: 'CSV'
    });

    /**
     * Métodos de liquidación del Rebate Agreement.
     * Valores reales en custrecord_rm_settlement_method.
     */
    const SETTLEMENT_METHODS = Object.freeze({
        CREDIT_MEMO: '2',
        VENDOR_BILL: '3'
    });

    /**
     * Mensajes de error estándar.
     */
    const ERROR_MESSAGES = {
        es_ES: {
            AMOUNT_MISMATCH: 'El monto total a liquidar no coincide con el monto total a aplicar en las facturas destino.',
            INSUFFICIENT_BALANCE: 'El saldo disponible es insuficiente para el monto solicitado.',
            EXCESS_NOT_ALLOWED: 'El monto solicitado excede la provisión disponible. Seleccione el escenario "Cobro en exceso" para proceder.',
            CONCURRENCY_CONFLICT: 'El saldo de la provisión ha cambiado desde que fue consultado. Recargue la pantalla e intente de nuevo.',
            MISSING_PAYER: 'El acuerdo de reembolso no tiene configurada la entidad pagadora (custrecord_hidden_payer).',
            MISSING_ACCOUNTING_ITEM: 'El acuerdo de reembolso no tiene configurado el artículo contable (custrecord_rm_accounting_item).',
            MISSING_DESTINATION_INVOICES: 'Debe seleccionar al menos una factura destino para liquidaciones por Credit Memo.',
            CURRENCY_MISMATCH: 'Todas las líneas de una liquidación deben compartir la misma moneda.',
            CSV_INVALID_ROW: 'Fila inválida en archivo CSV. Verifique los campos requeridos.',
            SELECT_PROVISION: 'Debe seleccionar al menos una provisión para liquidar.',
            SELECT_SCENARIO: 'Debe seleccionar un Escenario de Liquidación.',
            SELECT_AGREEMENT: 'Debe seleccionar un Acuerdo de Reembolso.',
            LINE_NO_AMOUNT: 'La línea {0} seleccionada no tiene monto a liquidar.',
            CONSOLIDATED_MIN: 'El escenario "Consolidada" requiere al menos dos provisiones seleccionadas.'
        },
        en_US: {
            AMOUNT_MISMATCH: 'The total settlement amount does not match the total applied amount in destination invoices.',
            INSUFFICIENT_BALANCE: 'The available balance is insufficient for the requested amount.',
            EXCESS_NOT_ALLOWED: 'The requested amount exceeds the available provision. Select the "Excess Collection" scenario to proceed.',
            CONCURRENCY_CONFLICT: 'The provision balance has changed since it was retrieved. Reload the page and try again.',
            MISSING_PAYER: 'The rebate agreement does not have a payer entity configured (custrecord_hidden_payer).',
            MISSING_ACCOUNTING_ITEM: 'The rebate agreement does not have an accounting item configured (custrecord_rm_accounting_item).',
            MISSING_DESTINATION_INVOICES: 'You must select at least one destination invoice for Credit Memo settlements.',
            CURRENCY_MISMATCH: 'All lines in a settlement must share the same currency.',
            CSV_INVALID_ROW: 'Invalid CSV row. Check the required fields.',
            SELECT_PROVISION: 'You must select at least one provision to settle.',
            SELECT_SCENARIO: 'You must select a Settlement Scenario.',
            SELECT_AGREEMENT: 'You must select a Rebate Agreement.',
            LINE_NO_AMOUNT: 'Selected line {0} has no settlement amount.',
            CONSOLIDATED_MIN: 'The "Consolidated" scenario requires at least two selected provisions.'
        }
    };

    /**
     * Etiquetas del Dashboard — Español e Inglés.
     * Se seleccionan automáticamente según el idioma del usuario en NetSuite.
     */
    const LABELS = {
        es_ES: {
            // Título y grupos
            FORM_TITLE: 'Panel de Liquidación de Rebates',
            FILTER_GROUP: 'Filtros de Búsqueda',

            // Filtros
            CUSTOMER: 'Cliente',
            AGREEMENT: 'Acuerdo de Reembolso',
            SOURCE_INVOICE: 'Factura Origen',
            ITEM: 'Artículo',
            DATE_FROM: 'Fecha Desde',
            DATE_TO: 'Fecha Hasta',
            SCENARIO: 'Escenario de Liquidación',

            // Opciones de escenario
            SCENARIO_STANDARD: 'Estándar',
            SCENARIO_CONSOLIDATED: 'Consolidada',
            SCENARIO_SPECIFIC: 'Específica (por SKU)',
            SCENARIO_EXCESS: 'Cobro en exceso',
            SCENARIO_GROUPED: 'Agrupación',

            // Botones
            BTN_SEARCH: 'Buscar Provisiones',
            BTN_PROCESS: 'Procesar Liquidación',
            BTN_BACK: 'Regresar al Dashboard',

            // Sublista origen
            SRC_TITLE: 'Reembolsos Disponibles',
            SELECT: 'Seleccionar',
            SRC_AGREEMENT: 'Acuerdo',
            SRC_INVOICE: 'Factura Origen',
            SRC_ITEM: 'Artículo',
            SRC_DATE: 'Fecha',
            SRC_ORIGINAL: 'Provisión Original',
            SRC_SETTLED: 'Liquidado',
            SRC_RETURNS: 'Devoluciones',
            SRC_LOCKED: 'Bloqueado',
            SRC_AVAILABLE: 'Saldo Disponible',
            SRC_AMOUNT: 'Monto a Liquidar',
            CURRENCY: 'Moneda',

            // Sublista destino
            DST_TITLE: 'Facturas Destino (Credit Memo)',
            DST_INVOICE: 'Factura',
            DST_CUSTOMER: 'Cliente',
            DST_DATE: 'Fecha',
            DST_TOTAL: 'Total',
            DST_OPEN: 'Saldo Abierto',
            DST_AMOUNT: 'Monto a Aplicar',

            // Error page
            ERROR_TITLE: 'Error en Liquidación',
            ERROR_LABEL: 'Errores Encontrados'
        },
        en_US: {
            FORM_TITLE: 'Rebate Settlement Dashboard',
            FILTER_GROUP: 'Search Filters',

            CUSTOMER: 'Customer',
            AGREEMENT: 'Rebate Agreement',
            SOURCE_INVOICE: 'Source Invoice',
            ITEM: 'Item',
            DATE_FROM: 'Date From',
            DATE_TO: 'Date To',
            SCENARIO: 'Settlement Scenario',

            SCENARIO_STANDARD: 'Standard',
            SCENARIO_CONSOLIDATED: 'Consolidated',
            SCENARIO_SPECIFIC: 'Specific (by SKU)',
            SCENARIO_EXCESS: 'Excess Collection',
            SCENARIO_GROUPED: 'Grouped',

            BTN_SEARCH: 'Search Provisions',
            BTN_PROCESS: 'Process Settlement',
            BTN_BACK: 'Back to Dashboard',

            SRC_TITLE: 'Available Rebates',
            SELECT: 'Select',
            SRC_AGREEMENT: 'Agreement',
            SRC_INVOICE: 'Source Invoice',
            SRC_ITEM: 'Item',
            SRC_DATE: 'Date',
            SRC_ORIGINAL: 'Original Provision',
            SRC_SETTLED: 'Settled',
            SRC_RETURNS: 'Returns',
            SRC_LOCKED: 'Locked',
            SRC_AVAILABLE: 'Available Balance',
            SRC_AMOUNT: 'Amount to Settle',
            CURRENCY: 'Currency',

            DST_TITLE: 'Destination Invoices (Credit Memo)',
            DST_INVOICE: 'Invoice',
            DST_CUSTOMER: 'Customer',
            DST_DATE: 'Date',
            DST_TOTAL: 'Total',
            DST_OPEN: 'Open Balance',
            DST_AMOUNT: 'Amount to Apply',

            ERROR_TITLE: 'Settlement Error',
            ERROR_LABEL: 'Errors Found'
        }
    };

    /**
     * Obtiene el idioma del usuario actual y retorna las etiquetas correspondientes.
     * Si el idioma no está soportado, retorna español por defecto.
     *
     * @param {Object} runtime - Módulo N/runtime (se pasa como parámetro para no cargarlo aquí)
     * @returns {Object} Objeto con las etiquetas en el idioma del usuario
     */
    const getLabels = (runtime) => {
        try {
            const lang = runtime.getCurrentUser().getPreference({ name: 'LANGUAGE' });
            return LABELS[lang] || LABELS.es_ES;
        } catch (e) {
            return LABELS.es_ES;
        }
    };

    /**
     * Obtiene los mensajes de error en el idioma del usuario.
     *
     * @param {Object} runtime - Módulo N/runtime
     * @returns {Object} Mensajes de error localizados
     */
    const getErrorMessages = (runtime) => {
        try {
            const lang = runtime.getCurrentUser().getPreference({ name: 'LANGUAGE' });
            return ERROR_MESSAGES[lang] || ERROR_MESSAGES.es_ES;
        } catch (e) {
            return ERROR_MESSAGES.es_ES;
        }
    };

    return {
        RM_RECORDS,
        RM_ACCRUAL_FIELDS,
        RM_AGREEMENT_FIELDS,
        RM_TRANSACTION_FIELDS,
        RM_DETAIL_FIELDS,
        GIV_RECORDS,
        WORK_FIELDS,
        HISTORY_FIELDS,
        STATUS,
        SCENARIOS,
        CREATED_FROM,
        SETTLEMENT_METHODS,
        ERROR_MESSAGES,
        LABELS,
        getLabels,
        getErrorMessages
    };
});

