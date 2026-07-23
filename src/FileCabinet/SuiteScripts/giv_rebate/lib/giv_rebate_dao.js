/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Data Access Object — Encapsula todas las búsquedas para el módulo
 *              de liquidación de rebates. Usa los Custom Records reales del SuiteApp
 *              de Rebate Management (customrecord_rm_*).
 */
define(['N/search', 'N/query', 'N/record', 'N/log'], (search, query, record, log) => {

    const MODULE = 'giv_rebate_dao';

    /**
     * Obtiene provisiones (Accruals) disponibles para liquidar.
     * Consulta optimizada que trae todos los cálculos en una sola query.
     *
     * @param {Object}            filters
     * @param {string|string[]}   [filters.agreementId]       Internal ID(s) del acuerdo
     * @param {string[]}          [filters.customerIds]       Internal IDs de clientes/pagadores
     * @param {string[]}          [filters.sourceInvoiceIds]  Internal IDs de facturas origen
     * @param {string[]}          [filters.itemIds]           Internal IDs de artículos (MULTISELECT)
     * @param {string}            [filters.itemId]            Internal ID de artículo (compat. singular)
     * @param {string}            [filters.dateFrom]          YYYY-MM-DD (fecha accrual desde)
     * @param {string}            [filters.dateTo]            YYYY-MM-DD (fecha accrual hasta)
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

    /* Liquidado — lógica de prioridad para soportar liquidaciones parciales de GIV:
       1. Si existen WORKs GIV Completados: usar su suma real (evita contar achieved_rebate_amount
          completo cuando solo se liquidó una fracción).
       2. Si no hay WORKs de GIV pero el RTD ya tiene un Claim nativo (liquidado fuera de GIV):
          usar achieved_rebate_amount (comportamiento anterior para claims nativos puros).
       3. Sin Claim ni WORKs: 0. */
        CASE
            WHEN (
                SELECT COUNT(*)
                FROM customrecord_giv_rebate_liq_work wc_chk
                WHERE wc_chk.custrecord_giv_lw_source_accrual = a.id
                  AND wc_chk.custrecord_giv_lw_proc_status    = 'Completado'
                  AND wc_chk.isinactive                       = 'F'
            ) > 0
            THEN COALESCE(
                (
                    SELECT SUM(ABS(wc.custrecord_giv_lw_amt_to_settle))
                    FROM customrecord_giv_rebate_liq_work wc
                    WHERE wc.custrecord_giv_lw_source_accrual = a.id
                      AND wc.custrecord_giv_lw_proc_status    = 'Completado'
                      AND wc.isinactive                       = 'F'
                ),
                0
            )
            WHEN rtd.custrecord_rm_rtd_claim IS NOT NULL
            THEN COALESCE(rtd.custrecord_rm_achieved_rebate_amount, 0)
            ELSE 0
        END AS settled_amount,

    /* Devoluciones —
       Path 1: Nota de Crédito creada directamente desde la Factura Origen (CustInvc → CustCred)
       Path 2: Nota de Crédito creada desde una RMA que nació de la Factura Origen
               (CustInvc → ReturnAuthorization → CustCred)                                      */
COALESCE(
(
    SELECT SUM(ABS(rtd_ret.custrecord_rm_accrual_amo))
    FROM customrecord_rm_accruals ret
    INNER JOIN customrecord_rm_transaction_details rtd_ret
        ON rtd_ret.custrecord_rm_rtd_accrual = ret.id
       AND rtd_ret.isinactive = 'F'
    WHERE ret.isinactive = 'F'
      AND ret.custrecord_rm_accrual_amount < 0
      /* mismo acuerdo */
      AND ret.custrecord_rm_accru_ra = a.custrecord_rm_accru_ra
      /* mismo artículo */
      AND rtd_ret.custrecord_rm_rebate_item = rtd.custrecord_rm_rebate_item
      AND (
          /* Path 1: NC directa desde la Factura Origen */
          EXISTS (
              SELECT 1
              FROM NextTransactionLineLink lnk_direct
              WHERE lnk_direct.nextdoc      = rtd_ret.custrecord_rm_source_transaction
                AND lnk_direct.previousdoc  = rtd.custrecord_rm_source_transaction
                AND lnk_direct.previoustype = 'CustInvc'
                AND lnk_direct.nexttype     = 'CustCred'
          )
          OR
          /* Path 2: NC desde RMA que nació de la Factura Origen */
          EXISTS (
              SELECT 1
              FROM NextTransactionLineLink lnk_rma
              INNER JOIN NextTransactionLineLink lnk_nc
                  ON lnk_nc.previousdoc = lnk_rma.nextdoc
                 AND lnk_nc.nextdoc     = rtd_ret.custrecord_rm_source_transaction
                 AND lnk_nc.nexttype    = 'CustCred'
              WHERE lnk_rma.previousdoc  = rtd.custrecord_rm_source_transaction
                AND lnk_rma.previoustype = 'CustInvc'
                AND lnk_rma.nexttype     = 'ReturnAuthorization'
          )
      )
),
0
) AS returns_amount,

    /* Bloqueado (en proceso activo: aún no se ha generado la transacción) */
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
    ) AS locked_amount,

    /* [COMENTADO] Liquidado por GIV (WORK records Completados).
       Se comenta porque GIV genera una liquidación nativa al completar,
       por lo que ya queda capturado en settled_amount (Claim nativo).
       Sumarlo aquí causaba doble conteo.
    COALESCE(
        (
            SELECT SUM(ABS(wc.custrecord_giv_lw_amt_to_settle))
            FROM customrecord_giv_rebate_liq_work wc
            WHERE wc.custrecord_giv_lw_source_accrual = a.id
              AND wc.custrecord_giv_lw_proc_status = 'Completado'
              AND wc.isinactive = 'F'
        ),
        0
    ) AS giv_settled_amount
    */

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

            // Filtro por cliente/pagador (campo custrecord_hidden_payer del acuerdo)
            if (filters.customerIds && filters.customerIds.length > 0) {
                sql += ` AND ag.custrecord_hidden_payer IN (${filters.customerIds.map(() => '?').join(',')})`;
                filters.customerIds.forEach(id => params.push(id));
            }

            if (filters.sourceInvoiceIds && filters.sourceInvoiceIds.length > 0) {
                sql += ` AND t.id IN (${filters.sourceInvoiceIds.map(() => '?').join(',')})`;
                filters.sourceInvoiceIds.forEach(id => params.push(id));
            }

            // Artículo — soporta múltiples valores (MULTISELECT) y singular (compat.)
            if (filters.itemIds && filters.itemIds.length > 0) {
                sql += ` AND rtd.custrecord_rm_rebate_item IN (${filters.itemIds.map(() => '?').join(',')})`;
                filters.itemIds.forEach(id => params.push(id));
            } else if (filters.itemId) {
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
                // accrual_detail_amount  = monto del RTD de la factura origen (custrecord_rm_accrual_amo).
                //                         Es el valor visible en la factura → base de "Original Provision".
                // achieved_rebate_amount = monto liquidable calculado por el RM Bundle.
                //                         Puede ser menor que accrual_amo cuando no se cumplen
                //                         todos los umbrales del acuerdo.
                const accrualDetailAmount = parseFloat(row.accrual_detail_amount)  || 0;
                const achievedAmount      = parseFloat(row.achieved_rebate_amount) || 0;

                // [FIX] Usar accrual_amo (lo que muestra la factura) como base de la provisión original.
                // Antes se usaba achieved_rebate_amount, lo que causaba mostrar la mitad del valor real
                // cuando achieved < accrual_amo (ej. INV123: accrual=$2.40, achieved=$1.20 → mostraba $1.20).
                const accrualAmount = accrualDetailAmount > 0 ? accrualDetailAmount : achievedAmount;

                const settledAmount = parseFloat(row.settled_amount) || 0;
                const lockedAmount  = parseFloat(row.locked_amount)  || 0;

                // [FIX] El RM Bundle ya calcula el accrual de la NC de forma proporcional:
                //   devolver 1 de 2 unidades → RTD de la CM con accrual_amo = $1.20 (exacto).
                // Aplicar achievedRatio encima de ese valor causaba doble reducción:
                //   $1.20 × 0.50 = $0.60 en lugar de $1.20.
                // Se usa returnsRaw directamente sin escalar.
                //
                // Escenario correcto post-fix:
                //   INV123 (2 uds): accrual_amo=$2.40  → Original Provision = $2.40
                //   CM     (1 ud):  return_raw =$1.20  → Returns            = $1.20
                //   available = $2.40 − $0 − $1.20 = $1.20 ✓
                const returnsAmount = parseFloat(row.returns_amount) || 0;

                // Saldo disponible = Provisión original − Liquidado − Devoluciones
                const available = accrualAmount - settledAmount - returnsAmount;

                // Solo mostrar provisiones con saldo disponible mayor a 0.
                // available = 0  → ya liquidado totalmente → excluir de la lista.
                // available < 0  → devoluciones > provisión (caso anómalo) → excluir también.
                if (available > 0) {
                    results.push({
                        accrualId:        String(row.accrual_id),
                        agreementId:      String(row.agreement_id),
                        agreementText:    row.agreement_name   || '',
                        accrualAmount:    accrualAmount,
                        settledAmount:    settledAmount,        // Claim nativo SuiteApp (incluye liquidaciones GIV)
                        // givSettledAmount: givSettledAmount,  // [COMENTADO] doble conteo
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

                }
            });


            log.debug({ title: `${MODULE}.getAvailableAccruals`, details: `${results.length} provisiones disponibles` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getAvailableAccruals`, details: e.message || e });
            return [];
        }
    };

    /**
     * Obtiene las transacciones (facturas) vinculadas a uno o varios acuerdos de rebate.
     *
     * @param {string|string[]} agreementIds  - ID único o array de IDs (multiselect \u0005)
     * @returns {Object[]}
     */
    const getTransactionsByAgreement = (agreementIds) => {
        try {
            // Normalizar a array — soporta string único, array, o multiselect con \u0005
            const ids = Array.isArray(agreementIds)
                ? agreementIds
                : String(agreementIds).split('\u0005').map(s => s.trim()).filter(Boolean);

            if (ids.length === 0) return [];

            const placeholders = ids.map(() => '?').join(',');

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
                    ON rad.custrecord_rm_rebate_agreement IN (${placeholders})
                WHERE rt.isinactive = 'F'
                    AND rt.custrecord_refund_type = 'sale'
                ORDER BY rt.custrecord_rm_origin_tran_date DESC
            `;

            const results = query.runSuiteQL({ query: sql, params: ids }).asMappedResults();
            log.debug({ title: `${MODULE}.getTransactionsByAgreement`, details: `${ids.join(',')} → ${results.length} transacciones` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getTransactionsByAgreement`, details: e.message || e });
            return [];
        }
    };

    /**
     * Obtiene los clientes configurados en uno o varios acuerdos de rebate.
     * Soporta multiselect (string con \u0005 como delimitador o array de IDs).
     *
     * @param {string|string[]} agreementIds  - ID único, array, o multiselect \u0005
     * @returns {string[]}
     */
    const getCustomersByAgreement = (agreementIds) => {
        try {
            // Normalizar a array — soporta string único, array, o multiselect con \u0005
            const ids = Array.isArray(agreementIds)
                ? agreementIds
                : String(agreementIds).split('\u0005').map(s => s.trim()).filter(Boolean);

            if (ids.length === 0) return [];

            const placeholders = ids.map(() => '?').join(',');

            const sql = `
                SELECT DISTINCT custrecord_custinc_v1 AS customer_id
                FROM customrecord_rebate_agreement_details
                WHERE custrecord_rm_rebate_agreement IN (${placeholders})
                  AND custrecord_custinc_v1 IS NOT NULL
                  AND isinactive = 'F'
            `;

            // custrecord_custinc_v1 puede almacenar múltiples IDs separados por coma
            // ej. "141,279,502" → se divide en IDs individuales
            const rows = query.runSuiteQL({ query: sql, params: ids }).asMappedResults();

            const uniqueIds = new Set();
            rows.forEach(r => {
                String(r.customer_id).split(',').forEach(id => {
                    const trimmed = id.trim();
                    if (trimmed) uniqueIds.add(trimmed);
                });
            });

            const result = Array.from(uniqueIds);
            log.debug({ title: `${MODULE}.getCustomersByAgreement`, details: `Agreements [${ids.join(',')}] → customers: ${result.join(', ')}` });
            return result;

        } catch (e) {
            log.error({ title: `${MODULE}.getCustomersByAgreement`, details: e.message || e });
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
            log.error({ title: `${MODULE}.getSettledAmountByAccrual`, details: e.message || e });
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
            log.error({ title: `${MODULE}.getReturnsAccrualAmount`, details: e.message || e });
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
            log.error({ title: `${MODULE}.getLockedAccrualAmount`, details: e.message || e });
            return 0;
        }
    };

    /**
     * Obtiene facturas abiertas de uno o varios clientes.
     * Excluye facturas con saldo residual menor al umbral mínimo configurable
     * (ej. $0.01 que pasaría el filtro > 0 pero se visualizaría como $0.00).
     *
     * @param {string[]} customerIds
     * @returns {Object[]}
     */
    const getOpenInvoices = (customerIds) => {
        try {
            if (!customerIds || customerIds.length === 0) return [];

            // Umbral mínimo: facturas con saldo menor a este valor se consideran
            // "prácticamente liquidadas" y se excluyen de la sublista destino.
            // Ajustar si la moneda del acuerdo maneja más decimales.
            const MIN_BALANCE = 0.01;

            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['entity',          'anyof',      ...customerIds],
                    'AND',
                    ['status',          'anyof',       'CustInvc:A'],
                    'AND',
                    ['mainline',        'is',          'T'],
                    'AND',
                    ['amountremaining', 'greaterthan', MIN_BALANCE]  // ← umbral mínimo en el filtro DB
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
                const amountRemaining = parseFloat(result.getValue('amountremaining')) || 0;

                // Post-filtro JS: segunda capa de protección ante redondeos del motor de búsqueda
                if (amountRemaining < MIN_BALANCE) {
                    log.debug({
                        title: `${MODULE}.getOpenInvoices`,
                        details: `Factura ${result.getValue('tranid')} excluida por saldo residual: $${amountRemaining}`
                    });
                    return true; // continuar iteración sin agregar
                }

                results.push({
                    invoiceId:       result.getValue('internalid'),
                    tranId:          result.getValue('tranid'),
                    customerId:      result.getValue('entity'),
                    customerText:    result.getText('entity'),
                    date:            result.getValue('trandate'),
                    total:           parseFloat(result.getValue('total')) || 0,
                    amountRemaining: amountRemaining,
                    currency:        result.getValue('currency'),
                    currencyText:    result.getText('currency')
                });
                return true;

            });

            log.debug({ title: `${MODULE}.getOpenInvoices`, details: `${results.length} facturas abiertas` });
            return results;

        } catch (e) {
            log.error({ title: `${MODULE}.getOpenInvoices`, details: e.message || e });
            return [];
        }
    };

    /**
     * Obtiene información fiscal (tax code y tasa) de una línea de factura.
     * Usa record.load() en lugar de search.create() para evitar errores de columna
     * con la localización avanzada de impuestos mexicana (AT localization).
     *
     * @param {string} invoiceId
     * @param {string} itemId
     * @returns {{ taxCodeId: string, taxRate: number }}
     */
    const getTaxInfoFromInvoiceLine = (invoiceId, itemId) => {
        try {
            if (!invoiceId || !itemId) return { taxCodeId: '', taxRate: 0 };

            // Cargar la factura directamente en memoria
            const inv = record.load({ type: record.Type.INVOICE, id: invoiceId, isDynamic: false });

            const lineCount = inv.getLineCount({ sublistId: 'item' });
            for (let i = 0; i < lineCount; i++) {
                const lineItemId = inv.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                if (String(lineItemId) === String(itemId)) {
                    // En AT localization, los campos del sublist 'item' son accesibles directamente
                    const taxCodeId = inv.getSublistValue({ sublistId: 'item', fieldId: 'taxcode', line: i }) || '';
                    const taxRate   = parseFloat(inv.getSublistValue({ sublistId: 'item', fieldId: 'taxrate', line: i })) || 0;
                    log.debug({ title: `${MODULE}.getTaxInfoFromInvoiceLine`, details: `Invoice ${invoiceId} / Item ${itemId} → taxCode: ${taxCodeId}, rate: ${taxRate}` });
                    return { taxCodeId: String(taxCodeId), taxRate };
                }
            }

            log.debug({ title: `${MODULE}.getTaxInfoFromInvoiceLine`, details: `Item ${itemId} not found in invoice ${invoiceId}` });
            return { taxCodeId: '', taxRate: 0 };

        } catch (e) {
            log.error({ title: `${MODULE}.getTaxInfoFromInvoiceLine`, details: e.message || e });
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
            if (results.length === 0) return null;

            // Retorna AMBOS formatos para compatibilidad con todos los callers:
            //   - camelCase: nuevo estándar (giv_sl_rebate_csv_upload.js usa settlementMethod)
            //   - snake_case: callers existentes (giv_sl_rebate_dashboard.js y giv_mr_rebate_liquidation.js
            //                 usan settlement_method y accounting_item)
            const r = results[0];
            return {
                // ── camelCase (estándar nuevo) ──
                id:               String(r.id),
                name:             r.name                 || '',
                settlementMethod: String(r.settlement_method || ''),
                payerId:          String(r.payer_id       || ''),
                accountingItem:   String(r.accounting_item || ''),
                subsidiaryId:     String(r.subsidiary_id  || ''),
                status:           r.status               || '',
                creditAccount:    String(r.credit_account || ''),
                debitAccount:     String(r.debit_account  || ''),
                // ── snake_case (backward-compat para Dashboard y M/R) ──
                settlement_method: String(r.settlement_method || ''),
                payer_id:          String(r.payer_id       || ''),
                accounting_item:   String(r.accounting_item || ''),
                subsidiary_id:     String(r.subsidiary_id  || ''),
                credit_account:    String(r.credit_account || ''),
                debit_account:     String(r.debit_account  || '')
            };

        } catch (e) {
            log.error({ title: `${MODULE}.getAgreement`, details: e.message || e });
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
            log.error({ title: `${MODULE}.getPendingWorkRecords`, details: e.message || e });
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