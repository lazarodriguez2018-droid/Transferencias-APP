const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..','..');
const source=fs.readFileSync(path.join(root,'operaciones','operations-analytics.js'),'utf8');
function mockRoot(){
  const root={nodeType:1,innerHTML:'',retry:null};
  root.querySelector=selector=>selector==='[data-a360-retry]'&&root.innerHTML.includes('data-a360-retry')
    ?{addEventListener:(event,handler)=>{if(event==='click')root.retry=handler;}}
    :null;
  return root;
}
const roots={
  'analytics-360-directory':mockRoot(),
  'analytics-360-inventario':mockRoot(),
  'analytics-360-reposicion':mockRoot(),
  'analytics-360-recepcion':mockRoot()
};
const calls={mount:[],load:[],refresh:[],setModule:[]};
const notices=[];
const loggedErrors=[];
let supervisor=false;
let failLocations=false;
const cloud={
  ready:Promise.resolve(),
  db:{from:()=>({select:()=>({order:async()=>failLocations?{data:null,error:new Error('sin conexión')}:{data:[],error:null}})})},
  profile:{local_nombre:'Local prueba'},
  isSupervisor:()=>supervisor
};
const context={
  console:{...console,error:error=>loggedErrors.push(error)},
  URLSearchParams,
  location:{search:'?module=inventario'},
  document:{getElementById:id=>roots[id]||null},
  toast:(message,type)=>notices.push({message,type}),
  SucanCloud:cloud,
  Analytics360:{mount:options=>{
    calls.mount.push({root:options.root,module:options.module});
    return {
      load:async()=>{calls.load.push(options.module);return options.module;},
      refresh:async()=>{calls.refresh.push(options.module);return options.module;},
      setModule:async module=>{calls.setModule.push(module);return module;},
      destroy:()=>{}
    };
  }}
};
context.window=context;
vm.runInNewContext(source,context,{filename:'operations-analytics.js'});

(async()=>{
  await context.loadOperationsDirectoryAnalytics('inventario');
  await context.loadOperationsDirectoryAnalytics('reposicion');
  await context.loadOperationsDirectoryAnalytics('inventario');
  assert.equal(calls.mount.filter(call=>call.root===roots['analytics-360-directory']).length,1,'El directorio compartido debe montar un solo controlador');
  assert.deepEqual(calls.setModule,['reposicion','inventario'],'Al volver de módulo debe actualizar el controlador visible, no recuperar uno desconectado');

  await context.loadOperationsAnalytics('inventario');
  await context.loadOperationsAnalytics('inventario');
  assert.equal(calls.mount.filter(call=>call.root===roots['analytics-360-inventario']).length,1,'Cada pestaña de módulo se monta una sola vez');
  assert.equal(calls.refresh.length,1,'Volver a la misma pestaña debe refrescar sus datos');

  supervisor=true;
  failLocations=true;
  const failed=await context.loadOperationsAnalytics('recepcion');
  assert.equal(failed,null,'Una falla inicial debe resolverse sin dejar una promesa rechazada');
  assert.match(roots['analytics-360-recepcion'].innerHTML,/No se pudo cargar/,'Debe mostrar un estado de error visible');
  assert.equal(typeof roots['analytics-360-recepcion'].retry,'function','Debe ofrecer una acción para reintentar');
  assert.equal(notices.at(-1)?.type,'e','Debe informar el error con el sistema de avisos');
  assert.equal(loggedErrors.length,1,'Debe conservar el diagnóstico técnico sin rechazar la promesa');
  failLocations=false;
  await roots['analytics-360-recepcion'].retry();
  assert.equal(calls.mount.filter(call=>call.root===roots['analytics-360-recepcion']).length,1,'El reintento debe montar el análisis cuando vuelve la conexión');
  console.log('operations analytics integration: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
