/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Etiquetas de UI en español e inglés para el Dashboard de Liquidación de Rebates.
 *              Solo contiene textos de traducción. Los field IDs y valores de negocio
 *              están hardcodeados directamente en cada archivo que los usa.
 */
define([], () => {

    const LABELS = {
        es_ES: {
            // Título y grupos
            FORM_TITLE:   'Panel de Liquidación de Rebates',
            FILTER_GROUP: 'Filtros de Búsqueda',

            // Filtros
            CUSTOMER:       'Cliente',
            AGREEMENT:      'Acuerdo de Reembolso',
            SOURCE_INVOICE: 'Factura Origen',
            ITEM:           'Artículo',
            DATE_FROM:      'Fecha Desde',
            DATE_TO:        'Fecha Hasta',
            SCENARIO:       'Escenario de Liquidación',

            // Opciones de escenario
            SCENARIO_STANDARD:     'Estándar',
            SCENARIO_CONSOLIDATED: 'Consolidada',
            SCENARIO_SPECIFIC:     'Específica (por SKU)',
            SCENARIO_EXCESS:       'Cobro en exceso',
            SCENARIO_GROUPED:      'Agrupación',

            // Botones
            BTN_SEARCH:  'Buscar Provisiones',
            BTN_PROCESS: 'Procesar Liquidación',
            BTN_BACK:    'Regresar al Dashboard',

            // Sublista origen
            SRC_TITLE:     'Reembolsos Disponibles',
            SELECT:        'Seleccionar',
            SRC_AGREEMENT: 'Acuerdo',
            SRC_INVOICE:   'Factura Origen',
            SRC_ITEM:      'Artículo',
            SRC_DATE:      'Fecha',
            SRC_ORIGINAL:  'Provisión Original',
            SRC_SETTLED:   'Liquidado',
            SRC_RETURNS:   'Devoluciones',
            SRC_LOCKED:    'Bloqueado',
            SRC_AVAILABLE: 'Saldo Disponible',
            SRC_AMOUNT:    'Monto a Liquidar',
            CURRENCY:      'Moneda',

            // Sublista destino
            DST_TITLE:    'Facturas Destino (Credit Memo)',
            DST_INVOICE:  'Factura',
            DST_CUSTOMER: 'Cliente',
            DST_DATE:     'Fecha',
            DST_TOTAL:    'Total',
            DST_OPEN:     'Saldo Abierto',
            DST_AMOUNT:   'Monto a Aplicar',

            // Página de error
            ERROR_TITLE:  'Error en Liquidación',
            ERROR_LABEL:  'Errores Encontrados'
        },
        en_US: {
            FORM_TITLE:   'Rebate Settlement Dashboard',
            FILTER_GROUP: 'Search Filters',

            CUSTOMER:       'Customer',
            AGREEMENT:      'Rebate Agreement',
            SOURCE_INVOICE: 'Source Invoice',
            ITEM:           'Item',
            DATE_FROM:      'Date From',
            DATE_TO:        'Date To',
            SCENARIO:       'Settlement Scenario',

            SCENARIO_STANDARD:     'Standard',
            SCENARIO_CONSOLIDATED: 'Consolidated',
            SCENARIO_SPECIFIC:     'Specific (by SKU)',
            SCENARIO_EXCESS:       'Excess Collection',
            SCENARIO_GROUPED:      'Grouped',

            BTN_SEARCH:  'Search Provisions',
            BTN_PROCESS: 'Process Settlement',
            BTN_BACK:    'Back to Dashboard',

            SRC_TITLE:     'Available Rebates',
            SELECT:        'Select',
            SRC_AGREEMENT: 'Agreement',
            SRC_INVOICE:   'Source Invoice',
            SRC_ITEM:      'Item',
            SRC_DATE:      'Date',
            SRC_ORIGINAL:  'Original Provision',
            SRC_SETTLED:   'Settled',
            SRC_RETURNS:   'Returns',
            SRC_LOCKED:    'Locked',
            SRC_AVAILABLE: 'Available Balance',
            SRC_AMOUNT:    'Amount to Settle',
            CURRENCY:      'Currency',

            DST_TITLE:    'Destination Invoices (Credit Memo)',
            DST_INVOICE:  'Invoice',
            DST_CUSTOMER: 'Customer',
            DST_DATE:     'Date',
            DST_TOTAL:    'Total',
            DST_OPEN:     'Open Balance',
            DST_AMOUNT:   'Amount to Apply',

            ERROR_TITLE:  'Settlement Error',
            ERROR_LABEL:  'Errors Found'
        }
    };

    /**
     * Retorna las etiquetas según el idioma del usuario en NetSuite.
     * Si el idioma no está soportado retorna español por defecto.
     *
     * @param {Object} runtime - Módulo N/runtime
     * @returns {Object}
     */
    const getLabels = (runtime) => {
        try {
            const lang = runtime.getCurrentUser().getPreference({ name: 'LANGUAGE' });
            return LABELS[lang] || LABELS.es_ES;
        } catch (e) {
            return LABELS.es_ES;
        }
    };

    // Valores nativos de NetSuite para custrecord_rm_settlement_method
    // en customrecord_rm_sales_transaction (Rebate Agreement)
    const SETTLEMENT_METHOD = {
        CREDIT_MEMO:  3,   // Nota de Crédito (Credit Memo / Credit Note)
        VENDOR_BILL:  1    // Factura de proveedor (Vendor Bill / Vendor Invoice)
    };

    return {
        LABELS,
        getLabels,
        SETTLEMENT_METHOD
    };
});
