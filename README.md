# Sucaneitor Web

Aplicación web unificada para:

- inventarios colaborativos;
- preparación de reposiciones desde XLS;
- pedidos de clientes entre locales;
- recepción y control colaborativo de remitos.

Los cuatro módulos comparten autenticación, locales y un único padrón en Supabase.

## Integración de reposiciones y pedidos

Al crear una reposición se incorporan de forma atómica los pedidos aceptados de la misma ruta. Para un mismo SKU, la cantidad física es el máximo entre la reposición automática y los pedidos de clientes. Al exportar, los clientes tienen prioridad y ninguna unidad se repite entre los dos remitos.

Los pedidos urgentes aceptados después de iniciar la preparación requieren aprobación de un supervisor. Al confirmar la salida se generan las asignaciones por cliente, los pedidos con unidades pasan a tránsito y los que no pudieron cubrirse quedan aceptados para una preparación futura.

## Recepción de remitos

El local destino importa el XLS completo, aunque contenga varias hojas. El control prioriza la búsqueda por nombre o SKU, permite sumar cantidades manualmente y ofrece la cámara como opción adicional. Todos los participantes ven las cantidades en tiempo real, pueden registrar productos sobrantes y cerrar con diferencias mediante una confirmación explícita.

Al cerrar, los pedidos entre locales vinculados se comparan contra las unidades recibidas. Los pedidos completos generan un aviso visible para contactar al cliente y conservan el registro de quién confirmó el aviso. El reporte final separa control, diferencias, extras, pedidos y auditoría.

## Base de datos

Las migraciones son aditivas. La base operativa está en `supabase/migrations/20260822010000_sucaneitor_operaciones.sql` y el control de remitos en `supabase/migrations/20260824170000_recepcion_remitos.sql`.

## Pruebas

```powershell
node operaciones/tests/search-engine.test.js
node operaciones/tests/reposition-engine.test.js
node operaciones/tests/reposition-export.test.js
node operaciones/tests/reception-engine.test.js
node operaciones/tests/ui-dialogs.test.js
node tools/reception-workflow.test.js
node tools/integration-volume-test.js 12000 100000
node tools/volume-test.js 100000
```

## Publicación

### Descargas y archivos compartidos

Todas las exportaciones existentes (Pedidos, CSV del dashboard, Inventario, Reposición, Recepción, originales y ZIP) pasan por `downloads.js` / `downloads.css`. La ventana permite renombrar conservando el formato y descargar sin subir nada. Usa `showSaveFilePicker` bajo HTTPS cuando está disponible; cancelar el explorador no inicia otra descarga. En navegadores sin soporte usa la descarga habitual.

Compartir sube **una copia** al bucket privado `op-archivos-compartidos` y crea un enlace firmado de descarga por siete días, sin requerir cuenta al destinatario. La ventana avisa la exposición por enlace y el vencimiento, confirma solo las copias al portapapeles que realmente tuvieron éxito, y ofrece copia manual si el navegador la bloquea. Un nombre diferente genera un enlace diferente; los originales permanecen intactos. No se amplían los permisos de los invitados QR, que actualmente no pueden exportar informes.

Antes de publicar esta versión, aplicar `supabase/migrations/20260902170000_archivos_compartidos.sql` al proyecto Supabase existente. No requiere claves privadas en el navegador. El bucket limita cada copia a 50 MB; solo usuarios aprobados pueden crear, firmar o borrar sus propias copias y nadie puede sobrescribirlas. Si no está configurado, la descarga local sigue disponible y Compartir muestra un error explicativo.

El vencimiento del enlace no borra físicamente la copia. Para limitar almacenamiento, configurar limpieza mediante la API de Storage según la retención acordada; no borrar filas directamente de `storage.objects`. Eliminar una copia desde Storage también revoca su enlace. No almacenar URLs firmadas en registros públicos.

Verificación: `node tools/downloads.test.js` y todos los tests existentes. `tools/downloads-preview.html` sirve para comprobar la interfaz local con un CSV sintético, portapapeles real y servidor simulado; no valida el almacenamiento de producción. Antes del despliegue verificar con dos usuarios aprobados que no puedan listar/firmar copias ajenas, que anónimos no puedan subir/listar, y que el enlace firmado descargue con el nombre elegido sin autenticación. Abrir un enlace no elude las restricciones de descarga propias de iOS/Android.

El proyecto es estático y está preparado para Vercel. La cámara requiere HTTPS (o localhost durante desarrollo). `operaciones/cloud-config.js` contiene únicamente la URL y la clave pública de Supabase; los permisos efectivos se controlan con Auth y RLS.
