const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('supabase/migrations/20260824210000_control_final_cantidades.sql');
const cloud=read('operaciones/cloud-api.js');
const repo=read('operaciones/reposition-app.js');
const receipt=read('operaciones/reception-app.js');
const inventory=read('operaciones/app.js');
const guest=read('operaciones/invitado.js');
const operationsHtml=read('operaciones/index.html');
const guestHtml=read('operaciones/invitado.html');

function quantityRule(previous,next,alreadyPending=false,verified=false){
  if(verified)return false;
  if(next<=1)return false;
  if(next!==previous&&next>1)return true;
  return alreadyPending;
}

const pendingToGather=(requested,prepared)=>Math.max(0,requested-prepared);

assert.equal(quantityRule(0,1),false,'Una lectura unitaria debe continuar sin pasos extra');
assert.equal(quantityRule(0,2),true,'Registrar dos unidades juntas debe requerir control final');
assert.equal(quantityRule(0,5),true,'El botón +5 debe requerir control final');
assert.equal(quantityRule(1,2),true,'La segunda unidad debe activar un único control final sin interrumpir la recolección');
assert.equal(quantityRule(2,3,true),true,'Una carga en lote pendiente no puede perder su marca por sumar una unidad');
assert.equal(quantityRule(2,1,true,true),false,'La comprobación debe poder corregir de dos a una unidad');
assert.equal(pendingToGather(5,0),5,'Encontrado debe proponer las cinco unidades pendientes');
assert.equal(pendingToGather(5,2),3,'Encontrado debe descontar lo que ya fue juntado');
assert.equal(pendingToGather(5,5),0,'Un producto completo no debe proponer unidades adicionales');

// Caso real informado: el sistema decía 2, pero físicamente viajó 1.
let wipes={sku:'60100001',recorded:0,requiresReview:false};
wipes.requiresReview=quantityRule(wipes.recorded,2,wipes.requiresReview);wipes.recorded=2;
assert.equal(wipes.requiresReview,true,'TOALLITAS M-PETS 60100001 debe quedar detenida para revisión si se cargan 2 juntas');
wipes.recorded=1;wipes.requiresReview=quantityRule(2,1,true,true);
assert.deepStrictEqual(wipes,{sku:'60100001',recorded:1,requiresReview:false});

assert.match(migration,/op_detectar_cantidad_en_lote/);
assert.match(migration,/op_reposicion_control_cierre/);
assert.match(migration,/op_recepcion_control_cierre/);
assert.match(migration,/Falta confirmar la cantidad física/);
assert.match(migration,/op_verificar_reposicion_cantidad/);
assert.match(migration,/op_verificar_recepcion_cantidad/);
assert.match(migration,/op_verificar_inventario_cantidad/);

assert.match(cloud,/selectDirectoryDetail[\s\S]*Las sesiones igualmente permanecerán disponibles/,'Un resumen auxiliar no debe ocultar las reposiciones');
assert.match(cloud,/summary_available:itemsResult\.available&&extrasResult\.available/);
assert.match(repo,/const suggested = Math\.max\(0, Number\(item\.pedido \|\| 0\) - Number\(item\.preparado \|\| 0\)\)/,'Encontrado debe comenzar con la cantidad pendiente');
assert.match(repo,/que es lo que falta juntar/,'El modal debe explicar el valor propuesto');
assert.doesNotMatch(repo,/openRepoDispatch|confirmRepoDispatch|finalizeDispatch/,'La reposición no debe incluir el cierre manual de envío eliminado');
assert.match(repo,/\['main','orders','summary','package'\]/,'Los archivos de salida deben usar cantidades verificadas');
assert.match(receipt,/openReceiptQuantityVerification\(\(\)=>closeReceptionFlow\(\)\)/,'El cierre de recepción debe verificar cargas en lote');
assert.match(receipt,/type==='received'&&receiptVerificationItems/,'El remito recibido debe usar cantidades verificadas');
assert.match(inventory,/openInventoryQuantityVerification\(\(\)=>generateReport\(\)\)/,'El informe de inventario debe revisar cargas en lote');
assert.match(inventory,/Confirmar \$\{quantity\}/,'El modal de inventario debe mostrar la cantidad exacta');
assert.match(guest,/pending=Math\.max\(0,num\(item\?\.requested\)-current\)/,'El invitado debe calcular la cantidad pendiente');
assert.match(guest,/saveRepoQuantity\(code,current\+value\)/,'El invitado debe sumar lo pendiente sin reemplazar el total acumulado');
assert.match(operationsHtml,/reposition-app\.js\?v=pending-found-v2/,'La sesión normal debe invalidar el JavaScript anterior');
assert.match(guestHtml,/invitado\.js\?v=guest-repo-v3/,'La sesión QR debe invalidar el JavaScript anterior');

console.log('quantity-control: OK');
