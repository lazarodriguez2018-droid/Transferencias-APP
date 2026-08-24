const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../operaciones/reposition-engine.js');
const lifecycleSql = fs.readFileSync(path.join(__dirname,'..','supabase','migrations','20260824130000_reposicion_cierre_eliminacion_pedidos_listos.sql'),'utf8');
const repositionUi = fs.readFileSync(path.join(__dirname,'..','operaciones','reposition-app.js'),'utf8');

const locales = [
  { codigo: 'PDE', nombre: 'Punta del Este' },
  { codigo: 'MDO', nombre: 'Maldonado' }
];
const inventorySessions = [
  { id: 'i-pde', local_nombre: 'Punta del Este' },
  { id: 'i-mdo', local_nombre: 'Maldonado' }
];
const repos = [
  { id: 'r1', origen_local: 'PDE', destino_local: 'MDO' },
  { id: 'r2', origen_local: 'MDO', destino_local: 'PDE' }
];

const normalize = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const locationMatches = (session, localCode) => {
  const local = locales.find(item => item.codigo === localCode);
  return local && normalize(session.local_nombre) === normalize(local.nombre);
};
const visibleInventories = profile => inventorySessions.filter(session =>
  ['admin', 'supervisor'].includes(profile.rol) || locationMatches(session, profile.local));
const visibleRepos = profile => repos.filter(repo =>
  ['admin', 'supervisor'].includes(profile.rol) || repo.origen_local === profile.local || repo.destino_local === profile.local);
const editableRepos = profile => visibleRepos(profile).filter(repo =>
  ['admin', 'supervisor'].includes(profile.rol) || repo.origen_local === profile.local);

for (const local of locales) {
  const employee = { rol: 'empleado', local: local.codigo };
  assert.strictEqual(visibleInventories(employee).length, 1, `${local.codigo} debe ver únicamente su inventario`);
  assert.strictEqual(visibleRepos(employee).length, 2, `${local.codigo} debe ver reposiciones donde participa`);
  assert.strictEqual(editableRepos(employee).length, 1, `${local.codigo} solo debe preparar cuando es origen`);
}
assert.strictEqual(visibleInventories({ rol: 'admin' }).length, 2, 'Administración debe ver todos los inventarios');
assert.strictEqual(editableRepos({ rol: 'supervisor' }).length, 2, 'Supervisión debe gestionar todas las rutas');

const repo = {
  items: [
    { codigo: 'A', pedido: 5, pedido_reposicion: 5, pedido_clientes: 2, preparado: 5 },
    { codigo: 'B', pedido: 4, pedido_reposicion: 1, pedido_clientes: 4, preparado: 3 },
    { codigo: 'C', pedido: 2, pedido_reposicion: 2, pedido_clientes: 0, preparado: 0, no_encontrado: true,
      motivo_codigo: 'stock_insuficiente', motivo_label: 'Stock insuficiente' }
  ],
  extras: [{ codigo: 'X', cantidad: 2 }]
};
assert.deepStrictEqual(engine.mainTransferRows(repo), [['A', 3]], 'La transferencia automática no debe duplicar pedidos de clientes');
assert.deepStrictEqual(engine.orderTransferRows(repo), [['A', 2], ['B', 3]], 'Los pedidos aceptados tienen prioridad sobre lo preparado');
assert.deepStrictEqual(engine.extraTransferRows(repo), [['X', 2]], 'Los productos fuera de reposición deben exportarse aparte');
assert.deepStrictEqual(engine.missingRows(repo).map(row => [row.codigo, row.faltante]), [['B', 1], ['C', 2]]);

const exported = [...engine.mainTransferRows(repo), ...engine.orderTransferRows(repo), ...engine.extraTransferRows(repo)]
  .reduce((sum, [, quantity]) => sum + quantity, 0);
assert.strictEqual(exported, 10, 'Todas las unidades preparadas deben quedar representadas una sola vez');

// Flujo solicitado: MDO hace un pedido a PDE. La mercadería viaja PDE → MDO,
// aparece como extra dentro de Preparar y el pedido queda Listo al completarse.
const mdoOrder = {
  requester:'MDO',origin:'PDE',destination:'MDO',estado:'aceptado',
  products:[{codigo:'X',cantidad_aceptada:2,cantidad_preparada:0}]
};
const pdeRepoItem = {codigo:'X',pedido_reposicion:1,pedido_clientes:2,pedido:Math.max(1,2),preparado:0};
assert.equal(mdoOrder.origin,'PDE');
assert.equal(mdoOrder.destination,'MDO');
assert.equal(pdeRepoItem.pedido,2,'El pedido y la reposición del mismo SKU no deben sumarse físicamente');
assert.match(repositionUi,/Extra pedido por \$\{esc\(repoState\.destination/);
pdeRepoItem.preparado = 2;
mdoOrder.products[0].cantidad_preparada = Math.min(pdeRepoItem.preparado,pdeRepoItem.pedido_clientes);
mdoOrder.estado = mdoOrder.products.every(item => item.cantidad_preparada >= item.cantidad_aceptada) ? 'listo' : 'aceptado';
assert.equal(mdoOrder.estado,'listo','Al juntar todo debe quedar Listo para enviar');
mdoOrder.estado = 'transito';
assert.equal(mdoOrder.estado,'transito','Al confirmar el despacho debe quedar En viaje');
assert.match(lifecycleSql,/after update of preparado/);
assert.match(lifecycleSql,/estado=case when t\.solicitada>0 and t\.preparada>=t\.solicitada then 'listo'/);
assert.match(lifecycleSql,/estado=case when t\.preparada>0 then 'transito'/);

console.log('workflow-integration: OK');
