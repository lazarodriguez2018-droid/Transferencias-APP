const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const start=source.indexOf('function buildDashboardAnalytics');
const end=source.indexOf('function renderMetricList',start);
assert.ok(start>=0&&end>start,'No se encontró el motor del dashboard de pedidos');

const context={
  el:()=>null,
  Date,
  Map,
  Math
};
vm.runInNewContext(`${source.slice(start,end)}\nthis.buildDashboardAnalytics=buildDashboardAnalytics;`,context);

const product=(quantity=1)=>({codigo:'SKU',nombre:'Producto',cantidad:quantity});
const order=(estado,hours=1,extra={})=>({
  id:`${estado}-${hours}-${Math.random()}`,
  estado,
  origen_local:'Origen',
  destino_local:'Destino',
  created_at:new Date(Date.now()-hours*3600000).toISOString(),
  pedido_productos:[product()],
  ...extra
});

let result=context.buildDashboardAnalytics([order('incompleto')],'Destino');
assert.equal(result.completedOrders,0,'Un cierre incompleto no debe contarse como completado');
assert.equal(result.riskCount,1,'Un pedido incompleto debe contarse una sola vez como riesgo');
assert.equal(result.riskOrders.length,1);

result=context.buildDashboardAnalytics(Array.from({length:12},()=>order('pendiente',30)),'Destino');
assert.equal(result.riskCount,12,'El KPI debe contar todos los pedidos demorados');
assert.equal(result.riskOrders.length,10,'La lista visual puede limitarse a los diez más importantes');

result=context.buildDashboardAnalytics([order('completo'),order('incompleto'),order('pendiente',30,{faltantes:'1 unidad'})],'Destino');
assert.equal(result.completedOrders,1);
assert.equal(result.riskCount,2,'Incompletos y demorados deben compartir un único conjunto sin duplicados');

const manyProducts=Array.from({length:14},(_,index)=>order('completo',1,{
  id:`pedido-${index}`,
  pedido_productos:[{codigo:`SKU-${index}`,nombre:`Producto ${index}`,cantidad:1}]
}));
result=context.buildDashboardAnalytics(manyProducts,'Destino');
assert.equal(result.topProducts.length,12,'La tabla visual conserva sus doce productos principales');
assert.equal(result.exportRows.length,14,'El CSV debe incluir todos los productos filtrados, no sólo el top visual');

assert.match(source,/for\(let from=0;;from\+=pageSize\)[\s\S]*\.range\(from,from\+pageSize-1\)/,'El resumen debe paginar hasta recuperar todo el rango');
assert.doesNotMatch(source,/\.limit\(2000\)/,'El histórico no debe cortarse silenciosamente en 2.000 pedidos');
assert.match(source,/dashboardDateBoundary\(desde\)[\s\S]*dashboardDateBoundary\(hasta,true\)/,'Los límites deben representar días completos de Montevideo');

// Dos lecturas pueden terminar fuera de orden. Sólo la última debe pintar la
// pantalla y reemplazar el conjunto que se exporta.
const renderStart=source.indexOf('async function renderDashboardControl');
const renderEnd=source.indexOf('function hydrateDashboardFilters',renderStart);
const delayed=[];
const renders=[];
const renderContext={
  appState:{currentPerfil:{role:'empleado',local_nombre:'Destino',almacen:'02'},dashboardRequestId:0},
  isSupervisorRole:()=>false,
  hydrateDashboardFilters:()=> 'Destino',
  safeSet:()=>{},
  fetchDashboardOrders:()=>new Promise(resolve=>delayed.push(resolve)),
  el:id=>id==='dash-filter-producto'?{value:'producto'}:id==='dash-recent'?{innerHTML:''}:null,
  tokenizeSearch:()=>[],
  orderMatchesTokens:()=>true,
  buildDashboardAnalytics:orders=>({activeOrders:0,totalUnits:0,completedOrders:0,riskCount:0,topProducts:[],localDemand:[],bufferRecommendations:[],riskOrders:[],exportRows:orders.map(row=>row.id)}),
  renderDashboardProducts:()=>renders.push('products'),
  renderDashboardLocales:()=>{},renderDashboardBuffer:()=>{},renderDashboardRisk:()=>{},
  orderCard:row=>row.id,
  window:{}
};
vm.runInNewContext(`${source.slice(renderStart,renderEnd)}\nthis.renderDashboardControl=renderDashboardControl;`,renderContext);

const first=renderContext.renderDashboardControl();
const second=renderContext.renderDashboardControl();
delayed[1]([{id:'nuevo',created_at:'2026-09-12T10:00:00Z'}]);
second.then(()=>{
  delayed[0]([{id:'viejo',created_at:'2026-09-11T10:00:00Z'}]);
});

Promise.all([first,second]).then(()=>{
  assert.deepEqual(renderContext.window.__dashboardLastRows,['nuevo'],'Una respuesta anterior no debe reemplazar el filtro más reciente');
  assert.equal(renders.length,1,'La respuesta obsoleta no debe volver a pintar el dashboard');
  assert.match(source,/function scheduleDashboardProductFilter\(\)[\s\S]*clearTimeout\(appState\.dashboardFilterTimer\)[\s\S]*setTimeout\([\s\S]*260\)/,'La búsqueda por producto debe agrupar las pulsaciones');
  assert.match(source,/dash-filter-producto[^\n]*addEventListener\('input', scheduleDashboardProductFilter\)/);
  console.log('dashboard analytics: OK');
}).catch(error=>{console.error(error);process.exitCode=1;});
