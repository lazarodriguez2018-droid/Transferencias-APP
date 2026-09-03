const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const migration = read('supabase/migrations/20260824010000_reposicion_colaborativa_tiempo_real.sql');
const fixMigration = read('supabase/migrations/20260824020000_reposicion_colaborativa_fix.sql');
const lifecycleMigration = read('supabase/migrations/20260824130000_reposicion_cierre_eliminacion_pedidos_listos.sql');
const cloud = read('operaciones/cloud-api.js');
const app = read('operaciones/reposition-app.js');
const html = read('operaciones/index.html');
const guest = read('operaciones/invitado.js');

// El contrato productivo debe resolver la carrera en PostgreSQL, no sólo en pantalla.
assert.match(migration,/for update skip locked/i);
assert.match(migration,/op_reposicion_dispositivos/);
assert.match(migration,/alter publication supabase_realtime add table public\.op_reposicion_dispositivos/);
assert.match(migration,/last_seen>now\(\)-interval '3 minutes'/);
assert.match(migration,/asignado_cliente<>cliente/);
assert.match(migration,/r\.preparado\+coalesce\(p_delta,0\)/,
  'Los escaneos concurrentes deben sumar sobre el valor bloqueado en la base');
assert.match(cloud,/kind:'item'/);
assert.match(cloud,/kind:'device'/);
assert.match(cloud,/subscribe\(status=>callback\(\{kind:'status',status\}\)\)/);
assert.match(app,/setInterval\(repoHeartbeat,45000\)/);
assert.match(app,/repoUpdateQuantity\(encodedCode,\{delta:change\}/);
assert.match(app,/repoItemClaimedByOther/);
assert.match(fixMigration,/nombre_usuario/,
  'Las funciones productivas no deben confundir el nombre del usuario con la columna del producto');
assert.doesNotMatch(fixMigration,/asignado_nombre\s*=\s*nombre\s*[,\n]/i);
assert.match(html,/>← Anterior<\/button>/);
assert.match(html,/>Saltar →<\/button>/);
assert.doesNotMatch(app,/>Tomar este producto<\/button>|>Ver mi producto asignado →<\/button>/,
  'La coordinación debe ser invisible y conservar los botones originales');
assert.match(app,/function repoHydrateItemFromCatalog\(item\)/,
  'Las reposiciones existentes deben completar sus barras desde el padrón vigente');
assert.match(app,/barras:barcode/,
  'La barra del padrón vigente debe reemplazar la copia vacía o desactualizada de la reposición');
assert.match(app,/repoState = repoHydrateStateFromCatalog\(data\.repo\)/,
  'Cada actualización completa en tiempo real debe reconciliar los productos con el padrón');
assert.match(cloud,/items:\(items \|\| \[\]\)\.map\(row=>repoItem\(row,catalogByCode\)\)/,
  'La API debe devolver las reposiciones ya enriquecidas por SKU');
assert.match(cloud,/itemsByRepo\.get\(row\.id\)\|\|\[\]\)\.map\(item=>repoItem\(item\)\)/,
  'El listado no debe pasar el índice de Array.map como si fuera el padrón');
assert.match(cloud,/typeof catalogByCode\?\.get === 'function'/,
  'El enriquecimiento debe tolerar llamadas sin un índice de padrón');
assert.match(html,/cloud-api\.js\?v=directory-v1/);
assert.match(html,/reposition-app\.js\?v=repo-orders-v1/);
assert.doesNotMatch(html,/repo-dispatch-card|Marcar todo como enviado|Confirmar envío/);
assert.match(app,/No hay productos disponibles para recoger/);
assert.match(app,/Revisar lista de productos/);
assert.match(app,/Extra pedido por \$\{esc\(repoState\.destination/,
  'El producto debe aclarar qué local lo pidió como extra');
assert.match(cloud,/path==='\/api\/reposicion\/delete'/);
assert.match(cloud,/can_delete:row\.estado==='preparando'&&canEdit/);
assert.match(lifecycleMigration,/create or replace function public\.op_eliminar_reposicion/);
assert.match(lifecycleMigration,/estado=case when t\.solicitada>0 and t\.preparada>=t\.solicitada then 'listo'/);
assert.match(lifecycleMigration,/p\.estado in \('aceptado','listo'\)/,
  'El despacho debe incluir los pedidos que ya pasaron automáticamente a Listo');

// La PC que crea la reposición puede coordinar sin reservar un producto.
assert.match(app,/joinReposition\(data\.reposition_id, data\.repo\.nombre, url, usuario, data\.repo, \{supervise:true\}\)/,
  'La PC creadora debe iniciar como supervisora');
assert.match(app,/async function toggleRepoSupervisionMode\(\)/);
assert.match(app,/function repoShouldAutoAssign\(\)/);
assert.match(app,/if \(repoIsSupervising\(\)\) await repoReleaseAssignment/,
  'El heartbeat no debe conservar una reserva accidental en la PC supervisora');
assert.match(html,/id="repo-assignment-mode-btn"/);
assert.match(html,/id="repo-supervision-banner"/);
assert.match(guest,/operate\('repo_claim'/,
  'Los invitados por QR deben conservar el reparto automático de productos');

// Lista unificada con filtros combinables y origen visible.
assert.doesNotMatch(html,/id="repo-tab-extras"/,
  'Extras ya no debe ocupar una pestaña principal');
assert.doesNotMatch(html,/id="repo-page-extras"/,
  'Extras debe vivir dentro de Lista');
assert.match(html,/id="repo-list-section-reposition"/);
assert.match(html,/id="repo-list-section-extra"/);
assert.match(html,/id="repo-status-filters"/);
assert.match(html,/type="checkbox" value="pending"/);
assert.match(app,/\$\{item\.codigo\} \$\{item\.nombre\} \$\{item\.barras \|\| ''\}/,
  'La lista debe buscar por código, nombre y barras');
assert.match(app,/Number\(item\.pedido_clientes\) > 0/,
  'La subpestaña Extra debe incluir pedidos de clientes');
assert.match(app,/repo-origin-badge customer/);
assert.match(app,/repo-origin-badge manual/);

// Simulación determinista del resultado esperado con muchos dispositivos.
class Coordinator {
  constructor(products) {
    this.products = products.map(code => ({code,owner:null,prepared:0,requested:1}));
  }
  claimNext(client) {
    const own = this.products.find(item => item.owner === client && item.prepared < item.requested);
    if (own) return own;
    const available = this.products.find(item => !item.owner && item.prepared < item.requested);
    if (!available) return null;
    available.owner = client;
    return available;
  }
  claim(client,code) {
    const item = this.products.find(row => row.code === code);
    if (!item) throw new Error('missing');
    if (item.owner && item.owner !== client) throw new Error('busy');
    this.products.forEach(row => { if (row.owner === client && row !== item) row.owner = null; });
    item.owner = client;
    return item;
  }
  add(client,code,delta) {
    const item = this.products.find(row => row.code === code);
    if (item.owner !== client) throw new Error('busy');
    item.prepared += delta;
    if (item.prepared >= item.requested) item.owner = null;
    return item.prepared;
  }
}

const coordinator = new Coordinator(Array.from({length:50},(_,index)=>`SKU-${index+1}`));
const clients = Array.from({length:20},(_,index)=>`phone-${index+1}`);
const assigned = clients.map(client => coordinator.claimNext(client));
assert.equal(new Set(assigned.map(item => item.code)).size,clients.length,
  'Veinte celulares deben recibir veinte productos diferentes');

const target = assigned[0];
assert.throws(()=>coordinator.claim('phone-2',target.code),/busy/,
  'Un segundo celular no puede tomar un producto reservado');
assert.throws(()=>coordinator.add('phone-2',target.code,1),/busy/,
  'Un segundo celular no puede sumar una unidad al producto ajeno');
assert.equal(coordinator.add('phone-1',target.code,1),1);
assert.equal(target.owner,null,'Al completar el producto la reserva debe liberarse');

const replacement = coordinator.claimNext('phone-1');
assert.ok(replacement && replacement.code !== target.code,
  'Después de completar se debe asignar otro producto pendiente');

console.log('reposition-collaboration: OK');

