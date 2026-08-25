const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825200000_recepcion_colaborativa_tiempo_real.sql');
const cloud = read('operaciones/cloud-api.js');
const app = read('operaciones/reception-app.js');
const guest = read('operaciones/invitado.js');

assert.match(migration, /op_recepcion_dispositivos/, 'Debe existir presencia por dispositivo');
assert.match(migration, /op_recepcion_reclamar[\s\S]*for update skip locked/, 'La asignación concurrente debe bloquear filas sin repetir SKU');
assert.match(migration, /Este producto lo está controlando/, 'Debe rechazar un producto reservado por otra persona');
assert.match(migration, /last_seen>now\(\)-interval '3 minutes'/, 'Las reservas abandonadas deben vencer');
assert.match(migration, /op_recepcion_cantidad_colaborativa[\s\S]*asignado_cliente is distinct from cliente/, 'Las cantidades requieren ser dueño de la reserva');
assert.match(migration, /controlado_at=now\(\)/, 'Una diferencia física debe quedar registrada como controlada');
assert.match(migration, /op_invitado_recepcion_operar/, 'Los invitados deben usar el mismo control exclusivo');

assert.match(cloud, /\/api\/recepcion\/claim/, 'La aplicación debe exponer la reserva de recepción');
assert.match(cloud, /op_recepcion_cantidad_colaborativa/, 'La aplicación no debe usar la actualización sin reserva');
assert.match(cloud, /op_recepcion_dispositivos/, 'La presencia debe sincronizarse en tiempo real');
assert.match(app, /receiptEnsureClaim/, 'Búsqueda, lista y escáner deben validar la reserva');
assert.match(app, /Controlando:/, 'La interfaz debe indicar quién controla el producto');
assert.match(guest, /receipt_claim/, 'El invitado debe reservar antes de controlar');
assert.match(guest, /op_invitado_recepcion_operar/, 'El invitado debe usar la función colaborativa');

class Coordinator {
  constructor(codes) { this.items = codes.map(code => ({code, owner:null, controlled:false, received:0})); }
  claim(client, code) {
    const item = this.items.find(row => row.code === code);
    if (!item) throw new Error('missing');
    if (item.owner && item.owner !== client) throw new Error('busy');
    this.items.forEach(row => { if (row.owner === client && row !== item) row.owner = null; });
    item.owner = client;
    return item;
  }
  save(client, code, quantity) {
    const item = this.items.find(row => row.code === code);
    if (item.owner !== client) throw new Error('not-owner');
    item.received = quantity;
    item.controlled = true;
    item.owner = null;
  }
}

const coordinator = new Coordinator(['A', 'B']);
coordinator.claim('phone-1', 'A');
assert.throws(() => coordinator.claim('phone-2', 'A'), /busy/, 'Dos personas no deben controlar el mismo producto');
coordinator.claim('phone-2', 'B');
coordinator.save('phone-1', 'A', 1);
coordinator.save('phone-2', 'B', 3);
assert.deepStrictEqual(coordinator.items.map(row => [row.code,row.received,row.controlled]), [['A',1,true],['B',3,true]]);

console.log('reception-collaboration: OK');
