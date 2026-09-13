const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const component=read('analytics-360.js');
const styles=read('analytics-360.css');
const migration=read('supabase/migrations/20260912010000_analytics_360.sql');
const reservationsPage=read('reservas/index.html');
const reservationsApp=read('reservas/reservas.js');

// Public browser contract shared by root, Operations and Reservations.
assert.match(component,/global\.Analytics360=Object\.freeze\(\{mount,formatValue,version:1\}\)/);
for(const method of ['load','refresh','setModule','destroy','getFilters']){
  assert.match(component,new RegExp(`const controller=\\{[^}]*${method}`),`Missing controller method: ${method}`);
}
assert.match(component,/db\.rpc\('op_dashboard_360',\{p_modulo:module,p_filtros:payload\}\)/);
assert.match(component,/date_from:current\.dateFrom,date_to:current\.dateTo,local:current\.local\|\|null,product:current\.product\|\|null/);
assert.match(component,/ownRequest=\+\+requestId[\s\S]*ownRequest!==requestId/,'Late responses must not replace newer filters');
assert.match(component,/const current=readFilters\(\);Object\.assign\(filters,current\);\s*const ownRequest=\+\+requestId;\s*if\(current\.dateFrom/,'An invalid range must invalidate an older request before returning');
assert.match(component,/if\(current\.dateFrom[\s\S]*root\.classList\.remove\('is-loading'\)/,'Invalid ranges must clear the loading state');
assert.match(component,/lastData=null;output\.innerHTML=renderEmpty\('No se pudo calcular el panel con estos filtros\.[\s\S]*resultados anteriores se ocultaron/,'Failed filters must hide stale results');
assert.match(component,/timeZone:'America\/Montevideo'/,'Presets must use the same business timezone as the SQL range');
assert.match(component,/Date\.UTC\([\s\S]*setUTCDate/,'Preset subtraction must be calendar-based and browser-timezone independent');
assert.match(component,/a360-chart" aria-hidden="true"/,'The visual-only chart must not duplicate its accessible data');
assert.match(component,/a360-sr-only"><table><caption>/,'Trend values must have an accessible tabular equivalent');
assert.doesNotMatch(component,/Math\.max\(3,Math\.round\(value\/maximum\*100\)\)/,'Small positive bars must remain proportional');
assert.match(styles,/\.analytics-360\{/);
assert.match(styles,/--a360-muted:var\(--muted,var\(--text2,/);
assert.match(styles,/--a360-good:var\(--green,var\(--accent3,/);
assert.match(styles,/--a360-warning:var\(--yellow,var\(--accent4,/);
assert.match(styles,/--a360-danger:var\(--red,var\(--accent2,/);
assert.match(styles,/@media\(max-width:720px\)/);
assert.match(styles,/@media\(prefers-reduced-motion:reduce\)/);

// The component can be loaded without a DOM; formatting is deterministic.
const context={Intl,globalThis:{}};
context.globalThis=context;
vm.runInNewContext(component,context,{filename:'analytics-360.js'});
assert.equal(context.Analytics360.version,1);
assert.equal(context.Analytics360.formatValue(95.25,'percent'),'95,3 %');
assert.match(context.Analytics360.formatValue(48,'duration'),/2(?:,0)? días/);
assert.equal(context.Analytics360.formatValue(null,'duration'),'Sin datos');
const fixedSource=component.replace(
  'global.Analytics360=Object.freeze({mount,formatValue,version:1});',
  'global.Analytics360=Object.freeze({mount,formatValue,presetDates,mergeLocations,locationOptionsHtml,version:1});'
);
class FixedDate extends Date{
  constructor(...args){super(...(args.length?args:['2026-09-14T01:30:00Z']));}
  static now(){return new Date('2026-09-14T01:30:00Z').getTime();}
}
const timezoneContext={Intl,Date:FixedDate,globalThis:{}};timezoneContext.globalThis=timezoneContext;
vm.runInNewContext(fixedSource,timezoneContext,{filename:'analytics-360-timezone.js'});
assert.equal(JSON.stringify(timezoneContext.Analytics360.presetDates('30d')),'{"dateFrom":"2026-08-15","dateTo":"2026-09-13"}');
const historicalLocations=timezoneContext.Analytics360.mergeLocations(
  [{nombre:'Local actual',almacen:'A-1'}],
  [{nombre:'Local anterior',historical:true},{nombre:'Local actual',historical:true}]
);
assert.equal(JSON.stringify(historicalLocations),JSON.stringify([
  {nombre:'Local actual',almacen:'A-1',historical:false},
  {nombre:'Local anterior',almacen:'',historical:true}
]));
assert.match(timezoneContext.Analytics360.locationOptionsHtml(historicalLocations),/Local anterior · histórico/,'Los locales eliminados deben distinguirse sin ocultar su historial');
assert.match(component,/syncLocationOptions\(lastData\?\.scope\?\.locations\)/,'El selector debe incorporar los locales históricos devueltos por el servidor');

// Reservations is an authenticated-only consumer; public creation remains locked to its form.
assert.match(reservationsPage,/data-view="analytics"[^>]*>Análisis 360/);
assert.match(reservationsPage,/id="view-analytics"[\s\S]*id="reservations-analytics"/);
assert.match(reservationsPage,/class="tabs" role="tablist"[\s\S]*role="tab" aria-selected="true" aria-controls="view-active"[\s\S]*role="tabpanel" aria-labelledby="tab-active"/);
assert.match(reservationsApp,/x\.setAttribute\('aria-selected',String\(active\)\);x\.tabIndex=active\?0:-1/,'Changing reservation views must keep tab accessibility state in sync');
assert.match(reservationsApp,/function onTabKeydown\(event\)[\s\S]*\['ArrowLeft','ArrowRight','Home','End'\][\s\S]*showView\(next\.dataset\.view\);next\.focus\(\)/,'Roving reservation tabs must support arrow, Home and End navigation');
assert.match(reservationsApp,/document\.querySelector\('\.tabs'\)\.addEventListener\('keydown',onTabKeydown\)/);
assert.match(reservationsPage,/analytics-360\.css\?v=1[\s\S]*analytics-360\.js\?v=1/);
assert.match(reservationsApp,/window\.Analytics360\.mount\(\{[\s\S]*module:'reservas'[\s\S]*defaultRange:'all'/);
assert.match(reservationsApp,/local:isAdmin\(\)\?'':state\.actor\.local/,'Supervisors should start with all locations while employees remain restricted to their own');
assert.match(reservationsApp,/if\(state\.publicCreate&&view!=='new'\)view='new'/);
const realtimeLines=reservationsApp.split(/\r?\n/);
assert.ok(realtimeLines.some(line=>line.includes("table:'op_reservas'")&&line.includes('refreshAnalyticsRealtime()')),'Reservation changes must refresh an open analytics panel');
for(const table of ['op_reserva_items','op_reserva_eventos','op_reserva_eliminaciones']){
  assert.ok(realtimeLines.some(line=>line.includes(`table:'${table}'`)&&line.includes('refreshAnalyticsRealtime')),
    `Realtime changes in ${table} must refresh an open analytics panel`);
}

// SQL contract: every branch, uniform response and server-side authorization/filters.
assert.match(migration,/create or replace function public\.op_dashboard_360\([\s\S]*p_modulo text,[\s\S]*p_filtros jsonb default/);
for(const module of ['inventario','reposicion','recepcion','pedidos','reservas','global']){
  assert.match(migration,new RegExp(`(?:if|elsif) v_module='${module}' then`),`Missing SQL branch: ${module}`);
}
for(const key of ['version','module','title','subtitle','generated_at','filters','scope','kpis','trend','breakdowns']){
  assert.ok((migration.match(new RegExp(`'${key}'`,'g'))||[]).length>=6,`Uniform response key missing: ${key}`);
}
assert.ok((migration.match(/'key','recent'/g)||[]).length>=6,'Every module, including global, needs recent individual records');
assert.match(migration,/auth\.uid\(\) is null[\s\S]*perfiles[\s\S]*approved=true/);
assert.match(migration,/p\.role in \('admin','supervisor_general'\)/);
assert.match(migration,/if v_supervisor then[\s\S]*v_local:=[\s\S]*else[\s\S]*v_local:=nullif\(trim\(coalesce\(v_user_local/);
assert.match(migration,/with location_sources as \([\s\S]*op_inventario_sesiones[\s\S]*op_reposiciones[\s\S]*op_recepciones[\s\S]*pedidos[\s\S]*op_analytics_reservas_base/,'Los filtros deben descubrir locales en todos los históricos');
assert.match(migration,/jsonb_array_elements\(v_locations\)[\s\S]*location->>'nombre'=v_local/,'Un supervisor debe poder seleccionar un local histórico validado por el servidor');
assert.ok((migration.match(/'locations',v_locations/g)||[]).length>=6,'Cada módulo debe devolver opciones de locales actuales e históricos');
assert.match(migration,/v_from_ts[\s\S]*v_to_ts[\s\S]*America\/Montevideo/);
assert.match(migration,/v_product:=nullif/);
assert.match(migration,/location_sources as \([\s\S]*op_inventario_sesiones[\s\S]*op_reposiciones[\s\S]*op_recepciones[\s\S]*pedidos[\s\S]*op_analytics_reservas_base/,'El filtro debe reconstruir nombres de local desde todos los históricos');
assert.match(migration,/jsonb_array_elements\(v_locations\)[\s\S]*location->>'nombre'=v_local/,'Un supervisor debe poder seleccionar un local histórico validado');
assert.ok((migration.match(/'locations',v_locations/g)||[]).length>=6,'Cada módulo debe devolver las opciones de local actuales e históricas');
assert.match(migration,/revoke all on function public\.op_dashboard_360\(text,jsonb\) from public,anon;[\s\S]*grant execute[\s\S]*to authenticated/);

// Deleted reservations are unioned from their audited snapshots, including items/events.
for(const view of ['op_analytics_reservas_base','op_analytics_reserva_items_base','op_analytics_reserva_eventos_base']){
  assert.match(migration,new RegExp(`create or replace view public\\.${view}`));
}
assert.ok((migration.match(/op_reserva_eliminaciones/g)||[]).length>=3);
assert.match(migration,/jsonb_array_elements\([\s\S]*snapshot->'items'/);
assert.match(migration,/jsonb_array_elements\([\s\S]*snapshot->'events'/);
assert.match(migration,/revoke all on public\.op_analytics_reservas_base[\s\S]*from public,anon,authenticated/);

// Global product activity includes SKU that only appeared as an unplanned extra.
assert.match(migration,/repo_extras as materialized[\s\S]*public\.op_reposicion_extras/);
assert.match(migration,/rec_extras as materialized[\s\S]*public\.op_recepcion_extras/);
assert.match(migration,/union all select x\.codigo,x\.nombre,s\.created_at,s\.id,0,x\.cantidad,0,0,0 from repo_extras/);
assert.match(migration,/union all select x\.codigo,x\.nombre,s\.created_at,s\.id,0,0,x\.cantidad,0,0 from rec_extras/);

// Fulfilment is capped per SKU: an excess of A cannot conceal a shortage of B.
assert.match(migration,/sum\(least\(i\.preparado,i\.pedido_total\)\) as fulfilled/);
assert.match(migration,/sum\(least\(i\.recibido,i\.esperado\)\) as fulfilled/);
assert.match(migration,/sum\(least\(preparado,pedido_total\)\)\/sum\(pedido_total\)/);
assert.match(migration,/sum\(least\(recibido,esperado\)\)\/sum\(esperado\)/);
assert.doesNotMatch(migration,/least\(sum\((?:preparado|recibido)\),sum\((?:pedido_total|esperado)\)\)/);
assert.match(migration,/'title','Unidades contadas y diferencia por período'[\s\S]*'key','counted','label','Unidades contadas'/,'Inventory chart series must share a unit scale');
assert.match(migration,/'key','complete_rate'[\s\S]*'tone',\(select case[\s\S]*'danger'/,'Order outcome color must reflect the actual completion rate');
assert.match(migration,/'key','delivery_rate'[\s\S]*'tone',\(select case[\s\S]*'danger'/,'Reservation delivery color must reflect the actual delivery rate');
assert.doesNotMatch(migration,/'key','lead_time'[\s\S]{0,260}'value',coalesce\(/,'Missing duration cohorts must remain unavailable instead of becoming zero minutes');
assert.match(migration,/'key','controlled_lines'[\s\S]*sum\(controlled\)[\s\S]*'key','accuracy'[\s\S]*sum\(exact\)\/sum\(controlled\)/,'Reception accuracy must only use reviewed product lines');
assert.match(migration,/'key','inferred_received','label','Recepción histórica inferida'[\s\S]*'receipt_basis','label','Base de recepción'/,'Orders must expose which historic receipts were inferred');
assert.match(migration,/'signal','Pedidos con recepción inferida'[\s\S]*from order_lines where inferred_received/,'The global dashboard must disclose inferred historic receipts');
assert.doesNotMatch(migration,/max\([^\n]*(?:nombre|marca)/i,'Product labels must come from the latest operation, not the lexicographic maximum');
assert.ok((migration.match(/jsonb_agg\(to_jsonb\([^\n]* order by/g)||[]).length>=21,'Every tabular JSON aggregate must preserve its documented sort order');

// The global view must be honest about overlaps and historic data gaps.
assert.match(migration,/no se suman[\s\S]*No representa existencias[\s\S]*no es posible reconstruir stock actual/);
assert.match(migration,/pedidos antiguos[\s\S]*no tener todos los campos estructurados|campos estructurados[\s\S]*pedidos eliminados/i);

assert.equal((migration.match(/\$\$/g)||[]).length%2,0,'SQL dollar quotes must be paired');
assert.match(migration,/^[\s\S]*\nbegin;[\s\S]*commit;\s*$/);
console.log('analytics 360 contract ok');
