/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Validaciones de negocio para el módulo de liquidación de rebates.
 *              Incluye cuadre de montos, validaciones por escenario y prorrateo de excedentes.
 */
define(['N/log', './giv_rebate_dao'], (log, dao) => {

    const MODULE = 'giv_rebate_validator';

    /**
     * Valida que el monto total origen coincida con el monto total destino.
     * Excepción: Escenario de Cobro en exceso no requiere cuadre.
     */
    const validateAmountBalance = (sourceTotal, destinationTotal, scenario) => {
        if (scenario === 'Cobro en exceso') {
            return { valid: true, message: '' };
        }

        const roundedSource = Math.round(sourceTotal * 100) / 100;
        const roundedDest = Math.round(destinationTotal * 100) / 100;

        if (roundedSource !== roundedDest) {
            return {
                valid: false,
                message: `El monto total a liquidar no coincide con el monto total a aplicar en las facturas destino. Origen: ${roundedSource}, Destino: ${roundedDest}`
            };
        }

        return { valid: true, message: '' };
    };

    /**
     * Valida en tiempo real que el saldo sigue disponible (prevención de concurrencia).
     */
    const validateAvailableAmount = (accrualId, itemId, requestedAmount, scenario) => {
        try {
            const locked = dao.getLockedAccrualAmounts(accrualId, itemId);

            if (scenario === 'Cobro en exceso') {
                return { valid: true, message: '', currentAvailable: 0 };
            }

            if (requestedAmount > 0 && locked > 0) {
                return {
                    valid: false,
                    message: 'El saldo de la provisión ha cambiado desde que fue consultado. Recargue la pantalla e intente de nuevo.',
                    currentAvailable: 0
                };
            }

            return { valid: true, message: '', currentAvailable: 0 };

        } catch (e) {
            log.error({
                title: `${MODULE}.validateAvailableAmount`,
                details: `AccrualId: ${accrualId}, ItemId: ${itemId}, Amount: ${requestedAmount}. Error: ${e.message}`
            });
            return {
                valid: false,
                message: `Error de validación: ${e.message}`,
                currentAvailable: 0
            };
        }
    };

    /**
     * Validaciones específicas por escenario.
     */
    const validateScenarioRules = (scenario, sourceLines, destLines, settlementMethod) => {
        const errors = [];

        if (!sourceLines || sourceLines.length === 0) {
            errors.push('Debe seleccionar al menos una provisión para liquidar.');
        }

        if (settlementMethod === '2') {
            if ((!destLines || destLines.length === 0) && scenario !== 'Cobro en exceso') {
                errors.push('Debe seleccionar al menos una factura destino para liquidaciones por Credit Memo.');
            }
        }

        if (sourceLines && sourceLines.length > 1) {
            const currencies = [...new Set(sourceLines.map(l => l.currency))];
            if (currencies.length > 1) {
                errors.push('Todas las líneas de una liquidación deben compartir la misma moneda.');
            }
        }

        switch (scenario) {
            case 'Estándar':
                break;

            case 'Consolidada':
                if (sourceLines && sourceLines.length < 2) {
                    errors.push('El escenario "Consolidada" requiere al menos dos provisiones seleccionadas.');
                }
                break;

            case 'Específica':
                break;

            case 'Cobro en exceso':
                break;

            case 'Agrupación':
                if (sourceLines && sourceLines.length > 0) {
                    const agreementId = sourceLines[0].agreementId;
                    const agreement = dao.getAgreementDetails(agreementId);
                    if (!agreement.accountingItem) {
                        errors.push('El acuerdo de reembolso no tiene configurado el artículo contable (custrecord_rm_accounting_item).');
                    }
                }
                break;
        }

        return { valid: errors.length === 0, errors: errors };
    };

    /**
     * Valida una fila de archivo CSV.
     */
    const validateCsvRow = (rowData, rowIndex) => {
        const errors = [];
        const prefix = `Fila ${rowIndex + 1}:`;

        if (!rowData.externalId) errors.push(`${prefix} External ID es obligatorio.`);
        if (!rowData.customerId) errors.push(`${prefix} Cliente es obligatorio.`);
        if (!rowData.agreementId) errors.push(`${prefix} Acuerdo de reembolso es obligatorio.`);
        if (!rowData.scenario) errors.push(`${prefix} Tipo de liquidación es obligatorio.`);
        if (!rowData.sourceInvoiceId) errors.push(`${prefix} Factura origen es obligatorio.`);
        if (!rowData.itemId) errors.push(`${prefix} Artículo es obligatorio.`);

        const amount = parseFloat(rowData.amountToSettle);
        if (isNaN(amount) || amount <= 0) {
            errors.push(`${prefix} Monto a liquidar debe ser mayor a cero.`);
        }

        if (rowData.settlementMethod === '2') {
            if (!rowData.invoiceTo) {
                errors.push(`${prefix} Factura destino es obligatoria para liquidaciones por Credit Memo.`);
            }
            const applyAmount = parseFloat(rowData.applyAmount);
            if (isNaN(applyAmount) || applyAmount <= 0) {
                errors.push(`${prefix} Monto a aplicar debe ser mayor a cero.`);
            }
        }

        return { valid: errors.length === 0, errors: errors };
    };

    /**
     * Calcula el prorrateo del excedente para Cobro en exceso (Escenario 4).
     */
    const calculateExcessProration = (lines, totalRequested) => {
        const totalProvision = lines.reduce((sum, l) => sum + parseFloat(l.provisionAmount), 0);
        const excess = totalRequested - totalProvision;

        if (excess <= 0) {
            return lines.map(l => ({
                ...l,
                finalAmount: parseFloat(l.provisionAmount),
                excessPortion: 0
            }));
        }

        let runningTotal = 0;
        const calculated = lines.map((line, index) => {
            const provision = parseFloat(line.provisionAmount);
            const weight = provision / totalProvision;
            let excessPortion = Math.round(weight * excess * 100) / 100;
            let finalAmount = Math.round((provision + excessPortion) * 100) / 100;

            if (index === lines.length - 1) {
                const expectedRemaining = Math.round((totalRequested - runningTotal) * 100) / 100;
                finalAmount = expectedRemaining;
                excessPortion = Math.round((finalAmount - provision) * 100) / 100;
            } else {
                runningTotal += finalAmount;
            }

            return { ...line, finalAmount, excessPortion };
        });

        log.debug({
            title: `${MODULE}.calculateExcessProration`,
            details: `Total provision: ${totalProvision}, Requested: ${totalRequested}, Excess: ${excess}, Lines: ${calculated.length}`
        });

        return calculated;
    };

    return {
        validateAmountBalance,
        validateAvailableAmount,
        validateScenarioRules,
        validateCsvRow,
        calculateExcessProration
    };
});
