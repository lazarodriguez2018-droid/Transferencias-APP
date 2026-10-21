# Inventarios Enjoy

Aplicación independiente en `/enjoy/inventarios` (scope offline `/enjoy/`), con las identidades Auth existentes. El acceso de Enjoy se aprueba en su propia membresía; la clave de empresa solamente elige el entorno. Finanzas administra roles, aprobaciones y almacenes. Supervisor y auditor con gestión tienen alcance por almacén. El contador accede a sus asignaciones desde su fecha programada.

## Flujo

Hay tres pantallas independientes. **Configuración** usa cuatro pasos: datos, MB52, participantes y programación. **Conteo** se abre desde Mis conteos, sin pestañas de configuración, importaciones ni botones de resultados. **Resultados y SAP** tiene su propio recorrido: comparar/autorizar, archivos SAP y cierre. Los botones Atrás, Siguiente y Guardar y salir pertenecen al asistente de configuración; el conteo conserva sus cantidades automáticamente. Las rutas `#configuracion/ID`, `#conteo/ID` y `#resultados/ID` permiten volver al área correspondiente sin mezclar las pantallas. Se puede programar antes de disponer de la base definitiva. AL04, AL05, AL02 y AL12 usan el procedimiento principal: MB52 de la fecha del inventario y bloqueo confirmado por el gestor. La aplicación registra el bloqueo realizado en SAP; no lo ejecuta.

La importación conserva centro, almacén, material, lote y unidad. El stock teórico cero se excluye; el cero contado es válido y distinto de un material sin contar. Se admiten hasta seis decimales. Los códigos de barras se pueden asociar antes del inicio, sin exigir un padrón global.

El buscador combina códigos, barras y el motor de nombres de SUCAN. Muestra sugerencias al escribir, resalta coincidencias y anticipa el resto del nombre o código sin reemplazar lo escrito. Tab o flecha derecha acepta la sugerencia; las flechas arriba/abajo eligen el producto y su lote. También muestra productos usados recientemente y avisa cuando no hay coincidencias. Enter selecciona; Enter en cantidad suma y devuelve el foco al buscador. Si un código corresponde a varios lotes se exige elegir uno. Restar y establecer un total son correcciones secundarias en la misma pantalla.

## Sin conexión y auditoría

Se debe abrir cada inventario con conexión en el dispositivo que realizará el conteo. El service worker conserva exclusivamente recursos estáticos; los paquetes y eventos están en IndexedDB, separados por usuario. Cantidad, evento y secuencia de dispositivo se escriben en una misma transacción. No se confirma una cantidad si falla el guardado local. Cerrar sesión exige sincronizar los movimientos pendientes.

Cada movimiento lleva UUID, usuario, función, dispositivo, secuencia, hora local, sector opcional y estado de GPS. El servidor añade su hora y calcula las cantidades anterior/posterior. Reintentar un UUID recibido no suma de nuevo. Las respuestas de apertura incluyen recibos explícitos de los eventos solicitados: una respuesta perdida no duplica el total local. Web Locks coordina sincronizaciones entre pestañas cuando está disponible. Una corrección absoluta con versión antigua se conserva para revisión. El autor puede registrar su descarte con motivo; el evento original queda en la auditoría.

Una carga de otro día requiere habilitación de recepción tardía por el gestor. Una entrega bloquea cambios de ese participante; reabrirla invalida las autorizaciones y el reporte vigente, conservando los documentos históricos.

La ubicación se solicita al iniciar el conteo, sin bloquearlo si falla o se deniega. Se registra automáticamente durante el conteo visible y se detiene al pausar, ocultar o abandonar la página. Cada posición conserva fecha y precisión; una posición de más de dos minutos no se adjunta como actual. No se promete rastreo en segundo plano ni ubicación instantánea de un dispositivo desconectado. Los permisos del navegador y el almacenamiento disponible condicionan el funcionamiento offline; borrar los datos del sitio elimina el trabajo local todavía no recibido.

El paquete ciego no incluye referencia de stock, valores, autorizaciones, reporte ni archivos fuente. Los conteos de auditor y responsable se mantienen separados. La base, fecha y asignaciones quedan protegidas desde el primer conteo.

## SAP y documentos

La revisión exige entregas completas y una cantidad autorizada con criterio. Se puede autorizar desde un conteo entregado y corregir luego producto por producto. El CSV se completa conservando documento/posición/material/lote/unidad, separador `;`, decimal coma, CRLF y Windows-1252. No se agrupan lotes. El CSV_2 es otra etapa y puede tener otro número de documento.

Los originales se guardan en un bucket privado; solo gestores del almacén pueden leerlos. Cada incorporación agrega una versión de documento. Reporte debe corresponder al almacén y a un documento SAP vinculado. La exportación no equivale a la carga/contabilización en SAP.

Excel conserva comparativo, justificaciones, reporte SAP y ajustes. Word es un `.docx` OOXML real con participantes, indicadores, top de diferencias, descargos y firmas. Cada acta generada con conexión se archiva como nueva versión. Se diferencian exactitud estricta y tolerancia inferior a 1.000 UYU; las valoraciones calculadas a partir de MB52 se distinguen de los importes originales SAP. Consolidación AL05 exige misma fecha y bases sin materiales/lotes superpuestos, conservando el origen y los lotes.

El cierre exige autorizaciones completas, entregas y, para principal, reporte SAP. Los ajustes posteriores se agregan sin reemplazar el historial; una propuesta y su ejecución con evidencia son registros distintos. El cierre protege cantidades y documentos SAP.

## Revisión antes de producción

`/enjoy/demo` ejecuta las mismas pantallas con datos ficticios, un cliente de demostración y otra base IndexedDB. No consulta Supabase, no envía documentos a SAP y no pide GPS. La versión real sigue usando Auth y `enjoy_api` con permisos del servidor. La revisión automática bloqueó aplicar la migración en producción hasta contar con aprobación explícita tras revisar los cambios. No se ha modificado la base de producción.

## Instalación y validación

1. Aplicar `supabase/migrations/20261021121523_enjoy_inventory_offline.sql` con Supabase migrations.
2. Dar el primer acceso de Finanzas a la identidad administradora verificada mediante una operación administrativa del servidor. La migración no contiene contraseñas ni identificadores personales de usuarios.
3. Publicar la rama del repositorio en Vercel. La clave Enjoy se verifica mediante hash en `/api/company-access`; no existe contraseña de empresa en el JavaScript del navegador.
4. Prueba de aceptación pendiente en teléfonos reales: descargar, desconectar, contar con decimales/ceros, cerrar y reabrir la aplicación, reconectar y verificar recepción única; revisar GPS con permiso concedido/denegado y CSV con un documento de prueba en SAP.

Pruebas reproducibles (Node 22):

```sh
npm install --prefix work --no-audit --no-fund --save-exact @electric-sql/pglite@0.5.11 fake-indexeddb@6.2.6 jsdom@26.1.0
PGLITE_PATH="$PWD/work/node_modules/@electric-sql/pglite" node --test enjoy/tests/*.test.js
node tools/company-access.test.js
node tools/registration-flow.test.js
node tools/navigation-routing.test.js
```

`ENJOY_FIXTURES=/ruta/archivos` agrega las comprobaciones contra los archivos adjuntos de octubre y septiembre. No se incorporan archivos reales de inventario al repositorio. SQL se prueba con todas las migraciones en PostgreSQL aislado; las pruebas de interfaz ejecutan los eventos DOM de búsqueda, cantidad y corrección. El workflow de GitHub repite estas comprobaciones en cada cambio.

No sustituye la prueba de aceptación con el SAP real ni la revisión visual en móviles. El navegador de automatización falló al intentar abrir la aplicación local; ese bloqueo se documenta y no se considera una verificación visual completada.
