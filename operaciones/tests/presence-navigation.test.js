const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('operaciones/app.js');
const cloud = read('operaciones/cloud-api.js');
const reception = read('operaciones/reception-app.js');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `No se encontró la sección ${start}`);
  return source.slice(from, to);
}

// Un estado de consulta no debe renovar presencia: esa escritura disparaba el
// mismo canal que volvía a consultar el estado y generaba un bucle de renders.
const receiptStateRoute = section(cloud, "if(path==='/api/recepcion/state')", "if(path==='/api/recepcion/claim'");
const repoStateRoute = section(cloud, "if(path==='/api/reposicion/state')", "if(path==='/api/reposicion/claim'");
assert.doesNotMatch(receiptStateRoute, /op_recepcion_tocar|upsert\s*\(/);
assert.doesNotMatch(repoStateRoute, /op_reposicion_tocar|upsert\s*\(/);

const receiptRealtime = section(reception, 'function handleReceiptRealtimeChange', 'async function refreshReceptionState');
assert.match(receiptRealtime, /change\.kind==='device'[\s\S]*applyReceiptPresenceChange\(change\)[\s\S]*return/);
assert.match(receiptRealtime, /change\.kind==='participant'\)return/);
assert.match(receiptRealtime, /scheduleReceiptStateRefresh\(\)/);
assert.match(reception, /renderOperationsParticipants\(participants,receiptState\.participantes\|\|\[\]\)/);
assert.match(reception, /function renderReceiptConfig\(\)[\s\S]*setOperationsStableHtml\(node,html\)/);
assert.match(cloud, /cloud\.goPortal\s*=\s*\(\)\s*=>\s*\{[\s\S]*window\.backToModules/);

let presenceChanges = 0;
let stateRefreshes = 0;
const realtimeContext = {
  receiptState:{},
  setSyncStatus:() => {},
  applyReceiptPresenceChange:() => { presenceChanges += 1; },
  scheduleReceiptStateRefresh:() => { stateRefreshes += 1; }
};
vm.runInNewContext(`${receiptRealtime}\nthis.handleReceiptRealtimeChange=handleReceiptRealtimeChange;`, realtimeContext);
realtimeContext.handleReceiptRealtimeChange({kind:'device',event:'UPDATE',row:{cliente_id:'one'}});
realtimeContext.handleReceiptRealtimeChange({kind:'participant',event:'UPDATE',row:{usuario_id:'user'}});
assert.equal(presenceChanges, 1);
assert.equal(stateRefreshes, 0, 'Los heartbeats de presencia no deben consultar nuevamente el estado');
realtimeContext.handleReceiptRealtimeChange({kind:'item',event:'UPDATE',row:{codigo:'SKU'}});
assert.equal(stateRefreshes, 1, 'Un cambio de cantidades sí debe programar una lectura de estado');

// Ejecutar los helpers de render en aislamiento permite comprobar que un mero
// cambio de last_seen no destruye y vuelve a crear las píldoras de personas.
const helperSource = section(app, 'function operationsElement', 'function showOperationsLoading');
let writes = 0;
let currentHtml = '';
const participantsNode = {};
Object.defineProperty(participantsNode, 'innerHTML', {
  get: () => currentHtml,
  set: value => { writes += 1; currentHtml = value; }
});
const nodes = {participants: participantsNode};
const context = {
  document: {getElementById: id => nodes[id] || null},
  esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
};
vm.runInNewContext(`${helperSource}\nthis.presenceApi={normalizeOperationsParticipants,renderOperationsParticipants,setOperationsStableHtml};`, context);

const firstPresence = [
  {usuario_id:'u-1',cliente_id:'device-a',nombre:'Ana',last_seen:'2026-09-12T10:00:00Z'},
  {usuario_id:'u-1',cliente_id:'device-b',nombre:'Ana',last_seen:'2026-09-12T10:00:01Z'},
  {invitado_id:'g-1',cliente_id:'device-c',nombre:'Bruno',last_seen:'2026-09-12T10:00:00Z'}
];
const normalized = context.presenceApi.normalizeOperationsParticipants(firstPresence);
assert.equal(normalized.length, 2, 'Una persona conectada desde dos dispositivos debe mostrarse una sola vez');
context.presenceApi.renderOperationsParticipants('participants', firstPresence);
assert.equal(writes, 1);
assert.equal((currentHtml.match(/Ana/g) || []).length, 1);

context.presenceApi.renderOperationsParticipants('participants', [
  {...firstPresence[2],last_seen:'2026-09-12T10:01:00Z'},
  {...firstPresence[1],last_seen:'2026-09-12T10:01:01Z'},
  {...firstPresence[0],last_seen:'2026-09-12T10:01:02Z'}
]);
assert.equal(writes, 1, 'Un heartbeat no debe volver a escribir el DOM de participantes');

context.presenceApi.renderOperationsParticipants('participants', [
  {...firstPresence[0],nombre:'Ana María'},
  firstPresence[2]
]);
assert.equal(writes, 2, 'Un cambio visible real sí debe actualizar participantes');

const changeSession = section(app, 'async function cambiarSesion()', 'async function cambiarModulo()');
const changeModule = section(app, 'async function cambiarModulo()', 'function updateSessionCard()');
assert.match(changeSession, /await waitForOperationsDialogHistory\(\)[\s\S]*await releaseActiveOperationsAssignment\(\)[\s\S]*leaveOperationsWorkspace\(\{releaseAssignment:false\}\)/);
assert.match(changeModule, /await waitForOperationsDialogHistory\(\)[\s\S]*await backToModules\(\)/);
assert.match(app, /function releaseActiveOperationsAssignment\(\)[\s\S]*repoReleaseAssignment[\s\S]*receiptReleaseAssignment/);
assert.match(app, /currentModule === 'inventario'[\s\S]*\/api\/sesion\/salir[\s\S]*keepalive:true/);

const releaseSource = section(app, 'function releaseActiveOperationsAssignment()', 'function leaveOperationsWorkspace');
const releases = {inventory:[],repo:0,receipt:0};
const releaseContext = {
  sessionId:'inventory-session',currentModule:'inventario',serverOnline:true,serverUrl:'',
  fetch:async (url,options)=>{releases.inventory.push({url,options});return {ok:true};},
  repoReleaseAssignment:async()=>{releases.repo+=1;},
  receiptReleaseAssignment:async()=>{releases.receipt+=1;},
  setTimeout
};
vm.runInNewContext(`${releaseSource}\nthis.releaseActiveOperationsAssignment=releaseActiveOperationsAssignment;`,releaseContext);

(async()=>{
  await releaseContext.releaseActiveOperationsAssignment();
  assert.equal(releases.inventory.length,1,'Salir de Inventario debe eliminar una sola vez su presencia');
  assert.equal(releases.inventory[0].url,'/api/sesion/salir');
  assert.equal(releases.inventory[0].options.keepalive,true,'La baja debe sobrevivir a la navegación inmediata');
  assert.deepEqual(JSON.parse(releases.inventory[0].options.body),{session_id:'inventory-session'});

  releaseContext.currentModule='reposicion';
  await releaseContext.releaseActiveOperationsAssignment();
  assert.equal(releases.repo,1,'Reposición debe liberar su asignación una sola vez');
  assert.equal(releases.inventory.length,1,'Reposición no debe borrar una presencia de Inventario');

  releaseContext.currentModule='recepcion';
  await releaseContext.releaseActiveOperationsAssignment();
  assert.equal(releases.receipt,1,'Recepción debe liberar su asignación una sola vez');
  assert.equal(releases.inventory.length,1,'Recepción no debe borrar una presencia de Inventario');
  console.log('presence-navigation: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
