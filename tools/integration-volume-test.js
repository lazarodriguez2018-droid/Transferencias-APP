'use strict';

const assert = require('assert');
const engine = require('../operaciones/reposition-engine.js');

const skuCount = Number(process.argv[2] || 12000);
const orderCount = Number(process.argv[3] || 100000);
const started = performance.now();
const items = Array.from({length:skuCount},(_,index)=>({
  codigo:`SKU-${String(index).padStart(6,'0')}`,
  nombre:`Producto ${index}`,
  pedido_reposicion:index%9,
  pedido_clientes:0,
  preparado:0,
  pedidos_asignados:[]
}));

for(let index=0;index<orderCount;index+=1){
  const item=items[(index*7919)%skuCount];
  const qty=1+(index%4);
  item.pedido_clientes+=qty;
  item.pedidos_asignados.push({pedido_id:`P-${index}`,cliente:`Cliente ${index%25000}`,cantidad:qty});
}

for(const item of items){
  item.pedido=Math.max(item.pedido_reposicion,item.pedido_clientes);
  item.preparado=item.pedido+(Number(item.codigo.slice(-1))%3===0?1:0);
}

const prepared=items.reduce((sum,item)=>sum+item.preparado,0);
const repo={items,extras:[]};
const automatic=engine.mainTransferRows(repo);
const customers=engine.orderTransferRows(repo);
const bySku=new Map();
for(const [code,qty] of [...automatic,...customers]) bySku.set(code,(bySku.get(code)||0)+qty);
for(const item of items) assert.strictEqual(bySku.get(item.codigo)||0,item.preparado,`Cantidad duplicada o perdida: ${item.codigo}`);

console.log(JSON.stringify({
  skus:skuCount,accepted_customer_orders:orderCount,prepared_units:prepared,
  automatic_rows:automatic.length,customer_rows:customers.length,
  elapsed_ms:Math.round(performance.now()-started),validation:'OK — ninguna unidad duplicada ni perdida'
},null,2));
