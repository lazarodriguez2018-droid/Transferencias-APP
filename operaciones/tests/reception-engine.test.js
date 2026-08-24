const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../reception-engine.js');
const exporter = require('../reposition-export.js');
const RealXLSX = require('../xlsx.full.min.js');

const page = (number, date, origin, destination, rows) => [
  [],[],['','','','','','','','','','','','Documento','','','','','','','Número'],
  ['','','','','','','','','','','','Transferencia','','','','','','',number],
  [],[],['','','','','','','','','','','','','','','','','','Fecha'],
  ['','','','','','','','','','','','','','','','','',date],
  [],[],[],[],[],
  ['', 'Almacén Salida','','','','','','','','','','','Almacén Entrada'],
  ['', origin,'','','','','','','','','','',destination],
  [],
  ['','','Código','','','Mercaderías','','','','','','','','Fábrica','','','Unidad','Cantidad','','Lote'],
  ...rows.map(row => ['', '', row.code, '', '', row.name, '', '', '', '', '', '', '', row.brand || '', '', '', '', String(row.qty).replace('.',','), '', row.lot || ''])
];

const sheets = {
  'Page 1':page('29500','19/08/2026','Centro de Distribución y Almacenaje','Bloqueo Punta del Este',[
    {code:'A',name:'ALIMENTO CACHORRO 15 KG',qty:2,brand:'MARCA'},
    {code:'B',name:'COMEDERO',qty:1}
  ]),
  'Page 2':page('29500','19/08/2026','Centro de Distribución y Almacenaje','Bloqueo Punta del Este',[
    {code:'A',name:'ALIMENTO CACHORRO 15 KG',qty:3,brand:'MARCA'},
    {code:'C',name:'CORREA',qty:4}
  ])
};
const XLSX = {utils:{sheet_to_json:sheet => sheet}};
const workbook = {SheetNames:Object.keys(sheets),Sheets:sheets};
const catalog = [{codigo:'A',nombre:'ALIMENTO COMPLETO CACHORRO 15 KG',barras:'7730001',marca:'MARCA'}];
const parsed = engine.parseWorkbook(workbook,XLSX,catalog);

assert.equal(parsed.document_number,'29500');
assert.equal(parsed.date,'2026-08-19');
assert.equal(parsed.items.length,3);
assert.equal(parsed.items.find(item=>item.codigo==='A').esperado,5,'Un SKU repetido entre páginas debe sumarse');
assert.equal(parsed.items.find(item=>item.codigo==='A').nombre,'ALIMENTO COMPLETO CACHORRO 15 KG','Debe priorizar el nombre completo del padrón');
assert.equal(parsed.meta.source_lines,4);
assert.equal(parsed.meta.expected_units,10);
assert.deepEqual(parsed.meta.missing_catalog.sort(),['B','C']);

const summary=engine.summary({items:[
  {esperado:5,recibido:5},{esperado:3,recibido:1},{esperado:2,recibido:0,no_recibido:true},{esperado:1,recibido:2}
],extras:[{cantidad:2}]});
assert.equal(summary.exactos,1);
assert.equal(summary.parciales,1);
assert.equal(summary.no_recibidos,1);
assert.equal(summary.sobrantes,1);
assert.equal(summary.extras_unidades,2);
assert.equal(summary.tiene_diferencias,true);

assert.deepEqual(engine.transferRows({items:[
  {codigo:'A',recibido:3},{codigo:'B',recibido:0},{codigo:'C',recibido:2.9}
],extras:[{codigo:'X',cantidad:4},{codigo:'Y',cantidad:0}]},'received'),[['A',3],['C',2]],
'El remito recibido debe exportar solo cantidades físicas positivas dentro del documento');
assert.deepEqual(engine.transferRows({items:[],extras:[{codigo:'X',cantidad:4},{codigo:'Y',cantidad:0}]},'extras'),[['X',4]],
'Los extras deben exportarse en un remito separado');

const template=fs.readFileSync(path.join(__dirname,'..','Plantilla Importacion Transaccion Stock.xls'));
const receivedRows=engine.transferRows({items:[{codigo:'00123',recibido:3},{codigo:'B',recibido:0}],extras:[{codigo:'X',cantidad:7}]},'received');
const transferBytes=Buffer.from(exporter.buildTransfer(template,RealXLSX,receivedRows));
assert.strictEqual(transferBytes.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1','La descarga recibida debe ser un .xls binario real');
const transferBook=RealXLSX.read(transferBytes,{type:'buffer'}),transferSheet=transferBook.Sheets[transferBook.SheetNames[0]];
assert.strictEqual(transferSheet.A2.v,'00123');
assert.strictEqual(transferSheet.B2.v,3);
assert.strictEqual(transferSheet.A3,undefined,'El archivo recibido no debe incluir productos extra ni cantidades cero');

const badSheets={...sheets,'Page 3':page('OTRO','19/08/2026','Centro de Distribución y Almacenaje','Bloqueo Punta del Este',[{code:'D',name:'D',qty:1}])};
assert.throws(()=>engine.parseWorkbook({SheetNames:Object.keys(badSheets),Sheets:badSheets},XLSX,catalog),/otro remito/i);
console.log('reception-engine: OK');
