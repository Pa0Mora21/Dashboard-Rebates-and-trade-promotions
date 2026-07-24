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

    /* Liquidado — lógica inteligente que combina liquidación nativa RM y WORKs GIV:
       CASO A — Existen WORKs GIV + claim nativo, y la suma NO excede la provisión:
                 → ambas son cobros independientes reales (ej. CM90 nativa + WORK GIV).
                 → settled = giv_completed + achieved_rebate_amount.
       CASO B — Existen WORKs GIV, pero la suma con el claim excedería la provisión:
                 → el claim fue generado por GIV (artefacto RM Bundle), no un cobro previo real.
                 → settled = giv_completed únicamente.
       CASO C — Solo existe claim nativo, sin WORKs GIV:
                 → settled = achieved_rebate_amount (proxy del cobro nativo).
       CASO D — Sin claim ni WORKs: settled = 0.
       NOTA: Se usa LEFT JOIN (giv_completed) en lugar de sub-query correlacionada en CASE
       porque SuiteQL NO soporta CASE WHEN (SELECT ...) cuando se combina con filtros específicos
       como sourceInvoiceIds + itemId. El LEFT JOIN agrupado es equivalente y totalmente compatible. */
        CASE
            /* CASO A: GIV + nativo independiente (suma ≤ provisión) */
            WHEN giv_completed.total_completed IS NOT NULL
                 AND rtd.custrecord_rm_rtd_claim IS NOT NULL
                 AND (giv_completed.total_completed + COALESCE(rtd.custrecord_rm_achieved_rebate_amount, 0))
                     <= ABS(rtd.custrecord_rm_accrual_amo)
            THEN giv_completed.total_completed + COALESCE(rtd.custrecord_rm_achieved_rebate_amount, 0)
            /* CASO B: GIV existe (con o sin claim excedente — usar solo GIV) */
            WHEN giv_completed.total_completed IS NOT NULL
            THEN giv_completed.total_completed
            /* CASO C: Solo claim nativo sin GIV */
            WHEN rtd.custrecord_rm_rtd_claim IS NOT NULL
            THEN COALESCE(rtd.custrecord_rm_achieved_rebate_amount, 0)
            /* CASO D: Sin liquidación */
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

    /* Bloqueado (en proceso activo: aún no se ha generado la transacción)
       NOTA: Se usa LEFT JOIN (giv_locked) en lugar de sub-query correlacionada por la misma
       razón que settled_amount: SuiteQL no soporta sub-queries correlacionadas en SELECT
       cuando el outer query tiene filtros específicos (sourceInvoiceIds + itemId). */
    COALESCE(giv_locked.total_locked, 0) AS locked_amount,

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

/* GIV WORKs Completados — agrupados por accrual para reemplazar sub-query correlacionada en CASE.
   SuiteQL no soporta CASE WHEN (SELECT COUNT(*)...) cuando se combina con filtros específicos. */
LEFT JOIN (
    SELECT
        wc.custrecord_giv_lw_source_accrual          AS accrual_id,
        SUM(ABS(wc.custrecord_giv_lw_amt_to_settle)) AS total_completed
    FROM customrecord_giv_rebate_liq_work wc
    WHERE wc.custrecord_giv_lw_proc_status = 'Completado'
      AND wc.isinactive = 'F'
    GROUP BY wc.custrecord_giv_lw_source_accrual
) giv_completed ON giv_completed.accrual_id = a.id

/* GIV WORKs en proceso (Capturado/Validado/Procesando) — agrupados por accrual. */
LEFT JOIN (
    SELECT
        wl.custrecord_giv_lw_source_accrual          AS accrual_id,
        SUM(ABS(wl.custrecord_giv_lw_amt_to_settle)) AS total_locked
    FROM customrecord_giv_rebate_liq_work wl
    WHERE wl.custrecord_giv_lw_proc_status IN ('Capturado','Validado','Procesando')
      AND wl.isinactive = 'F'
    GROUP BY wl.custrecord_giv_lw_source_accrual
) giv_locked ON giv_locked.accrual_id = a.id

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

    /**
     * Resuelve nombres/códigos → Internal IDs para la carga CSV en una sola pasada por tipo.
     * Los valores puramente numéricos se mapean a sí mismos sin ninguna búsqueda en NS.
     * Los valores texto se buscan por nombre/código en NetSuite (una búsqueda por tipo de entidad).
     *
     * @param {Object}   rawData
     * @param {string[]} rawData.customerValues   Valores únicos de la columna Cliente
     * @param {string[]} rawData.agreementValues  Valores únicos de la columna Agreement
     * @param {string[]} rawData.invoiceValues    Valores únicos de Facturas (origen + destino combinados)
     * @param {string[]} rawData.itemValues       Valores únicos de la columna Artículo
     *
     * @returns {{ customers: Object, agreements: Object, invoices: Object, items: Object }}
     *   Mapas { "valorCSV": "internalId" } para cada tipo de entidad
     */
    const resolveCsvIdentifiers = (rawData) => {
        const result = {
            customers:      {},
            agreements:     {},
            invoices:       {},
            invoiceCustomers: {},
            invoiceLabels:  {},   // id → tranid (para links en errores)
            items:          {},
            itemLabels:     {},   // id → itemid (para links en errores)
            agreementLabels:{},   // id → nombre acuerdo (para errores legibles)
        };

        /** Separa numéricos (ya son IDs) de texto (requieren búsqueda). */
        const partition = (values) => {
            const ids = [], names = [];
            (values || []).forEach(v => {
                const s = String(v || '').trim();
                if (!s) return;
                (/^[1-9]\d*$/.test(s) ? ids : names).push(s);
            });
            return { ids, names };
        };

        /** Numéricos: se mapean a sí mismos sin consulta a NS. */
        const selfMap = (ids, map) => ids.forEach(id => { map[id] = id; });

        /**
         * Construye filtro NS: field IS v1 OR field IS v2 ...
         * Retorna un array válido para search.create({ filters }).
         */
        const orFilter = (fieldId, values) => {
            if (!values.length) return [];
            if (values.length === 1) return [[fieldId, 'is', values[0]]];
            const parts = [];
            values.forEach((v, i) => {
                if (i > 0) parts.push('OR');
                parts.push([fieldId, 'is', v]);
            });
            return parts;
        };

        /**
         * Construye filtro NS: (f1 IS v OR f2 IS v) OR (f1 IS v2 OR f2 IS v2) ...
         * Para dos campos alternativos por valor.
         */
        const dualOrFilter = (field1, field2, values) => {
            if (!values.length) return [];
            if (values.length === 1) {
                return [
                    [field1, 'is', values[0]],
                    'OR',
                    [field2, 'is', values[0]]
                ];
            }
            const groups = values.map(v => [
                [field1, 'is', v],
                'OR',
                [field2, 'is', v]
            ]);
            const parts = [];
            groups.forEach((g, i) => {
                if (i > 0) parts.push('OR');
                parts.push(g);
            });
            return parts;
        };

        // ── Clientes ─────────────────────────────────────────────────────────────
        {
            const { ids, names } = partition(rawData.customerValues);
            selfMap(ids, result.customers);
            if (names.length > 0) {
                try {
                    search.create({
                        type: search.Type.CUSTOMER,
                        filters: dualOrFilter('entityid', 'companyname', names),
                        columns: [
                            search.createColumn({ name: 'internalid' }),
                            search.createColumn({ name: 'entityid' }),
                            search.createColumn({ name: 'companyname' }),
                            search.createColumn({ name: 'altname' })
                        ]
                    }).run().each(r => {
                        const id  = r.getValue('internalid');
                        const eid = (r.getValue('entityid')    || '').trim();
                        const cn  = (r.getValue('companyname') || '').trim();
                        const an  = (r.getValue('altname')     || '').trim();
                        if (eid) result.customers[eid] = id;
                        if (cn)  result.customers[cn]  = id;
                        if (an)  result.customers[an]  = id;
                        return true;
                    });
                } catch (e) {
                    log.error({ title: `${MODULE}.resolveCsvIdentifiers.customers`, details: e.message || e });
                }
            }
        }

        // ── Acuerdos ────────────────────────────────────────────────────────────────────────
        {
            const { ids, names } = partition(rawData.agreementValues);
            selfMap(ids, result.agreements);
            if (names.length > 0) {
                try {
                    // NOTA: el tipo correcto del RM Bundle para acuerdos es customrecord_rm_sales_transaction.
                    // Se busca por custrecord_agreement_names (campo personalizado) y también por
                    // el nombre nativo del registro (name) para soportar ambas formas en el CSV.
                    search.create({
                        type: 'customrecord_rm_sales_transaction',
                        filters: dualOrFilter('custrecord_agreement_names', 'name', names),
                        columns: [
                            search.createColumn({ name: 'internalid' }),
                            search.createColumn({ name: 'name' }),
                            search.createColumn({ name: 'custrecord_agreement_names' })
                        ]
                    }).run().each(r => {
                        const id         = r.getValue('internalid');
                        const recName    = (r.getValue('name')                       || '').trim();
                        const agName     = (r.getValue('custrecord_agreement_names') || '').trim();
                        // Registrar ambas variantes como clave válida en el CSV
                        if (agName) {
                            result.agreements[agName] = id;
                            result.agreementLabels[String(id)] = agName;
                        }
                        if (recName && !result.agreements[recName]) {
                            result.agreements[recName] = id;
                            if (!result.agreementLabels[String(id)]) result.agreementLabels[String(id)] = recName;
                        }
                        return true;
                    });
                } catch (e) {
                    log.error({ title: `${MODULE}.resolveCsvIdentifiers.agreements`, details: e.message || e });
                }
            }
        }

        // ── Facturas (origen + destino comparten el mismo mapa) ──────────────────
        {
            const { ids, names } = partition(rawData.invoiceValues);
            selfMap(ids, result.invoices);
            if (names.length > 0) {
                try {
                    // Construir filtro tranid OR para múltiples valores
                    const tranFilters = [];
                    names.forEach((n, i) => {
                        if (i > 0) tranFilters.push('OR');
                        tranFilters.push(['tranid', 'is', n]);
                    });
                    const invFilters = names.length === 1
                        ? [['mainline', 'is', 'T'], 'AND', tranFilters[0]]
                        : [['mainline', 'is', 'T'], 'AND', tranFilters];

                    search.create({
                        type: search.Type.INVOICE,
                        filters: invFilters,
                        columns: [
                            search.createColumn({ name: 'internalid' }),
                            search.createColumn({ name: 'tranid' })
                        ]
                    }).run().each(r => {
                        const id     = r.getValue('internalid');
                        const tranid = (r.getValue('tranid') || '').trim();
                        if (tranid) result.invoices[tranid] = id;
                        return true;
                    });
                } catch (e) {
                    log.error({ title: `${MODULE}.resolveCsvIdentifiers.invoices`, details: e.message || e });
                }
            }
        }

        // ── Artículos ────────────────────────────────────────────────────────────
        {
            const { ids, names } = partition(rawData.itemValues);
            selfMap(ids, result.items);
            if (names.length > 0) {
                try {
                    search.create({
                        type: search.Type.ITEM,
                        filters: dualOrFilter('itemid', 'displayname', names),
                        columns: [
                            search.createColumn({ name: 'internalid' }),
                            search.createColumn({ name: 'itemid' }),
                            search.createColumn({ name: 'displayname' })
                        ]
                    }).run().each(r => {
                        const id  = r.getValue('internalid');
                        const iid = (r.getValue('itemid')      || '').trim();
                        const dn  = (r.getValue('displayname') || '').trim();
                        if (iid) result.items[iid] = id;
                        if (dn)  result.items[dn]  = id;
                        return true;
                    });
                } catch (e) {
                    log.error({ title: `${MODULE}.resolveCsvIdentifiers.items`, details: e.message || e });
                }
            }
        }

        // ── Clientes de cada factura (para validar que Factura Destino pertenece al mismo cliente) ─
        // Se hace después de resolver nombres porque necesitamos los Internal IDs finales.
        const resolvedInvoiceIds = [...new Set(Object.values(result.invoices))];
        if (resolvedInvoiceIds.length > 0) {
            try {
                const invIdFilters = resolvedInvoiceIds.length === 1
                    ? [['internalid', 'anyof', resolvedInvoiceIds[0]], 'AND', ['mainline', 'is', 'T']]
                    : [['internalid', 'anyof', resolvedInvoiceIds], 'AND', ['mainline', 'is', 'T']];

                search.create({
                    type: search.Type.INVOICE,
                    filters: invIdFilters,
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'entity' }),
                        search.createColumn({ name: 'tranid' })  // para invoiceLabels
                    ]
                }).run().each(r => {
                    const id     = r.getValue('internalid');
                    const cust   = r.getValue('entity');
                    const tranid = (r.getValue('tranid') || '').trim();
                    if (id && cust)   result.invoiceCustomers[String(id)] = String(cust);
                    if (id && tranid) result.invoiceLabels[String(id)]    = tranid;
                    return true;
                });
            } catch (e) {
                log.error({ title: `${MODULE}.resolveCsvIdentifiers.invoiceCustomers`, details: e.message || e });
            }
        }

        // ── itemLabels: id → itemid (para mensajes de error con link clickeable) ──
        // Usa orFilter (IS + OR) porque 'anyof' no está soportado en internalid para items en NS.
        const resolvedItemIds = [...new Set(Object.values(result.items))];
        if (resolvedItemIds.length > 0) {
            try {
                search.create({
                    type: search.Type.ITEM,
                    filters: orFilter('internalid', resolvedItemIds),
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'itemid' })
                    ]
                }).run().each(r => {
                    const id  = r.getValue('internalid');
                    const iid = (r.getValue('itemid') || '').trim();
                    if (id && iid) result.itemLabels[String(id)] = iid;
                    return true;
                });
            } catch (e) {
                log.error({ title: `${MODULE}.resolveCsvIdentifiers.itemLabels`, details: e.message || e });
            }
        }

        log.debug({
            title:   `${MODULE}.resolveCsvIdentifiers`,
            details: `Resuelto — customers: ${Object.keys(result.customers).length}, ` +
                     `agreements: ${Object.keys(result.agreements).length}, ` +
                     `invoices: ${Object.keys(result.invoices).length}, ` +
                     `invoiceCustomers: ${Object.keys(result.invoiceCustomers).length}, ` +
                     `items: ${Object.keys(result.items).length}`
        });

        return result;
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
        getPendingWorkRecords,
        resolveCsvIdentifiers
    };
});