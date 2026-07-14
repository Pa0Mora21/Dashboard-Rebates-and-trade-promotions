/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Data Access Object — Encapsula todas las búsquedas para el módulo
 *              de liquidación de rebates. Usa los Custom Records reales del SuiteApp
 *              de Rebate Management (customrecord_rm_*).
 */
define(['N/search', 'N/query', 'N/log'], (search, query, log) => {

    const MODULE = 'giv_rebate_dao';

    /**
     * Obtiene provisiones (Accruals) disponibles para liquidar.
     * Consulta optimizada que trae todos los cálculos en una sola query.
     *
     * @param {Object}            filters
     * @param {string|string[]}   [filters.agreementId]
     * @param {string|string[]}   [filters.sourceInvoiceIds]
     * @param {string}            [filters.itemId]
     * @param {string}            [filters.dateFrom]   YYYY-MM-DD
     * @param {string}            [filters.dateTo]     YYYY-MM-DD
     * @returns {Object[]}
     */
    const getAvailableAccruals = (filters) => {
        try {

            let sql = `
   SELECT
    /* Transaction Detail */
    rtd.id                                            AS transaction_detail_id,

    /* Accrual */
    a.id                                              AS accrual_id,
    a.custrecord_rm_accrual_amount                    AS accrual_amount,
    a.custrecord_rm_accru_date                        AS accrual_date,

    /* Agreement */
    ag.id                                             AS agreement_id,
    ag.custrecord_agreement_names                     AS agreement_name,
    ag.custrecord_rm_settlement_method                AS settlement_method,
    ag.custrecord_hidden_payer                        AS payer_id,
    ag.custrecord_rm_accounting_item                  AS accounting_item,
    ag.custrecord_rm_subsidiary                       AS subsidiary_id,

    /* Source Transaction */
    t.id                                              AS invoice_id,
    t.tranid                                          AS invoice_number,

    /* Item */
    rtd.custrecord_rm_rebate_item                     AS item_id,
    itm.itemid                                        AS item_name,

    /* Transaction Detail Amounts */
    rtd.custrecord_rm_td_totalamt                     AS transaction_detail_amount,
    rtd.custrecord_rm_achieved_rebate_amount          AS achieved_rebate_amount,
    rtd.custrecord_rm_accrual_amo                     AS accrual_detail_amount,
    rtd.custrecord_rm_td_item_qty                     AS quantity,

    /* Liquidado: el mayor entre lo liquidado nativamente (achieved_rebate_amount)
       y lo registrado en el historial GIV, para cubrir ambas fuentes de liquidación */
    GREATEST(
        COALESCE(rtd.custrecord_rm_achieved_rebate_amount, 0),
        COALESCE(
            (
                SELECT SUM(ABS(h.custrecord_giv_lh_src_settl_amt))
                FROM customrecord_giv_rebate_liq_history h
                WHERE h.custrecord_giv_lh_src_accrual = a.id
                  AND h.isinactive = 'F'
            ),
            0
        )
    ) AS settled_amount,

    /* Devoluciones */
    COALESCE(
        (
            SELECT SUM(ABS(ret.custrecord_rm_accrual_amount))
            FROM customrecord_rm_accruals ret
            WHERE ret.custrecord_rm_accru_ra = a.custrecord_rm_accru_ra
              AND ret.custrecord_rm_accrual_amount < 0
              AND ret.isinactive = 'F'
              AND ret.id <> a.id
        ),
        0
    ) AS returns_amount,

    /* Bloqueado */
    COALESCE(
        (
            SELECT SUM(ABS(w.custrecord_giv_lw_amt_to_settle))
            FROM customrecord_giv_rebate_liq_work w
            WHERE w.custrecord_giv_lw_source_accrual = a.id
              AND w.custrecord_giv_lw_proc_status IN
                  ('Capturado','Validado','Procesando')
              AND w.isinactive = 'F'
        ),
        0
    ) AS locked_amount

FROM customrecord_rm_transaction_details rtd

INNER JOIN customrecord_rm_accruals a
    ON a.id = rtd.custrecord_rm_rtd_accrual
   AND a.isinactive = 'F'

INNER JOIN customrecord_rm_sales_transaction ag
    ON ag.id = a.custrecord_rm_accru_ra

LEFT JOIN transaction t
    ON t.id = rtd.custrecord_rm_source_transaction

LEFT JOIN item itm
    ON itm.id = rtd.custrecord_rm_rebate_item

WHERE rtd.isinactive = 'F'

    /* Debe existir un accrual */
    AND rtd.custrecord_rm_rtd_accrual IS NOT NULL
        `;


            const params = [];

            if (filters.agreementId) {
                const ids = Array.isArray(filters.agreementId) ? filters.agreementId : [filters.agreementId];
                if (ids.length > 0) {
                    sql += ` AND a.custrecord_rm_accru_ra IN (${ids.map(() => '?').join(',')})`;
                    ids.forEach(id => params.push(id));
                }
            }

            if (filters.sourceInvoiceIds && filters.sourceInvoiceIds.length > 0) {
                sql += ` AND t.id IN (${filters.sourceInvoiceIds.map(() => '?').join(',')})`;
                filters.sourceInvoiceIds.forEach(id => params.push(id));
            }

            if (filters.itemId) {
                sql += ` AND rtd.custrecord_rm_rebate_item = ?`;
                params.push(filters.itemId);
            }

            if (filters.dateFrom) {
                sql += ` AND a.custrecord_rm_accru_date >= TO_DATE(?, 'YYYY-MM-DD')`;
                params.push(filters.dateFrom);
            }

            if (filters.dateTo) {
                sql += ` AND a.custrecord_rm_accru_date <= TO_DATE(?, 'YYYY-MM-DD')`;
                params.push(filters.dateTo);
            }

            sql += ` ORDER BY a.custrecord_rm_accru_date DESC`;

            log.debug({ title: `${MODULE}.getAvailableAccruals SQL`, details: sql });
            log.debug({ title: `${MODULE}.getAvailableAccruals Params`, details: JSON.stringify(params) });

            const mappedResults = query.runSuiteQL({ query: sql, params }).asMappedResults();

            log.debug({ title: `${MODULE}.getAvailableAccruals raw rows`, details: mappedResults.length });
            log.debug({ title: `${MODULE}.getAvailableAccruals raw data`, details: JSON.stringify(mappedResults) });

            const results = [];
            log.debug({ title: `${MODULE}.getAvailableAccruals`, details: `Processing ${mappedResults.length} rows. First row: ${JSON.stringify(mappedResults[0])}` });

            mappedResults.forEach((row) => {
                const accrualAmount = parseFloat(row.accrual_detail_amount) || 0;
                const settledAmount = parseFloat(row.settled_amount) || 0;
                const returnsAmount = parseFloat(row.returns_amount) || 0;
                const lockedAmount  = parseFloat(row.locked_amount)  || 0;
                const available     = accrualAmount - settledAmount - returnsAmount - lockedAmount;

                // Solo mostrar provisiones que aún tengan saldo disponible.
                // Esto reemplaza el filtro SQL «rtd.custrecord_rm_rtd_claim IS NULL»
                // que excluía liquidaciones parciales. Ahora se usa el cálculo real
                // del saldo (accrual − liquidado − devoluciones − bloqueado).
               // if (available > 0) {
                    results.push({
                        accrualId:        String(row.accrual_id),
                        agreementId:      String(row.agreement_id),
                        agreementText:    row.agreement_name   || '',
                        accrualAmount:    accrualAmount,
                        settledAmount:    settledAmount,
                        returnsAmount:    returnsAmount,
                        accrualDate:      row.accrual_date     || '',
                        invoiceNumber:    row.invoice_number   || 'N/A',
                        invoiceId:        String(row.invoice_id || ''),
                        itemId:           String(row.item_id   || ''),
                        itemText:         row.item_name        || (row.item_id ? String(row.item_id) : 'N/A'),
                        settlementMethod: String(row.settlement_method || ''),
                        payerId:          String(row.payer_id  || ''),
                        accountingItem:   String(row.accounting_item || ''),
                        subsidiaryId:     String(row.subsidiary_id   || ''),
                        lockedAmount:     lockedAmount,
                        availableAmount:  Math.max(available, 0)
                    });
                //}
            });

            log.debug({ title: `${MODULE}.getAvailableAccruals`, details: `${results.length} provisiones disponibles` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getAvailableAccruals`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene las transacciones (facturas) vinculadas a un acuerdo de rebate.
     *
     * @param {string} agreementId
     * @returns {Object[]}
     */
    const getTransactionsByAgreement = (agreementId) => {
        try {
            const sql = `
                SELECT
                    rt.id                                   AS rm_tran_id,
                    rt.custrecord_rm_rebate_transaction     AS invoice_id,
                    rt.custrecord_rm_tran_item              AS item_id,
                    rt.custrecord_rm_origin_tran_date       AS origin_date,
                    rt.custrecord_rebatetran_curr           AS currency_id,
                    rt.custrecord_refund_type               AS refund_type,
                    t.tranid                                AS invoice_number,
                    t.entity                                AS customer_id
                FROM customrecord_rm_transactions rt
                INNER JOIN transaction t
                    ON rt.custrecord_rm_rebate_transaction = t.id
                INNER JOIN customrecord_rebate_agreement_details rad
                    ON rad.custrecord_rm_rebate_agreement = ?
                WHERE rt.isinactive = 'F'
                    AND rt.custrecord_refund_type = 'sale'
                ORDER BY rt.custrecord_rm_origin_tran_date DESC
            `;

            const results = query.runSuiteQL({ query: sql, params: [agreementId] }).asMappedResults();
            log.debug({ title: `${MODULE}.getTransactionsByAgreement`, details: `${results.length} transacciones` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getTransactionsByAgreement`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene los clientes configurados en un acuerdo de rebate.
     *
     * @param {string} agreementId
     * @returns {string[]}
     */
    const getCustomersByAgreement = (agreementId) => {
        try {
            const sql = `
                SELECT DISTINCT custrecord_custinc_v1 AS customer_id
                FROM customrecord_rebate_agreement_details
                WHERE custrecord_rm_rebate_agreement = ?
                  AND custrecord_custinc_v1 IS NOT NULL
                  AND isinactive = 'F'
            `;

            return query.runSuiteQL({ query: sql, params: [agreementId] })
                        .asMappedResults()
                        .map(r => String(r.customer_id));

        } catch (e) {
            log.error({ title: `${MODULE}.getCustomersByAgreement`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene el monto ya liquidado de un accrual.
     *
     * NOTA: El módulo nativo de NetSuite Rebates genera settlements por acuerdo completo,
     * no por accrual individual. No hay una relación directa almacenada.
     *
     * Para calcular correctamente el monto liquidado, usamos la tabla propia
     * GIV_REBATE_LIQ_HISTORY que guarda qué accruals se han liquidado.
     *
     * @param {string} accrualId
     * @returns {number}
     */
    const getSettledAmountByAccrual = (accrualId) => {
        try {
            // Buscar en nuestro historial de liquidaciones (GIV_REBATE_LIQ_HISTORY)
            // qué se ha liquidado de este accrual específico
            const historySearch = search.create({
                type: 'customrecord_giv_rebate_liq_history',
                filters: [
                    ['custrecord_giv_lh_src_accrual', 'anyof', accrualId],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: [
                    search.createColumn({
                        name: 'custrecord_giv_lh_src_settl_amt',
                        summary: search.Summary.SUM
                    })
                ]
            });

            let settledAmount = 0;
            historySearch.run().each((result) => {
                settledAmount = parseFloat(result.getValue({
                    name: 'custrecord_giv_lh_src_settl_amt',
                    summary: search.Summary.SUM
                })) || 0;
                return false;
            });

            return Math.abs(settledAmount);

        } catch (e) {
            log.error({ title: `${MODULE}.getSettledAmountByAccrual`, details: e.message });
            // Si la tabla no existe aún (primera vez que se usa), retornar 0
            return 0;
        }
    };

    /**
     * Obtiene el monto de devoluciones (accruals negativos) relacionados a un accrual origen.
     * Busca accruals negativos del mismo acuerdo y factura base que el accrual dado.
     *
     * @param {string} accrualId
     * @returns {number}  Valor absoluto del impacto negativo por devoluciones
     */
    const getReturnsAccrualAmount = (accrualId) => {
        try {
            const sql = `
                SELECT COALESCE(SUM(ret.custrecord_rm_accrual_amount), 0) AS returns_total
                FROM customrecord_rm_accruals ret
                INNER JOIN customrecord_rm_accruals orig
                    ON  ret.custrecord_rm_accru_ra              = orig.custrecord_rm_accru_ra
                    AND ret.custrecord_rm_accrual_base_transaction = orig.custrecord_rm_accrual_base_transaction
                WHERE orig.id                        = ?
                  AND ret.custrecord_rm_accrual_amount < 0
                  AND ret.isinactive                 = 'F'
                  AND ret.id                         <> orig.id
            `;

            const rows = query.runSuiteQL({ query: sql, params: [accrualId] }).asMappedResults();
            return Math.abs(parseFloat(rows[0]?.returns_total) || 0);

        } catch (e) {
            log.error({ title: `${MODULE}.getReturnsAccrualAmount`, details: e.message });
            return 0;
        }
    };

    /**
     * Obtiene el monto "bloqueado" en registros WORK para un accrual
     * (estados Capturado / Validado / Procesando).
     *
     * @param {string} accrualId
     * @returns {number}
     */
    const getLockedAccrualAmount = (accrualId) => {
        try {
            const workSearch = search.create({
                type: 'customrecord_giv_rebate_liq_work',
                filters: [
                    ['custrecord_giv_lw_source_accrual', 'anyof', accrualId],
                    'AND',
                    [
                        ['custrecord_giv_lw_proc_status', 'is', 'Capturado'],
                        'OR',
                        ['custrecord_giv_lw_proc_status', 'is', 'Validado'],
                        'OR',
                        ['custrecord_giv_lw_proc_status', 'is', 'Procesando']
                    ]
                ],
                columns: [
                    search.createColumn({ name: 'custrecord_giv_lw_amt_to_settle', summary: search.Summary.SUM })
                ]
            });

            let locked = 0;
            workSearch.run().each((result) => {
                locked = parseFloat(result.getValue({
                    name: 'custrecord_giv_lw_amt_to_settle',
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
     * Obtiene facturas abiertas de uno o varios clientes.
     *
     * @param {string[]} customerIds
     * @returns {Object[]}
     */
    const getOpenInvoices = (customerIds) => {
        try {
            if (!customerIds || customerIds.length === 0) return [];

            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['entity',          'anyof',      ...customerIds],
                    'AND',
                    ['status',          'anyof',       'CustInvc:A'],
                    'AND',
                    ['mainline',        'is',          'T'],
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
                    invoiceId:       result.getValue('internalid'),
                    tranId:          result.getValue('tranid'),
                    customerId:      result.getValue('entity'),
                    customerText:    result.getText('entity'),
                    date:            result.getValue('trandate'),
                    total:           parseFloat(result.getValue('total'))           || 0,
                    amountRemaining: parseFloat(result.getValue('amountremaining')) || 0,
                    currency:        result.getValue('currency'),
                    currencyText:    result.getText('currency')
                });
                return true;
            });

            log.debug({ title: `${MODULE}.getOpenInvoices`, details: `${results.length} facturas abiertas` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getOpenInvoices`, details: e.message });
            return [];
        }
    };

    /**
     * Obtiene información fiscal (tax code y tasa) de una línea de factura.
     *
     * @param {string} invoiceId
     * @param {string} itemId
     * @returns {{ taxCodeId: string, taxRate: number }}
     */
    const getTaxInfoFromInvoiceLine = (invoiceId, itemId) => {
        try {
            if (!invoiceId || !itemId) return { taxCodeId: '', taxRate: 0 };

            const lineSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['internalid', 'is',    invoiceId],
                    'AND',
                    ['item',       'anyof', itemId],
                    'AND',
                    ['mainline',   'is',    'F'],
                    'AND',
                    ['taxline',    'is',    'F']
                ],
                columns: [
                    search.createColumn({ name: 'taxcode' }),
                    search.createColumn({ name: 'taxrate' })
                ]
            });

            let taxInfo = { taxCodeId: '', taxRate: 0 };
            lineSearch.run().each((result) => {
                taxInfo.taxCodeId = result.getValue('taxcode') || '';
                taxInfo.taxRate   = parseFloat(result.getValue('taxrate')) || 0;
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
     * @param {string} agreementId
     * @returns {Object|null}
     */
    const getAgreement = (agreementId) => {
        try {
            const sql = `
                SELECT
                    id,
                    custrecord_agreement_names              AS name,
                    custrecord_rm_settlement_method         AS settlement_method,
                    custrecord_hidden_payer                 AS payer_id,
                    custrecord_rm_accounting_item           AS accounting_item,
                    custrecord_rm_subsidiary                AS subsidiary_id,
                    custrecord_status_field                 AS status,
                    custrecord_rm_ra_accrual_credit_account AS credit_account,
                    custrecord_rm_ra_accrual_debit_account  AS debit_account
                FROM customrecord_rm_sales_transaction
                WHERE id = ?
            `;

            const results = query.runSuiteQL({ query: sql, params: [agreementId] }).asMappedResults();
            return results.length > 0 ? results[0] : null;

        } catch (e) {
            log.error({ title: `${MODULE}.getAgreement`, details: e.message });
            return null;
        }
    };

    /**
     * Obtiene registros WORK pendientes de procesar.
     *
     * @param {string} [status]  Estado a filtrar (default: 'Capturado')
     * @returns {Object[]}
     */
    const getPendingWorkRecords = (status) => {
        try {
            const workSearch = search.create({
                type: 'customrecord_giv_rebate_liq_work',
                filters: [
                    ['custrecord_giv_lw_proc_status', 'is', status || 'Capturado']
                ],
                columns: [
                    search.createColumn({ name: 'internalid'                     }),
                    search.createColumn({ name: 'custrecord_giv_lw_customer'      }),
                    search.createColumn({ name: 'custrecord_giv_lw_agreement'     }),
                    search.createColumn({ name: 'custrecord_giv_lw_source_invoice'}),
                    search.createColumn({ name: 'custrecord_giv_lw_source_accrual'}),
                    search.createColumn({ name: 'custrecord_giv_lw_source_item'   }),
                    search.createColumn({ name: 'custrecord_giv_lw_invoice_to'    }),
                    search.createColumn({ name: 'custrecord_giv_lw_taxcode'       }),
                    search.createColumn({ name: 'custrecord_giv_lw_settle_method' }),
                    search.createColumn({ name: 'custrecord_giv_lw_scenario'      }),
                    search.createColumn({ name: 'custrecord_giv_lw_original_amt'  }),
                    search.createColumn({ name: 'custrecord_giv_lw_available_amt' }),
                    search.createColumn({ name: 'custrecord_giv_lw_amt_to_settle' }),
                    search.createColumn({ name: 'custrecord_giv_lw_apply_amount'  }),
                    search.createColumn({ name: 'custrecord_giv_lw_tax_basis'     }),
                    search.createColumn({ name: 'custrecord_giv_lw_excess_flag'   }),
                    search.createColumn({ name: 'custrecord_giv_lw_created_from'  })
                ]
            });

            const results = [];
            workSearch.run().each((result) => {
                results.push({
                    workId:           result.getValue('internalid'),
                    customerId:       result.getValue('custrecord_giv_lw_customer'),
                    agreementId:      result.getValue('custrecord_giv_lw_agreement'),
                    sourceInvoiceId:  result.getValue('custrecord_giv_lw_source_invoice'),
                    sourceAccrualId:  result.getValue('custrecord_giv_lw_source_accrual'),
                    sourceItemId:     result.getValue('custrecord_giv_lw_source_item'),
                    invoiceToId:      result.getValue('custrecord_giv_lw_invoice_to'),
                    taxCodeId:        result.getValue('custrecord_giv_lw_taxcode'),
                    settlementMethod: result.getValue('custrecord_giv_lw_settle_method'),
                    scenario:         result.getValue('custrecord_giv_lw_scenario'),
                    originalAmount:   parseFloat(result.getValue('custrecord_giv_lw_original_amt'))  || 0,
                    availableAmount:  parseFloat(result.getValue('custrecord_giv_lw_available_amt')) || 0,
                    amountToSettle:   parseFloat(result.getValue('custrecord_giv_lw_amt_to_settle')) || 0,
                    applyAmount:      parseFloat(result.getValue('custrecord_giv_lw_apply_amount'))  || 0,
                    taxBasis:         parseFloat(result.getValue('custrecord_giv_lw_tax_basis'))     || 0,
                    excessFlag:       result.getValue('custrecord_giv_lw_excess_flag'),
                    createdFrom:      result.getValue('custrecord_giv_lw_created_from')
                });
                return true;
            });

            log.debug({ title: `${MODULE}.getPendingWorkRecords`, details: `${results.length} registros WORK pendientes` });
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
        getSettledAmountByAccrual,
        getReturnsAccrualAmount,
        getLockedAccrualAmount,
        getLockedAccrualAmounts: getLockedAccrualAmount,
        getOpenInvoices,
        getTaxInfoFromInvoiceLine,
        getAgreement,
        getAgreementDetails: getAgreement,
        getPendingWorkRecords
    };
});