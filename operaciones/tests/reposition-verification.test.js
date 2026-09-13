const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const engine=require('../reposition-engine.js');

const source=fs.readFileSync(path.join(__dirname,'..','reposition-app.js'),'utf8');
const start=source.indexOf('async function confirmRepoQuantityVerification()');
assert.ok(start>=0,'Debe existir el control final de cantidades');
const functionSource=source.slice(start);
const input={value:'4'};
const button={disabled:false,textContent:'Confirmar y continuar'};
const confirmations=[];
const requests=[];
let allowExcess=false;
const context={
  window:{_repoVerificationCode:encodeURIComponent('SKU-1')},
  document:{
    getElementById:id=>id==='repo-verification-qty'?input:null,
    querySelector:selector=>selector==='#modal-actions .btn-p'?button:null
  },
  repoState:{items:[{codigo:'SKU-1',nombre:'Producto',pedido:3,preparado:3,requiere_verificacion:true}]},
  repoDecoded:decodeURIComponent,
  appConfirm:async options=>{confirmations.push(options);return allowExcess;},
  waitForOperationsDialogHistory:async()=>{},
  esc:value=>String(value),
  toast:()=>{},
  sessionId:'repo-1',
  repoApi:async (url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>({ok:true,item:{codigo:'SKU-1',nombre:'Producto',pedido:3,preparado:4,requiere_verificacion:false}})};
  },
  repoHydrateItemFromCatalog:item=>item,
  renderRepositionAll:()=>{},
  tactileFeedback:()=>{},
  repoVerificationItems:()=>[],
  repoVerificationContinuation:null,
  closeModal:()=>{},
  openRepoQuantityVerification:()=>{},
  setTimeout
};
vm.runInNewContext(`${functionSource}\nthis.confirmRepoQuantityVerification=confirmRepoQuantityVerification;`,context);

(async()=>{
  await context.confirmRepoQuantityVerification();
  assert.equal(requests.length,0,'Cancelar el excedente no debe enviar ninguna modificación');
  assert.equal(button.disabled,false,'Cancelar debe dejar disponible el control final');
  assert.match(confirmations[0].confirmText,/Enviar 4 unidades/);
  assert.match(confirmations[0].bodyHtml,/marcado como excedido/);

  allowExcess=true;
  await context.confirmRepoQuantityVerification();
  assert.equal(requests.length,1,'Confirmar el excedente debe enviar una sola modificación');
  assert.equal(requests[0].url,'/api/reposicion/verify_qty');
  assert.deepEqual(JSON.parse(requests[0].options.body),{reposition_id:'repo-1',codigo:'SKU-1',cantidad:4});
  assert.equal(engine.status(context.repoState.items[0]),'excedido','La cantidad confirmada debe quedar en estado excedido');
  console.log('reposition-verification: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
