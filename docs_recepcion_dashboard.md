# Evolución Recepción + Exportación XLS + Dashboard

## Impacto completo

### 1) Base de datos
Se propone `pedido_recepcion_lineas` para registrar cada línea recibida como hecho auditable.
- Permite estados por línea: `CORRECTO`, `DIFERENCIA_CANTIDAD`, `NO_RECIBIDO`, `SUSTITUIDO`.
- Guarda solicitado vs recibido, diferencia, motivo, observación, usuario y fecha de recepción.
- Incluye índices y vista `v_pedido_recepcion_auditoria` para exportaciones/reportes.

### 2) Backend/API (Supabase)
- Reemplazar dependencia de `faltantes` texto para analytics por consultas a `pedido_recepcion_lineas`.
- Mantener compatibilidad retroactiva: si no hay líneas, fallback a parser histórico de `__xls__`.
- Activar RLS:
  - destino/origen/admin lectura
  - sólo destino/admin inserción en recepción

### 3) Frontend recepción
- UI de recepción por línea con estado explícito.
- Si estado `SUSTITUIDO`, mostrar selector de producto recibido + cantidad + motivo/observación.
- Persistir lote de líneas al confirmar recepción incompleta.

### 4) Exportación XLS
- Fuente primaria: `pedido_recepcion_lineas`.
- Columnas auditoría:
  - Pedido, Fecha, Local Origen, Local Destino
  - Código/Producto Solicitado, Cantidad Solicitada
  - Código/Producto Recibido, Cantidad Recibida
  - Diferencia, Estado
- Formato XLSX real (ya implementado) con hoja comparativa por pedido y hoja consolidada opcional.

### 5) Dashboard
Nueva sección **Calidad Operativa** usando líneas:
- KPI tasa correcta = CORRECTO / total líneas
- KPI tasa diferencias = DIFERENCIA_CANTIDAD / total líneas
- KPI tasa sustituciones = SUSTITUIDO / total líneas
- KPI tasa incidencias = (NO_RECIBIDO + DIFERENCIA + SUSTITUIDO) / total líneas

Tablas nuevas:
- Locales con más errores de envío (origen)
- Locales con más incidencias recibidas (destino)
- Productos más sustituidos
- Sustituciones más frecuentes (solicitado->recibido)
- Productos con más diferencias

### 6) Trazabilidad
- El historial del pedido debe mostrar solicitado vs recibido por línea y actor que registró.
- Se elimina ambigüedad de observaciones de texto libre como fuente principal.

### 7) Futuras integraciones stock/ERP
Con esta estructura ya se puede:
- descontar stock del producto efectivamente enviado/recibido,
- detectar sustituciones frecuentes,
- generar conciliaciones automáticas por estado de línea.

## Plan de migración recomendado
1. Desplegar tabla + vista + políticas RLS.
2. Escribir recepción nueva por línea y mantener `faltantes` como resumen legacy.
3. Migrar exportaciones y dashboard a `pedido_recepcion_lineas`.
4. Ejecutar backfill de pedidos históricos parseando `__xls__`.
5. Desactivar parser legacy cuando cobertura > 99%.
