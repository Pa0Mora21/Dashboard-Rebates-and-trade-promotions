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
     * También bloquea que el monto solicitado supere el saldo disponible en escenarios comunes.
     *
     * @param {string} accrualId       - Internal ID del Accrual
     * @param {string} itemId          - Internal ID del artículo
     * @param {number} requestedAmount - Monto que el usuario quiere liquidar
     * @param {string} scenario        - Escenario seleccionado
     * @param {number} availableAmount - Saldo disponible leido en el dashboard (valor de custpage_src_available)
     */
    const validateAvailableAmount = (accrualId, itemId, requestedAmount, scenario, availableAmount) => {
        try {
            // ── Cobro en exceso: no aplica ninguna restricción de monto ──
            if (scenario === 'Cobro en exceso') {
                return { valid: true, message: '', currentAvailable: 0 };
            }

            // ── Bloqueo estricto: monto solicitado > saldo disponible ──
            // DRD: solo el escenario "Cobro en exceso" puede superar el disponible.
            // Para todos los demás, el monto es un límite duro.
            const available = parseFloat(availableAmount) || 0;
            if (requestedAmount > Math.round(available * 100) / 100 + 0.001) {  // +0.001 tolerancia de redondeo
                return {
                    valid: false,
                    message: `El monto a liquidar ($${requestedAmount.toFixed(2)}) supera el saldo disponible ($${available.toFixed(2)}). ` +
                             'Solo el escenario "Cobro en exceso" permite liquidar por encima del disponible.',
                    currentAvailable: available
                };
            }

            // ── Validación de concurrencia: si ya hay otro WORK bloqueando el saldo ──
            const locked = dao.getLockedAccrualAmounts(accrualId, itemId);
            if (requestedAmount > 0 && locked > 0) {
                return {
                    valid: false,
                    message: 'El saldo de la provisión ha cambiado desde que fue consultado. Recargue la pantalla e intente de nuevo.',
                    currentAvailable: 0
                };
            }

            return { valid: true, message: '', currentAvailable: available };

        } catch (e) {
            log.error({
                title:   `${MODULE}.validateAvailableAmount`,
                details: `[AccrualId=${accrualId}, ItemId=${itemId}, Requested=${requestedAmount}, Available=${availableAmount}] ${e.message || e}`
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

        // settlementMethod '3' = Credit Memo (valor real en custrecord_rm_settlement_method)
        if (settlementMethod === '3') {
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

            case 'Específica (por SKU)':
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
    const validateCsvRow = (rowData, rowIndex, labels = {}) => {
        const errors = [];
        const prefix = `Fila ${rowIndex + 1}:`;

        if (!rowData.externalId) errors.push(`${prefix} External ID es obligatorio.`);
        if (!rowData.customerId) errors.push(`${prefix} Cliente es obligatorio.`);
        if (!rowData.agreementId) errors.push(`${prefix} Acuerdo de reembolso es obligatorio.`);
        if (!rowData.sourceInvoiceId) errors.push(`${prefix} Factura origen es obligatorio.`);
        if (!rowData.itemId) errors.push(`${prefix} Artículo es obligatorio.`);

        // Validar que el escenario sea uno de los valores permitidos por el DRD
        const VALID_SCENARIOS = ['Estándar', 'Consolidada', 'Específica (por SKU)', 'Cobro en exceso', 'Agrupación'];
        if (!rowData.scenario) {
            errors.push(`${prefix} Tipo de liquidación es obligatorio.`);
        } else if (!VALID_SCENARIOS.includes(rowData.scenario)) {
            errors.push(`${prefix} Tipo de liquidación "${rowData.scenario}" no es válido. Valores aceptados: ${VALID_SCENARIOS.join(', ')}.`);
        }

        const amount = parseFloat(rowData.amountToSettle);
        if (isNaN(amount) || amount <= 0) {
            errors.push(`${prefix} Monto a liquidar debe ser mayor a cero.`);
        }

        // Credit Memo = '3' (custrecord_rm_settlement_method interno en NetSuite)
        // [FIX] Era '2', valor incorrecto — el ID real de Credit Memo es 3
        if (rowData.settlementMethod === '3') {
            if (!rowData.invoiceTo) {
                errors.push(`${prefix} Factura destino es obligatoria para liquidaciones por Credit Memo.`);
            }
            const applyAmount = parseFloat(rowData.applyAmount);
            if (isNaN(applyAmount) || applyAmount <= 0) {
                errors.push(`${prefix} Monto a aplicar debe ser mayor a cero.`);
            }
        }

        // Validar que la Factura Destino pertenezca al mismo cliente de la fila
        // invoiceToCustomerId es poblado por el suitelet desde idMaps.invoiceCustomers
        // labels.invoiceTo puede ser un <a> HTML con link clickeable (viene del suitelet).
        if (rowData.invoiceTo && rowData.invoiceToCustomerId && rowData.customerId) {
            if (String(rowData.invoiceToCustomerId) !== String(rowData.customerId)) {
                const invoiceDisplay = labels.invoiceTo || `ID ${rowData.invoiceTo}`;
                errors.push(
                    `${prefix} La Factura Destino (${invoiceDisplay}) pertenece al cliente ` +
                    `${rowData.invoiceToCustomerId}, pero la fila indica el cliente ${rowData.customerId}. ` +
                    `Verifique que la factura destino corresponda al mismo cliente.`
                );
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
