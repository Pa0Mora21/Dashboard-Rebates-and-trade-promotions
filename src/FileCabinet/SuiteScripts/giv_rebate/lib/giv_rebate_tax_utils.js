/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Utilidades fiscales para manejo de Tax Details Override (Escenario 9)
 *              y herencia de programas fiscales desde la factura origen.
 */
define(['N/log', './giv_rebate_dao'], (log, dao) => {

    const MODULE = 'giv_rebate_tax_utils';

    /**
     * Obtiene el Tax Schedule/Code de un artículo en la factura origen.
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
     * Construye las líneas para la sublista taxdetails agrupando por código de impuesto.
     * Se usa en el Escenario 9 (Agrupación).
     */
    const buildTaxDetailsOverride = (workRecords) => {
        try {
            const taxGroups = {};

            workRecords.forEach((wr) => {
                const taxCode = wr.taxScheduleId || wr.custrecord_giv_liq_work_taxcode || '';
                if (!taxCode) return;

                if (!taxGroups[taxCode]) {
                    taxGroups[taxCode] = {
                        taxCodeId: taxCode,
                        taxBasis: 0,
                        taxRate: wr.taxRate || 0,
                        taxAmount: 0
                    };
                }

                const basis = parseFloat(wr.taxBasis || wr.custrecord_giv_liq_work_tax_basis || wr.amountToSettle || 0);
                taxGroups[taxCode].taxBasis += basis;
            });

            const taxLines = Object.values(taxGroups).map((group) => {
                group.taxBasis = Math.round(group.taxBasis * 100) / 100;
                group.taxAmount = Math.round(group.taxBasis * (group.taxRate / 100) * 100) / 100;
                return group;
            });

            log.debug({
                title: `${MODULE}.buildTaxDetailsOverride`,
                details: `Built ${taxLines.length} tax detail lines from ${workRecords.length} work records`
            });

            return taxLines;

        } catch (e) {
            log.error({
                title: `${MODULE}.buildTaxDetailsOverride`,
                details: `[workRecords=${workRecords.length}] ${e.message || e}`
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

    /**
     * Enriquece registros WORK con información fiscal de la factura origen.
     */
    const enrichWithTaxInfo = (workRecords) => {
        try {
            return workRecords.map((wr) => {
                const invoiceId = wr.custrecord_giv_liq_work_source_invoice || wr.sourceInvoiceId || '';
                const itemId = wr.custrecord_giv_liq_work_source_item || wr.sourceItemId || '';
                const amount = parseFloat(wr.custrecord_giv_liq_work_amount_to_settle || wr.amountToSettle || 0);

                if (!invoiceId || !itemId) return wr;

                const taxInfo = getTaxScheduleFromSourceInvoice(invoiceId, itemId);

                return {
                    ...wr,
                    taxScheduleId: taxInfo.taxScheduleId,
                    taxScheduleText: taxInfo.taxScheduleText,
                    taxRate: taxInfo.taxRate,
                    taxBasis: amount
                };
            });

        } catch (e) {
            log.error({
                title: `${MODULE}.enrichWithTaxInfo`,
                details: `[workRecords=${workRecords.length}] ${e.message || e}`
            });
            return workRecords;
        }
    };

    return {
        getTaxScheduleFromSourceInvoice,
        buildTaxDetailsOverride,
        calculateTaxBasis,
        enrichWithTaxInfo
    };
});
