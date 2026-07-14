# Guía de Creación Manual — Records, Lists, Fields y Scripts en NetSuite

> Esta guía contiene las instrucciones exactas para crear los Custom Records, Custom Lists, Custom Fields y Script Records necesarios para la solución de Liquidación de Rebates.
>
> **IMPORTANTE — IDs de campo:**
> Los Script IDs utilizados en el código SuiteScript y en los archivos SDF (XML) son los **IDs cortos** (`custrecord_giv_lw_*` y `custrecord_giv_lh_*`). El DRD original listaba IDs largos (`custrecord_giv_liq_work_*`) que **no corresponden** a lo desplegado. Esta guía usa los IDs cortos que son la fuente de verdad.

---

## 1. Custom Lists

> Las Custom Lists del DRD original están documentadas como referencia. Sin embargo, la implementación actual almacena los valores de estado, escenario y origen como **texto libre** (Free-Form Text) en los campos del Custom Record, usando las constantes definidas en `giv_rebate_constants.js`. No es necesario crear estas listas en NetSuite para que el sistema funcione.

### 1.1 `customlist_giv_liq_scenario` *(referencia)*
| Propiedad | Valor |
|---|---|
| **Name** | GIV Liquidation Scenario |
| **Script ID** | `customlist_giv_liq_scenario` |

**Valores usados en código:**

| Valor en código (`SCENARIOS`) | Texto |
|---|---|
| `Estándar` | Estándar |
| `Consolidada` | Consolidada |
| `Específica` | Específica (por SKU) |
| `Cobro en exceso` | Cobro en exceso |
| `Agrupación` | Agrupación |

---

### 1.2 `customlist_giv_liq_work_status` *(referencia)*

**Valores usados en código (`STATUS`):**

| Valor | Descripción |
|---|---|
| `Capturado` | Registro creado, pendiente de procesar |
| `Validado` | Validado, pendiente de Map/Reduce |
| `Procesando` | En ejecución en Map/Reduce |
| `Completado` | Transacción generada exitosamente |
| `Error` | Falló — detalle en campo Error Message |

---

### 1.3 `customlist_giv_liq_created_from` *(referencia)*

**Valores usados en código (`CREATED_FROM`):**

| Valor | Descripción |
|---|---|
| `Suitelet` | Creado manualmente desde el Dashboard |
| `CSV` | Creado por carga masiva CSV |

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

**Campos** — usar exactamente estos Script IDs al crear en NetSuite:

| Label | Script ID (SDF/Código) | Type | Source/List | Mandatory |
|---|---|---|---|---|
| Customer | `custrecord_giv_lw_customer` | List/Record | Customer (`-2`) | ✅ |
| Agreement | `custrecord_giv_lw_agreement` | Integer | — | ✅ |
| Source Invoice | `custrecord_giv_lw_source_invoice` | List/Record | Transaction (`-30`) | ✅ |
| Source Accrual | `custrecord_giv_lw_source_accrual` | List/Record | Transaction (`-30`) | ✅ |
| Source Item | `custrecord_giv_lw_source_item` | List/Record | Item (`-10`) | ✅ |
| Invoice To | `custrecord_giv_lw_invoice_to` | List/Record | Transaction (`-30`) | ❌ |
| Tax Code | `custrecord_giv_lw_taxcode` | List/Record | Tax Code (`-128`) | ❌ |
| Processed Transaction | `custrecord_giv_lw_processed_tran` | List/Record | Transaction (`-30`) | ❌ |
| Settlement Method | `custrecord_giv_lw_settle_method` | Free-Form Text | — | ✅ |
| Scenario | `custrecord_giv_lw_scenario` | Free-Form Text | — | ✅ |
| Processing Status | `custrecord_giv_lw_proc_status` | Free-Form Text | — | ✅ |
| Created From | `custrecord_giv_lw_created_from` | Free-Form Text | — | ❌ |
| CSV Batch ID | `custrecord_giv_lw_csv_batch_id` | Free-Form Text | — | ❌ |
| Original Amount | `custrecord_giv_lw_original_amt` | Decimal Number | — | ✅ |
| Related Returns Amount | `custrecord_giv_lw_returns_amt` | Decimal Number | — | ❌ |
| Settled Amount | `custrecord_giv_lw_settled_amt` | Decimal Number | — | ❌ |
| Available Amount | `custrecord_giv_lw_available_amt` | Decimal Number | — | ✅ |
| Amount to Settle | `custrecord_giv_lw_amt_to_settle` | Decimal Number | — | ✅ |
| Apply Amount | `custrecord_giv_lw_apply_amount` | Decimal Number | — | ❌ |
| Tax Basis | `custrecord_giv_lw_tax_basis` | Decimal Number | — | ❌ |
| Excess Collection Flag | `custrecord_giv_lw_excess_flag` | Checkbox | — | ❌ |
| Error Message | `custrecord_giv_lw_error_message` | Long Text (Textarea) | — | ❌ |

> **Nota:** El DRD original listaba IDs con el prefijo `custrecord_giv_liq_work_*`. Esos IDs **no son los desplegados**. Los IDs de la tabla anterior son los correctos.

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

| Label | Script ID (SDF/Código) | Type | Source/List | Mandatory |
|---|---|---|---|---|
| Customer | `custrecord_giv_lh_customer` | List/Record | Customer (`-2`) | ✅ |
| Agreement | `custrecord_giv_lh_agreement` | Integer | — | ✅ |
| Settlement | `custrecord_giv_lh_settlement` | List/Record | Transaction (`-30`) | ❌ |
| Generated Transaction | `custrecord_giv_lh_generated_tran` | List/Record | Transaction (`-30`) | ❌ |
| Source Rebate Accrual | `custrecord_giv_lh_src_accrual` | List/Record | Transaction (`-30`) | ❌ |
| Source Invoice | `custrecord_giv_lh_src_invoice` | List/Record | Transaction (`-30`) | ❌ |
| Source Item | `custrecord_giv_lh_src_item` | List/Record | Item (`-10`) | ❌ |
| Invoice To | `custrecord_giv_lh_invoiceto` | List/Record | Transaction (`-30`) | ❌ |
| Tax Code | `custrecord_giv_lh_taxcode` | List/Record | Tax Code (`-128`) | ❌ |
| User | `custrecord_giv_lh_user` | List/Record | Employee (`-4`) | ❌ |
| Transaction Type | `custrecord_giv_lh_tran_type` | Free-Form Text | — | ❌ |
| Scenario | `custrecord_giv_lh_scenario` | Free-Form Text | — | ❌ |
| CSV Batch ID | `custrecord_giv_lh_csv_batch_id` | Free-Form Text | — | ❌ |
| Source Accrual Amount | `custrecord_giv_lh_src_accr_amt` | Decimal Number | — | ❌ |
| Source Settled Amount | `custrecord_giv_lh_src_settl_amt` | Decimal Number | — | ❌ |
| Return Credits Impact | `custrecord_giv_lh_ret_credits` | Decimal Number | — | ❌ |
| Applied Amount | `custrecord_giv_lh_applied_amt` | Decimal Number | — | ❌ |
| Difference | `custrecord_giv_lh_difference` | Decimal Number | — | ❌ |
| Tax Basis | `custrecord_giv_lh_tax_basis` | Decimal Number | — | ❌ |
| Date | `custrecord_giv_lh_date` | Date/Time | — | ❌ |

> **Nota:** El DRD original listaba IDs con prefijo `custrecord_giv_liq_history_*` y `custrecord_giv_history_*`. Los IDs correctos son los de esta tabla (`custrecord_giv_lh_*`).

---

## 3. Custom Field en Rebate Agreement

### 3.1 `custrecord_giv_exclude_returns`
| Propiedad | Valor |
|---|---|
| **Label** | Excluir de Provisiones por Devolución |
| **Script ID** | `custrecord_giv_exclude_returns` |
| **Type** | Checkbox |
| **Applies To** | Custom Record: Rebate Agreement (`customrecord_rm_sales_transaction`) |
| **Default Value** | Unchecked |
| **Help Text** | "Cuando está marcado, las devoluciones no reducirán la provisión acumulada para este acuerdo (Escenario Aniversario)." |

---

## 4. Script Records & Deployments

> Todos los deployments deben configurarse con **Execute As Role = Administrator**.

### 4.1 Suitelets

| Script Record Name | Script ID | Deployment ID | File |
|---|---|---|---|
| GIV Rebate Dashboard | `customscript_giv_sl_rebate_dashboard` | `customdeploy_giv_sl_dashboard` | `giv_sl_rebate_dashboard.js` |
| GIV Rebate CSV Upload | `customscript_giv_sl_csv_upload` | `customdeploy_giv_sl_csv_upload` | `giv_sl_rebate_csv_upload.js` |
| GIV Rebate Processing Status | `customscript_giv_sl_rebate_status` | `customdeploy_giv_sl_status` | `giv_sl_rebate_processing_status.js` |
| GIV Rebate Reprocess | `customscript_giv_sl_reprocess` | `customdeploy_giv_sl_reprocess` | `giv_sl_rebate_reprocess.js` |

**Configuración de cada Deployment Suitelet:**
- Status: Released
- Execute As Role: Administrator
- Available Without Login: ❌
- Log Level: DEBUG (cambiar a AUDIT en producción)

### 4.2 Map/Reduce Scripts

| Script Record Name | Script ID | Deployment ID | File |
|---|---|---|---|
| GIV Rebate Liquidation M/R | `customscript_giv_mr_liquidation` | `customdeploy_giv_mr_liquidation` | `giv_mr_rebate_liquidation.js` |
| GIV Rebate Reprocess M/R | `customscript_giv_mr_reprocess` | `customdeploy_giv_mr_reprocess` | `giv_mr_rebate_reprocess.js` |

**Configuración de cada Deployment Map/Reduce:**
- Status: Released
- Execute As Role: Administrator
- Concurrency Limit: 1
- Log Level: DEBUG (cambiar a AUDIT en producción)

**Script Parameters para `customscript_giv_mr_reprocess`:**

| Parameter Name | Script ID | Type |
|---|---|---|
| Agreement | `custscript_giv_reprocess_agreement` | List/Record → Rebate Agreement |
| Date From | `custscript_giv_reprocess_date_from` | Date |
| Date To | `custscript_giv_reprocess_date_to` | Date |

### 4.3 User Event Script

| Script Record Name | Script ID | Deployment ID | Applies To |
|---|---|---|---|
| GIV Exclude Return Accruals | `customscript_giv_ue_exclude_ret` | `customdeploy_giv_ue_exclude_ret_cm` | Credit Memo |
| GIV Exclude Return Accruals | `customscript_giv_ue_exclude_ret` | `customdeploy_giv_ue_exclude_ret_rma` | Return Authorization |

**Configuración de los Deployments User Event:**
- Event Type: **Before Submit** *(no After Submit — el script modifica `context.newRecord` que solo existe en beforeSubmit)*
- Trigger on: CREATE únicamente
- Status: Released
- Execute As Role: Administrator

> **Corrección DRD:** El documento original decía "After Submit", pero el script manipula `context.newRecord` para desmarcar líneas, lo que solo es posible en `beforeSubmit`. El código está correcto. El deploy en **Return Authorization** faltaba y fue agregado.

---

## 5. Notas sobre IDs — Reconciliación DRD vs. SDF

La siguiente tabla mapea los IDs del DRD original a los IDs reales del SDF para los campos más relevantes:

| Campo (DRD) | ID DRD original | ID real (SDF/código) |
|---|---|---|
| Customer (WORK) | `custrecord_giv_liq_work_customer` | `custrecord_giv_lw_customer` |
| Agreement (WORK) | `custrecord_giv_liq_work_agreement` | `custrecord_giv_lw_agreement` |
| Processing Status (WORK) | `custrecord_giv_liq_work_processing_status` | `custrecord_giv_lw_proc_status` |
| Amount to Settle (WORK) | `custrecord_giv_liq_work_amount_to_settle` | `custrecord_giv_lw_amt_to_settle` |
| Tax Schedule (WORK) | `custrecord_giv_liq_work_taxschedule` | `custrecord_giv_lw_taxcode` |
| Error Message (WORK) | `custrecord_giv_liq_work_error_message` | `custrecord_giv_lw_error_message` |
| Customer (HISTORY) | `custrecord_giv_liq_history_customer` | `custrecord_giv_lh_customer` |
| Tax Schedule (HISTORY) | `custrecord_giv_history_taxschedule` | `custrecord_giv_lh_taxcode` |
| Tax Basis (HISTORY) | `custrecord_giv_history_tax_basis` | `custrecord_giv_lh_tax_basis` |

---

## 6. Orden de Creación Recomendado

1. **Custom Field en Rebate Agreement** — `custrecord_giv_exclude_returns`
2. **Custom Records** — WORK y HISTORY (con todos los campos de las tablas de la sección 2)
3. **Subir archivos JS** al File Cabinet: `SuiteScripts/giv_rebate/...`
4. **Script Records y Deployments** — usando los Script IDs y Deployment IDs de la sección 4

---

## 7. Verificación Post-Creación

- [ ] El Custom Record WORK tiene los 22 campos con los Script IDs cortos (`custrecord_giv_lw_*`)
- [ ] El Custom Record HISTORY tiene los 20 campos con los Script IDs cortos (`custrecord_giv_lh_*`)
- [ ] El campo checkbox `custrecord_giv_exclude_returns` aparece en el formulario de Rebate Agreement
- [ ] Los 4 Suitelets son accesibles por URL usando los IDs de la sección 4.1
- [ ] Los 2 Map/Reduce se muestran en Script Status con los IDs de la sección 4.2
- [ ] El User Event está deployeado en **Credit Memo** Y **Return Authorization** (2 deployments)
- [ ] Todos los deployments ejecutan como Administrator con evento **Before Submit**
