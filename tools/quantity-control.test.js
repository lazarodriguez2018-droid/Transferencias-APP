const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('supabase/migrations/20260824210000_control_final_cantidades.sql');
const partialMigration=read('supabase/migrations/20260912020000_reposicion_cierre_parcial.sql');
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
assert.match(repo,/Enviar \$\{prepared\} y terminar/,'Un parcial debe ofrecer una acción explícita para terminar y enviar lo juntado');
assert.match(repo,/repoMark\('\$\{code\}','cerrado_incompleto'\)/,'La acción parcial debe guardar el estado correcto');
assert.match(repo,/Controlar \$\{verificationCount\}/,'El resumen debe dar acceso visible al control final de cantidades');
assert.match(repo,/Productos controlados[\s\S]*summary\.cerrados_incompletos \+ summary\.no_encontrados/,'El KPI debe contar todos los productos cuyo control ya terminó');
assert.match(repo,/El remito y la planilla usarán estas <strong>\$\{qty\}<\/strong> unidades físicas[\s\S]*control final/,'La confirmación de excedentes debe explicar exactamente qué se enviará y revisará');
assert.match(repo,/comment === false \|\| comment == null/,'Cancelar el motivo no puede cerrar el producto accidentalmente');
assert.match(repo,/name === 'analisis'.*loadOperationsAnalytics\('reposicion'\)/,'La pestaña de análisis debe cargar el histórico de reposición');
assert.doesNotMatch(repo,/openRepoDispatch|confirmRepoDispatch|finalizeDispatch/,'La reposición no debe incluir el cierre manual de envío eliminado');
const repoExportBody=repo.match(/async function downloadRepoExport\(type\) \{([\s\S]*?)\n\}/)?.[1]||'';
assert.doesNotMatch(repoExportBody,/openRepoQuantityVerification/,'Ningún archivo de reposición debe abrir el control final');
assert.match(receipt,/openReceiptQuantityVerification\(\(\)=>closeReceptionFlow\(\)\)/,'El cierre de recepción debe verificar cargas en lote');
const receptionReportBody=receipt.match(/async function downloadReceptionReport\(\) \{([\s\S]*?)\n\}/)?.[1]||'';
const receptionTransferBody=receipt.match(/async function downloadReceiptTransfer\(type\) \{([\s\S]*?)\n\}/)?.[1]||'';
assert.doesNotMatch(receptionReportBody,/openReceiptQuantityVerification/,'El informe de recepción debe descargarse sin abrir el control final');
assert.doesNotMatch(receptionTransferBody,/openReceiptQuantityVerification/,'Los remitos de recepción deben descargarse sin abrir el control final');
const generateReportBody=inventory.match(/async function generateReport\(\) \{([\s\S]*?)\n\}/)?.[1]||'';
const analysisReportBody=inventory.match(/function exportAnalysisReport\(\) \{([\s\S]*?)\n\}/)?.[1]||'';
const countExportBody=inventory.match(/function exportConteo\(\) \{([\s\S]*?)\n\}/)?.[1]||'';
assert.doesNotMatch(generateReportBody,/openInventoryQuantityVerification/,'El reporte de stock debe generarse sin abrir el control final de cantidades');
assert.doesNotMatch(analysisReportBody,/openInventoryQuantityVerification/,'El análisis debe exportarse sin abrir el control final de cantidades');
assert.doesNotMatch(countExportBody,/openInventoryQuantityVerification/,'El conteo debe exportarse sin abrir el control final de cantidades');
assert.match(inventory,/Confirmar \$\{quantity\}/,'El modal de inventario debe mostrar la cantidad exacta');
assert.match(guest,/pending=Math\.max\(0,num\(item\?\.requested\)-current\)/,'El invitado debe calcular la cantidad pendiente');
assert.match(guest,/saveRepoQuantity\(code,current\+value\)/,'El invitado debe sumar lo pendiente sin reemplazar el total acumulado');
assert.match(guest,/guestRepoCloseIncomplete/,'El invitado debe poder cerrar una cantidad parcial sin marcarla como no encontrada');
assert.match(guest,/op_invitado_reposicion_cerrar_incompleto/,'El cierre parcial invitado debe usar una operación validada por la base');
assert.match(guest,/Cantidad mayor a la solicitada/,'El invitado debe confirmar explícitamente los excedentes');
assert.match(guest,/El remito y la planilla usarán la cantidad física confirmada, que quedará pendiente del control final/,'El invitado debe saber que el excedente se exporta y luego se verifica');
assert.match(partialMigration,/where no_encontrado and preparado>0/,'La migración debe reparar el atajo histórico');
assert.match(partialMigration,/create trigger op_reposicion_normalizar_estado[\s\S]*before insert or update/,'Los clientes antiguos deben normalizarse antes de guardar');
assert.match(partialMigration,/new\.no_encontrado:=false[\s\S]*new\.cerrado_incompleto:=true/,'Una cantidad parcial nunca debe quedar como no encontrada');
assert.match(partialMigration,/check \(not no_encontrado or preparado=0\)/,'La base debe impedir estados contradictorios');
assert.match(partialMigration,/check \(not cerrado_incompleto or \(preparado>0 and preparado<pedido_total\)\)/,'Un cierre parcial debe conservar una cantidad física estrictamente incompleta');
assert.match(partialMigration,/solicitado:=greatest\(coalesce\(new\.pedido_reposicion,0\),coalesce\(new\.pedido_clientes,0\)\)/,'El trigger BEFORE debe calcular el total sin leer prematuramente una columna generada');
assert.match(partialMigration,/update of preparado,no_encontrado,cerrado_incompleto,pedido_reposicion,pedido_clientes/,'Un pedido urgente debe volver a evaluar cualquier cierre anterior');
assert.match(partialMigration,/solicitado>solicitado_anterior[\s\S]*old\.no_encontrado[\s\S]*old\.cerrado_incompleto[\s\S]*new\.no_encontrado:=false[\s\S]*new\.cerrado_incompleto:=false/,'La demanda física nueva debe reabrir productos cerrados antes de ese pedido');
assert.match(partialMigration,/new\.cerrado_incompleto and \(new\.preparado<=0 or new\.preparado>=solicitado\)/,'Editar un cierre parcial a cero, completo o excedido debe limpiar ese estado');
assert.match(partialMigration,/r\.preparado>0[\s\S]*cierre con envío parcial/,'La API autenticada debe rechazar el atajo antiguo con un mensaje claro');
assert.match(partialMigration,/create or replace function public\.op_invitado_reposicion_cerrar_incompleto/,'La sesión QR debe tener paridad de cierre parcial');
assert.match(operationsHtml,/reposition-app\.js\?v=partial-close-v1/,'La sesión normal debe invalidar el JavaScript anterior');
assert.match(guestHtml,/invitado\.js\?v=partial-close-v1/,'La sesión QR debe invalidar el JavaScript anterior');

console.log('quantity-control: OK');
