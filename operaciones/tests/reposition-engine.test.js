const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('../xlsx.full.min.js');
const engine = require('../reposition-engine.js');

function testSyntheticMacroRule() {
  const rows = [
    ['sku','location','description','qty_replenishment','origin','day_to_replenish','stock_origin'],
    ['A1','MDO','Adult Dog 3 KG',2,'PDE','viernes',5],
    ['A2','MDO','Puppy Medium 15 KG',2,'PDE','viernes',2],
    ['A3','MDO','Cama grande',1,'PDE','viernes',3]
  ];
  const padron = [
    {codigo:'A1',nombre:'Alimento Perro Adulto 3 KG',barras:'111'},
    {codigo:'A2',nombre:'Alimento Cachorro Mediano 15 KG',barras:'222'},
    {codigo:'A3',nombre:'Cama Grande',barras:''}
  ];
  const parsed = engine.parseRows(rows,padron);
  assert.strictEqual(parsed.origin,'PDE');
  assert.strictEqual(parsed.destination,'MDO');
  assert.deepStrictEqual(parsed.items.map(item => item.codigo),['A1','A3']);
  assert.deepStrictEqual(parsed.excluded.map(item => item.codigo),['A2']);
  assert.strictEqual(parsed.meta.retained_requested_units,3);
}

function testStatusesAndExports() {
  const repo = {
    items:[
      {codigo:'001',nombre:'Uno',pedido:2,preparado:2},
      {codigo:'002',nombre:'Dos',pedido:5,preparado:3},
      {codigo:'003',nombre:'Tres',pedido:1,preparado:2},
      {codigo:'004',nombre:'Cuatro',pedido:4,preparado:0,no_encontrado:true,motivo_codigo:'stock_insuficiente',motivo_label:'Stock insuficiente',comentario:'Se revisó depósito'}
    ],
    extras:[{codigo:'001',nombre:'Uno',cantidad:4},{codigo:'005',nombre:'Cinco',cantidad:0}]
  };
  assert.strictEqual(engine.status(repo.items[0]),'completo');
  assert.strictEqual(engine.status(repo.items[1]),'parcial');
  assert.strictEqual(engine.status(repo.items[2]),'excedido');
  assert.strictEqual(engine.status(repo.items[3]),'no_encontrado');
  assert.deepStrictEqual(engine.mainTransferRows(repo),[['001',2],['002',3],['003',2]]);
  assert.deepStrictEqual(engine.extraTransferRows(repo),[['001',4]]);
  assert.strictEqual(engine.missingRows(repo).reduce((sum,row)=>sum+row.faltante,0),6);
  const notFound = engine.missingRows(repo).find(row => row.codigo === '004');
  assert.strictEqual(notFound.motivo_codigo,'stock_insuficiente');
  assert.strictEqual(notFound.motivo_label,'Stock insuficiente');
  assert.strictEqual(notFound.comentario,'Se revisó depósito');
  assert.deepStrictEqual(engine.pickupState(repo),{total:4,remaining:1,assigned:0,completed:false});
  repo.items[1].preparado = 5;
  assert.deepStrictEqual(engine.pickupState(repo),{total:4,remaining:0,assigned:0,completed:true});
}

function testSpanishFillrateHeaders() {
  const rows = [
    ['SKU','Ubicación','Descripción SKU','Cant a reponer','Origen','Frecuencia de reposición','stock_origin'],
    ['10045','MDO','ROYAL CANIN MINI ADULT 3 KG','1','PDE','1:3:5:0','2'],
    ['BIO60','MDO','BOLSITAS EARTH RATED - LAVANDA X60','9','PDE','1:3:5:0','0'],
    ['11340','MDO','ROYAL CANIN GATO LIGHT 40 1.5 KG','1','PDE','1:3:5:0','3']
  ];
  const parsed = engine.parseRows(rows,[]);
  assert.strictEqual(parsed.origin,'PDE');
  assert.strictEqual(parsed.destination,'MDO');
  assert.deepStrictEqual(parsed.items.map(item=>item.codigo),['11340','10045']);
  assert.deepStrictEqual(parsed.excluded.map(item=>item.codigo),['BIO60']);
  assert.strictEqual(parsed.meta.retained_requested_units,2);
}

function testRealWorkbookWhenAvailable() {
  const source = 'C:/Users/Lazaro/Desktop/sku_ro_2026-08-21_09_08_Reposición_Paseo_del_Este_(MDO).xls';
  const padronPath = path.join(__dirname,'fixtures','padron_global.json');
  if (!fs.existsSync(source) || !fs.existsSync(padronPath)) return;
  const rawPadron = JSON.parse(fs.readFileSync(padronPath,'utf8'));
  const padron = rawPadron.padron || rawPadron;
  const workbook = XLSX.read(fs.readFileSync(source),{type:'buffer',raw:false});
  const parsed = engine.parseWorkbook(workbook,XLSX,padron);
  assert.strictEqual(parsed.origin,'PDE');
  assert.strictEqual(parsed.destination,'MDO');
  assert.strictEqual(parsed.items.length,106);
  assert.strictEqual(parsed.meta.retained_requested_units,393);
  assert.strictEqual(parsed.excluded.length,337);
  assert.strictEqual(parsed.items.filter(item=>!item.en_padron).length,0);
}

function testSpanishWorkbookWhenAvailable() {
  const source = 'C:/Users/Lazaro/Downloads/fillrate100.skulocation - 2026-08-26T104457.577.xls';
  const padronPath = path.join(__dirname,'fixtures','padron_global.json');
  if (!fs.existsSync(source) || !fs.existsSync(padronPath)) return;
  const rawPadron = JSON.parse(fs.readFileSync(padronPath,'utf8'));
  const padron = rawPadron.padron || rawPadron;
  const workbook = XLSX.read(fs.readFileSync(source),{type:'buffer',raw:false});
  const parsed = engine.parseWorkbook(workbook,XLSX,padron);
  assert.strictEqual(parsed.origin,'PDE');
  assert.strictEqual(parsed.destination,'MDO');
  assert.strictEqual(parsed.items.length,51);
  assert.strictEqual(parsed.meta.retained_requested_units,104);
  assert.strictEqual(parsed.excluded.length,361);
  assert.strictEqual(parsed.items.filter(item=>!item.en_padron).length,0);
}

function testCustomerOrderCoverageAndNoDuplicates() {
  const repo={items:[
    // La reposición y los clientes necesitan el mismo SKU: se juntan 5, no 7.
    {codigo:'A',pedido:5,pedido_reposicion:5,pedido_clientes:2,preparado:5},
    // El pedido del cliente supera a la reposición: se juntan 5, no 7.
    {codigo:'B',pedido:5,pedido_reposicion:2,pedido_clientes:5,preparado:5},
    // Producto solamente pedido por clientes; un excedente autorizado no se pierde.
    {codigo:'C',pedido:2,pedido_reposicion:0,pedido_clientes:2,preparado:3},
    // Prioridad a clientes cuando solo se consiguió una parte.
    {codigo:'D',pedido:5,pedido_reposicion:5,pedido_clientes:2,preparado:1}
  ],extras:[]};
  assert.deepStrictEqual(engine.orderTransferRows(repo),[['A',2],['B',5],['C',3],['D',1]]);
  assert.deepStrictEqual(engine.mainTransferRows(repo),[['A',3]]);
  const exported=new Map();
  [...engine.mainTransferRows(repo),...engine.orderTransferRows(repo)].forEach(([code,qty])=>exported.set(code,(exported.get(code)||0)+qty));
  repo.items.forEach(item=>assert.strictEqual(exported.get(item.codigo)||0,item.preparado,`Cantidad duplicada o perdida en ${item.codigo}`));
}

testSyntheticMacroRule();
testSpanishFillrateHeaders();
testStatusesAndExports();
testCustomerOrderCoverageAndNoDuplicates();
testRealWorkbookWhenAvailable();
testSpanishWorkbookWhenAvailable();
console.log('reposition-engine: OK');
