-- Separa el destino comercial de la reserva del origen y recorrido de cada producto.

begin;

alter table public.op_reservas add column if not exists finalidad text;
alter table public.op_reservas add column if not exists entrega_tipo text;
update public.op_reservas set finalidad=case
  when lower(coalesce(motivo_nombre,'')) like '%web%' then 'pedido_web'
  when lower(coalesce(motivo_nombre,'')) like '%repart%' then 'reparto'
  when lower(coalesce(motivo_nombre,'')) like '%traslado%intern%' then 'traslado_interno'
  else 'retiro_cliente' end where finalidad is null;
alter table public.op_reservas alter column finalidad set default 'retiro_cliente';
alter table public.op_reservas alter column finalidad set not null;
alter table public.op_reservas drop constraint if exists op_reservas_finalidad_check;
alter table public.op_reservas add constraint op_reservas_finalidad_check
  check (finalidad in ('retiro_cliente','reparto','pedido_web','traslado_interno','otro'));
alter table public.op_reservas drop constraint if exists op_reservas_entrega_tipo_check;
alter table public.op_reservas add constraint op_reservas_entrega_tipo_check
  check (entrega_tipo is null or entrega_tipo in ('retiro_local','reparto_local','agencia'));
update public.op_reservas set entrega_tipo=case when finalidad='retiro_cliente' then 'retiro_local'
  when finalidad='reparto' then 'reparto_local' when finalidad='pedido_web' then coalesce(entrega_tipo,'retiro_local') end;

alter table public.op_reserva_items add column if not exists cantidad_origen integer not null default 0;
alter table public.op_reserva_items add column if not exists traslado_tipo text;
alter table public.op_reserva_items add column if not exists traslado_detalle text;
alter table public.op_reserva_items add column if not exists tracking text;
alter table public.op_reserva_items add column if not exists origen_preparado_at timestamptz;
alter table public.op_reserva_items drop constraint if exists op_reserva_items_cantidad_origen_check;
alter table public.op_reserva_items add constraint op_reserva_items_cantidad_origen_check
  check (cantidad_origen between 0 and cantidad);
alter table public.op_reserva_items drop constraint if exists op_reserva_items_traslado_tipo_check;
alter table public.op_reserva_items add constraint op_reserva_items_traslado_tipo_check
  check (traslado_tipo is null or traslado_tipo in ('reposicion','agencia','propio','coordinar'));
alter table public.op_reserva_items drop constraint if exists op_reserva_items_estado_check;
alter table public.op_reserva_items add constraint op_reserva_items_estado_check check (estado in (
  'pendiente','preparado_origen','en_transito','recibido','separado','entregado'
));
update public.op_reserva_items i set
  fecha_estimada=case when i.procedencia='local' then null else i.fecha_estimada end,
  remito_numero=case when i.procedencia='local' then null else i.remito_numero end,
  traslado_tipo=case when i.procedencia='pedido_local' then coalesce(i.traslado_tipo,
    case when exists(select 1 from public.pedidos p where p.id=i.pedido_id and p.reposicion_id is not null) then 'reposicion'
      when exists(select 1 from public.pedidos p where p.id=i.pedido_id and nullif(trim(coalesce(p.transporte,'')),'') is not null) then 'agencia'
      else 'coordinar' end) end,
  cantidad_origen=case when i.procedencia='pedido_local' then least(i.cantidad,greatest(i.cantidad_origen,coalesce((
    select sum(coalesce(pp.cantidad_preparada,0))::integer from public.pedido_productos pp where pp.pedido_id=i.pedido_id and pp.codigo=i.codigo
  ),0))) else 0 end;

create or replace function public.op_reserva_insertar_items(p_reserva uuid,p_items jsonb,p_actor jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_reservas; pedido public.pedidos; v_pedido_id uuid; existente_id uuid; ruta record;
begin
  select * into r from public.op_reservas where id=p_reserva;
  if r.id is null then raise exception 'Reserva no disponible'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Agregá al menos un producto'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where nullif(trim(x->>'codigo'),'') is null or nullif(trim(x->>'nombre'),'') is null
    or coalesce(x->>'cantidad','')!~'^\d{1,6}$' or (x->>'cantidad')::integer<1
    or coalesce(x->>'cantidad_local','0')!~'^\d{1,6}$' or (x->>'cantidad_local')::integer>(x->>'cantidad')::integer
    or coalesce(x->>'cantidad_origen','0')!~'^\d{1,6}$' or (x->>'cantidad_origen')::integer>(x->>'cantidad')::integer
    or coalesce(x->>'procedencia','') not in ('local','proveedor','pedido_local')) then
    raise exception 'Revisá los productos, cantidades y orígenes';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where x->>'procedencia'='proveedor' and nullif(trim(x->>'proveedor_nombre'),'') is null) then
    raise exception 'Indicá el proveedor de cada producto que lo espera';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where x->>'procedencia'='pedido_local' and (
    coalesce(x->>'pedido_local_gestion','') not in ('crear','existente','externo') or nullif(trim(x->>'origen_local'),'') is null
    or coalesce(nullif(x->>'traslado_tipo',''),'coordinar') not in ('reposicion','agencia','propio','coordinar')
    or x->>'origen_local'=r.local_nombre or not exists(select 1 from public.locales l where l.nombre=x->>'origen_local'))) then
    raise exception 'Revisá el local, el pedido y la forma de traslado de los productos solicitados';
  end if;
  for existente_id in select distinct (x->>'pedido_existente_id')::uuid from jsonb_array_elements(p_items) x
    where x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='existente' and coalesce(x->>'pedido_existente_id','')~'^[0-9a-fA-F-]{36}$'
  loop
    select * into pedido from public.pedidos where id=existente_id for update;
    if pedido.id is null or pedido.destino_local<>r.local_nombre or pedido.estado='denegado' or (pedido.reserva_id is not null and pedido.reserva_id<>r.id) then
      raise exception 'El pedido existente no está disponible para esta reserva';
    end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where x->>'pedido_existente_id'=existente_id::text
      and not exists(select 1 from public.pedido_productos pp where pp.pedido_id=existente_id and pp.codigo=x->>'codigo')) then
      raise exception 'El pedido existente no contiene uno de los productos seleccionados';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_items) x where x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='existente'
    and coalesce(x->>'pedido_existente_id','')!~'^[0-9a-fA-F-]{36}$') then raise exception 'Elegí el pedido existente de cada producto'; end if;

  insert into public.op_reserva_items(reserva_id,codigo,nombre,cantidad,cantidad_local,cantidad_origen,procedencia,origen_local,proveedor_nombre,
    pedido_local_gestion,traslado_tipo,traslado_detalle,tracking,fecha_estimada,remito_numero,comentario,estado,pedido_id,origen_preparado_at)
  select r.id,left(trim(x->>'codigo'),80),left(trim(x->>'nombre'),240),(x->>'cantidad')::integer,coalesce((x->>'cantidad_local')::integer,0),
    case when x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='externo' then coalesce((x->>'cantidad_origen')::integer,0) else 0 end,
    x->>'procedencia',case when x->>'procedencia'='pedido_local' then nullif(left(trim(x->>'origen_local'),120),'') end,
    case when x->>'procedencia'='proveedor' then nullif(left(trim(x->>'proveedor_nombre'),120),'') end,
    case when x->>'procedencia'='pedido_local' then x->>'pedido_local_gestion' end,
    case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'traslado_tipo',''),'coordinar') end,
    case when x->>'procedencia'='pedido_local' then nullif(left(trim(coalesce(x->>'traslado_detalle','')),120),'') end,
    case when x->>'procedencia'='pedido_local' then nullif(left(trim(coalesce(x->>'tracking','')),120),'') end,
    case when x->>'procedencia'<>'local' and coalesce(x->>'fecha_estimada','')~'^\d{4}-\d{2}-\d{2}$' then (x->>'fecha_estimada')::date end,
    case when x->>'procedencia'<>'local' then nullif(left(trim(coalesce(x->>'remito_numero','')),100),'') end,
    nullif(left(trim(coalesce(x->>'comentario','')),500),''),
    case when coalesce((x->>'cantidad_local')::integer,0)>0 then 'separado'
      when x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='externo' and coalesce((x->>'cantidad_origen')::integer,0)>0 then 'preparado_origen' else 'pendiente' end,
    case when x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='existente' then (x->>'pedido_existente_id')::uuid end,
    case when x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='externo' and coalesce((x->>'cantidad_origen')::integer,0)>0 then now() end
  from jsonb_array_elements(p_items) x;

  for existente_id in select distinct i.pedido_id from public.op_reserva_items i where i.reserva_id=r.id and i.pedido_id is not null loop
    update public.pedidos set reserva_id=r.id,updated_at=now() where id=existente_id;
  end loop;
  for ruta in select i.origen_local,i.traslado_tipo,max(i.traslado_detalle) traslado_detalle,max(l.almacen) almacen
    from public.op_reserva_items i join public.locales l on l.nombre=i.origen_local
    where i.reserva_id=r.id and i.procedencia='pedido_local' and i.pedido_local_gestion='crear'
    group by i.origen_local,i.traslado_tipo
  loop
    insert into public.pedidos(origen_local,origen_almacen,destino_local,destino_almacen,cliente,telefono,notas,estado,creado_por,canal_creacion,reserva_id,generado_desde_reserva)
    values(ruta.origen_local,ruta.almacen,r.local_nombre,r.local_almacen,nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),r.cliente_telefono,
      'Reserva #'||coalesce(r.numero::text,r.codigo)||' · Traslado previsto: '||case ruta.traslado_tipo when 'reposicion' then 'próxima reposición' when 'agencia' then 'agencia o tercero' when 'propio' then 'traslado propio' else 'a coordinar' end||
      case when ruta.traslado_detalle is not null then ' · '||ruta.traslado_detalle else '' end||case when r.referencia_externa is not null then ' · Ref. '||r.referencia_externa else '' end,
      'pendiente',(p_actor->>'user_id')::uuid,'interno',r.id,true) returning id into v_pedido_id;
    insert into public.pedido_productos(pedido_id,codigo,nombre,cantidad)
      select v_pedido_id,i.codigo,max(i.nombre),sum(i.cantidad)::integer from public.op_reserva_items i
      where i.reserva_id=r.id and i.procedencia='pedido_local' and i.pedido_local_gestion='crear'
        and i.origen_local=ruta.origen_local and i.traslado_tipo=ruta.traslado_tipo group by i.codigo;
    update public.op_reserva_items set pedido_id=v_pedido_id where reserva_id=r.id and procedencia='pedido_local' and pedido_local_gestion='crear'
      and origen_local=ruta.origen_local and traslado_tipo=ruta.traslado_tipo;
    insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre) values(v_pedido_id,'pendiente',(p_actor->>'user_id')::uuid,p_actor->>'name');
    insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
      select p.id,'Nuevo pedido vinculado a una reserva','#'||coalesce(r.numero::text,r.codigo)||' · '||r.local_nombre,v_pedido_id
      from public.perfiles p where p.approved=true and p.local_nombre=ruta.origen_local;
  end loop;
  update public.op_reservas set
    pedido_local_gestion=(select case when count(distinct i.pedido_local_gestion)=1 then max(i.pedido_local_gestion) end from public.op_reserva_items i where i.reserva_id=r.id and i.procedencia='pedido_local'),
    pedido_local_origen=(select case when count(distinct i.origen_local)=1 then max(i.origen_local) end from public.op_reserva_items i where i.reserva_id=r.id and i.procedencia='pedido_local')
  where id=r.id;
end $$;
revoke all on function public.op_reserva_insertar_items(uuid,jsonb,jsonb) from public,anon,authenticated;

do $$ begin
  if to_regprocedure('public.op_reserva_crear_v2_base(jsonb,text)') is null then
    execute 'alter function public.op_reserva_crear_v2(jsonb,text) rename to op_reserva_crear_v2_base';
  end if;
  if to_regprocedure('public.op_reserva_editar_base(uuid,jsonb,text)') is null then
    execute 'alter function public.op_reserva_editar(uuid,jsonb,text) rename to op_reserva_editar_base';
  end if;
end $$;
revoke all on function public.op_reserva_crear_v2_base(jsonb,text) from public,anon,authenticated;
revoke all on function public.op_reserva_editar_base(uuid,jsonb,text) from public,anon,authenticated;

create or replace function public.op_reserva_crear_v2(p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; rid uuid; v_finalidad text; v_entrega text; v_nombre text; v_referencia text; v_direccion text;
begin
  v_finalidad:=coalesce(nullif(p_datos->>'finalidad',''),'retiro_cliente');
  if v_finalidad not in ('retiro_cliente','reparto','pedido_web','traslado_interno','otro') then raise exception 'Elegí para qué se separa la mercadería'; end if;
  v_entrega:=case when v_finalidad='retiro_cliente' then 'retiro_local' when v_finalidad='reparto' then 'reparto_local'
    when v_finalidad='pedido_web' then coalesce(nullif(p_datos->>'entrega_tipo',''),'retiro_local') end;
  if v_finalidad='pedido_web' and v_entrega not in ('retiro_local','reparto_local','agencia') then raise exception 'Elegí cómo se entregará el pedido web'; end if;
  v_referencia:=nullif(left(trim(coalesce(p_datos->>'referencia_externa','')),120),'');
  v_direccion:=nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),'');
  if v_finalidad='pedido_web' and v_referencia is null then raise exception 'Ingresá el número del pedido web'; end if;
  if (v_finalidad='reparto' or (v_finalidad='pedido_web' and v_entrega<>'retiro_local')) and v_direccion is null then raise exception 'Ingresá la dirección de entrega'; end if;
  result:=public.op_reserva_crear_v2_base(p_datos,p_acceso); rid:=(result->>'id')::uuid;
  v_nombre:=case v_finalidad when 'retiro_cliente' then 'Retiro en tienda' when 'reparto' then 'Reparto'
    when 'pedido_web' then 'Pedido web' when 'traslado_interno' then 'Traslado interno' else 'Otro destino' end;
  update public.op_reservas r set finalidad=v_finalidad,entrega_tipo=v_entrega,motivo_nombre=v_nombre,
    motivo_id=(select m.id from public.op_reserva_motivos m where m.local_nombre=r.local_nombre and lower(m.nombre)=lower(v_nombre) and m.activo order by m.orden limit 1)
    where r.id=rid;
  update public.op_reserva_eventos set detalle=detalle||jsonb_build_object('finalidad',v_finalidad,'entrega_tipo',v_entrega)
    where reserva_id=rid and accion='crear';
  return result||jsonb_build_object('purpose',v_finalidad,'delivery',v_entrega);
end $$;

create or replace function public.op_reserva_editar(p_reserva uuid,p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; v_finalidad text; v_entrega text; v_nombre text; v_referencia text; v_direccion text;
begin
  v_finalidad:=coalesce(nullif(p_datos->>'finalidad',''),'retiro_cliente');
  if v_finalidad not in ('retiro_cliente','reparto','pedido_web','traslado_interno','otro') then raise exception 'Elegí para qué se separa la mercadería'; end if;
  v_entrega:=case when v_finalidad='retiro_cliente' then 'retiro_local' when v_finalidad='reparto' then 'reparto_local'
    when v_finalidad='pedido_web' then coalesce(nullif(p_datos->>'entrega_tipo',''),'retiro_local') end;
  if v_finalidad='pedido_web' and v_entrega not in ('retiro_local','reparto_local','agencia') then raise exception 'Elegí cómo se entregará el pedido web'; end if;
  v_referencia:=nullif(left(trim(coalesce(p_datos->>'referencia_externa','')),120),'');
  v_direccion:=nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),'');
  if v_finalidad='pedido_web' and v_referencia is null then raise exception 'Ingresá el número del pedido web'; end if;
  if (v_finalidad='reparto' or (v_finalidad='pedido_web' and v_entrega<>'retiro_local')) and v_direccion is null then raise exception 'Ingresá la dirección de entrega'; end if;
  result:=public.op_reserva_editar_base(p_reserva,p_datos,p_acceso);
  v_nombre:=case v_finalidad when 'retiro_cliente' then 'Retiro en tienda' when 'reparto' then 'Reparto'
    when 'pedido_web' then 'Pedido web' when 'traslado_interno' then 'Traslado interno' else 'Otro destino' end;
  update public.op_reservas r set finalidad=v_finalidad,entrega_tipo=v_entrega,motivo_nombre=v_nombre,
    motivo_id=(select m.id from public.op_reserva_motivos m where m.local_nombre=r.local_nombre and lower(m.nombre)=lower(v_nombre) and m.activo order by m.orden limit 1)
    where r.id=p_reserva;
  update public.op_reserva_eventos set detalle=detalle||jsonb_build_object('finalidad',v_finalidad,'entrega_tipo',v_entrega)
    where id=(select max(id) from public.op_reserva_eventos where reserva_id=p_reserva and accion='editar');
  return public.op_reserva_detalle(p_reserva,p_acceso);
end $$;

create or replace function public.op_reserva_actualizar_item(p_item uuid,p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; i public.op_reserva_items; nueva integer; origen integer; estado_nuevo text; motivo text; traslado text;
begin
  a:=public.op_reserva_actor(p_acceso); select * into i from public.op_reserva_items where id=p_item for update;
  if i.id is null or not public.op_reserva_puede_ver(i.reserva_id,a) then raise exception 'Producto no disponible'; end if;
  if exists(select 1 from public.op_reservas r where r.id=i.reserva_id and r.estado in ('completado','cancelado')) then raise exception 'La reserva está cerrada; usá Corregir cierre antes de modificar productos'; end if;
  nueva:=coalesce((p_datos->>'cantidad_local')::integer,i.cantidad_local);
  if nueva<0 or nueva+i.cantidad_entregada>i.cantidad then raise exception 'La cantidad en el local debe estar entre cero y lo que todavía falta entregar'; end if;
  origen:=case when i.procedencia='pedido_local' and i.pedido_local_gestion='externo' then coalesce((p_datos->>'cantidad_origen')::integer,i.cantidad_origen) else i.cantidad_origen end;
  origen:=least(greatest(origen,0),greatest(0,i.cantidad-i.cantidad_entregada-nueva));
  traslado:=case when i.procedencia='pedido_local' then coalesce(nullif(p_datos->>'traslado_tipo',''),i.traslado_tipo,'coordinar') end;
  if traslado is not null and traslado not in ('reposicion','agencia','propio','coordinar') then raise exception 'Elegí una forma de traslado válida'; end if;
  motivo:=nullif(trim(coalesce(p_datos->>'motivo_correccion','')),'');
  if nueva<i.cantidad_local and motivo is null then raise exception 'Indicá el motivo de la corrección'; end if;
  estado_nuevo:=coalesce(nullif(p_datos->>'estado',''),case when nueva+i.cantidad_entregada>=i.cantidad then 'separado' when nueva>0 then 'recibido' when origen>0 then 'preparado_origen' else i.estado end);
  if estado_nuevo not in ('pendiente','preparado_origen','en_transito','recibido','separado','entregado') then raise exception 'Estado de producto inválido'; end if;
  if i.procedencia='local' and estado_nuevo in ('preparado_origen','en_transito') then raise exception 'La mercadería local no necesita traslado'; end if;
  if estado_nuevo='en_transito' and i.pedido_local_gestion='externo' and origen<1 then raise exception 'Indicá cuántas unidades salieron del local de origen'; end if;
  update public.op_reserva_items set cantidad_local=nueva,cantidad_origen=origen,estado=estado_nuevo,
    origen_preparado_at=case when origen>0 then coalesce(origen_preparado_at,now()) else null end,
    fecha_estimada=case when procedencia='local' then null when p_datos ? 'fecha_estimada' then case when coalesce(p_datos->>'fecha_estimada','')~'^\d{4}-\d{2}-\d{2}$' then (p_datos->>'fecha_estimada')::date end else fecha_estimada end,
    remito_numero=case when procedencia='local' then null when p_datos ? 'remito_numero' then nullif(left(trim(coalesce(p_datos->>'remito_numero','')),100),'') else remito_numero end,
    traslado_tipo=traslado,
    traslado_detalle=case when procedencia='pedido_local' and p_datos ? 'traslado_detalle' then nullif(left(trim(coalesce(p_datos->>'traslado_detalle','')),120),'') else traslado_detalle end,
    tracking=case when procedencia='pedido_local' and p_datos ? 'tracking' then nullif(left(trim(coalesce(p_datos->>'tracking','')),120),'') else tracking end,
    comentario=case when p_datos ? 'comentario' then nullif(left(trim(coalesce(p_datos->>'comentario','')),500),'') else comentario end,updated_at=now() where id=i.id;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(i.reserva_id,'actualizar_producto',estado_nuevo,jsonb_build_object('item_id',i.id,'codigo',i.codigo,'antes_local',i.cantidad_local,'despues_local',nueva,'separado_origen',origen,'traslado',traslado,'motivo',motivo),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  perform public.op_reserva_recalcular(i.reserva_id,a->>'name');
  return public.op_reserva_detalle(i.reserva_id,p_acceso);
end $$;

create or replace function public.op_reserva_detalle(p_reserva uuid,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; items jsonb; comments jsonb; events jsonb;
begin
  a:=public.op_reserva_actor(p_acceso); perform public.op_reservas_actualizar_vencidas();
  if not public.op_reserva_puede_ver(p_reserva,a) then raise exception 'No tenés acceso a esta reserva'; end if;
  select * into r from public.op_reservas where id=p_reserva;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]') into items from (
    select i.*,p.estado pedido_estado,p.reposicion_id pedido_reposicion_id,p.recepcion_id pedido_recepcion_id,
      least(greatest(0,i.cantidad-i.cantidad_local-i.cantidad_entregada),greatest(i.cantidad_origen,coalesce((select sum(coalesce(pp.cantidad_preparada,0))::integer from public.pedido_productos pp where pp.pedido_id=i.pedido_id and pp.codigo=i.codigo),0))) cantidad_preparada_origen,
      case when p.reposicion_id is not null then 'reposicion' when nullif(trim(coalesce(p.transporte,'')),'') is not null then coalesce(i.traslado_tipo,'agencia') else i.traslado_tipo end traslado_tipo_actual,
      coalesce(nullif(p.transporte,''),i.traslado_detalle) traslado_actual,coalesce(nullif(p.tracking,''),i.tracking) tracking_actual,coalesce(nullif(p.remito,''),i.remito_numero) remito_actual
    from public.op_reserva_items i left join public.pedidos p on p.id=i.pedido_id where i.reserva_id=r.id
  ) x;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into comments from (select id,texto,autor_nombre,created_at from public.op_reserva_comentarios where reserva_id=r.id order by created_at desc limit 100) x;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into events from (select id,accion,estado,detalle,autor_nombre,created_at from public.op_reserva_eventos where reserva_id=r.id order by created_at desc limit 200) x;
  return jsonb_build_object('reservation',to_jsonb(r),'items',items,'comments',comments,'events',events);
end $$;

create or replace function public.op_reserva_listar(p_filtros jsonb default '{}'::jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; result jsonb; v_local text; v_history boolean; q text;
begin
  a:=public.op_reserva_actor(p_acceso); perform public.op_reservas_actualizar_vencidas();
  v_local:=case when coalesce((a->>'supervisor')::boolean,false) then nullif(trim(p_filtros->>'local'),'') else a->>'local' end;
  v_history:=coalesce((p_filtros->>'history')::boolean,false); q:=lower(unaccent(trim(coalesce(p_filtros->>'search',''))));
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]') into result from (
    select r.id,r.numero,r.codigo,r.local_nombre,r.motivo_nombre,r.finalidad,r.entrega_tipo,r.responsable_nombre,r.cliente_nombre,r.cliente_apellido,r.cliente_telefono,
      r.estado,r.mercaderia_local_at,r.vencimiento_at,r.fecha_estimada,r.referencia_externa,r.created_at,r.updated_at,
      count(i.id)::integer productos,coalesce(sum(i.cantidad),0)::integer unidades,coalesce(sum(i.cantidad_local),0)::integer unidades_local,coalesce(sum(i.cantidad_entregada),0)::integer unidades_entregadas
    from public.op_reservas r left join public.op_reserva_items i on i.reserva_id=r.id
    where (coalesce((a->>'supervisor')::boolean,false) or r.local_nombre=a->>'local') and (v_local is null or r.local_nombre=v_local)
      and (case when v_history then r.estado in ('completado','cancelado') else r.estado not in ('completado','cancelado') end)
      and (nullif(p_filtros->>'estado','') is null or r.estado=p_filtros->>'estado')
      and (q='' or lower(unaccent(concat_ws(' ',r.numero::text,r.codigo,r.cliente_nombre,r.cliente_apellido,r.cliente_telefono,r.motivo_nombre,r.finalidad,r.responsable_nombre,r.referencia_externa,i.codigo,i.nombre))) like '%'||q||'%')
    group by r.id order by r.updated_at desc limit 300
  ) x;
  return result;
end $$;

create or replace function public.op_reserva_qr_detalle(p_token text)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare r public.op_reservas; items jsonb;
begin
  select * into r from public.op_reservas where qr_token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex');
  if r.id is null then return jsonb_build_object('ok',false,'error','El QR no es válido o fue reemplazado'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('codigo',i.codigo,'nombre',i.nombre,'cantidad',i.cantidad,'cantidad_local',i.cantidad_local,'cantidad_entregada',i.cantidad_entregada,
    'cantidad_origen',i.cantidad_origen,'cantidad_preparada_origen',least(greatest(0,i.cantidad-i.cantidad_local-i.cantidad_entregada),greatest(i.cantidad_origen,coalesce((select sum(coalesce(pp.cantidad_preparada,0))::integer from public.pedido_productos pp where pp.pedido_id=i.pedido_id and pp.codigo=i.codigo),0))),
    'procedencia',i.procedencia,'proveedor_nombre',i.proveedor_nombre,'pedido_local_gestion',i.pedido_local_gestion,'origen_local',i.origen_local,'estado',i.estado,
    'traslado_tipo',i.traslado_tipo,'traslado_tipo_actual',case when p.reposicion_id is not null then 'reposicion' when nullif(trim(coalesce(p.transporte,'')),'') is not null then coalesce(i.traslado_tipo,'agencia') else i.traslado_tipo end,
    'traslado_actual',coalesce(nullif(p.transporte,''),i.traslado_detalle),'tracking_actual',coalesce(nullif(p.tracking,''),i.tracking),'fecha_estimada',i.fecha_estimada,'remito_numero',coalesce(nullif(p.remito,''),i.remito_numero)) order by i.created_at),'[]') into items
    from public.op_reserva_items i left join public.pedidos p on p.id=i.pedido_id where i.reserva_id=r.id;
  return jsonb_build_object('ok',true,'reservation',jsonb_build_object('number',r.numero,'code',r.codigo,'local',r.local_nombre,'warehouse',r.local_almacen,
    'reason',r.motivo_nombre,'purpose',r.finalidad,'delivery',r.entrega_tipo,'customer',nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),'phone',r.cliente_telefono,
    'responsible',r.responsable_nombre,'state',r.estado,'created_at',r.created_at,'merchandise_at',r.mercaderia_local_at,'expires_at',r.vencimiento_at,'reference',r.referencia_externa,
    'location',(select ubicacion_reservas from public.op_reserva_config_local where local_nombre=r.local_nombre),'items',items));
end $$;

revoke all on function public.op_reserva_crear_v2(jsonb,text) from public;
revoke all on function public.op_reserva_editar(uuid,jsonb,text) from public;
revoke execute on function public.op_reserva_editar(uuid,jsonb,text) from anon;
revoke execute on function public.op_reserva_actualizar_item(uuid,jsonb,text) from anon;
revoke execute on function public.op_reserva_detalle(uuid,text) from anon;
revoke execute on function public.op_reserva_listar(jsonb,text) from anon;
grant execute on function public.op_reserva_crear_v2(jsonb,text) to anon,authenticated;
grant execute on function public.op_reserva_editar(uuid,jsonb,text) to authenticated;
grant execute on function public.op_reserva_actualizar_item(uuid,jsonb,text) to authenticated;
grant execute on function public.op_reserva_detalle(uuid,text) to authenticated;
grant execute on function public.op_reserva_listar(jsonb,text) to authenticated;

notify pgrst,'reload schema';
commit;
