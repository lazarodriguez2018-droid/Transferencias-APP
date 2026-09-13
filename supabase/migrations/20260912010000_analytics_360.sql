-- Indicadores históricos y comparables para todos los módulos operativos.
-- Las vistas auxiliares permanecen privadas. El único punto de lectura para
-- el cliente es op_dashboard_360, que vuelve a aplicar alcance por rol/local.

begin;

create or replace view public.op_analytics_reservas_base as
select
  r.id,r.local_nombre,r.estado,r.finalidad,r.entrega_tipo,r.final_tipo,
  r.responsable_nombre,r.created_by_name,r.created_at,r.updated_at,r.completed_at,
  false as deleted,null::timestamptz as deleted_at
from public.op_reservas r
union all
select
  e.reserva_id,
  e.local_nombre,
  coalesce(nullif(e.snapshot->'reservation'->>'estado',''),'eliminada'),
  coalesce(nullif(e.snapshot->'reservation'->>'finalidad',''),'otro'),
  nullif(e.snapshot->'reservation'->>'entrega_tipo',''),
  nullif(e.snapshot->'reservation'->>'final_tipo',''),
  nullif(e.snapshot->'reservation'->>'responsable_nombre',''),
  nullif(e.snapshot->'reservation'->>'created_by_name',''),
  coalesce(nullif(e.snapshot->'reservation'->>'created_at','')::timestamptz,e.created_at),
  coalesce(nullif(e.snapshot->'reservation'->>'updated_at','')::timestamptz,e.created_at),
  nullif(e.snapshot->'reservation'->>'completed_at','')::timestamptz,
  true,e.created_at
from public.op_reserva_eliminaciones e;

create or replace view public.op_analytics_reserva_items_base as
select
  i.reserva_id,i.codigo,i.nombre,i.cantidad,i.cantidad_local,i.cantidad_entregada,
  i.procedencia,i.pedido_id,i.reposicion_id,i.recepcion_id,false as deleted
from public.op_reserva_items i
union all
select
  e.reserva_id,
  coalesce(nullif(x.item->>'codigo',''),'SIN-CODIGO'),
  coalesce(nullif(x.item->>'nombre',''),nullif(x.item->>'codigo',''),'Producto'),
  coalesce(nullif(x.item->>'cantidad','')::integer,0),
  coalesce(nullif(x.item->>'cantidad_local','')::integer,0),
  coalesce(nullif(x.item->>'cantidad_entregada','')::integer,0),
  coalesce(nullif(x.item->>'procedencia',''),'otro'),
  nullif(x.item->>'pedido_id','')::uuid,
  nullif(x.item->>'reposicion_id','')::uuid,
  nullif(x.item->>'recepcion_id','')::uuid,
  true
from public.op_reserva_eliminaciones e
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(e.snapshot->'items')='array' then e.snapshot->'items' else '[]'::jsonb end
) x(item);

create or replace view public.op_analytics_reserva_eventos_base as
select e.reserva_id,e.accion,e.estado,e.created_at,false as deleted
from public.op_reserva_eventos e
union all
select
  d.reserva_id,
  coalesce(nullif(x.evento->>'accion',''),'evento'),
  nullif(x.evento->>'estado',''),
  coalesce(nullif(x.evento->>'created_at','')::timestamptz,d.created_at),
  true
from public.op_reserva_eliminaciones d
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(d.snapshot->'events')='array' then d.snapshot->'events' else '[]'::jsonb end
) x(evento);

revoke all on public.op_analytics_reservas_base,
  public.op_analytics_reserva_items_base,
  public.op_analytics_reserva_eventos_base
from public,anon,authenticated;

create index if not exists op_inventory_analytics_scope_idx
  on public.op_inventario_sesiones(local_nombre,created_at,id);
create index if not exists op_reposition_analytics_scope_idx
  on public.op_reposiciones(origen_local,destino_local,created_at,id);
create index if not exists op_reception_analytics_scope_idx
  on public.op_recepciones(origen_local,destino_local,created_at,id);
create index if not exists orders_analytics_scope_idx
  on public.pedidos(origen_local,destino_local,created_at,id);
create index if not exists orders_analytics_scale_idx
  on public.pedidos(escala_local,created_at,id) where escala_local is not null;
create index if not exists order_history_analytics_idx
  on public.pedido_historial(pedido_id,created_at);
create index if not exists reservations_analytics_scope_idx
  on public.op_reservas(local_nombre,created_at,id);

create or replace function public.op_dashboard_360(
  p_modulo text,
  p_filtros jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer
set search_path=public,pg_temp
as $$
declare
  v_filters jsonb:=coalesce(p_filtros,'{}'::jsonb);
  v_module text:=lower(trim(coalesce(p_modulo,'')));
  v_role text;
  v_user_local text;
  v_supervisor boolean:=false;
  v_local text;
  v_product text;
  v_from date;
  v_to date;
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_grain text:='month';
  v_locations jsonb:='[]'::jsonb;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión para consultar Análisis 360'; end if;
  select p.role,p.local_nombre,p.role in ('admin','supervisor_general')
    into v_role,v_user_local,v_supervisor
  from public.perfiles p where p.id=auth.uid() and p.approved=true;
  if v_role is null then raise exception 'Tu cuenta no está habilitada'; end if;
  if v_module not in ('global','inventario','reposicion','recepcion','pedidos','reservas') then
    raise exception 'Módulo de análisis inválido';
  end if;
  if jsonb_typeof(v_filters)<>'object' or pg_column_size(v_filters)>12000 then
    raise exception 'Filtros inválidos';
  end if;

  if nullif(trim(v_filters->>'date_from'),'') is not null then v_from:=(v_filters->>'date_from')::date; end if;
  if nullif(trim(v_filters->>'date_to'),'') is not null then v_to:=(v_filters->>'date_to')::date; end if;
  if v_from is not null and v_to is not null and v_from>v_to then
    raise exception 'La fecha inicial debe ser anterior a la final';
  end if;
  if v_from is not null then v_from_ts:=v_from::timestamp at time zone 'America/Montevideo'; end if;
  if v_to is not null then v_to_ts:=(v_to+1)::timestamp at time zone 'America/Montevideo'; end if;
  if v_from is not null and v_to is not null then
    v_grain:=case when v_to-v_from<=45 then 'day' when v_to-v_from<=210 then 'week' else 'month' end;
  end if;

  v_product:=nullif(left(trim(coalesce(v_filters->>'product','')),100),'');
  if v_supervisor then
    -- Los procesos conservan el nombre del local como snapshot. También deben
    -- poder filtrarse los locales eliminados o renombrados del catálogo actual.
    with location_sources as (
      select l.nombre,null::text as module from public.locales l
      union all select s.local_nombre,'inventario' from public.op_inventario_sesiones s
      union all select r.origen_local,'reposicion' from public.op_reposiciones r
      union all select r.destino_local,'reposicion' from public.op_reposiciones r
      union all select r.origen_local,'recepcion' from public.op_recepciones r
      union all select r.destino_local,'recepcion' from public.op_recepciones r
      union all select p.origen_local,'pedidos' from public.pedidos p
      union all select p.destino_local,'pedidos' from public.pedidos p
      union all select p.escala_local,'pedidos' from public.pedidos p
      union all select r.local_nombre,'reservas' from public.op_analytics_reservas_base r
    ), names as (
      select distinct trim(s.nombre) as nombre
      from location_sources s
      where nullif(trim(s.nombre),'') is not null
        and (s.module is null or v_module='global' or s.module=v_module)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'nombre',n.nombre,
      'almacen',coalesce(l.almacen,''),
      'historical',l.nombre is null
    ) order by lower(n.nombre),n.nombre),'[]'::jsonb)
    into v_locations
    from names n left join public.locales l on l.nombre=n.nombre;

    v_local:=nullif(left(trim(coalesce(v_filters->>'local','')),120),'');
    if v_local is not null and not exists(
      select 1 from jsonb_array_elements(v_locations) location
      where location->>'nombre'=v_local
    ) then
      raise exception 'El local seleccionado no existe';
    end if;
  else
    v_local:=nullif(trim(coalesce(v_user_local,'')),'');
    if v_local is null then raise exception 'Tu cuenta no tiene un local asignado'; end if;
    v_locations:=jsonb_build_array(jsonb_build_object('nombre',v_local,'almacen','','historical',false));
  end if;

  if v_module='inventario' then
    with sessions as materialized (
      select s.*
      from public.op_inventario_sesiones s
      where (v_supervisor or s.local_nombre=v_user_local)
        and (v_local is null or s.local_nombre=v_local)
        and (v_from_ts is null or s.created_at>=v_from_ts)
        and (v_to_ts is null or s.created_at<v_to_ts)
        and (v_product is null or exists(
          select 1 from public.op_busqueda_productos_base p
          where p.modulo='inventario' and p.sesion_id=s.id
            and public.op_busqueda_coincide(p.texto,v_product)
        ))
    ), lines as materialized (
      select p.*
      from public.op_busqueda_productos_base p
      join sessions s on s.id=p.sesion_id
      where p.modulo='inventario'
        and (v_product is null or public.op_busqueda_coincide(p.texto,v_product))
    ), per_session as materialized (
      select s.id,s.local_nombre,s.created_at,s.estado,
        count(l.codigo) as products,
        coalesce(sum(l.cantidad),0) as counted,
        count(l.codigo) filter(where l.esperado is not null) as compared,
        count(l.codigo) filter(where l.esperado is not null and l.cantidad=l.esperado) as exact,
        coalesce(sum(abs(l.cantidad-l.esperado)) filter(where l.esperado is not null),0) as absolute_difference,
        coalesce(sum(l.cantidad-l.esperado) filter(where l.esperado is not null),0) as net_difference
      from sessions s left join lines l on l.sesion_id=s.id
      group by s.id,s.local_nombre,s.created_at,s.estado
    ), trend_rows as (
      select date_trunc(v_grain,p.created_at at time zone 'America/Montevideo')::date as period,
        count(*) as sessions,sum(p.counted) as counted,sum(p.absolute_difference) as differences
      from per_session p group by 1 order by 1
    ), product_rows as (
      select l.codigo,(array_agg(l.nombre order by s.created_at desc,s.id desc))[1] as product,count(distinct l.sesion_id) as sessions,
        sum(l.esperado) as system_units,sum(l.cantidad) as counted_units,
        sum(abs(l.cantidad-l.esperado)) as absolute_difference
      from lines l join sessions s on s.id=l.sesion_id where l.esperado is not null and l.cantidad<>l.esperado
      group by l.codigo order by absolute_difference desc,sessions desc,product limit 12
    ), local_rows as (
      select p.local_nombre as local,count(*) as sessions,sum(p.compared) as compared,
        case when sum(p.compared)>0 then round(100.0*sum(p.exact)/sum(p.compared),1) end as accuracy,
        sum(p.absolute_difference) as absolute_difference
      from per_session p group by p.local_nombre order by absolute_difference desc,local limit 20
    ), method_rows as (
      select t.key as method,sum(case when t.value~'^-?[0-9]+$' then t.value::bigint else 0 end) as units
      from public.op_inventario_items i join sessions s on s.id=i.sesion_id
      cross join lateral jsonb_each_text(coalesce(i.tipos,'{}'::jsonb)) t
      where v_product is null or exists(select 1 from lines l where l.sesion_id=i.sesion_id and l.codigo=i.codigo)
      group by t.key order by units desc,t.key limit 12
    )
    select jsonb_build_object(
      'version',1,'module','inventario','title','Inventarios · visión histórica',
      'subtitle','Conteos físicos, cobertura de balance y diferencias acumuladas por sesión.',
      'generated_at',now(),
      'filters',jsonb_build_object('date_from',v_from,'date_to',v_to,'local',v_local,'product',v_product,'granularity',v_grain),
      'scope',jsonb_build_object('supervisor',v_supervisor,'local',v_user_local,'locations',v_locations),
      'kpis',jsonb_build_array(
        jsonb_build_object('key','sessions','label','Sesiones','value',(select count(*) from per_session),'format','number','tone','info','hint','Inventarios iniciados en el período'),
        jsonb_build_object('key','counted','label','Unidades contadas','value',coalesce((select sum(counted) from per_session),0),'format','number','hint','Suma histórica de conteos; no es stock actual'),
        jsonb_build_object('key','products','label','Líneas controladas','value',coalesce((select sum(products) from per_session),0),'format','number'),
        jsonb_build_object('key','balanced_sessions','label','Con balance','value',(select count(*) from sessions s where exists(select 1 from public.op_inventario_balances b where b.sesion_id=s.id)),'format','number','hint','Sesiones que permiten comparar sistema contra físico'),
        jsonb_build_object('key','accuracy','label','Exactitud por SKU','value',(select case when sum(compared)>0 then round(100.0*sum(exact)/sum(compared),1) end from per_session),'format','percent','tone',(select case when coalesce(sum(compared),0)=0 then 'info' when 100.0*sum(exact)/sum(compared)>=95 then 'good' when 100.0*sum(exact)/sum(compared)>=80 then 'warning' else 'danger' end from per_session)),
        jsonb_build_object('key','absolute_difference','label','Diferencia absoluta','value',coalesce((select sum(absolute_difference) from per_session),0),'format','number','tone','warning','hint','Unidades de desvío sin compensar faltantes con sobrantes'),
        jsonb_build_object('key','net_difference','label','Diferencia neta','value',coalesce((select sum(net_difference) from per_session),0),'format','number','hint','Sobrantes menos faltantes'),
        jsonb_build_object('key','open','label','Sesiones abiertas','value',(select count(*) from per_session where estado='abierta'),'format','number','tone','warning')
      ),
      'trend',jsonb_build_object(
        'title','Unidades contadas y diferencia por período',
        'series',jsonb_build_array(
          jsonb_build_object('key','counted','label','Unidades contadas','format','number'),
          jsonb_build_object('key','differences','label','Diferencia absoluta','format','number')
        ),
        'points',coalesce((select jsonb_agg(jsonb_build_object(
          'period',period,'label',case when v_grain='month' then to_char(period,'MM/YYYY') else to_char(period,'DD/MM') end,
          'sessions',sessions,'differences',differences,'counted',counted
        ) order by period) from trend_rows),'[]'::jsonb)
      ),
      'breakdowns',jsonb_build_array(
        jsonb_build_object('key','products','title','SKU con diferencias recurrentes','description','Prioriza el desvío absoluto acumulado; una misma unidad puede aparecer en distintas sesiones.',
          'columns',jsonb_build_array(
            jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),
            jsonb_build_object('key','sessions','label','Sesiones','format','number'),jsonb_build_object('key','system_units','label','Sistema','format','number'),
            jsonb_build_object('key','counted_units','label','Físico','format','number'),jsonb_build_object('key','absolute_difference','label','Desvío','format','number')
          ),'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.absolute_difference desc,p.sessions desc,p.product) from product_rows p),'[]'::jsonb)),
        jsonb_build_object('key','locals','title','Exactitud por local',
          'columns',jsonb_build_array(jsonb_build_object('key','local','label','Local'),jsonb_build_object('key','sessions','label','Sesiones','format','number'),jsonb_build_object('key','compared','label','SKU comparados','format','number'),jsonb_build_object('key','accuracy','label','Exactitud','format','percent'),jsonb_build_object('key','absolute_difference','label','Desvío','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(l) order by l.absolute_difference desc,l.local) from local_rows l),'[]'::jsonb)),
        jsonb_build_object('key','methods','title','Métodos de registro',
          'columns',jsonb_build_array(jsonb_build_object('key','method','label','Método'),jsonb_build_object('key','units','label','Unidades','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(m) order by m.units desc,m.method) from method_rows m),'[]'::jsonb)),
        jsonb_build_object('key','recent','title','Inventarios individuales recientes','description','Últimos 20 inventarios dentro de los filtros. El historial operativo permite abrir el detalle completo.',
          'columns',jsonb_build_array(jsonb_build_object('key','reference','label','ID'),jsonb_build_object('key','name','label','Inventario'),jsonb_build_object('key','date','label','Fecha'),jsonb_build_object('key','local','label','Local'),jsonb_build_object('key','responsible','label','Creado por'),jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','units','label','Unidades','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(x)-'sort_at' order by x.sort_at desc) from (
            select left(s.id::text,8) as reference,s.nombre as name,to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI') as date,
              s.local_nombre as local,coalesce(nullif(trim(concat_ws(' ',u.nombre,u.apellido)),''),'Sin identificar') as responsible,
              s.estado as status,p.counted as units,s.created_at as sort_at
            from sessions s join per_session p on p.id=s.id left join public.perfiles u on u.id=s.created_by
            order by s.created_at desc limit 20
          ) x),'[]'::jsonb))
      ),
      'cross_module','[]'::jsonb,
      'notes',jsonb_build_array(
        'Los conteos son fotografías históricas y no representan el stock disponible hoy.',
        'La exactitud sólo considera sesiones con un balance cargado y SKU comparables.',
        'Una sesión abierta no tiene un cierre confiable; su duración no se usa como indicador.'
      )
    ) into v_result;

  elsif v_module='reposicion' then
    with sessions as materialized (
      select r.* from public.op_reposiciones r
      where (v_supervisor or v_user_local in (r.origen_local,r.destino_local))
        and (v_local is null or v_local in (r.origen_local,r.destino_local))
        and (v_from_ts is null or r.created_at>=v_from_ts)
        and (v_to_ts is null or r.created_at<v_to_ts)
        and (v_product is null or exists(
          select 1 from public.op_reposicion_items i where i.reposicion_id=r.id
            and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product)
          union all select 1 from public.op_reposicion_extras x where x.reposicion_id=r.id
            and public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product)
        ))
    ), lines as materialized (
      select i.* from public.op_reposicion_items i join sessions s on s.id=i.reposicion_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product)
    ), extras as materialized (
      select x.* from public.op_reposicion_extras x join sessions s on s.id=x.reposicion_id
      where x.cantidad>0 and (v_product is null or public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product))
    ), per_session as materialized (
      select s.id,s.origen_local,s.destino_local,s.estado,s.created_at,s.started_at,s.enviado_at,
        coalesce(l.products,0) as products,coalesce(l.requested,0) as requested,coalesce(l.prepared,0) as prepared,
        coalesce(l.fulfilled,0) as fulfilled,
        coalesce(l.shortage,0) as shortage,coalesce(l.overage,0)+coalesce(x.extra_units,0) as overage,
        coalesce(l.resolved,0) as resolved,coalesce(l.client_units,0) as client_units,coalesce(l.restock_units,0) as restock_units,
        coalesce(x.extra_units,0) as extra_units
      from sessions s
      left join lateral (
        select count(*) as products,sum(i.pedido_total) as requested,sum(i.preparado) as prepared,
          sum(least(i.preparado,i.pedido_total)) as fulfilled,
          sum(greatest(i.pedido_total-i.preparado,0)) as shortage,sum(greatest(i.preparado-i.pedido_total,0)) as overage,
          count(*) filter(where i.preparado>=i.pedido_total or i.no_encontrado or i.cerrado_incompleto) as resolved,
          sum(i.pedido_clientes) as client_units,sum(i.pedido_reposicion) as restock_units
        from lines i where i.reposicion_id=s.id
      ) l on true
      left join lateral (select sum(x.cantidad) as extra_units from extras x where x.reposicion_id=s.id) x on true
    ), trend_rows as (
      select date_trunc(v_grain,p.created_at at time zone 'America/Montevideo')::date as period,
        count(*) as sessions,sum(p.requested) as requested,sum(p.prepared) as prepared
      from per_session p group by 1 order by 1
    ), product_rows as (
      select i.codigo,(array_agg(i.nombre order by s.created_at desc,s.id desc))[1] as product,
        (array_agg(coalesce(i.marca,'') order by s.created_at desc,s.id desc))[1] as brand,
        count(distinct i.reposicion_id) as sessions,sum(i.pedido_total) as requested,sum(i.preparado) as prepared,
        sum(greatest(i.pedido_total-i.preparado,0)) as shortage
      from lines i join sessions s on s.id=i.reposicion_id where i.preparado<i.pedido_total
      group by i.codigo order by shortage desc,sessions desc,product limit 12
    ), route_rows as (
      select p.origen_local||' → '||p.destino_local as route,count(*) as sessions,sum(p.requested) as requested,
        sum(p.prepared) as prepared,case when sum(p.requested)>0 then round(100.0*sum(p.fulfilled)/sum(p.requested),1) end as fulfillment
      from per_session p group by p.origen_local,p.destino_local order by sessions desc,requested desc limit 16
    ), reason_rows as (
      select coalesce(nullif(i.motivo_label,''),nullif(i.motivo_codigo,''),case when i.no_encontrado then 'No encontrado' else 'Sin motivo' end) as reason,
        count(*) as products,sum(greatest(i.pedido_total-i.preparado,0)) as units
      from lines i where i.preparado<i.pedido_total and (i.no_encontrado or i.cerrado_incompleto or i.motivo_codigo is not null)
      group by 1 order by units desc,products desc limit 12
    ), status_rows as (
      select estado as status,count(*) as sessions,sum(requested) as requested,sum(prepared) as prepared
      from per_session group by estado order by sessions desc,status
    )
    select jsonb_build_object(
      'version',1,'module','reposicion','title','Reposiciones · preparación y cumplimiento',
      'subtitle','Demanda física, unidades preparadas, faltantes, extras y desempeño por ruta.',
      'generated_at',now(),
      'filters',jsonb_build_object('date_from',v_from,'date_to',v_to,'local',v_local,'product',v_product,'granularity',v_grain),
      'scope',jsonb_build_object('supervisor',v_supervisor,'local',v_user_local,'locations',v_locations),
      'kpis',jsonb_build_array(
        jsonb_build_object('key','sessions','label','Reposiciones','value',(select count(*) from per_session),'format','number','tone','info'),
        jsonb_build_object('key','requested','label','Unidades pedidas','value',coalesce((select sum(requested) from per_session),0),'format','number','hint','Pedido físico = mayor entre reposición y pedidos de clientes por SKU'),
        jsonb_build_object('key','prepared','label','Unidades preparadas','value',coalesce((select sum(prepared) from per_session),0),'format','number'),
        jsonb_build_object('key','fulfillment','label','Cumplimiento','value',(select case when sum(requested)>0 then round(100.0*sum(fulfilled)/sum(requested),1) end from per_session),'format','percent','tone',(select case when coalesce(sum(requested),0)=0 then 'info' when 100.0*sum(fulfilled)/sum(requested)>=95 then 'good' when 100.0*sum(fulfilled)/sum(requested)>=80 then 'warning' else 'danger' end from per_session)),
        jsonb_build_object('key','shortage','label','Faltantes','value',coalesce((select sum(shortage) from per_session),0),'format','number','tone','danger'),
        jsonb_build_object('key','overage','label','Excedentes y extras','value',coalesce((select sum(overage) from per_session),0),'format','number','tone','warning'),
        jsonb_build_object('key','resolved','label','Líneas resueltas','value',coalesce((select sum(resolved) from per_session),0),'format','number','hint','Completas o cerradas explícitamente como incompletas'),
        jsonb_build_object('key','lead_time','label','Tiempo hasta envío','value',(select round(avg(extract(epoch from (enviado_at-started_at))/3600.0)::numeric,1) from per_session where enviado_at is not null and enviado_at>=started_at),'format','duration')
      ),
      'trend',jsonb_build_object('title','Unidades pedidas y preparadas por período',
        'series',jsonb_build_array(jsonb_build_object('key','requested','label','Pedidas','format','number'),jsonb_build_object('key','prepared','label','Preparadas','format','number')),
        'points',coalesce((select jsonb_agg(jsonb_build_object('period',period,'label',case when v_grain='month' then to_char(period,'MM/YYYY') else to_char(period,'DD/MM') end,'requested',requested,'prepared',prepared,'sessions',sessions) order by period) from trend_rows),'[]'::jsonb)),
      'breakdowns',jsonb_build_array(
        jsonb_build_object('key','shortages','title','Productos con mayor faltante',
          'columns',jsonb_build_array(jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),jsonb_build_object('key','brand','label','Marca'),jsonb_build_object('key','sessions','label','Reposiciones','format','number'),jsonb_build_object('key','requested','label','Pedido','format','number'),jsonb_build_object('key','prepared','label','Preparado','format','number'),jsonb_build_object('key','shortage','label','Faltante','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.shortage desc,p.sessions desc,p.product) from product_rows p),'[]'::jsonb)),
        jsonb_build_object('key','routes','title','Cumplimiento por ruta',
          'columns',jsonb_build_array(jsonb_build_object('key','route','label','Ruta'),jsonb_build_object('key','sessions','label','Reposiciones','format','number'),jsonb_build_object('key','requested','label','Pedido','format','number'),jsonb_build_object('key','prepared','label','Preparado','format','number'),jsonb_build_object('key','fulfillment','label','Cumplimiento','format','percent')),
          'rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.sessions desc,r.requested desc,r.route) from route_rows r),'[]'::jsonb)),
        jsonb_build_object('key','reasons','title','Motivos de faltante',
          'columns',jsonb_build_array(jsonb_build_object('key','reason','label','Motivo'),jsonb_build_object('key','products','label','Líneas','format','number'),jsonb_build_object('key','units','label','Unidades','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.units desc,r.products desc,r.reason) from reason_rows r),'[]'::jsonb)),
        jsonb_build_object('key','states','title','Estado de las reposiciones',
          'columns',jsonb_build_array(jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','sessions','label','Reposiciones','format','number'),jsonb_build_object('key','requested','label','Pedido','format','number'),jsonb_build_object('key','prepared','label','Preparado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.sessions desc,s.status) from status_rows s),'[]'::jsonb)),
        jsonb_build_object('key','recent','title','Reposiciones individuales recientes','description','Últimas 20 reposiciones del alcance seleccionado.',
          'columns',jsonb_build_array(jsonb_build_object('key','reference','label','ID'),jsonb_build_object('key','name','label','Reposición'),jsonb_build_object('key','date','label','Fecha'),jsonb_build_object('key','route','label','Ruta'),jsonb_build_object('key','responsible','label','Creado por'),jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','requested','label','Pedido','format','number'),jsonb_build_object('key','prepared','label','Preparado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(x)-'sort_at' order by x.sort_at desc) from (
            select left(s.id::text,8) as reference,s.nombre as name,to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI') as date,
              s.origen_local||' → '||s.destino_local as route,coalesce(nullif(trim(concat_ws(' ',u.nombre,u.apellido)),''),'Sin identificar') as responsible,
              s.estado as status,p.requested,p.prepared,s.created_at as sort_at
            from sessions s join per_session p on p.id=s.id left join public.perfiles u on u.id=s.created_by
            order by s.created_at desc limit 20
          ) x),'[]'::jsonb))
      ),
      'cross_module',jsonb_build_array(
        jsonb_build_object('key','client_demand','label','Demanda de clientes','primary',coalesce((select sum(client_units) from per_session),0),'primary_label','Unidades consignadas en líneas'),
        jsonb_build_object('key','restock_demand','label','Demanda de reposición','primary',coalesce((select sum(restock_units) from per_session),0),'primary_label','Unidades consignadas en líneas'),
        jsonb_build_object('key','linked_orders','label','Pedidos vinculados','primary',(select count(distinct rp.pedido_id) from public.op_reposicion_pedidos rp join sessions s on s.id=rp.reposicion_id),'primary_label','Pedidos entre locales')
      ),
      'notes',jsonb_build_array(
        'El pedido físico de un SKU es el mayor valor entre reposición y pedidos de clientes; no se suman porque pueden representar las mismas unidades.',
        'El cumplimiento se limita al 100 % por SKU, para que un excedente no compense el faltante de otro producto. Los excedentes se muestran por separado.',
        'Los totales son retroactivos; operaciones abiertas eliminadas antes de enviarse no dejaron una auditoría recuperable.'
      )
    ) into v_result;

  elsif v_module='recepcion' then
    with sessions as materialized (
      select r.* from public.op_recepciones r
      where (v_supervisor or v_user_local in (r.origen_local,r.destino_local))
        and (v_local is null or v_local in (r.origen_local,r.destino_local))
        and (v_from_ts is null or r.created_at>=v_from_ts)
        and (v_to_ts is null or r.created_at<v_to_ts)
        and (v_product is null or exists(
          select 1 from public.op_recepcion_items i where i.recepcion_id=r.id
            and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product)
          union all select 1 from public.op_recepcion_extras x where x.recepcion_id=r.id
            and public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product)
        ))
    ), lines as materialized (
      select i.* from public.op_recepcion_items i join sessions s on s.id=i.recepcion_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product)
    ), extras as materialized (
      select x.* from public.op_recepcion_extras x join sessions s on s.id=x.recepcion_id
      where x.cantidad>0 and (v_product is null or public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product))
    ), per_session as materialized (
      select s.id,s.origen_local,s.destino_local,s.estado,s.created_at,s.closed_at,
        coalesce(l.products,0) as products,coalesce(l.expected,0) as expected,coalesce(l.received,0) as received,
        coalesce(l.fulfilled,0) as fulfilled,
        coalesce(l.shortage,0) as shortage,coalesce(l.overage,0)+coalesce(x.extra_units,0) as overage,
        coalesce(l.exact,0) as exact,coalesce(l.controlled,0) as controlled,coalesce(x.extra_units,0) as extra_units
      from sessions s
      left join lateral (
        select count(*) as products,sum(i.esperado) as expected,sum(i.recibido) as received,
          sum(least(i.recibido,i.esperado)) as fulfilled,
          sum(greatest(i.esperado-i.recibido,0)) as shortage,sum(greatest(i.recibido-i.esperado,0)) as overage,
          count(*) filter(where (i.controlado_at is not null or i.no_recibido) and i.recibido=i.esperado) as exact,
          count(*) filter(where i.controlado_at is not null or i.no_recibido) as controlled
        from lines i where i.recepcion_id=s.id
      ) l on true
      left join lateral (select sum(x.cantidad) as extra_units from extras x where x.recepcion_id=s.id) x on true
    ), trend_rows as (
      select date_trunc(v_grain,p.created_at at time zone 'America/Montevideo')::date as period,
        count(*) as receipts,sum(p.expected) as expected,sum(p.received) as received
      from per_session p group by 1 order by 1
    ), product_rows as (
      select i.codigo,(array_agg(i.nombre order by s.created_at desc,s.id desc))[1] as product,
        (array_agg(coalesce(i.marca,'') order by s.created_at desc,s.id desc))[1] as brand,
        count(distinct i.recepcion_id) as receipts,sum(i.esperado) as expected,sum(i.recibido) as received,
        count(*) filter(where i.controlado_at is not null or i.no_recibido) as controlled,
        sum(abs(i.recibido-i.esperado)) as difference
      from lines i join sessions s on s.id=i.recepcion_id where i.recibido<>i.esperado
      group by i.codigo order by difference desc,receipts desc,product limit 12
    ), route_rows as (
      select p.origen_local||' → '||p.destino_local as route,count(*) as receipts,sum(p.expected) as expected,
        sum(p.received) as received,case when sum(p.expected)>0 then round(100.0*sum(p.fulfilled)/sum(p.expected),1) end as fulfillment
      from per_session p group by p.origen_local,p.destino_local order by receipts desc,expected desc limit 16
    ), status_rows as (
      select estado as status,count(*) as receipts,sum(expected) as expected,sum(received) as received
      from per_session group by estado order by receipts desc,status
    ), extra_rows as (
      select x.codigo,(array_agg(x.nombre order by s.created_at desc,s.id desc))[1] as product,
        count(distinct x.recepcion_id) as receipts,sum(x.cantidad) as units
      from extras x join sessions s on s.id=x.recepcion_id group by x.codigo order by units desc,receipts desc,product limit 12
    )
    select jsonb_build_object(
      'version',1,'module','recepcion','title','Remitos y recepción · control histórico',
      'subtitle','Comparación entre unidades esperadas y recibidas, extras y desempeño por ruta.',
      'generated_at',now(),
      'filters',jsonb_build_object('date_from',v_from,'date_to',v_to,'local',v_local,'product',v_product,'granularity',v_grain),
      'scope',jsonb_build_object('supervisor',v_supervisor,'local',v_user_local,'locations',v_locations),
      'kpis',jsonb_build_array(
        jsonb_build_object('key','receipts','label','Controles de remito','value',(select count(*) from per_session),'format','number','tone','info','hint','Incluye controles abiertos y cerrados'),
        jsonb_build_object('key','expected','label','Unidades esperadas','value',coalesce((select sum(expected) from per_session),0),'format','number'),
        jsonb_build_object('key','received','label','Unidades recibidas','value',coalesce((select sum(received) from per_session),0),'format','number'),
        jsonb_build_object('key','fulfillment','label','Avance de recepción','value',(select case when sum(expected)>0 then round(100.0*sum(fulfilled)/sum(expected),1) end from per_session),'format','percent','tone',(select case when coalesce(sum(expected),0)=0 then 'info' when 100.0*sum(fulfilled)/sum(expected)>=95 then 'good' when 100.0*sum(fulfilled)/sum(expected)>=80 then 'warning' else 'danger' end from per_session),'hint','Incluye lo registrado en controles todavía abiertos'),
        jsonb_build_object('key','shortage','label','Pendiente o no recibido','value',coalesce((select sum(shortage) from per_session),0),'format','number','tone','danger','hint','En controles abiertos puede incluir unidades aún no revisadas'),
        jsonb_build_object('key','overage','label','Excedentes y extras','value',coalesce((select sum(overage) from per_session),0),'format','number','tone','warning'),
        jsonb_build_object('key','controlled_lines','label','SKU revisados','value',coalesce((select sum(controlled) from per_session),0),'format','number','hint','Líneas confirmadas o marcadas como no recibidas'),
        jsonb_build_object('key','accuracy','label','Coincidencia controlada','value',(select case when sum(controlled)>0 then round(100.0*sum(exact)/sum(controlled),1) end from per_session),'format','percent','tone',(select case when coalesce(sum(controlled),0)=0 then 'info' when 100.0*sum(exact)/sum(controlled)>=95 then 'good' when 100.0*sum(exact)/sum(controlled)>=80 then 'warning' else 'danger' end from per_session),'hint','Solo considera SKU que ya fueron revisados'),
        jsonb_build_object('key','lead_time','label','Tiempo de control','value',(select round(avg(extract(epoch from (closed_at-created_at))/3600.0)::numeric,1) from per_session where closed_at is not null and closed_at>=created_at),'format','duration')
      ),
      'trend',jsonb_build_object('title','Unidades esperadas y recibidas por período',
        'series',jsonb_build_array(jsonb_build_object('key','expected','label','Esperadas','format','number'),jsonb_build_object('key','received','label','Recibidas','format','number')),
        'points',coalesce((select jsonb_agg(jsonb_build_object('period',period,'label',case when v_grain='month' then to_char(period,'MM/YYYY') else to_char(period,'DD/MM') end,'expected',expected,'received',received,'receipts',receipts) order by period) from trend_rows),'[]'::jsonb)),
      'breakdowns',jsonb_build_array(
        jsonb_build_object('key','differences','title','Productos pendientes o con diferencia','description','En controles abiertos también muestra unidades que todavía no fueron revisadas.',
          'columns',jsonb_build_array(jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),jsonb_build_object('key','brand','label','Marca'),jsonb_build_object('key','receipts','label','Remitos','format','number'),jsonb_build_object('key','controlled','label','Revisiones','format','number'),jsonb_build_object('key','expected','label','Esperado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number'),jsonb_build_object('key','difference','label','Desvío','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.difference desc,p.receipts desc,p.product) from product_rows p),'[]'::jsonb)),
        jsonb_build_object('key','routes','title','Recepción por ruta',
          'columns',jsonb_build_array(jsonb_build_object('key','route','label','Ruta'),jsonb_build_object('key','receipts','label','Remitos','format','number'),jsonb_build_object('key','expected','label','Esperado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number'),jsonb_build_object('key','fulfillment','label','Nivel','format','percent')),
          'rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.receipts desc,r.expected desc,r.route) from route_rows r),'[]'::jsonb)),
        jsonb_build_object('key','extras','title','Productos extra más frecuentes',
          'columns',jsonb_build_array(jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),jsonb_build_object('key','receipts','label','Remitos','format','number'),jsonb_build_object('key','units','label','Unidades','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(e) order by e.units desc,e.receipts desc,e.product) from extra_rows e),'[]'::jsonb)),
        jsonb_build_object('key','states','title','Estado de los controles',
          'columns',jsonb_build_array(jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','receipts','label','Remitos','format','number'),jsonb_build_object('key','expected','label','Esperado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.receipts desc,s.status) from status_rows s),'[]'::jsonb)),
        jsonb_build_object('key','recent','title','Remitos individuales recientes','description','Últimos 20 controles de recepción dentro de los filtros.',
          'columns',jsonb_build_array(jsonb_build_object('key','reference','label','ID'),jsonb_build_object('key','name','label','Control'),jsonb_build_object('key','date','label','Fecha'),jsonb_build_object('key','route','label','Ruta'),jsonb_build_object('key','responsible','label','Creado por'),jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','expected','label','Esperado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(x)-'sort_at' order by x.sort_at desc) from (
            select left(s.id::text,8) as reference,s.nombre as name,to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI') as date,
              s.origen_local||' → '||s.destino_local as route,coalesce(nullif(trim(concat_ws(' ',u.nombre,u.apellido)),''),'Sin identificar') as responsible,
              s.estado as status,p.expected,p.received,s.created_at as sort_at
            from sessions s join per_session p on p.id=s.id left join public.perfiles u on u.id=s.created_by
            order by s.created_at desc limit 20
          ) x),'[]'::jsonb))
      ),
      'cross_module',jsonb_build_array(
        jsonb_build_object('key','linked_orders','label','Pedidos vinculados','primary',(select count(distinct rp.pedido_id) from public.op_recepcion_pedidos rp join sessions s on s.id=rp.recepcion_id),'primary_label','Pedidos relacionados'),
        jsonb_build_object('key','allocated_order_units','label','Unidades para pedidos','primary',coalesce((select sum(u.cantidad) from public.op_recepcion_pedido_unidades u join sessions s on s.id=u.recepcion_id),0),'primary_label','Asignación confirmada'),
        jsonb_build_object('key','linked_reservations','label','Reservas vinculadas','primary',(select count(distinct rr.reserva_id) from public.op_recepcion_reservas rr join sessions s on s.id=rr.recepcion_id),'primary_label','Reservas actuales relacionadas')
      ),
      'notes',jsonb_build_array(
        'El nivel de recepción se limita al 100 % por SKU, para que un excedente no compense el faltante de otro producto. Los excedentes y productos extra se informan aparte.',
        'La fecha del filtro corresponde al alta del control; la fecha del remito sigue disponible en el detalle operativo.',
        'Los controles abiertos eliminados no dejaron una auditoría histórica recuperable.'
      )
    ) into v_result;

  elsif v_module='pedidos' then
    with orders as materialized (
      select p.* from public.pedidos p
      where (v_supervisor or v_user_local in (p.origen_local,p.destino_local,p.escala_local))
        and (v_local is null or v_local in (p.origen_local,p.destino_local,p.escala_local))
        and (v_from_ts is null or p.created_at>=v_from_ts)
        and (v_to_ts is null or p.created_at<v_to_ts)
        and (v_product is null or exists(
          select 1 from public.pedido_productos pp where pp.pedido_id=p.id
            and public.op_busqueda_coincide(concat_ws(' ',pp.codigo,pp.nombre,pp.marca),v_product)
        ))
    ), lines as materialized (
      select pp.id,pp.pedido_id,pp.codigo,pp.nombre,pp.marca,pp.cantidad as requested,
        case when p.estado in ('aceptado','listo','transito_escala','en_escala','listo_escala','transito','llegado','completo','incompleto')
          then greatest(coalesce(pp.cantidad_aceptada,pp.cantidad),0) else 0 end as accepted,
        greatest(coalesce(pp.cantidad_preparada,0),0) as prepared,
        case when coalesce(pp.cantidad_recibida,0)>0 then pp.cantidad_recibida
          when p.estado='completo' then greatest(coalesce(nullif(pp.cantidad_preparada,0),pp.cantidad_aceptada,pp.cantidad),0)
          else greatest(coalesce(pp.cantidad_recibida,0),0) end as received,
        (p.estado='completo' and coalesce(pp.cantidad_recibida,0)=0) as inferred_received
      from public.pedido_productos pp join orders p on p.id=pp.pedido_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',pp.codigo,pp.nombre,pp.marca),v_product)
    ), per_order as materialized (
      select p.id,p.origen_local,p.destino_local,p.escala_local,p.estado,p.urgente,p.canal_creacion,p.cliente_aviso_pendiente,
        p.reposicion_id,p.recepcion_id,p.reserva_id,p.created_at,
        coalesce(sum(l.requested),0) as requested,coalesce(sum(l.accepted),0) as accepted,
        coalesce(sum(l.prepared),0) as prepared,coalesce(sum(l.received),0) as received,
        bool_or(coalesce(l.inferred_received,false)) as inferred_received,
        (select max(h.created_at) from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('completo','incompleto','denegado')) as final_at
      from orders p left join lines l on l.pedido_id=p.id
      group by p.id,p.origen_local,p.destino_local,p.escala_local,p.estado,p.urgente,p.canal_creacion,p.cliente_aviso_pendiente,p.reposicion_id,p.recepcion_id,p.reserva_id,p.created_at
    ), trend_rows as (
      select date_trunc(v_grain,p.created_at at time zone 'America/Montevideo')::date as period,
        count(*) as orders,sum(p.requested) as requested,sum(p.received) as received
      from per_order p group by 1 order by 1
    ), product_rows as (
      select l.codigo,(array_agg(l.nombre order by p.created_at desc,p.id desc,l.id desc))[1] as product,
        (array_agg(coalesce(l.marca,'') order by p.created_at desc,p.id desc,l.id desc))[1] as brand,count(distinct l.pedido_id) as orders,
        sum(l.requested) as requested,sum(l.accepted) as accepted,sum(l.prepared) as prepared,sum(l.received) as received,
        coalesce(sum(l.received) filter(where l.inferred_received),0) as inferred_units
      from lines l join orders p on p.id=l.pedido_id group by l.codigo order by requested desc,orders desc,product limit 12
    ), route_rows as (
      select p.origen_local||' → '||p.destino_local as route,count(*) as orders,sum(p.requested) as requested,
        count(*) filter(where p.estado='completo') as complete,
        count(*) filter(where p.estado in ('incompleto','denegado')) as incidents
      from per_order p group by p.origen_local,p.destino_local order by orders desc,requested desc limit 16
    ), status_rows as (
      select p.estado as status,count(*) as orders,sum(p.requested) as requested,sum(p.received) as received
      from per_order p group by p.estado order by orders desc,status
    ), channel_rows as (
      select case p.canal_creacion when 'publico' then 'Enlace público' else 'Interno' end as channel,
        count(*) as orders,sum(p.requested) as requested,count(*) filter(where p.urgente) as urgent
      from per_order p group by p.canal_creacion order by orders desc,channel
    )
    select jsonb_build_object(
      'version',1,'module','pedidos','title','Pedidos entre locales · recorrido completo',
      'subtitle','Demanda, aceptación, preparación, recepción y resultados de los pedidos.',
      'generated_at',now(),
      'filters',jsonb_build_object('date_from',v_from,'date_to',v_to,'local',v_local,'product',v_product,'granularity',v_grain),
      'scope',jsonb_build_object('supervisor',v_supervisor,'local',v_user_local,'locations',v_locations),
      'kpis',jsonb_build_array(
        jsonb_build_object('key','orders','label','Pedidos','value',(select count(*) from per_order),'format','number','tone','info'),
        jsonb_build_object('key','requested','label','Unidades solicitadas','value',coalesce((select sum(requested) from per_order),0),'format','number'),
        jsonb_build_object('key','accepted','label','Unidades aceptadas','value',coalesce((select sum(accepted) from per_order),0),'format','number'),
        jsonb_build_object('key','received','label','Unidades recibidas','value',coalesce((select sum(received) from per_order),0),'format','number'),
        jsonb_build_object('key','complete_rate','label','Cierres completos','value',(select case when count(*) filter(where estado in ('completo','incompleto','denegado'))>0 then round(100.0*count(*) filter(where estado='completo')/count(*) filter(where estado in ('completo','incompleto','denegado')),1) end from per_order),'format','percent','tone',(select case when count(*) filter(where estado in ('completo','incompleto','denegado'))=0 then 'info' when 100.0*count(*) filter(where estado='completo')/count(*) filter(where estado in ('completo','incompleto','denegado'))>=90 then 'good' when 100.0*count(*) filter(where estado='completo')/count(*) filter(where estado in ('completo','incompleto','denegado'))>=70 then 'warning' else 'danger' end from per_order),'hint','Sobre pedidos con resultado final'),
        jsonb_build_object('key','active','label','Pedidos activos','value',(select count(*) from per_order where estado not in ('completo','incompleto','denegado')),'format','number','tone','warning'),
        jsonb_build_object('key','urgent_active','label','Urgentes activos','value',(select count(*) from per_order where urgente and estado not in ('completo','incompleto','denegado')),'format','number','tone','danger'),
        jsonb_build_object('key','inferred_received','label','Recepción histórica inferida','value',(select count(*) from per_order where inferred_received),'format','number','tone',case when exists(select 1 from per_order where inferred_received) then 'warning' else 'info' end,'hint','Pedidos completos antiguos sin cantidad recibida estructurada'),
        jsonb_build_object('key','lead_time','label','Tiempo hasta cierre','value',(select round(avg(extract(epoch from (final_at-created_at))/3600.0)::numeric,1) from per_order where final_at is not null and final_at>=created_at),'format','duration')
      ),
      'trend',jsonb_build_object('title','Unidades solicitadas y recibidas por período',
        'series',jsonb_build_array(jsonb_build_object('key','requested','label','Solicitadas','format','number'),jsonb_build_object('key','received','label','Recibidas','format','number')),
        'points',coalesce((select jsonb_agg(jsonb_build_object('period',period,'label',case when v_grain='month' then to_char(period,'MM/YYYY') else to_char(period,'DD/MM') end,'requested',requested,'received',received,'orders',orders) order by period) from trend_rows),'[]'::jsonb)),
      'breakdowns',jsonb_build_array(
        jsonb_build_object('key','products','title','Productos con mayor demanda',
          'columns',jsonb_build_array(jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),jsonb_build_object('key','brand','label','Marca'),jsonb_build_object('key','orders','label','Pedidos','format','number'),jsonb_build_object('key','requested','label','Solicitado','format','number'),jsonb_build_object('key','accepted','label','Aceptado','format','number'),jsonb_build_object('key','prepared','label','Preparado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number'),jsonb_build_object('key','inferred_units','label','Recibido inferido','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.requested desc,p.orders desc,p.product) from product_rows p),'[]'::jsonb)),
        jsonb_build_object('key','routes','title','Resultados por ruta',
          'columns',jsonb_build_array(jsonb_build_object('key','route','label','Ruta'),jsonb_build_object('key','orders','label','Pedidos','format','number'),jsonb_build_object('key','requested','label','Unidades','format','number'),jsonb_build_object('key','complete','label','Completos','format','number'),jsonb_build_object('key','incidents','label','Con incidencia','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.orders desc,r.requested desc,r.route) from route_rows r),'[]'::jsonb)),
        jsonb_build_object('key','states','title','Pedidos por estado',
          'columns',jsonb_build_array(jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','orders','label','Pedidos','format','number'),jsonb_build_object('key','requested','label','Solicitado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.orders desc,s.status) from status_rows s),'[]'::jsonb)),
        jsonb_build_object('key','channels','title','Canal de creación',
          'columns',jsonb_build_array(jsonb_build_object('key','channel','label','Canal'),jsonb_build_object('key','orders','label','Pedidos','format','number'),jsonb_build_object('key','requested','label','Unidades','format','number'),jsonb_build_object('key','urgent','label','Urgentes','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(c) order by c.orders desc,c.channel) from channel_rows c),'[]'::jsonb)),
        jsonb_build_object('key','funnel','title','Embudo de unidades','description','Cada etapa muestra volumen registrado; los pedidos antiguos pueden no tener todos los campos estructurados.',
          'columns',jsonb_build_array(jsonb_build_object('key','stage','label','Etapa'),jsonb_build_object('key','units','label','Unidades','format','number')),
          'rows',jsonb_build_array(
            jsonb_build_object('stage','Solicitadas','units',coalesce((select sum(requested) from per_order),0)),
            jsonb_build_object('stage','Aceptadas','units',coalesce((select sum(accepted) from per_order),0)),
            jsonb_build_object('stage','Preparadas','units',coalesce((select sum(prepared) from per_order),0)),
            jsonb_build_object('stage','Recibidas','units',coalesce((select sum(received) from per_order),0))
          )),
        jsonb_build_object('key','recent','title','Pedidos individuales recientes','description','Últimos 20 pedidos dentro del alcance y filtros seleccionados.',
          'columns',jsonb_build_array(jsonb_build_object('key','reference','label','ID'),jsonb_build_object('key','date','label','Fecha'),jsonb_build_object('key','route','label','Ruta'),jsonb_build_object('key','customer','label','Cliente'),jsonb_build_object('key','responsible','label','Creado por'),jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','requested','label','Solicitado','format','number'),jsonb_build_object('key','received','label','Recibido','format','number'),jsonb_build_object('key','receipt_basis','label','Base de recepción')),
          'rows',coalesce((select jsonb_agg(to_jsonb(x)-'sort_at' order by x.sort_at desc) from (
            select left(p.id::text,8) as reference,to_char(p.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI') as date,
              p.origen_local||' → '||p.destino_local as route,coalesce(nullif(trim(p.cliente),''),'Sin cliente') as customer,
              coalesce(nullif(trim(concat_ws(' ',u.nombre,u.apellido)),''),'Sin identificar') as responsible,
              p.estado as status,o.requested,o.received,case when o.inferred_received then 'Inferida (histórico)' else 'Registrada' end as receipt_basis,p.created_at as sort_at
            from orders p join per_order o on o.id=p.id left join public.perfiles u on u.id=p.creado_por
            order by p.created_at desc limit 20
          ) x),'[]'::jsonb))
      ),
      'cross_module',jsonb_build_array(
        jsonb_build_object('key','repositions','label','Con reposición','primary',(select count(*) from per_order where reposicion_id is not null),'primary_label','Pedidos vinculados'),
        jsonb_build_object('key','receptions','label','Con recepción','primary',(select count(*) from per_order where recepcion_id is not null),'primary_label','Pedidos vinculados'),
        jsonb_build_object('key','reservations','label','Desde reservas','primary',(select count(*) from per_order where reserva_id is not null),'primary_label','Pedidos vinculados'),
        jsonb_build_object('key','customer_notice','label','Aviso pendiente','primary',(select count(*) from per_order where cliente_aviso_pendiente),'primary_label','Pedidos recibidos por avisar')
      ),
      'notes',jsonb_build_array(
        'Para pedidos completos antiguos sin cantidad recibida estructurada se infiere la recepción desde la mejor cantidad disponible; el tablero no modifica los registros.',
        'Los pedidos eliminados antes de esta mejora no pueden reconstruirse porque no existe una papelera histórica de pedidos.',
        'El filtro de fecha usa la creación del pedido; el tiempo hasta cierre usa el último evento final registrado.'
      )
    ) into v_result;

  elsif v_module='reservas' then
    with reservations as materialized (
      select r.* from public.op_analytics_reservas_base r
      where (v_supervisor or r.local_nombre=v_user_local)
        and (v_local is null or r.local_nombre=v_local)
        and (v_from_ts is null or r.created_at>=v_from_ts)
        and (v_to_ts is null or r.created_at<v_to_ts)
        and (v_product is null or exists(
          select 1 from public.op_analytics_reserva_items_base i where i.reserva_id=r.id
            and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre),v_product)
        ))
    ), lines as materialized (
      select i.* from public.op_analytics_reserva_items_base i join reservations r on r.id=i.reserva_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre),v_product)
    ), per_reservation as materialized (
      select r.id,r.local_nombre,r.estado,r.finalidad,r.entrega_tipo,r.final_tipo,r.responsable_nombre,r.created_by_name,r.created_at,r.completed_at,r.deleted,r.deleted_at,
        coalesce(sum(i.cantidad),0) as requested,coalesce(sum(i.cantidad_local),0) as local_units,
        coalesce(sum(i.cantidad_entregada),0) as delivered,
        bool_or(i.pedido_id is not null) as linked_order,bool_or(i.reposicion_id is not null) as linked_reposition,
        bool_or(i.recepcion_id is not null) as linked_reception,
        r.estado='vencido' or exists(select 1 from public.op_analytics_reserva_eventos_base e where e.reserva_id=r.id and (e.accion='vencimiento' or e.estado='vencido')) as ever_overdue
      from reservations r left join lines i on i.reserva_id=r.id
      group by r.id,r.local_nombre,r.estado,r.finalidad,r.entrega_tipo,r.final_tipo,r.responsable_nombre,r.created_by_name,r.created_at,r.completed_at,r.deleted,r.deleted_at
    ), trend_rows as (
      select date_trunc(v_grain,p.created_at at time zone 'America/Montevideo')::date as period,
        count(*) as reservations,sum(p.requested) as requested,sum(p.delivered) as delivered
      from per_reservation p group by 1 order by 1
    ), product_rows as (
      select i.codigo,(array_agg(i.nombre order by r.created_at desc,r.id desc,i.nombre desc))[1] as product,count(distinct i.reserva_id) as reservations,
        sum(i.cantidad) as requested,sum(i.cantidad_local) as local_units,sum(i.cantidad_entregada) as delivered
      from lines i join reservations r on r.id=i.reserva_id group by i.codigo order by requested desc,reservations desc,product limit 12
    ), local_rows as (
      select p.local_nombre as local,count(*) as reservations,sum(p.requested) as requested,sum(p.delivered) as delivered,
        case when sum(p.requested)>0 then round(100.0*sum(p.delivered)/sum(p.requested),1) end as delivery_rate,
        count(*) filter(where p.ever_overdue) as overdue
      from per_reservation p group by p.local_nombre order by reservations desc,local limit 20
    ), state_rows as (
      select case when p.deleted then 'eliminada' else p.estado end as status,count(*) as reservations,
        sum(p.requested) as requested,sum(p.delivered) as delivered
      from per_reservation p group by 1 order by reservations desc,status
    ), source_rows as (
      select i.procedencia as source,count(distinct i.reserva_id) as reservations,sum(i.cantidad) as requested,
        sum(i.cantidad_local) as local_units,sum(i.cantidad_entregada) as delivered
      from lines i group by i.procedencia order by requested desc,source
    ), purpose_rows as (
      select p.finalidad as purpose,count(*) as reservations,sum(p.requested) as requested,sum(p.delivered) as delivered
      from per_reservation p group by p.finalidad order by reservations desc,purpose
    )
    select jsonb_build_object(
      'version',1,'module','reservas','title','Reservas · seguimiento de punta a punta',
      'subtitle','Demanda reservada, mercadería separada, entregas, vencimientos y recorridos vinculados.',
      'generated_at',now(),
      'filters',jsonb_build_object('date_from',v_from,'date_to',v_to,'local',v_local,'product',v_product,'granularity',v_grain),
      'scope',jsonb_build_object('supervisor',v_supervisor,'local',v_user_local,'locations',v_locations),
      'kpis',jsonb_build_array(
        jsonb_build_object('key','reservations','label','Reservas creadas','value',(select count(*) from per_reservation),'format','number','tone','info'),
        jsonb_build_object('key','active','label','Reservas activas','value',(select count(*) from per_reservation where not deleted and estado not in ('completado','cancelado')),'format','number'),
        jsonb_build_object('key','requested','label','Unidades reservadas','value',coalesce((select sum(requested) from per_reservation),0),'format','number'),
        jsonb_build_object('key','local_units','label','Actualmente separadas','value',coalesce((select sum(local_units) from per_reservation where not deleted),0),'format','number','hint','Fotografía actual de reservas existentes'),
        jsonb_build_object('key','delivered','label','Unidades entregadas','value',coalesce((select sum(delivered) from per_reservation),0),'format','number'),
        jsonb_build_object('key','delivery_rate','label','Entrega sobre reserva','value',(select case when sum(requested)>0 then round(100.0*sum(delivered)/sum(requested),1) end from per_reservation),'format','percent','tone',(select case when coalesce(sum(requested),0)=0 then 'info' when 100.0*sum(delivered)/sum(requested)>=90 then 'good' when 100.0*sum(delivered)/sum(requested)>=60 then 'warning' else 'danger' end from per_reservation)),
        jsonb_build_object('key','overdue','label','Alguna vez vencidas','value',(select count(*) from per_reservation where ever_overdue),'format','number','tone','warning'),
        jsonb_build_object('key','lead_time','label','Tiempo hasta cierre','value',(select round(avg(extract(epoch from (completed_at-created_at))/3600.0)::numeric,1) from per_reservation where completed_at is not null and completed_at>=created_at),'format','duration')
      ),
      'trend',jsonb_build_object('title','Unidades reservadas y entregadas por período de creación',
        'series',jsonb_build_array(jsonb_build_object('key','requested','label','Reservadas','format','number'),jsonb_build_object('key','delivered','label','Entregadas','format','number')),
        'points',coalesce((select jsonb_agg(jsonb_build_object('period',period,'label',case when v_grain='month' then to_char(period,'MM/YYYY') else to_char(period,'DD/MM') end,'requested',requested,'delivered',delivered,'reservations',reservations) order by period) from trend_rows),'[]'::jsonb)),
      'breakdowns',jsonb_build_array(
        jsonb_build_object('key','products','title','Productos más reservados',
          'columns',jsonb_build_array(jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),jsonb_build_object('key','reservations','label','Reservas','format','number'),jsonb_build_object('key','requested','label','Reservado','format','number'),jsonb_build_object('key','local_units','label','Separado','format','number'),jsonb_build_object('key','delivered','label','Entregado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.requested desc,p.reservations desc,p.product) from product_rows p),'[]'::jsonb)),
        jsonb_build_object('key','locals','title','Resultados por local',
          'columns',jsonb_build_array(jsonb_build_object('key','local','label','Local'),jsonb_build_object('key','reservations','label','Reservas','format','number'),jsonb_build_object('key','requested','label','Unidades','format','number'),jsonb_build_object('key','delivered','label','Entregadas','format','number'),jsonb_build_object('key','delivery_rate','label','Entrega','format','percent'),jsonb_build_object('key','overdue','label','Vencidas','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(l) order by l.reservations desc,l.local) from local_rows l),'[]'::jsonb)),
        jsonb_build_object('key','states','title','Estado y cierres',
          'columns',jsonb_build_array(jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','reservations','label','Reservas','format','number'),jsonb_build_object('key','requested','label','Reservado','format','number'),jsonb_build_object('key','delivered','label','Entregado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.reservations desc,s.status) from state_rows s),'[]'::jsonb)),
        jsonb_build_object('key','sources','title','Origen de la mercadería',
          'columns',jsonb_build_array(jsonb_build_object('key','source','label','Origen'),jsonb_build_object('key','reservations','label','Reservas','format','number'),jsonb_build_object('key','requested','label','Reservado','format','number'),jsonb_build_object('key','local_units','label','Separado','format','number'),jsonb_build_object('key','delivered','label','Entregado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.requested desc,s.source) from source_rows s),'[]'::jsonb)),
        jsonb_build_object('key','purposes','title','Finalidad de las reservas',
          'columns',jsonb_build_array(jsonb_build_object('key','purpose','label','Finalidad'),jsonb_build_object('key','reservations','label','Reservas','format','number'),jsonb_build_object('key','requested','label','Reservado','format','number'),jsonb_build_object('key','delivered','label','Entregado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.reservations desc,p.purpose) from purpose_rows p),'[]'::jsonb)),
        jsonb_build_object('key','recent','title','Reservas individuales recientes','description','Últimas 20 reservas, incluidas las eliminadas que cuentan con auditoría.',
          'columns',jsonb_build_array(jsonb_build_object('key','reference','label','ID'),jsonb_build_object('key','date','label','Fecha'),jsonb_build_object('key','local','label','Local'),jsonb_build_object('key','responsible','label','Responsable'),jsonb_build_object('key','created_by','label','Creado por'),jsonb_build_object('key','status','label','Estado'),jsonb_build_object('key','requested','label','Reservado','format','number'),jsonb_build_object('key','delivered','label','Entregado','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(x)-'sort_at' order by x.sort_at desc) from (
            select left(p.id::text,8) as reference,to_char(p.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI') as date,
              p.local_nombre as local,coalesce(p.responsable_nombre,'Sin identificar') as responsible,
              coalesce(p.created_by_name,'Sin identificar') as created_by,case when p.deleted then 'eliminada' else p.estado end as status,
              p.requested,p.delivered,p.created_at as sort_at
            from per_reservation p order by p.created_at desc limit 20
          ) x),'[]'::jsonb))
      ),
      'cross_module',jsonb_build_array(
        jsonb_build_object('key','orders','label','Con pedido vinculado','primary',(select count(*) from per_reservation where linked_order),'primary_label','Reservas'),
        jsonb_build_object('key','repositions','label','Con reposición','primary',(select count(*) from per_reservation where linked_reposition),'primary_label','Reservas'),
        jsonb_build_object('key','receptions','label','Con recepción','primary',(select count(*) from per_reservation where linked_reception),'primary_label','Reservas'),
        jsonb_build_object('key','no_pickup','label','No retiradas','primary',(select count(*) from per_reservation where final_tipo='no_retirado'),'primary_label','Cierres'),
        jsonb_build_object('key','deleted','label','Eliminadas con auditoría','primary',(select count(*) from per_reservation where deleted),'primary_label','Incluidas retroactivamente')
      ),
      'notes',jsonb_build_array(
        'Las reservas eliminadas se reconstruyen desde su auditoría y se incluyen en los totales históricos.',
        '“Actualmente separadas” solo suma reservas existentes; una reserva eliminada no representa mercadería física actual.',
        'Los vínculos logísticos reflejan identificadores confirmados. Coincidencias solamente por fecha o ruta no se presentan como vínculo real.'
      )
    ) into v_result;

  elsif v_module='global' then
    with inv_sessions as materialized (
      select s.* from public.op_inventario_sesiones s
      where (v_supervisor or s.local_nombre=v_user_local) and (v_local is null or s.local_nombre=v_local)
        and (v_from_ts is null or s.created_at>=v_from_ts) and (v_to_ts is null or s.created_at<v_to_ts)
        and (v_product is null or exists(select 1 from public.op_busqueda_productos_base p where p.modulo='inventario' and p.sesion_id=s.id and public.op_busqueda_coincide(p.texto,v_product)))
    ), inv_lines as materialized (
      select p.* from public.op_busqueda_productos_base p join inv_sessions s on s.id=p.sesion_id
      where p.modulo='inventario' and (v_product is null or public.op_busqueda_coincide(p.texto,v_product))
    ), repo_sessions as materialized (
      select r.* from public.op_reposiciones r
      where (v_supervisor or v_user_local in (r.origen_local,r.destino_local)) and (v_local is null or v_local in (r.origen_local,r.destino_local))
        and (v_from_ts is null or r.created_at>=v_from_ts) and (v_to_ts is null or r.created_at<v_to_ts)
        and (v_product is null
          or exists(select 1 from public.op_reposicion_items i where i.reposicion_id=r.id and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product))
          or exists(select 1 from public.op_reposicion_extras x where x.reposicion_id=r.id and x.cantidad>0 and public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product)))
    ), repo_lines as materialized (
      select i.* from public.op_reposicion_items i join repo_sessions r on r.id=i.reposicion_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product)
    ), repo_extras as materialized (
      select x.* from public.op_reposicion_extras x join repo_sessions r on r.id=x.reposicion_id
      where x.cantidad>0 and (v_product is null or public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product))
    ), rec_sessions as materialized (
      select r.* from public.op_recepciones r
      where (v_supervisor or v_user_local in (r.origen_local,r.destino_local)) and (v_local is null or v_local in (r.origen_local,r.destino_local))
        and (v_from_ts is null or r.created_at>=v_from_ts) and (v_to_ts is null or r.created_at<v_to_ts)
        and (v_product is null
          or exists(select 1 from public.op_recepcion_items i where i.recepcion_id=r.id and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product))
          or exists(select 1 from public.op_recepcion_extras x where x.recepcion_id=r.id and x.cantidad>0 and public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product)))
    ), rec_lines as materialized (
      select i.* from public.op_recepcion_items i join rec_sessions r on r.id=i.recepcion_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca,i.barras),v_product)
    ), rec_extras as materialized (
      select x.* from public.op_recepcion_extras x join rec_sessions r on r.id=x.recepcion_id
      where x.cantidad>0 and (v_product is null or public.op_busqueda_coincide(concat_ws(' ',x.codigo,x.nombre,x.barras),v_product))
    ), orders as materialized (
      select p.* from public.pedidos p
      where (v_supervisor or v_user_local in (p.origen_local,p.destino_local,p.escala_local)) and (v_local is null or v_local in (p.origen_local,p.destino_local,p.escala_local))
        and (v_from_ts is null or p.created_at>=v_from_ts) and (v_to_ts is null or p.created_at<v_to_ts)
        and (v_product is null or exists(select 1 from public.pedido_productos i where i.pedido_id=p.id and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca),v_product)))
    ), order_lines as materialized (
      select i.*,
        case when coalesce(i.cantidad_recibida,0)>0 then i.cantidad_recibida
          when p.estado='completo' then greatest(coalesce(nullif(i.cantidad_preparada,0),i.cantidad_aceptada,i.cantidad),0)
          else greatest(coalesce(i.cantidad_recibida,0),0) end as analytics_received,
        (p.estado='completo' and coalesce(i.cantidad_recibida,0)=0) as inferred_received
      from public.pedido_productos i join orders p on p.id=i.pedido_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre,i.marca),v_product)
    ), reservations as materialized (
      select r.* from public.op_analytics_reservas_base r
      where (v_supervisor or r.local_nombre=v_user_local) and (v_local is null or r.local_nombre=v_local)
        and (v_from_ts is null or r.created_at>=v_from_ts) and (v_to_ts is null or r.created_at<v_to_ts)
        and (v_product is null or exists(select 1 from public.op_analytics_reserva_items_base i where i.reserva_id=r.id and public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre),v_product)))
    ), reserve_lines as materialized (
      select i.* from public.op_analytics_reserva_items_base i join reservations r on r.id=i.reserva_id
      where v_product is null or public.op_busqueda_coincide(concat_ws(' ',i.codigo,i.nombre),v_product)
    ), activity as materialized (
      select created_at,1::bigint as inventories,0::bigint as logistics,0::bigint as reservations from inv_sessions
      union all select created_at,0,1,0 from repo_sessions
      union all select created_at,0,1,0 from rec_sessions
      union all select created_at,0,1,0 from orders
      union all select created_at,0,0,1 from reservations
    ), trend_rows as (
      select date_trunc(v_grain,a.created_at at time zone 'America/Montevideo')::date as period,
        sum(a.inventories) as inventories,sum(a.logistics) as logistics,sum(a.reservations) as reservations
      from activity a group by 1 order by 1
    ), product_activity as materialized (
      select i.codigo,i.nombre,s.created_at as occurred_at,s.id as source_id,
        i.cantidad::numeric as inventory_counted,0::numeric as reposition_prepared,0::numeric as reception_received,0::numeric as order_requested,0::numeric as reserved
      from inv_lines i join inv_sessions s on s.id=i.sesion_id
      union all select i.codigo,i.nombre,s.created_at,s.id,0,i.preparado,0,0,0 from repo_lines i join repo_sessions s on s.id=i.reposicion_id
      union all select x.codigo,x.nombre,s.created_at,s.id,0,x.cantidad,0,0,0 from repo_extras x join repo_sessions s on s.id=x.reposicion_id
      union all select i.codigo,i.nombre,s.created_at,s.id,0,0,i.recibido,0,0 from rec_lines i join rec_sessions s on s.id=i.recepcion_id
      union all select x.codigo,x.nombre,s.created_at,s.id,0,0,x.cantidad,0,0 from rec_extras x join rec_sessions s on s.id=x.recepcion_id
      union all select i.codigo,i.nombre,s.created_at,s.id,0,0,0,i.cantidad,0 from order_lines i join orders s on s.id=i.pedido_id
      union all select i.codigo,i.nombre,s.created_at,s.id,0,0,0,0,i.cantidad from reserve_lines i join reservations s on s.id=i.reserva_id
    ), product_rows as (
      select p.codigo,(array_agg(p.nombre order by p.occurred_at desc,p.source_id desc,p.nombre desc))[1] as product,
        sum(p.inventory_counted) as inventory_counted,
        sum(p.reposition_prepared) as reposition_prepared,sum(p.reception_received) as reception_received,
        sum(p.order_requested) as order_requested,sum(p.reserved) as reserved,
        sum(p.inventory_counted+p.reposition_prepared+p.reception_received+p.order_requested+p.reserved) as activity
      from product_activity p group by p.codigo order by activity desc,product limit 15
    ), active_locals as (
      select local_nombre as local from inv_sessions
      union select origen_local from repo_sessions union select destino_local from repo_sessions
      union select origen_local from rec_sessions union select destino_local from rec_sessions
      union select origen_local from orders union select destino_local from orders union select escala_local from orders where escala_local is not null
      union select local_nombre from reservations
    )
    select jsonb_build_object(
      'version',1,'module','global','title','Visión 360 · operación completa',
      'subtitle','Lectura transversal de inventarios, reposiciones, remitos, pedidos y reservas.',
      'generated_at',now(),
      'filters',jsonb_build_object('date_from',v_from,'date_to',v_to,'local',v_local,'product',v_product,'granularity',v_grain),
      'scope',jsonb_build_object('supervisor',v_supervisor,'local',v_user_local,'locations',v_locations),
      'kpis',jsonb_build_array(
        jsonb_build_object('key','processes','label','Procesos registrados','value',(select count(*) from activity),'format','number','tone','info','hint','Suma de sesiones, reposiciones, remitos, pedidos y reservas'),
        jsonb_build_object('key','active_locals','label','Locales con actividad','value',(select count(*) from active_locals where local is not null),'format','number'),
        jsonb_build_object('key','inventory_accuracy','label','Exactitud inventario','value',(select case when count(*) filter(where esperado is not null)>0 then round(100.0*count(*) filter(where esperado is not null and cantidad=esperado)/count(*) filter(where esperado is not null),1) end from inv_lines),'format','percent'),
        jsonb_build_object('key','reposition_fulfillment','label','Cumplimiento reposición','value',(select case when sum(pedido_total)>0 then round(100.0*sum(least(preparado,pedido_total))/sum(pedido_total),1) end from repo_lines),'format','percent'),
        jsonb_build_object('key','reception_fulfillment','label','Nivel de recepción','value',(select case when sum(esperado)>0 then round(100.0*sum(least(recibido,esperado))/sum(esperado),1) end from rec_lines),'format','percent'),
        jsonb_build_object('key','order_completion','label','Pedidos completos','value',(select case when count(*) filter(where estado in ('completo','incompleto','denegado'))>0 then round(100.0*count(*) filter(where estado='completo')/count(*) filter(where estado in ('completo','incompleto','denegado')),1) end from orders),'format','percent'),
        jsonb_build_object('key','reservation_delivery','label','Entrega de reservas','value',(select case when sum(cantidad)>0 then round(100.0*sum(cantidad_entregada)/sum(cantidad),1) end from reserve_lines),'format','percent'),
        jsonb_build_object('key','active_work','label','Trabajo abierto','value',
          (select count(*) from inv_sessions where estado='abierta')+(select count(*) from repo_sessions where estado='preparando')+(select count(*) from rec_sessions where estado='en_control')+(select count(*) from orders where estado not in ('completo','incompleto','denegado'))+(select count(*) from reservations where not deleted and estado not in ('completado','cancelado')),
          'format','number','tone','warning')
      ),
      'trend',jsonb_build_object('title','Procesos iniciados por período',
        'series',jsonb_build_array(jsonb_build_object('key','inventories','label','Inventarios','format','number'),jsonb_build_object('key','logistics','label','Logística y pedidos','format','number'),jsonb_build_object('key','reservations','label','Reservas','format','number')),
        'points',coalesce((select jsonb_agg(jsonb_build_object('period',period,'label',case when v_grain='month' then to_char(period,'MM/YYYY') else to_char(period,'DD/MM') end,'inventories',inventories,'logistics',logistics,'reservations',reservations) order by period) from trend_rows),'[]'::jsonb)),
      'breakdowns',jsonb_build_array(
        jsonb_build_object('key','modules','title','Resumen por módulo','description','Las unidades de módulos diferentes no se suman: pueden describir etapas de la misma mercadería.',
          'columns',jsonb_build_array(jsonb_build_object('key','module','label','Módulo'),jsonb_build_object('key','records','label','Procesos','format','number'),jsonb_build_object('key','planned','label','Planificado','format','number'),jsonb_build_object('key','actual','label','Registrado','format','number'),jsonb_build_object('key','rate','label','Indicador','format','percent')),
          'rows',jsonb_build_array(
            jsonb_build_object('module','Inventarios','records',(select count(*) from inv_sessions),'planned',coalesce((select sum(esperado) from inv_lines),0),'actual',coalesce((select sum(cantidad) from inv_lines),0),'rate',(select case when count(*) filter(where esperado is not null)>0 then round(100.0*count(*) filter(where esperado is not null and cantidad=esperado)/count(*) filter(where esperado is not null),1) end from inv_lines)),
            jsonb_build_object('module','Reposiciones','records',(select count(*) from repo_sessions),'planned',coalesce((select sum(pedido_total) from repo_lines),0),'actual',coalesce((select sum(preparado) from repo_lines),0)+coalesce((select sum(cantidad) from repo_extras),0),'rate',(select case when sum(pedido_total)>0 then round(100.0*sum(least(preparado,pedido_total))/sum(pedido_total),1) end from repo_lines)),
            jsonb_build_object('module','Remitos / recepción','records',(select count(*) from rec_sessions),'planned',coalesce((select sum(esperado) from rec_lines),0),'actual',coalesce((select sum(recibido) from rec_lines),0)+coalesce((select sum(cantidad) from rec_extras),0),'rate',(select case when sum(esperado)>0 then round(100.0*sum(least(recibido,esperado))/sum(esperado),1) end from rec_lines)),
            jsonb_build_object('module','Pedidos','records',(select count(*) from orders),'planned',coalesce((select sum(cantidad) from order_lines),0),'actual',coalesce((select sum(analytics_received) from order_lines),0),'rate',(select case when count(*) filter(where estado in ('completo','incompleto','denegado'))>0 then round(100.0*count(*) filter(where estado='completo')/count(*) filter(where estado in ('completo','incompleto','denegado')),1) end from orders)),
            jsonb_build_object('module','Reservas','records',(select count(*) from reservations),'planned',coalesce((select sum(cantidad) from reserve_lines),0),'actual',coalesce((select sum(cantidad_entregada) from reserve_lines),0),'rate',(select case when sum(cantidad)>0 then round(100.0*sum(cantidad_entregada)/sum(cantidad),1) end from reserve_lines))
          )),
        jsonb_build_object('key','products','title','Actividad por producto entre módulos','description','Sirve para detectar SKU de alto movimiento. No representa existencias ni debe sumarse como stock.',
          'columns',jsonb_build_array(jsonb_build_object('key','codigo','label','Código'),jsonb_build_object('key','product','label','Producto'),jsonb_build_object('key','inventory_counted','label','Inventario','format','number'),jsonb_build_object('key','reposition_prepared','label','Preparado','format','number'),jsonb_build_object('key','reception_received','label','Recibido','format','number'),jsonb_build_object('key','order_requested','label','Pedidos','format','number'),jsonb_build_object('key','reserved','label','Reservas','format','number')),
          'rows',coalesce((select jsonb_agg(to_jsonb(p)-'activity' order by p.activity desc,p.product) from product_rows p),'[]'::jsonb)),
        jsonb_build_object('key','attention','title','Señales que requieren atención',
          'columns',jsonb_build_array(jsonb_build_object('key','signal','label','Señal'),jsonb_build_object('key','value','label','Cantidad','format','number'),jsonb_build_object('key','meaning','label','Lectura')),
          'rows',jsonb_build_array(
            jsonb_build_object('signal','Desvío absoluto de inventario','value',coalesce((select sum(abs(cantidad-esperado)) from inv_lines where esperado is not null),0),'meaning','Unidades diferentes al balance'),
            jsonb_build_object('signal','Faltante en reposiciones','value',coalesce((select sum(greatest(pedido_total-preparado,0)) from repo_lines),0),'meaning','Unidades físicas no preparadas'),
            jsonb_build_object('signal','Faltante en remitos','value',coalesce((select sum(greatest(esperado-recibido,0)) from rec_lines),0),'meaning','Unidades esperadas no recibidas'),
            jsonb_build_object('signal','Pedidos con incidencia','value',(select count(*) from orders where estado in ('incompleto','denegado')),'meaning','Cierre incompleto o denegado'),
            jsonb_build_object('signal','Pedidos con recepción inferida','value',(select count(distinct pedido_id) from order_lines where inferred_received),'meaning','Completos antiguos reconstruidos desde preparación o aceptación'),
            jsonb_build_object('signal','Reservas alguna vez vencidas','value',(select count(*) from reservations r where r.estado='vencido' or exists(select 1 from public.op_analytics_reserva_eventos_base e where e.reserva_id=r.id and (e.accion='vencimiento' or e.estado='vencido'))),'meaning','Llegaron al límite sin cierre')
          )),
        jsonb_build_object('key','recent','title','Actividad individual reciente','description','Últimos 20 registros del alcance. No expone clientes ni otros datos personales; el detalle se consulta en cada módulo.',
          'columns',jsonb_build_array(jsonb_build_object('key','module','label','Módulo'),jsonb_build_object('key','reference','label','Referencia'),jsonb_build_object('key','date','label','Fecha'),jsonb_build_object('key','location','label','Local / ruta'),jsonb_build_object('key','status','label','Estado')),
          'rows',coalesce((select jsonb_agg(to_jsonb(x)-'sort_at' order by x.sort_at desc) from (
            select * from (
              select 'Inventario'::text as module,'#'||left(s.id::text,8) as reference,to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI') as date,s.local_nombre as location,s.estado as status,s.created_at as sort_at from inv_sessions s
              union all select 'Reposición','#'||left(s.id::text,8),to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI'),s.origen_local||' → '||s.destino_local,s.estado,s.created_at from repo_sessions s
              union all select 'Recepción','#'||left(s.id::text,8),to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI'),s.origen_local||' → '||s.destino_local,s.estado,s.created_at from rec_sessions s
              union all select 'Pedido','#'||left(s.id::text,8),to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI'),s.origen_local||' → '||s.destino_local,s.estado,s.created_at from orders s
              union all select 'Reserva','#'||left(s.id::text,8),to_char(s.created_at at time zone 'America/Montevideo','DD/MM/YYYY HH24:MI'),s.local_nombre,case when s.deleted then 'eliminada' else s.estado end,s.created_at from reservations s
            ) recent_all order by sort_at desc limit 20
          ) x),'[]'::jsonb))
      ),
      'cross_module',jsonb_build_array(
        jsonb_build_object('key','inventory','label','Inventarios','primary',(select count(*) from inv_sessions),'primary_label','Sesiones','secondary',coalesce((select sum(cantidad) from inv_lines),0),'secondary_label','Unidades contadas'),
        jsonb_build_object('key','reposition','label','Reposiciones','primary',(select count(*) from repo_sessions),'primary_label','Procesos','secondary',coalesce((select sum(preparado) from repo_lines),0)+coalesce((select sum(cantidad) from repo_extras),0),'secondary_label','Unidades preparadas y extra'),
        jsonb_build_object('key','reception','label','Remitos / recepción','primary',(select count(*) from rec_sessions),'primary_label','Controles','secondary',coalesce((select sum(recibido) from rec_lines),0)+coalesce((select sum(cantidad) from rec_extras),0),'secondary_label','Unidades recibidas y extra'),
        jsonb_build_object('key','orders','label','Pedidos','primary',(select count(*) from orders),'primary_label','Pedidos','secondary',coalesce((select sum(cantidad) from order_lines),0),'secondary_label','Unidades solicitadas'),
        jsonb_build_object('key','reservations','label','Reservas','primary',(select count(*) from reservations),'primary_label','Reservas','secondary',coalesce((select sum(cantidad) from reserve_lines),0),'secondary_label','Unidades reservadas')
      ),
      'notes',jsonb_build_array(
        'Los módulos pueden describir distintas etapas de la misma mercadería; por eso la visión global compara, pero no suma, sus unidades como si fueran stock.',
        'Inventario es una fotografía por sesión. Sin un libro de movimientos y saldos no es posible reconstruir stock actual ni valuación histórica.',
        'Los cruces usan vínculos explícitos. Coincidencias de ruta, remito o fecha sin identificador común quedan fuera para evitar conclusiones falsas.',
        'En pedidos completos antiguos sin cantidad recibida estructurada se usa la mejor cantidad disponible, igual que en el panel específico de Pedidos.',
        'Reservas eliminadas con auditoría sí son retroactivas; pedidos y operaciones abiertas eliminados antes de contar con auditoría no pueden recuperarse.'
      )
    ) into v_result;
  end if;

  return v_result;
end $$;

revoke all on function public.op_dashboard_360(text,jsonb) from public,anon;
grant execute on function public.op_dashboard_360(text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
