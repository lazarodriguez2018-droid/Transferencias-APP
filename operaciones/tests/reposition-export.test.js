const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('../xlsx.full.min.js');
const engine = require('../reposition-engine.js');
const exporter = require('../reposition-export.js');

const template = fs.readFileSync(path.join(__dirname,'..','Plantilla Importacion Transaccion Stock.xls'));
const transfer = exporter.buildTransfer(template,XLSX,[['00123',7],['ABC-9',2]]);
const bytes = Buffer.from(transfer);
assert.strictEqual(bytes.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1','Debe ser un .xls binario real');
const transferBook = XLSX.read(bytes,{type:'buffer',cellStyles:true});
const transferSheet = transferBook.Sheets[transferBook.SheetNames[0]];
assert.strictEqual(transferBook.SheetNames[0],'Importar Stock Excel');
assert.strictEqual(transferSheet.A1.v,'CODIGO');
assert.strictEqual(transferSheet.B1.v,'REMITO TRANSFERENCIA');
assert.strictEqual(transferSheet.A2.t,'s');
assert.strictEqual(transferSheet.A2.v,'00123');
assert.strictEqual(transferSheet.B2.t,'n');
assert.strictEqual(transferSheet.B2.v,7);
assert.strictEqual(transferSheet.A3.v,'ABC-9');

const repo = {
  nombre:'Prueba',origin:'PDE',destination:'MDO',created_at:'2026-08-21',updated_at:'2026-08-21',
  participantes:[{nombre:'Ana'}],
  items:[
    {codigo:'00123',nombre:'Producto uno',descripcion_archivo:'Product one',pedido:10,stock_origen:20,preparado:7,no_encontrado:true,motivo_codigo:'otro',motivo_label:'Otro',motivo_otro:'Caja sin identificar',comentario:'Revisar con depósito',updated_by:'Ana',updated_at:'2026-08-21'},
    {codigo:'B2',nombre:'Producto dos',descripcion_archivo:'Product two',pedido:2,stock_origen:4,preparado:2,updated_by:'Luis',updated_at:'2026-08-21'}
  ],
  extras:[{codigo:'00123',nombre:'Producto uno',cantidad:3,nota:'Separado',updated_by:'Ana',updated_at:'2026-08-21'}],
  log:[{ts:'2026-08-21',usuario:'Ana',accion:'cantidad',codigo:'00123',detalle:{despues:7}}]
};
const missing = XLSX.read(exporter.buildMissing(repo,XLSX,engine),{type:'array'});
assert.deepStrictEqual(missing.SheetNames,['Faltantes']);
assert.strictEqual(missing.Sheets.Faltantes.A2.v,'00123');
assert.strictEqual(missing.Sheets.Faltantes.E2.v,3);
assert.strictEqual(missing.Sheets.Faltantes.G2.v,'Otro');
assert.strictEqual(missing.Sheets.Faltantes.H2.v,'Caja sin identificar');
assert.strictEqual(missing.Sheets.Faltantes.I2.v,'Revisar con depósito');
const summary = XLSX.read(exporter.buildSummary(repo,XLSX,engine),{type:'array'});
assert.deepStrictEqual(summary.SheetNames,['Resumen','Detalle','Extras','Auditoria']);
assert.strictEqual(summary.Sheets.Detalle.A2.v,'00123');
assert.strictEqual(summary.Sheets.Extras.A2.v,'00123');

console.log('reposition-export: OK');
