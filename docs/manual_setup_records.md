# Guía de Creación Manual — Records, Lists, Fields y Scripts en NetSuite

> Esta guía contiene las instrucciones exactas para crear los Custom Records, Custom Lists, Custom Fields y Script Records necesarios para la solución de Liquidación de Rebates.

---

## 1. Custom Lists

### 1.1 `customlist_giv_liq_scenario`
| Propiedad | Valor |
|---|---|
| **Name** | GIV Liquidation Scenario |
| **Script ID** | `customlist_giv_liq_scenario` |

**Valores:**

| Internal ID | Value |
|---|---|
| 1 | Estándar |
| 2 | Consolidada |
| 3 | Específica (por SKU) |
| 4 | Cobro en exceso |
| 5 | Agrupación |

---

### 1.2 `customlist_giv_liq_work_status`
| Propiedad | Valor |
|---|---|
| **Name** | GIV Liquidation Work Status |
| **Script ID** | `customlist_giv_liq_work_status` |

**Valores:**

| Internal ID | Value |
|---|---|
| 1 | Capturado |
| 2 | Validado |
| 3 | Procesando |
| 4 | Completado |
| 5 | Error |

---

### 1.3 `customlist_giv_liq_created_from`
| Propiedad | Valor |
|---|---|
| **Name** | GIV Liquidation Created From |
| **Script ID** | `customlist_giv_liq_created_from` |

**Valores:**

| Internal ID | Value |
|---|---|
| 1 | Suitelet |
| 2 | CSV |

---

## 2. Custom Records

### 2.1 `customrecord_giv_rebate_liq_work`
| Propiedad | Valor |
|---|---|
| **Name** | GIV Rebate Liquidation Work |
| **Script ID** | `customrecord_giv_rebate_liq_work` |
| **Access Type** | No Permission Required |
| **Allow Inline Editing** | ✅ |
| **Show in Menu** | ❌ |

**Campos:**

| Label | Script ID | Type | Source/List | Mandatory |
|---|---|---|---|---|
| Customer | `custrecord_giv_liq_work_customer` | List/Record | Customer | ✅ |
| Agreement | `custrecord_giv_liq_work_agreement` | List/Record | Rebate Agreement (`customrecord_rm_rebate_agreement`) | ✅ |
| Settlement Method | `custrecord_giv_liq_work_settlement_method` | List/Record | (list del acuerdo nativo) | ✅ |
| Scenario | `custrecord_giv_liq_work_scenario` | List/Record | `customlist_giv_liq_scenario` | ✅ |
| Source Invoice | `custrecord_giv_liq_work_source_invoice` | List/Record | Transaction | ✅ |
| Source Accrual | `custrecord_giv_liq_work_source_accrual` | List/Record | Transaction | ✅ |
| Source Item | `custrecord_giv_liq_work_source_item` | List/Record | Item | ✅ |
| Original Amount | `custrecord_giv_liq_work_original_amount` | Currency | — | ✅ |
| Related Returns Amount | `custrecord_giv_liq_work_related_returns_amount` | Currency | — | ❌ |
| Settled Amount | `custrecord_giv_liq_work_settled_amount` | Currency | — | ❌ |
| Available Amount | `custrecord_giv_liq_work_available_amount` | Currency | — | ✅ |
| Amount to Settle | `custrecord_giv_liq_work_amount_to_settle` | Currency | — | ✅ |
| Invoice To | `custrecord_giv_liq_work_invoice_to` | List/Record | Transaction | ❌ |
| Apply Amount | `custrecord_giv_liq_work_apply_amount` | Currency | — | ❌ |
| Tax Schedule | `custrecord_giv_liq_work_taxschedule` | List/Record | Tax Schedule | ❌ |
| Tax Basis | `custrecord_giv_liq_work_tax_basis` | Currency | — | ❌ |
| Excess Collection Flag | `custrecord_giv_liq_work_excess_collection_flag` | Checkbox | — | ❌ |
| CSV Batch ID | `custrecord_giv_liq_work_csv_batch_id` | Free-Form Text | — | ❌ |
| Processing Status | `custrecord_giv_liq_work_processing_status` | List/Record | `customlist_giv_liq_work_status` | ✅ |
| Error Message | `custrecord_giv_liq_work_error_message` | Long Text | — | ❌ |
| Created From | `custrecord_giv_liq_work_created_from` | List/Record | `customlist_giv_liq_created_from` | ❌ |
| Processed Transaction | `custrecord_giv_liq_work_processed_transaction` | List/Record | Transaction | ❌ |

---

### 2.2 `customrecord_giv_rebate_liq_history`
| Propiedad | Valor |
|---|---|
| **Name** | GIV Rebate Liquidation History |
| **Script ID** | `customrecord_giv_rebate_liq_history` |
| **Access Type** | No Permission Required |
| **Allow Inline Editing** | ❌ (solo lectura) |
| **Show in Menu** | ❌ |

**Campos:**

| Label | Script ID | Type | Source/List | Mandatory |
|---|---|---|---|---|
| Customer | `custrecord_giv_liq_history_customer` | List/Record | Customer | ✅ |
| Agreement | `custrecord_giv_liq_history_agreement` | List/Record | Rebate Agreement | ✅ |
| Settlement | `custrecord_giv_liq_history_settlement` | List/Record | Transaction | ❌ |
| Transaction Type | `custrecord_giv_liq_history_transaction_type` | Free-Form Text | — | ❌ |
| Generated Transaction | `custrecord_giv_liq_history_generated_transaction` | List/Record | Transaction | ❌ |
| Source Rebate Accrual | `custrecord_giv_liq_history_source_rebate_accrual` | List/Record | Transaction | ❌ |
| Source Invoice | `custrecord_giv_liq_history_source_invoice` | List/Record | Transaction | ❌ |
| Source Item | `custrecord_giv_liq_history_source_item` | List/Record | Item | ❌ |
| Invoice To | `custrecord_giv_liq_history_invoiceto` | List/Record | Transaction | ❌ |
| Scenario | `custrecord_giv_liq_history_scenario` | List/Record | `customlist_giv_liq_scenario` | ❌ |
| Source Accrual Amount | `custrecord_giv_liq_history_source_accrual_amount` | Currency | — | ❌ |
| Source Settled Amount | `custrecord_giv_liq_history_source_settled_amount` | Currency | — | ❌ |
| Return Credits Impact | `custrecord_giv_liq_history_source_return_credits_impact` | Currency | — | ❌ |
| Applied Amount | `custrecord_giv_liq_history_applied_amount` | Currency | — | ❌ |
| Difference | `custrecord_giv_liq_history_difference` | Currency | — | ❌ |
| Tax Schedule | `custrecord_giv_history_taxschedule` | List/Record | Tax Schedule | ❌ |
| Tax Basis | `custrecord_giv_history_tax_basis` | Currency | — | ❌ |
| CSV Batch ID | `custrecord_giv_history_csv_batch_id` | Free-Form Text | — | ❌ |
| User | `custrecord_giv_liq_history_user` | List/Record | Employee | ❌ |
| Date | `custrecord_giv_liq_history_date` | Date/Time | — | ❌ |

---

## 3. Custom Field en Rebate Agreement

### 3.1 `custrecord_giv_exclude_returns`
| Propiedad | Valor |
|---|---|
| **Label** | Excluir de Provisiones por Devolución |
| **Script ID** | `custrecord_giv_exclude_returns` |
| **Type** | Checkbox |
| **Applies To** | Custom Record: Rebate Agreement (`customrecord_rm_rebate_agreement`) |
| **Default Value** | Unchecked |
| **Help Text** | "Cuando está marcado, las devoluciones no reducirán la provisión acumulada para este acuerdo (Escenario Aniversario)." |

---

## 4. Script Records & Deployments

> Todos los deployments deben configurarse con **Execute As Role = Administrator**.

### 4.1 Suitelets

| Script Record Name | Script ID | File Path | Deployment ID |
|---|---|---|---|
| GIV Rebate Dashboard | `_giv_sl_rebate_dashboard` | `SuiteScripts/giv_rebate/suitelet/giv_sl_rebate_dashboard.js` | `_giv_dep_rebate_dashboard` |
| GIV Rebate CSV Upload | `_giv_sl_rebate_csv_upload` | `SuiteScripts/giv_rebate/suitelet/giv_sl_rebate_csv_upload.js` | `_giv_dep_rebate_csv_upload` |
| GIV Rebate Processing Status | `_giv_sl_rebate_status` | `SuiteScripts/giv_rebate/suitelet/giv_sl_rebate_processing_status.js` | `_giv_dep_rebate_status` |
| GIV Rebate Reprocess | `_giv_sl_rebate_reprocess` | `SuiteScripts/giv_rebate/suitelet/giv_sl_rebate_reprocess.js` | `_giv_dep_rebate_reprocess` |

**Configuración de cada Deployment Suitelet:**
- Status: Released
- Execute As Role: Administrator
- Available Without Login: ❌
- Log Level: DEBUG (cambiar a AUDIT en producción)

### 4.2 Map/Reduce Scripts

| Script Record Name | Script ID | File Path | Deployment ID |
|---|---|---|---|
| GIV Rebate Liquidation M/R | `_giv_mr_rebate_liquidation` | `SuiteScripts/giv_rebate/mapreduce/giv_mr_rebate_liquidation.js` | `_giv_dep_mr_liquidation` |
| GIV Rebate Reprocess M/R | `_giv_mr_rebate_reprocess` | `SuiteScripts/giv_rebate/mapreduce/giv_mr_rebate_reprocess.js` | `_giv_dep_mr_reprocess` |

**Configuración de cada Deployment Map/Reduce:**
- Status: Released
- Execute As Role: Administrator
- Concurrency Limit: 1 (seguridad inicial, aumentar según volumen)
- Log Level: DEBUG (cambiar a AUDIT en producción)

**Script Parameters para `_giv_mr_rebate_reprocess`:**

| Parameter Name | Script ID | Type |
|---|---|---|
| Agreement | `custscript_giv_reprocess_agreement` | List/Record → Rebate Agreement |
| Date From | `custscript_giv_reprocess_date_from` | Date |
| Date To | `custscript_giv_reprocess_date_to` | Date |

### 4.3 User Event Script

| Script Record Name | Script ID | File Path | Deployment ID |
|---|---|---|---|
| GIV Exclude Return Accruals | `_giv_ue_exclude_return_accruals` | `SuiteScripts/giv_rebate/userevent/giv_ue_exclude_return_accruals.js` | `_giv_dep_ue_exclude_returns` |

**Configuración del Deployment User Event:**
- Applies To: Credit Memo
- Event Type: After Submit
- Status: Released
- Execute As Role: Administrator

---

## 5. Orden de Creación Recomendado

1. **Custom Lists** (3 listas) — Se referencian en los campos de los records
2. **Custom Records** (2 records) — Usan las listas anteriores
3. **Custom Field en Rebate Agreement** (1 field) — Campo en record existente
4. **Subir archivos JS** al File Cabinet: `SuiteScripts/giv_rebate/...`
5. **Script Records y Deployments** — Vinculan los archivos JS

---

## 6. Verificación Post-Creación

- [ ] Las 3 Custom Lists tienen los valores correctos con los Internal IDs esperados
- [ ] El Custom Record WORK tiene los 22 campos listados
- [ ] El Custom Record HISTORY tiene los 20 campos listados
- [ ] El campo checkbox `custrecord_giv_exclude_returns` aparece en el formulario de Rebate Agreement
- [ ] Los 4 Suitelets son accesibles por URL
- [ ] Los 2 Map/Reduce se muestran en el Script Status
- [ ] El User Event está deployeado sobre Credit Memo
- [ ] Todos los deployments ejecutan como Administrator
