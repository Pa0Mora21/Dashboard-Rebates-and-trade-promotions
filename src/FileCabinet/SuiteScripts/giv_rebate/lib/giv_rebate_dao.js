/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Data Access Object — Encapsula todas las búsquedas para el módulo
 *              de liquidación de rebates. Usa los Custom Records reales del SuiteApp
 *              de Rebate Management (customrecord_rm_*).
 */
define(['N/search', 'N/query', 'N/log', 'N/runtime', './giv_rebate_constants'], (search, query, log, runtime, CONST) => {

    const MODULE = 'giv_rebate_dao';

    /**
     * Obtiene provisiones (Accruals) disponibles para liquidar.
     *
     * El modelo de datos del SuiteApp es:
     *  - customrecord_rm_accruals: montos provisionados por acuerdo/período
     *  - customrecord_rm_transactions: transacciones (facturas) vinculadas al acuerdo
     *  - customrecord_rm_sales_transaction: el acuerdo con método de liquidación
     *
     * Se usa SuiteQL para hacer los joins necesarios entre estos 3 records.
     *
     * @param {Object} filters
     * @param {string|string[]} [filters.customerId] - Internal ID(s) del cliente
     * @param {string} [filters.agreementId] - Internal ID del acuerdo
     * @param {string} [filters.dateFrom] - Fecha inicio (rango provisión)
     * @param {string} [filters.dateTo] - Fecha fin (rango provisión)
     * @returns {Object[]} Array de objetos con datos de provisiones disponibles
     */
    const getAvailableAccruals = (filters) => {
        try {
            let sql = `
                SELECT
                    a.id                            AS accrual_id,
                    a.${CONST.RM_ACCRUAL_FIELDS.AGREEMENT}  AS agreement_id,
                    ag.${CONST.RM_AGREEMENT_FIELDS.NAME}    AS agreement_name,
                    a.${CONST.RM_ACCRUAL_FIELDS.AMOUNT}     AS accrual_amount,
                    a.${CONST.RM_ACCRUAL_FIELDS.DATE}       AS accrual_date,
                    t.tranid                                AS invoice_number,
                    t.id                                    AS invoice_id,
                    tl.item                                 AS item_id,
                    ag.${CONST.RM_AGREEMENT_FIELDS.SETTLEMENT_METHOD} AS settlement_method,
                    ag.${CONST.RM_AGREEMENT_FIELDS.PAYER}    AS payer_id,
                    ag.${CONST.RM_AGREEMENT_FIELDS.ACCOUNTING_ITEM} AS accounting_item,
                    ag.${CONST.RM_AGREEMENT_FIELDS.SUBSIDIARY} AS subsidiary_id
                FROM ${CONST.RM_RECORDS.ACCRUALS} a
                INNER JOIN ${CONST.RM_RECORDS.AGREEMENT} ag ON a.${CONST.RM_ACCRUAL_FIELDS.AGREEMENT} = ag.id
                LEFT JOIN transaction t ON a.${CONST.RM_ACCRUAL_FIELDS.BASE_TRANSACTION} = t.id
                LEFT JOIN transactionline tl ON (tl.transaction = t.id AND tl.id = (SELECT MIN(id) FROM transactionline WHERE transaction = t.id AND mainline = 'F'))
                WHERE a.isinactive = 'F'
            `;

            const params = [];

            if (filters.agreementId) {
                const ids = Array.isArray(filters.agreementId) ? filters.agreementId : [filters.agreementId];
                if (ids.length > 0) {
                    const placeholders = ids.map(() => '?').join(',');
                    sql += ` AND a.${CONST.RM_ACCRUAL_FIELDS.AGREEMENT} IN (${placeholders})`;
                    ids.forEach(id => params.push(id));
                }
            }

            if (filters.dateFrom) {
                sql += ` AND a.${CONST.RM_ACCRUAL_FIELDS.DATE} >= TO_DATE(?, 'YYYY-MM-DD')`;
                params.push(filters.dateFrom);
            }
            if (filters.dateTo) {
                sql += ` AND a.${CONST.RM_ACCRUAL_FIELDS.DATE} <= TO_DATE(?, 'YYYY-MM-DD')`;
                params.push(filters.dateTo);
            }

            sql += ` ORDER BY a.${CONST.RM_ACCRUAL_FIELDS.DATE} DESC`;

            log.debug('DAO SQL', sql);
            log.debug('DAO Params', params);

            const queryResults = query.runSuiteQL({ query: sql, params: params });
            const mappedResults = queryResults.asMappedResults();

            log.debug('Raw Results Count', mappedResults.length);
            log.debug('Raw Results JSON', JSON.stringify(mappedResults));


            const results = [];
            mappedResults.forEach((row) => {
                const accrualId = row.accrual_id;
                const accrualAmount = parseFloat(row.accrual_amount) || 0;
                const lockedAmount = getLockedAccrualAmount(accrualId);
                const available = accrualAmount - lockedAmount;

                if (available > 0) {
                    results.push({
                        accrualId: String(accrualId),
                        agreementId: String(row.agreement_id),
                        agreementText: row.agreement_name || '',
                        accrualAmount: accrualAmount,
                        accrualDate: row.accrual_date || '',
                        invoiceNumber: row.invoice_number || 'N/A',
                        invoiceId: row.invoice_id || '',
                        itemText: row.item_id ? ('Item #' + row.item_id) : 'N/A',
                        itemId: row.item_id || '',
                        settlementMethod: String(row.settlement_method || ''),
                        payerId: String(row.payer_id || ''),
                        accountingItem: String(row.accounting_item || ''),
                        subsidiaryId: String(row.subsidiary_id || ''),
                        lockedAmount: lockedAmount,
                        availableAmount: available
                    });
                }
            });

            log.debug({ title: `${MODULE}.getAvailableAccruals`, details: `Found ${results} available accruals` });
            log.debug({ title: `${MODULE}.getAvailableAccruals`, details: results });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getAvailableAccruals`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene las transacciones (facturas) vinculadas a un acuerdo de rebate.
     * Estas son las transacciones origen que generaron las provisiones.
     *
     * @param {string} agreementId - Internal ID del acuerdo
     * @returns {Object[]} Transacciones vinculadas con detalle de factura, item y cliente
     */
    const getTransactionsByAgreement = (agreementId) => {
        try {
            const sql = `
                SELECT
                    rt.id                                       AS rm_tran_id,
                    rt.${CONST.RM_TRANSACTION_FIELDS.INVOICE}   AS invoice_id,
                    rt.${CONST.RM_TRANSACTION_FIELDS.ITEM}      AS item_id,
                    rt.${CONST.RM_TRANSACTION_FIELDS.ORIGIN_DATE} AS origin_date,
                    rt.${CONST.RM_TRANSACTION_FIELDS.CURRENCY}  AS currency_id,
                    rt.${CONST.RM_TRANSACTION_FIELDS.REFUND_TYPE} AS refund_type,
                    t.tranid                                    AS invoice_number,
                    t.entity                                    AS customer_id
                FROM ${CONST.RM_RECORDS.TRANSACTIONS} rt
                INNER JOIN transaction t
                    ON rt.${CONST.RM_TRANSACTION_FIELDS.INVOICE} = t.id
                INNER JOIN ${CONST.RM_RECORDS.AGREEMENT_DETAILS} rad
                    ON rad.${CONST.RM_DETAIL_FIELDS.AGREEMENT} = ?
                WHERE rt.isinactive = 'F'
                    AND rt.${CONST.RM_TRANSACTION_FIELDS.REFUND_TYPE} = 'sale'
                ORDER BY rt.${CONST.RM_TRANSACTION_FIELDS.ORIGIN_DATE} DESC
            `;

            const queryResults = query.runSuiteQL({ query: sql, params: [agreementId] });
            const results = queryResults.asMappedResults();

            log.debug({ title: `${MODULE}.getTransactionsByAgreement`, details: `Found ${results.length} transactions for agreement ${agreementId}` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getTransactionsByAgreement`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene los clientes configurados en un acuerdo de rebate (desde Agreement Details).
     *
     * @param {string} agreementId - Internal ID del acuerdo
     * @returns {string[]} Array de Internal IDs de clientes
     */
    const getCustomersByAgreement = (agreementId) => {
        try {
            const sql = `
                SELECT DISTINCT ${CONST.RM_DETAIL_FIELDS.CUSTOMER_INCLUDE_1} AS customer_id
                FROM ${CONST.RM_RECORDS.AGREEMENT_DETAILS}
                WHERE ${CONST.RM_DETAIL_FIELDS.AGREEMENT} = ?
                  AND ${CONST.RM_DETAIL_FIELDS.CUSTOMER_INCLUDE_1} IS NOT NULL
                  AND isinactive = 'F'
            `;

            const queryResults = query.runSuiteQL({ query: sql, params: [agreementId] });
            const results = queryResults.asMappedResults();

            return results.map(r => String(r.customer_id));

        } catch (e) {
            log.error({ title: `${MODULE}.getCustomersByAgreement`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene el monto ya "bloqueado" en registros WORK para un accrual específico.
     * Evita que dos usuarios liquiden la misma provisión simultáneamente.
     *
     * @param {string} accrualId - Internal ID del accrual
     * @returns {number} Monto total bloqueado
     */
    const getLockedAccrualAmount = (accrualId) => {
        try {
            const workSearch = search.create({
                type: CONST.GIV_RECORDS.WORK,
                filters: [
                    [CONST.WORK_FIELDS.SOURCE_ACCRUAL, 'anyof', accrualId],
                    'AND',
                    [
                        [CONST.WORK_FIELDS.PROC_STATUS, 'is', CONST.STATUS.CAPTURED],
                        'OR',
                        [CONST.WORK_FIELDS.PROC_STATUS, 'is', CONST.STATUS.VALIDATED],
                        'OR',
                        [CONST.WORK_FIELDS.PROC_STATUS, 'is', CONST.STATUS.PROCESSING]
                    ]
                ],
                columns: [
                    search.createColumn({
                        name: CONST.WORK_FIELDS.AMT_TO_SETTLE,
                        summary: search.Summary.SUM
                    })
                ]
            });

            let locked = 0;
            workSearch.run().each((result) => {
                locked = parseFloat(result.getValue({
                    name: CONST.WORK_FIELDS.AMT_TO_SETTLE,
                    summary: search.Summary.SUM
                })) || 0;
                return false;
            });

            return locked;

        } catch (e) {
            log.error({ title: `${MODULE}.getLockedAccrualAmount`, details: e.message });
            return 0;
        }
    };

    /**
     * Obtiene facturas abiertas de un cliente para la sublista destino.
     *
     * @param {string[]} customerIds - Internal IDs de los clientes
     * @returns {Object[]} Facturas abiertas con saldo
     */
    const getOpenInvoices = (customerIds) => {
        try {
            if (!customerIds || customerIds.length === 0) return [];

            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['entity', 'anyof', ...customerIds],
                    'AND',
                    ['status', 'anyof', 'CustInvc:A'],
                    'AND',
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['amountremaining', 'greaterthan', 0]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'tranid' }),
                    search.createColumn({ name: 'entity' }),
                    search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
                    search.createColumn({ name: 'total' }),
                    search.createColumn({ name: 'amountremaining' }),
                    search.createColumn({ name: 'currency' })
                ]
            });

            const results = [];
            invoiceSearch.run().each((result) => {
                results.push({
                    invoiceId: result.getValue('internalid'),
                    tranId: result.getValue('tranid'),
                    customerId: result.getValue('entity'),
                    customerText: result.getText('entity'),
                    date: result.getValue('trandate'),
                    total: parseFloat(result.getValue('total')) || 0,
                    amountRemaining: parseFloat(result.getValue('amountremaining')) || 0,
                    currency: result.getValue('currency'),
                    currencyText: result.getText('currency')
                });
                return true;
            });

            log.debug({ title: `${MODULE}.getOpenInvoices`, details: `Found ${results.length} open invoices` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getOpenInvoices`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene información fiscal de una línea de factura.
     *
     * @param {string} invoiceId - Internal ID de la factura
     * @param {string} itemId - Internal ID del artículo
     * @returns {Object} Información fiscal {taxCodeId, taxRate}
     */
    const getTaxInfoFromInvoiceLine = (invoiceId, itemId) => {
        try {
            if (!invoiceId || !itemId) return { taxCodeId: '', taxRate: 0 };

            const lineSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['internalid', 'is', invoiceId],
                    'AND',
                    ['item', 'anyof', itemId],
                    'AND',
                    ['mainline', 'is', 'F'],
                    'AND',
                    ['taxline', 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: 'taxcode' }),
                    search.createColumn({ name: 'taxrate' })
                ]
            });

            let taxInfo = { taxCodeId: '', taxRate: 0 };
            lineSearch.run().each((result) => {
                taxInfo.taxCodeId = result.getValue('taxcode') || '';
                taxInfo.taxRate = parseFloat(result.getValue('taxrate')) || 0;
                return false;
            });

            return taxInfo;

        } catch (e) {
            log.error({ title: `${MODULE}.getTaxInfoFromInvoiceLine`, details: e.message });
            return { taxCodeId: '', taxRate: 0 };
        }
    };

    /**
     * Obtiene datos de un acuerdo de rebate por su Internal ID.
     *
     * @param {string} agreementId - Internal ID del acuerdo
     * @returns {Object|null} Datos del acuerdo
     */
    const getAgreement = (agreementId) => {
        try {
            const sql = `
                SELECT
                    id,
                    ${CONST.RM_AGREEMENT_FIELDS.NAME} AS name,
                    ${CONST.RM_AGREEMENT_FIELDS.SETTLEMENT_METHOD} AS settlement_method,
                    ${CONST.RM_AGREEMENT_FIELDS.PAYER} AS payer_id,
                    ${CONST.RM_AGREEMENT_FIELDS.ACCOUNTING_ITEM} AS accounting_item,
                    ${CONST.RM_AGREEMENT_FIELDS.SUBSIDIARY} AS subsidiary_id,
                    ${CONST.RM_AGREEMENT_FIELDS.STATUS} AS status,
                    ${CONST.RM_AGREEMENT_FIELDS.ACCRUAL_CREDIT_ACCOUNT} AS credit_account,
                    ${CONST.RM_AGREEMENT_FIELDS.ACCRUAL_DEBIT_ACCOUNT} AS debit_account
                FROM ${CONST.RM_RECORDS.AGREEMENT}
                WHERE id = ?
            `;

            const queryResults = query.runSuiteQL({ query: sql, params: [agreementId] });
            const results = queryResults.asMappedResults();

            if (results.length > 0) {
                return results[0];
            }
            return null;

        } catch (e) {
            log.error({ title: `${MODULE}.getAgreement`, details: e.message });
            return null;
        }
    };

    /**
     * Obtiene registros WORK pendientes de procesar.
     *
     * @param {string} [status] - Filtrar por estado específico (default: Capturado)
     * @returns {Object[]} Registros WORK pendientes
     */
    const getPendingWorkRecords = (status) => {
        try {
            const filterStatus = status || CONST.STATUS.CAPTURED;

            const workSearch = search.create({
                type: CONST.GIV_RECORDS.WORK,
                filters: [
                    [CONST.WORK_FIELDS.PROC_STATUS, 'is', filterStatus]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: CONST.WORK_FIELDS.CUSTOMER }),
                    search.createColumn({ name: CONST.WORK_FIELDS.AGREEMENT }),
                    search.createColumn({ name: CONST.WORK_FIELDS.SOURCE_INVOICE }),
                    search.createColumn({ name: CONST.WORK_FIELDS.SOURCE_ACCRUAL }),
                    search.createColumn({ name: CONST.WORK_FIELDS.SOURCE_ITEM }),
                    search.createColumn({ name: CONST.WORK_FIELDS.INVOICE_TO }),
                    search.createColumn({ name: CONST.WORK_FIELDS.TAX_CODE }),
                    search.createColumn({ name: CONST.WORK_FIELDS.SETTLE_METHOD }),
                    search.createColumn({ name: CONST.WORK_FIELDS.SCENARIO }),
                    search.createColumn({ name: CONST.WORK_FIELDS.ORIGINAL_AMT }),
                    search.createColumn({ name: CONST.WORK_FIELDS.AVAILABLE_AMT }),
                    search.createColumn({ name: CONST.WORK_FIELDS.AMT_TO_SETTLE }),
                    search.createColumn({ name: CONST.WORK_FIELDS.APPLY_AMOUNT }),
                    search.createColumn({ name: CONST.WORK_FIELDS.TAX_BASIS }),
                    search.createColumn({ name: CONST.WORK_FIELDS.EXCESS_FLAG }),
                    search.createColumn({ name: CONST.WORK_FIELDS.CREATED_FROM })
                ]
            });

            const results = [];
            workSearch.run().each((result) => {
                results.push({
                    workId: result.getValue('internalid'),
                    customerId: result.getValue(CONST.WORK_FIELDS.CUSTOMER),
                    agreementId: result.getValue(CONST.WORK_FIELDS.AGREEMENT),
                    sourceInvoiceId: result.getValue(CONST.WORK_FIELDS.SOURCE_INVOICE),
                    sourceAccrualId: result.getValue(CONST.WORK_FIELDS.SOURCE_ACCRUAL),
                    sourceItemId: result.getValue(CONST.WORK_FIELDS.SOURCE_ITEM),
                    invoiceToId: result.getValue(CONST.WORK_FIELDS.INVOICE_TO),
                    taxCodeId: result.getValue(CONST.WORK_FIELDS.TAX_CODE),
                    settlementMethod: result.getValue(CONST.WORK_FIELDS.SETTLE_METHOD),
                    scenario: result.getValue(CONST.WORK_FIELDS.SCENARIO),
                    originalAmount: parseFloat(result.getValue(CONST.WORK_FIELDS.ORIGINAL_AMT)) || 0,
                    availableAmount: parseFloat(result.getValue(CONST.WORK_FIELDS.AVAILABLE_AMT)) || 0,
                    amountToSettle: parseFloat(result.getValue(CONST.WORK_FIELDS.AMT_TO_SETTLE)) || 0,
                    applyAmount: parseFloat(result.getValue(CONST.WORK_FIELDS.APPLY_AMOUNT)) || 0,
                    taxBasis: parseFloat(result.getValue(CONST.WORK_FIELDS.TAX_BASIS)) || 0,
                    excessFlag: result.getValue(CONST.WORK_FIELDS.EXCESS_FLAG),
                    createdFrom: result.getValue(CONST.WORK_FIELDS.CREATED_FROM)
                });
                return true;
            });

            log.debug({ title: `${MODULE}.getPendingWorkRecords`, details: `Found ${results.length} pending WORK records` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getPendingWorkRecords`, details: e.message });
            return [];
        }
    };

    return {
        getAvailableAccruals,
        getTransactionsByAgreement,
        getCustomersByAgreement,
        getLockedAccrualAmount,
        getLockedAccrualAmounts: getLockedAccrualAmount,
        getOpenInvoices,
        getTaxInfoFromInvoiceLine,
        getAgreement,
        getAgreementDetails: getAgreement,
        getPendingWorkRecords
    };
});
