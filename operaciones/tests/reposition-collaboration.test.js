const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const migration = read('supabase/migrations/20260824010000_reposicion_colaborativa_tiempo_real.sql');
const cloud = read('operaciones/cloud-api.js');
const app = read('operaciones/reposition-app.js');

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
