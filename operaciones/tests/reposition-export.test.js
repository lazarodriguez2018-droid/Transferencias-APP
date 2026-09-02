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

const sourceBook=XLSX.utils.book_new();
const sourceSheet=XLSX.utils.aoa_to_sheet([
  ['sku','location','description','qty_replenishment','origin','day_to_replenish','stock_origin','Calculo stock'],
  ['00123','MDO','Zeta producto',10,'PDE','1:4:0:0',20,null],
  ['B2','MDO','Alfa producto',2,'PDE','1:4:0:0',4,null],
  ['EXCLUIDO','MDO','No cumple regla',5,'PDE','1:4:0:0',5,null]
]);
sourceSheet.H2={t:'n',v:10,f:'+G2-D2'};sourceSheet.H3={t:'n',v:2,f:'+G3-D3'};sourceSheet.H4={t:'n',v:0,f:'+G4-D4'};
sourceSheet['!cols']=[{wch:16},{wch:10},{wch:42},{wch:18},{wch:10},{wch:18},{wch:14},{wch:15}];
sourceSheet['!autofilter']={ref:'A1:H4'};
XLSX.utils.book_append_sheet(sourceBook,sourceSheet,'Rep FR100');
const sourceBytes=XLSX.write(sourceBook,{bookType:'biff8',type:'array',cellStyles:true});
const processed=XLSX.read(exporter.buildProcessedSource(sourceBytes,XLSX,repo,engine,'xlsx'),{type:'array',cellStyles:true,cellFormula:true});
const processedSheet=processed.Sheets['Rep FR100'];
assert.strictEqual(processedSheet['!ref'],'A1:H3','Solo deben quedar encabezado y productos que cumplieron la regla');
assert.strictEqual(processedSheet.A2.v,'B2','Los productos deben ordenarse alfabéticamente por descripción');
assert.strictEqual(processedSheet.A3.v,'00123');
assert.strictEqual(processedSheet.H2.f,'+G2-D2','La fórmula debe conservarse y apuntar a la nueva fila');
assert.strictEqual(processedSheet.H3.f,'+G3-D3','Las fórmulas deben reindexarse tras filtrar filas');
assert.strictEqual(processedSheet.H2.v,2);
assert.strictEqual(processedSheet['!cols'][1].hidden,true,'La columna auxiliar location debe quedar agrupada y oculta');
assert.strictEqual(processedSheet['!cols'][4].level,1,'Las columnas auxiliares deben conservarse dentro de un grupo');
assert.strictEqual(processedSheet['!cols'][5].hidden,true,'day_to_replenish no debe eliminarse');
assert.strictEqual(processedSheet['!cols'][6].hidden,true,'stock_origin debe conservarse, pero oculto');
const exporterSource=fs.readFileSync(path.join(__dirname,'..','reposition-export.js'),'utf8');
assert.match(exporterSource,/fgColor rgb=\\?"FFFFFF00/,'El reporte debe aplicar amarillo a las filas juntadas');
assert.match(exporterSource,/highlightedRows\.push\(newRow\+1\)/,'El resaltado debe abarcar cualquier fila con cantidad juntada');
assert.match(exporterSource,/tableBorder=.*border.*left style=\\?"thin/,'Toda la tabla resultante debe tener bordes');
assert.match(exporterSource,/localeCompare\(rightValue,'es'/,'La planilla debe ordenarse alfabéticamente');

console.log('reposition-export: OK');
