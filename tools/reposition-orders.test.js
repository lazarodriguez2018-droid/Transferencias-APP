const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'operaciones/reposition-orders.js'),'utf8');
const api=require('../operaciones/reposition-orders.js');
const order={id:'00000000-0000-0000-0000-000123456700',cliente:'Prueba',estado:'aceptado',reposicion_id:'repo',products:[{id:'line',solicitada:2,aceptada:1,preparada:0}]};
assert.equal(api.code(order.id),'234567');assert.equal(api.stateLabel(order),'En preparación');
assert.deepEqual(api.quantities(order),{requested:1,prepared:0});
assert.equal(api.transition(undefined,{...order,estado:'listo'}),'');
assert.match(api.transition(order,{...order,estado:'listo'}),/listo para enviar/);
assert.match(api.transition({...order,estado:'listo'},order),/faltan unidades/);
assert.equal(api.html('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
assert.throws(()=>api.validateQuantities(order,[{id:'line',cantidad:0}]),/al menos/);
for(const value of [-1,3,1.5,NaN])assert.throws(()=>api.validateQuantities(order,[{id:'line',cantidad:value}]),/enteras/);
assert.throws(()=>api.validateQuantities(order,[{id:'wrong',cantidad:1}]),/enteras/);
assert.deepEqual(api.validateQuantities(order,[{id:'line',cantidad:1}]),[{id:'line',cantidad:1}]);
async function testRefresh(){
 const host={},messages=[],requests=[];
 const window={document:{getElementById:()=>host},console:{warn(){}}};vm.runInNewContext(source,{window});
 const control=window.SucanRepositionOrders.create({context:{id:'repo',origin:'PDE',destination:'MDO'},hosts:['panel'],load:()=>new Promise(resolve=>requests.push(resolve)),notify:message=>messages.push(message)});
 const initial=control.refresh();requests.shift()({orders:[order],can_accept:true});await initial;
 const old=control.refresh(),latest=control.refresh();
 requests.pop()({orders:[{...order,estado:'listo'}],can_accept:true});assert.equal((await latest).announced,true);
 requests.shift()({orders:[order],can_accept:true});await old;assert.equal(messages.length,1,'Stale response must not regress ready status');
 const repeat=control.refresh();requests.shift()({orders:[{...order,estado:'listo'}],can_accept:true});assert.equal((await repeat).announced,false);
 const correction=control.refresh();requests.shift()({orders:[order],can_accept:true});assert.equal((await correction).announced,true);
 const late=control.refresh();control.destroy();const before=host.innerHTML;requests.shift()({orders:[]});await late;assert.equal(host.innerHTML,before,'Disposed session must not rerender');
}
for(const f of ['operaciones/reposition-orders.js','operaciones/invitado.js','operaciones/reposition-app.js','operaciones/cloud-api.js'])new vm.Script(fs.readFileSync(path.join(root,f),'utf8'),{filename:f});
testRefresh().then(()=>console.log('reposition-orders: OK — validation, escaping, notifications, response ordering, lifecycle and syntax')).catch(e=>{console.error(e);process.exitCode=1;});
