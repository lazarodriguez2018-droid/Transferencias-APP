const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const portal = read('app.js');
const operations = read('operaciones/app.js');
const cloud = read('operaciones/cloud-api.js');
const cloudConfig = read('operaciones/cloud-config.js');
const reposition = read('operaciones/reposition-app.js');
const realtime = read('supabase/migrations/20260822030000_realtime_operaciones.sql');
const receptionMigration = read('supabase/migrations/20260824170000_recepcion_remitos.sql');

const productionProject = 'akqqpodyijzjdoibkint';
assert.match(portal, new RegExp(productionProject), 'El portal debe usar el proyecto principal Transfeapp');
assert.match(cloudConfig, new RegExp(productionProject), 'Operaciones debe usar el proyecto principal Transfeapp');
assert.doesNotMatch(portal + cloudConfig, /fjpsggtfssibyuxupggd/,
  'La versión final no debe apuntar al proyecto de pruebas');

[
  'pedido_productos', 'catalogo_version', 'locales', 'transportes'
].forEach(table => assert.match(portal, new RegExp(`table:\\s*'${table}'`), `Falta sincronizar ${table} en el portal`));

[
  'op_inventario_sesiones', 'op_inventario_items', 'op_inventario_eventos',
  'op_inventario_balances', 'op_inventario_participantes', 'op_reposiciones',
  'op_reposicion_items', 'op_reposicion_extras', 'op_reposicion_participantes'
].forEach(table => {
  assert.match(cloud, new RegExp(`table:\\s*'${table}'`), `Falta observar ${table} en el cliente web`);
  assert.match(realtime, new RegExp(`'${table}'`), `Falta publicar ${table} en Realtime`);
});
[
  'op_recepciones','op_recepcion_items','op_recepcion_extras','op_recepcion_participantes'
].forEach(table => {
  assert.match(cloud,new RegExp(`table:\\s*'${table}'`),`Falta observar ${table} en el cliente web`);
  assert.match(receptionMigration,new RegExp(`'${table}'`),`Falta publicar ${table} en Realtime`);
});
assert.match(realtime, /alter publication supabase_realtime add table public\.%I/);

assert.match(cloud, /function selectInBatches/);
assert.match(cloud, /function groupRows/);
assert.doesNotMatch(cloud, /for \(const session of rows \|\| \[\]\) \{[\s\S]{0,1200}await client\.from\('op_inventario_items'\)/,
  'El directorio de inventarios no debe consultar sesión por sesión');
assert.match(operations, /session-create-location/);
assert.match(operations, /populateLocationControls/);
assert.doesNotMatch(operations, /<option value="(?:CEN|CDA|CDE)"/,
  'No deben existir locales ficticios codificados en la aplicación');
assert.match(reposition, /function repoCanEdit\(\)/);
assert.match(reposition, /repoState\?\.can_edit !== false/);
assert.match(reposition, /classList\.toggle\('repo-readonly'/);
assert.match(operations, /cargarSesionesDisponibles\(\{silent:true\}\)/,
  'Las actualizaciones en tiempo real del directorio no deben tapar la lista con un cargador');
const directoryWatcher = cloud.slice(cloud.indexOf('cloud.watchSessionDirectory'), cloud.indexOf('cloud.checkUrgentOrders'));
assert.doesNotMatch(directoryWatcher, /event:'\*',schema:'public',table:'op_(?:inventario|reposicion|recepcion)_participantes'/,
  'Los heartbeats de participantes no deben recargar continuamente el selector de sesiones');

console.log('sync-contract: OK');
