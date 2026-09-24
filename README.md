# GIV Rebate Liquidation

## Descripción técnica

Este repositorio contiene una personalización de NetSuite para gestionar la liquidación de rebates y promociones comerciales, con soporte para validación, cálculo, procesamiento masivo y trazabilidad de resultados. La solución está implementada con SuiteScript y SDF, y se apoya en custom records, custom fields, suitelets, Map/Reduce scripts y user event scripts.

El proyecto está orientado a automatizar el flujo de liquidación de montos asociados a acuerdos de rebate, facturas de origen, acumulados, devoluciones y ajustes de negocio.

## Objetivo funcional

El sistema permite:

- registrar trabajos de liquidación por cliente, acuerdo y escenario
- capturar montos originales, disponibles y a liquidar
- diferenciar escenarios de negocio
- validar reglas de cálculo y excepciones
- procesar lotes mediante Map/Reduce
- cargar información masiva desde CSV
- registrar historial de transacciones generadas
- reprocesar casos con error
- controlar exclusión de devoluciones en acuerdos específicos

## Alcance del negocio

La solución aborda procesos financieros y operativos de la liquidación de rebates, principalmente en escenarios donde:

- existen acuerdos comerciales con acumulados
- se generan facturas y devoluciones
- se requieren procesos de liquidación por período o escenario
- es necesario registrar un historial de cada operación
- se requiere auditoría y control de errores

## Arquitectura

La solución se compone de varios niveles:

1. Capas de datos
   - custom records para trabajo y historial
   - custom fields sobre registros de negocio
   - almacenamiento de resultados y errores

2. Capas de lógica
   - Suitelets para interacción y dashboard
   - Map/Reduce scripts para procesamiento masivo
   - User Event scripts para validaciones de negocio

3. Capa de configuración
   - archivos XML de objetos NetSuite
   - manifest y configuración SDF
   - despliegues de scripts

## Estructura del proyecto

```text
Dashboard-Rebates-and-trade-promotions/
├── docs/
│   ├── ejemplo_carga_csv.csv
│   └── manual_setup_records.md
├── src/
│   ├── FileCabinet/
│   │   └── SuiteScripts/
│   ├── Objects/
│   │   ├── customrecord_giv_rebate_liq_history.xml
│   │   ├── customrecord_giv_rebate_liq_work.xml
│   │   ├── customscript_giv_mr_liquidation.xml
│   │   ├── customscript_giv_mr_reprocess.xml
│   │   ├── customscript_giv_sl_csv_upload.xml
│   │   ├── customscript_giv_sl_rebate_dashboard.xml
│   │   ├── customscript_giv_sl_rebate_status.xml
│   │   ├── customscript_giv_sl_reprocess.xml
│   │   ├── customscript_giv_ue_exclude_ret.xml
│   │   └── ...
│   ├── deploy.xml
│   ├── manifest.xml
│   ├── project.json
│   └── ...
├── Grupo Vida _ DRD Rebates.txt
├── README.md
└── ...
