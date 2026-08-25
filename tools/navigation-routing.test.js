const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const portalHtml = read('index.html');
const portalJs = read('app.js');
const portalCss = read('style.css');
const operationsHtml = read('operaciones/index.html');
const operationsJs = read('operaciones/app.js');
const cloudApi = read('operaciones/cloud-api.js');
const cloudConfig = read('operaciones/cloud-config.js');
const operationsMigration = read('supabase/migrations/20260822010000_sucaneitor_operaciones.sql');
const realtimeMigration = read('supabase/migrations/20260822030000_realtime_operaciones.sql');

assert.match(operationsHtml, /<base href="\/operaciones\/">/,
  'Operaciones debe conservar su base al publicarse como URL limpia');
assert.match(portalHtml, /href="\/operaciones\?module=inventario"/);
assert.match(portalHtml, /href="\/operaciones\?module=reposicion"/);
assert.match(portalHtml, /href="\/operaciones\?module=recepcion"/);
assert.match(operationsHtml, /href="\/"[^>]*>← Volver al inicio<\/a>/);
assert.doesNotMatch(operationsHtml, /id="module-screen"|¿Qué vas a hacer\?|Usar sin servidor|URL del servidor|Modo Red Local/,
  'Operaciones no debe conservar el selector blanco ni opciones del servidor local');
assert.match(operationsHtml, /app\.js\?v=report-download-v4/,
  'El navegador debe solicitar la versión nueva y no reutilizar archivos antiguos');
assert.match(portalHtml, /<h1>Escoja un modulo para realizar su tarea:<\/h1>/,
  'El selector debe mostrar la instrucción solicitada');
assert.doesNotMatch(portalHtml, /SUCANEITOR OPERACIONES|Administrar padrón de mercaderías|Los cuatro módulos comparten/,
  'El selector no debe conservar el texto ni el botón eliminados');
assert.match(portalCss, /\.operations-grid\{display:grid;grid-template-columns:1fr/,
  'Los módulos deben presentarse como una lista vertical');
assert.match(operationsHtml, /\.mo\.app-dialog-layer\{z-index:10050!important/,
  'Las confirmaciones deben aparecer por encima del panel de invitaciones');
assert.doesNotMatch(operationsJs, /module-screen|sc_server_url|input-server-url/,
  'La navegación y las sesiones deben funcionar únicamente sobre la web alojada');
assert.match(operationsJs, /if \(!\['inventario','reposicion','recepcion'\]\.includes\(requestedModule\)\) \{\s*location\.replace\('\/'\);/,
  'Abrir Operaciones sin un módulo válido debe volver al inicio principal');
assert.match(operationsJs, /function backToModules\(\)[\s\S]*location\.href = '\/';/,
  'Volver desde Operaciones debe llevar al inicio principal');
assert.match(operationsJs, /function mostrarPantallaSesion\(loadSessions = true\)[\s\S]*if \(loadSessions\) cargarSesionesDisponibles\(\);/,
  'Cada módulo debe cargar automáticamente sus sesiones alojadas');
assert.match(operationsHtml, /id="session-search"/);
assert.match(operationsHtml, /id="session-location-filter"/);
assert.match(operationsJs, /function normalizeSessionSearch[\s\S]*normalize\('NFD'\)/,
  'La búsqueda de sesiones debe ignorar tildes y mayúsculas');
assert.match(operationsJs, /isSupervisor[\s\S]*Acceso administrativo: podés ver las sesiones de toda la empresa/,
  'La interfaz debe distinguir el alcance administrativo');
assert.match(cloudConfig, /portalUrl:\s*'\/'/);
assert.match(cloudConfig, /pedidosUrl:\s*'\/\?module=pedidos'/);
assert.doesNotMatch(portalJs, /return_to|returnTo/,
  'Después de iniciar sesión siempre se debe mostrar el inicio principal');
assert.doesNotMatch(cloudApi, /return_to|returnTo/,
  'Operaciones sin autenticar debe volver al inicio sin reenvío automático');
assert.match(cloudApi, /local_nombre:session\.local_nombre/,
  'Los inventarios deben informar el local para su búsqueda y filtro');
assert.match(operationsMigration, /inventario_sesiones_scope[\s\S]*is_ops_supervisor\(\) or local_nombre = public\.my_local\(\)/,
  'Los inventarios deben limitarse por local salvo para administradores');
assert.match(operationsMigration, /reposiciones_scope[\s\S]*is_ops_supervisor\(\) or origen_local=public\.my_local\(\) or destino_local=public\.my_local\(\)/,
  'Las reposiciones deben limitarse a los locales involucrados salvo para administradores');
assert.match(realtimeMigration, /'op_inventario_items'/,
  'Los cambios de conteo deben publicarse en tiempo real');
assert.match(realtimeMigration, /'op_reposicion_items'/,
  'Los cambios de preparación deben publicarse en tiempo real');
assert.match(realtimeMigration, /'pedido_productos'/,
  'Los productos de pedidos entre locales deben actualizarse en tiempo real');
assert.match(portalJs, /classList\.toggle\('hub-mode',view==='hub'\)/);
assert.match(portalJs, /window\.addEventListener\('popstate', restoreNavigationState\)/,
  'El botón Atrás debe restaurar la sección anterior del portal');
assert.match(portalJs, /view!==appState\.activeView\|\|!appState\.navigationReady/,
  'Atrás no debe renderizar otra vez una sección que ya está visible');
assert.match(portalJs, /function closeModal[\s\S]*return new Promise[\s\S]*history\.back\(\)/,
  'Cerrar una ventana debe esperar a que el historial vuelva antes de abrir otra vista');
assert.match(operationsJs, /window\.addEventListener\('popstate', handleOperationsPopState\)/,
  'El botón Atrás debe recorrer sesión y pestañas de Operaciones');
assert.match(operationsJs, /if \(routeAlreadyCurrent\) return;/,
  'Cerrar una ventana de Operaciones no debe volver a renderizar la pantalla anterior');
assert.match(operationsJs, /selectModule\(requestedModule,\{showSessions:!requestedSession\}\)/,
  'Un enlace directo a una sesión no debe mostrar antes el selector de sesiones');
assert.match(portalCss, /#app-page\.hub-mode \.sidebar[\s\S]*display:none !important/,
  'El selector inicial no debe mostrar la barra lateral');

console.log('navigation-routing: OK');

