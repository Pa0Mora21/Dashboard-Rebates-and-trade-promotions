/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Utilidades fiscales para manejo de Tax Details Override (Escenario 9)
 *              y herencia de programas fiscales desde la factura origen.
 *
 *  Flujo Escenario 9 (Agrupación):
 *  1. enrichWithTaxInfo(workRecords) → lee TODOS los impuestos de cada item/factura
 *  2. buildTaxDetailsOverride(enrichedRecords) → agrupa por taxCodeId sumando bases
 *  3. El transaction_builder inyecta las líneas resultantes en la sublista taxdetails del CM
 */
define(['N/log', './giv_rebate_dao'], (log, dao) => {

    const MODULE = 'giv_rebate_tax_utils';

    /**
     * Obtiene el Tax Schedule/Code de un artículo en la factura origen (UN solo impuesto).
     * Usado por escenarios 1-4 donde cada línea del CM lleva su propio taxcode.
     */
    const getTaxScheduleFromSourceInvoice = (invoiceId, itemId) => {
        try {
            return dao.getTaxInfoFromInvoiceLine(invoiceId, itemId);
        } catch (e) {
            log.error({
                title: `${MODULE}.getTaxScheduleFromSourceInvoice`,
                details: `[InvoiceId=${invoiceId}, ItemId=${itemId}] ${e.message || e}`
            });
            return { taxScheduleId: '', taxScheduleText: '', taxRate: 0, lineAmount: 0 };
        }
    };

    /**
     * Enriquece registros WORK con TODOS los detalles fiscales de la factura origen.
     * Cada WORK recibe un array 'taxDetails' con todas las líneas de impuesto
     * (ej. [{taxCodeId: '612', taxRate: 8, taxBasis: 1, taxAmount: 0.08},
     *       {taxCodeId: '634', taxRate: 0, taxBasis: 1, taxAmount: 0}])
     *
     * @param {Object[]} workRecords  Registros WORK filtrados (solo fuente, amountToSettle > 0)
     * @returns {Object[]}  workRecords enriquecidos con propiedad 'taxDetails' (array)
     */
    const enrichWithTaxInfo = (workRecords) => {
        try {
            return workRecords.map((wr) => {
                const invoiceId = wr.sourceInvoiceId || '';
                const itemId    = wr.sourceItemId || '';
                const amount    = parseFloat(wr.amountToSettle || 0);

                if (!invoiceId || !itemId) return { ...wr, taxDetails: [] };

                // Leer TODOS los impuestos de esa línea (IEPS + IVA, etc.)
                const taxDetails = dao.getAllTaxDetailsFromInvoiceLine(invoiceId, itemId, amount);

                log.debug({
                    title: `${MODULE}.enrichWithTaxInfo`,
                    details: `WORK inv=${invoiceId}, item=${itemId}, amt=${amount} → ${taxDetails.length} tax lines`
                });

                return { ...wr, taxDetails };
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.enrichWithTaxInfo`,
                details: `[workRecords=${workRecords.length}] ${e.message || e}`
            });
            return workRecords;
        }
    };

    /**
     * Construye las líneas para la sublista taxdetails del CM agrupando por código de impuesto.
     * Suma taxBasis y taxAmount de todos los WORK records para cada taxCodeId.
     *
     * Ejemplo con 2 provisiones:
     *   WR1: [{IEPS 8%, basis: 1, amt: 0.08}, {IVA 0%, basis: 1, amt: 0}]
     *   WR2: [{IEPS 8%, basis: 2, amt: 0.16}, {IVA 0%, basis: 2, amt: 0}]
     * Resultado:
     *   [{IEPS 8%, basis: 3, amt: 0.24}, {IVA 0%, basis: 3, amt: 0}]
     *
     * @param {Object[]} enrichedRecords  WORKs con propiedad 'taxDetails' (del enrichWithTaxInfo)
     * @returns {Array<{taxCodeId: string, taxBasis: number, taxAmount: number, taxRate: number}>}
     */
    const buildTaxDetailsOverride = (enrichedRecords) => {
        try {
            const taxGroups = {};

            enrichedRecords.forEach((wr) => {
                const details = wr.taxDetails || [];
                details.forEach((td) => {
                    const key = td.taxCodeId;
                    if (!key) return;

                    if (!taxGroups[key]) {
                        taxGroups[key] = {
                            taxCodeId: key,
                            taxRate:   td.taxRate || 0,
                            taxType:   td.taxType || '',
                            taxBasis:  0,
                            taxAmount: 0
                        };
                    }

                    taxGroups[key].taxBasis  += td.taxBasis  || 0;
                    taxGroups[key].taxAmount += td.taxAmount || 0;
                });
            });

            // Redondear a 2 decimales
            const taxLines = Object.values(taxGroups).map((group) => ({
                taxCodeId: group.taxCodeId,
                taxRate:   group.taxRate,
                taxType:   group.taxType,
                taxBasis:  Math.round(group.taxBasis * 100) / 100,
                taxAmount: Math.round(group.taxAmount * 100) / 100
            }));

            log.audit({
                title: `${MODULE}.buildTaxDetailsOverride`,
                details: `Built ${taxLines.length} tax detail lines from ${enrichedRecords.length} work records: ${JSON.stringify(taxLines)}`
            });

            return taxLines;

        } catch (e) {
            log.error({
                title: `${MODULE}.buildTaxDetailsOverride`,
                details: `[workRecords=${enrichedRecords.length}] ${e.message || e}`
            });
            throw e;
        }
    };

    /**
     * Calcula la base gravable por combinación fiscal para un conjunto de líneas.
     */
    const calculateTaxBasis = (lines) => {
        try {
            const basisMap = {};

            lines.forEach((line) => {
                const taxCode = line.taxScheduleId || '';
                const amount = parseFloat(line.amount || line.amountToSettle || 0);

                if (!basisMap[taxCode]) {
                    basisMap[taxCode] = 0;
                }
                basisMap[taxCode] = Math.round((basisMap[taxCode] + amount) * 100) / 100;
            });

            return basisMap;

        } catch (e) {
            log.error({
                title: `${MODULE}.calculateTaxBasis`,
                details: `${e.message || e}`
            });
            return {};
        }
    };

    return {
        getTaxScheduleFromSourceInvoice,
        buildTaxDetailsOverride,
        calculateTaxBasis,
        enrichWithTaxInfo
    };
});
