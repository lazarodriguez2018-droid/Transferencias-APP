-- Origen y seguimiento por producto, con calendarios de recepción por ruta.

begin;

alter table public.op_reserva_items add column if not exists proveedor_nombre text;
alter table public.op_reserva_items add column if not exists pedido_local_gestion text;
alter table public.op_reserva_items drop constraint if exists op_reserva_items_pedido_local_gestion_check;
alter table public.op_reserva_items add constraint op_reserva_items_pedido_local_gestion_check
  check (pedido_local_gestion is null or pedido_local_gestion in ('crear','existente','externo'));

update public.op_reserva_items i set
  proveedor_nombre=case when i.procedencia='proveedor' then coalesce(i.proveedor_nombre,'Proveedor no especificado') else null end,
  pedido_local_gestion=case when i.procedencia='pedido_local' then coalesce(i.pedido_local_gestion,r.pedido_local_gestion,case when i.pedido_id is null then 'externo' else 'existente' end) else null end
from public.op_reservas r where r.id=i.reserva_id;

create table if not exists public.op_reserva_recepciones_habituales (
  id uuid primary key default gen_random_uuid(),
  local_nombre text not null,
  origen_tipo text not null check (origen_tipo in ('proveedor','local')),
  origen_nombre text not null check (char_length(trim(origen_nombre)) between 2 and 120),
  dias_recepcion smallint[] not null default '{}'::smallint[],
  activo boolean not null default true,
  updated_by uuid references public.perfiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint op_reserva_recepcion_dias_check check (dias_recepcion <@ array[0,1,2,3,4,5,6]::smallint[])
);

create unique index if not exists op_reserva_recepcion_origen_idx
  on public.op_reserva_recepciones_habituales(local_nombre,origen_tipo,lower(origen_nombre));

alter table public.op_reserva_recepciones_habituales enable row level security;
drop policy if exists op_reserva_recepcion_read on public.op_reserva_recepciones_habituales;
create policy op_reserva_recepcion_read on public.op_reserva_recepciones_habituales for select to authenticated
  using(public.is_ops_supervisor() or local_nombre=public.my_local());
drop policy if exists op_reserva_recepcion_admin on public.op_reserva_recepciones_habituales;
create policy op_reserva_recepcion_admin on public.op_reserva_recepciones_habituales for all to authenticated
  using(public.is_ops_supervisor()) with check(public.is_ops_supervisor());
grant select on public.op_reserva_recepciones_habituales to authenticated;

create or replace function public.op_reserva_contexto(p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; motivos jsonb; locales jsonb; cfg jsonb; recepciones jsonb;
begin
  a:=public.op_reserva_actor(p_acceso);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'nombre',nombre,'almacen',almacen) order by nombre),'[]')
    into locales from public.locales;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'local_nombre',local_nombre,'nombre',nombre,'activo',activo,'orden',orden) order by orden,nombre),'[]')
    into motivos from public.op_reserva_motivos where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  select coalesce(jsonb_object_agg(local_nombre,jsonb_build_object('horas_reserva',horas_reserva,
    'ubicacion_reservas',ubicacion_reservas,'printer_path',printer_path,'printer_profile',printer_profile)),'{}') into cfg
    from public.op_reserva_config_local where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'local_nombre',local_nombre,'origen_tipo',origen_tipo,
    'origen_nombre',origen_nombre,'dias_recepcion',dias_recepcion,'activo',activo) order by local_nombre,origen_tipo,origen_nombre),'[]')
    into recepciones from public.op_reserva_recepciones_habituales
    where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  return jsonb_build_object('actor',a,'locals',locales,'reasons',motivos,'config',cfg,'reception_schedules',recepciones);
end $$;

create or replace function public.op_reserva_guardar_recepcion_habitual(
  p_id uuid,p_local text,p_origen_tipo text,p_origen_nombre text,p_dias smallint[],p_activo boolean default true
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data public.op_reserva_recepciones_habituales; v_nombre text; v_existente uuid;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo administradores pueden configurar calendarios de recepción'; end if;
  if not exists(select 1 from public.locales where nombre=trim(p_local)) then raise exception 'El local de destino no existe'; end if;
  if p_origen_tipo not in ('proveedor','local') then raise exception 'Elegí proveedor u otro local'; end if;
  v_nombre:=left(trim(coalesce(p_origen_nombre,'')),120);
  if char_length(v_nombre)<2 then raise exception 'Indicá el proveedor o local de origen'; end if;
  if p_origen_tipo='local' and (v_nombre=trim(p_local) or not exists(select 1 from public.locales l where l.nombre=v_nombre)) then
    raise exception 'Elegí un local de origen válido y distinto del destino';
  end if;
  if not (coalesce(p_dias,'{}'::smallint[]) <@ array[0,1,2,3,4,5,6]::smallint[]) or cardinality(coalesce(p_dias,'{}'))=0 then
    raise exception 'Elegí al menos un día válido';
  end if;
  if p_id is null then
    select id into v_existente from public.op_reserva_recepciones_habituales
      where local_nombre=trim(p_local) and origen_tipo=p_origen_tipo and lower(origen_nombre)=lower(v_nombre);
    if v_existente is null then
      insert into public.op_reserva_recepciones_habituales(local_nombre,origen_tipo,origen_nombre,dias_recepcion,activo,updated_by)
        values(trim(p_local),p_origen_tipo,v_nombre,p_dias,coalesce(p_activo,true),auth.uid()) returning * into row_data;
    else
      update public.op_reserva_recepciones_habituales set origen_nombre=v_nombre,dias_recepcion=p_dias,activo=coalesce(p_activo,true),
        updated_by=auth.uid(),updated_at=now() where id=v_existente returning * into row_data;
    end if;
  else
    update public.op_reserva_recepciones_habituales set local_nombre=trim(p_local),origen_tipo=p_origen_tipo,origen_nombre=v_nombre,
      dias_recepcion=p_dias,activo=coalesce(p_activo,true),updated_by=auth.uid(),updated_at=now()
      where id=p_id returning * into row_data;
    if row_data.id is null then raise exception 'El calendario ya no existe'; end if;
  end if;
  return to_jsonb(row_data);
end $$;

revoke all on function public.op_reserva_guardar_recepcion_habitual(uuid,text,text,text,smallint[],boolean) from public,anon,authenticated;
grant execute on function public.op_reserva_guardar_recepcion_habitual(uuid,text,text,text,smallint[],boolean) to authenticated;

create or replace function public.op_reserva_insertar_items(p_reserva uuid,p_items jsonb,p_actor jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_reservas; origen public.locales; pedido public.pedidos; v_pedido_id uuid; existente_id uuid;
begin
  select * into r from public.op_reservas where id=p_reserva;
  if r.id is null then raise exception 'Reserva no disponible'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Agregá al menos un producto'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where nullif(trim(x->>'codigo'),'') is null or nullif(trim(x->>'nombre'),'') is null
    or coalesce(x->>'cantidad','')!~'^\d{1,6}$' or (x->>'cantidad')::integer<1
    or coalesce(x->>'cantidad_local','0')!~'^\d{1,6}$' or (x->>'cantidad_local')::integer>(x->>'cantidad')::integer
    or coalesce(x->>'procedencia','') not in ('local','proveedor','pedido_local')) then
    raise exception 'Revisá los productos, cantidades y orígenes';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where x->>'procedencia'='proveedor' and nullif(trim(x->>'proveedor_nombre'),'') is null) then
    raise exception 'Indicá el proveedor de cada producto que lo espera';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where x->>'procedencia'='pedido_local' and (
    coalesce(x->>'pedido_local_gestion','') not in ('crear','existente','externo') or nullif(trim(x->>'origen_local'),'') is null
    or x->>'origen_local'=r.local_nombre or not exists(select 1 from public.locales l where l.nombre=x->>'origen_local'))) then
    raise exception 'Revisá el local de origen y la gestión de los productos pedidos a otro local';
  end if;

  for existente_id in select distinct (x->>'pedido_existente_id')::uuid from jsonb_array_elements(p_items) x
    where x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='existente'
      and coalesce(x->>'pedido_existente_id','')~'^[0-9a-fA-F-]{36}$'
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

  insert into public.op_reserva_items(reserva_id,codigo,nombre,cantidad,cantidad_local,procedencia,origen_local,proveedor_nombre,
    pedido_local_gestion,fecha_estimada,remito_numero,comentario,estado,pedido_id)
  select r.id,left(trim(x->>'codigo'),80),left(trim(x->>'nombre'),240),(x->>'cantidad')::integer,coalesce((x->>'cantidad_local')::integer,0),x->>'procedencia',
    case when x->>'procedencia'='pedido_local' then nullif(left(trim(x->>'origen_local'),120),'') end,
    case when x->>'procedencia'='proveedor' then nullif(left(trim(x->>'proveedor_nombre'),120),'') end,
    case when x->>'procedencia'='pedido_local' then x->>'pedido_local_gestion' end,
    case when coalesce(x->>'fecha_estimada','')~'^\d{4}-\d{2}-\d{2}$' then (x->>'fecha_estimada')::date end,
    nullif(left(trim(coalesce(x->>'remito_numero','')),100),''),nullif(left(trim(coalesce(x->>'comentario','')),500),''),
    case when coalesce((x->>'cantidad_local')::integer,0)>0 then 'separado' else 'pendiente' end,
    case when x->>'procedencia'='pedido_local' and x->>'pedido_local_gestion'='existente' then (x->>'pedido_existente_id')::uuid end
  from jsonb_array_elements(p_items) x;

  for existente_id in select distinct i.pedido_id from public.op_reserva_items i where i.reserva_id=r.id and i.pedido_id is not null loop
    update public.pedidos set reserva_id=r.id,updated_at=now() where id=existente_id;
  end loop;

  for origen in select l.* from public.locales l where l.nombre in (
    select distinct i.origen_local from public.op_reserva_items i where i.reserva_id=r.id and i.procedencia='pedido_local' and i.pedido_local_gestion='crear'
  ) loop
    insert into public.pedidos(origen_local,origen_almacen,destino_local,destino_almacen,cliente,telefono,notas,estado,creado_por,canal_creacion,reserva_id,generado_desde_reserva)
    values(origen.nombre,origen.almacen,r.local_nombre,r.local_almacen,nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),r.cliente_telefono,
      'Creado desde Control de reservas · Reserva #'||r.codigo||case when r.motivo_comentario is not null then ' · '||r.motivo_comentario else '' end,
      'pendiente',(p_actor->>'user_id')::uuid,'interno',r.id,true) returning id into v_pedido_id;
    insert into public.pedido_productos(pedido_id,codigo,nombre,cantidad)
      select v_pedido_id,i.codigo,max(i.nombre),sum(i.cantidad)::integer from public.op_reserva_items i
      where i.reserva_id=r.id and i.procedencia='pedido_local' and i.pedido_local_gestion='crear' and i.origen_local=origen.nombre group by i.codigo;
    update public.op_reserva_items set pedido_id=v_pedido_id where reserva_id=r.id and procedencia='pedido_local' and pedido_local_gestion='crear' and origen_local=origen.nombre;
    insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre) values(v_pedido_id,'pendiente',(p_actor->>'user_id')::uuid,p_actor->>'name');
    insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
      select p.id,'Nuevo pedido vinculado a una reserva','#'||r.codigo||' · '||r.local_nombre,v_pedido_id from public.perfiles p where p.approved=true and p.local_nombre=origen.nombre;
  end loop;

  update public.op_reservas set
    pedido_local_gestion=(select case when count(distinct i.pedido_local_gestion)=1 then max(i.pedido_local_gestion) end from public.op_reserva_items i where i.reserva_id=r.id and i.procedencia='pedido_local'),
    pedido_local_origen=(select case when count(distinct i.origen_local)=1 then max(i.origen_local) end from public.op_reserva_items i where i.reserva_id=r.id and i.procedencia='pedido_local')
  where id=r.id;
end $$;
revoke all on function public.op_reserva_insertar_items(uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.op_reserva_crear_v2(p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; l public.locales; m public.op_reserva_motivos; r public.op_reservas; c public.clientes_agenda;
  items jsonb; motivo text; v_phone text; v_token text; v_estado text;
begin
  a:=public.op_reserva_actor(p_acceso);
  select * into l from public.locales where nombre=coalesce(nullif(trim(p_datos->>'local'),''),a->>'local');
  if l.id is null or not (coalesce((a->>'supervisor')::boolean,false) or l.nombre=a->>'local') then raise exception 'No podés crear reservas para ese local'; end if;
  if char_length(trim(coalesce(p_datos->>'responsable',''))) not between 2 and 80 then raise exception 'El responsable es obligatorio'; end if;
  select coalesce(jsonb_agg(x||jsonb_build_object(
    'pedido_local_gestion',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'pedido_local_gestion',''),nullif(p_datos->>'pedido_local_gestion',''),'externo') end,
    'pedido_existente_id',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'pedido_existente_id',''),nullif(p_datos->>'pedido_existente_id','')) end,
    'origen_local',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'origen_local',''),nullif(p_datos->>'pedido_local_origen','')) end,
    'proveedor_nombre',case when x->>'procedencia'='proveedor' then coalesce(nullif(trim(x->>'proveedor_nombre'),''),'Proveedor no especificado') end
  ) order by ord),'[]') into items from jsonb_array_elements(coalesce(p_datos->'items','[]')) with ordinality item(x,ord);
  select case when count(distinct x->>'procedencia')>1 then 'Origen mixto'
    when max(x->>'procedencia')='local' then 'Ya estaba en local'
    when max(x->>'procedencia')='pedido_local' then 'Pedido a otro local' else 'Esperando proveedor' end
    into motivo from jsonb_array_elements(items) x;
  select * into m from public.op_reserva_motivos where local_nombre=l.nombre and nombre=motivo and activo limit 1;

  v_phone:=regexp_replace(coalesce(p_datos#>>'{cliente,telefono}',''),'\D','','g');
  if v_phone<>'' then perform pg_advisory_xact_lock(hashtext('agenda:'||v_phone)); end if;
  if nullif(p_datos#>>'{cliente,id}','') is not null then
    select * into c from public.clientes_agenda where id=(p_datos#>>'{cliente,id}')::uuid;
  elsif v_phone<>'' then
    select * into c from public.clientes_agenda where regexp_replace(coalesce(telefono,''),'\D','','g')=v_phone order by updated_at desc limit 1;
  end if;
  if c.id is null and nullif(trim(concat_ws('',p_datos#>>'{cliente,nombre}',p_datos#>>'{cliente,apellido}',p_datos#>>'{cliente,telefono}',p_datos#>>'{cliente,direccion}',p_datos#>>'{cliente,documento}')),'') is not null then
    insert into public.clientes_agenda(nombre,apellido,telefono,direccion,documento)
    values(nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),''),
      nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),''),
      nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')) returning * into c;
  elsif c.id is not null then
    update public.clientes_agenda set nombre=coalesce(nullif(trim(p_datos#>>'{cliente,nombre}'),''),nombre),apellido=coalesce(nullif(trim(p_datos#>>'{cliente,apellido}'),''),apellido),
      telefono=coalesce(nullif(trim(p_datos#>>'{cliente,telefono}'),''),telefono),direccion=coalesce(nullif(trim(p_datos#>>'{cliente,direccion}'),''),direccion),
      documento=coalesce(nullif(trim(p_datos#>>'{cliente,documento}'),''),documento),updated_at=now() where id=c.id returning * into c;
  end if;

  insert into public.op_reservas(local_nombre,local_almacen,motivo_id,motivo_nombre,motivo_comentario,responsable_nombre,
    cliente_id,cliente_nombre,cliente_apellido,cliente_telefono,cliente_direccion,cliente_documento,referencia_externa,created_by,created_by_name,invitado_id)
  values(l.nombre,l.almacen,m.id,motivo,nullif(left(trim(coalesce(p_datos->>'motivo_comentario','')),1000),''),left(trim(p_datos->>'responsable'),80),
    c.id,coalesce(c.nombre,nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),'')),coalesce(c.apellido,nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),'')),
    coalesce(c.telefono,nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),'')),coalesce(c.direccion,nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),'')),
    coalesce(c.documento,nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')),nullif(left(trim(coalesce(p_datos->>'referencia_externa','')),120),''),
    (a->>'user_id')::uuid,a->>'name',(a->>'guest_id')::uuid) returning * into r;
  perform public.op_reserva_insertar_items(r.id,items,a);
  perform public.op_reserva_recalcular(r.id,a->>'name');
  v_token:=encode(gen_random_bytes(32),'hex');
  update public.op_reservas set qr_token=v_token,qr_token_hash=encode(digest(v_token,'sha256'),'hex'),qr_updated_at=now() where id=r.id returning estado into v_estado;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'crear',v_estado,jsonb_build_object('productos',jsonb_array_length(items),'origen_general',motivo),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return jsonb_build_object('ok',true,'id',r.id,'code',r.codigo,'state',v_estado,'qr_token',v_token);
end $$;

create or replace function public.op_reserva_editar(p_reserva uuid,p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; l public.locales; m public.op_reserva_motivos; c public.clientes_agenda;
  items jsonb; motivo text; v_phone text; antes jsonb;
begin
  a:=public.op_reserva_actor(p_acceso);
  select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  if r.estado in ('completado','cancelado') then raise exception 'Una reserva cerrada no se puede editar'; end if;
  if exists(select 1 from public.op_reserva_items where reserva_id=r.id and cantidad_entregada>0) then raise exception 'No se pueden cambiar los datos o productos después de registrar entregas'; end if;
  if exists(select 1 from public.pedidos where reserva_id=r.id and estado<>'pendiente') then raise exception 'Un pedido entre locales ya avanzó; corregí el proceso desde su módulo'; end if;
  select * into l from public.locales where nombre=coalesce(nullif(trim(p_datos->>'local'),''),r.local_nombre);
  if l.id is null or l.nombre<>r.local_nombre then raise exception 'No se puede mover una reserva a otro local'; end if;
  if char_length(trim(coalesce(p_datos->>'responsable',''))) not between 2 and 80 then raise exception 'El responsable es obligatorio'; end if;
  select coalesce(jsonb_agg(x||jsonb_build_object(
    'pedido_local_gestion',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'pedido_local_gestion',''),case when nullif(x->>'pedido_existente_id','') is not null then 'existente' else 'externo' end) end,
    'proveedor_nombre',case when x->>'procedencia'='proveedor' then coalesce(nullif(trim(x->>'proveedor_nombre'),''),'Proveedor no especificado') end
  ) order by ord),'[]') into items from jsonb_array_elements(coalesce(p_datos->'items','[]')) with ordinality item(x,ord);
  select case when count(distinct x->>'procedencia')>1 then 'Origen mixto'
    when max(x->>'procedencia')='local' then 'Ya estaba en local'
    when max(x->>'procedencia')='pedido_local' then 'Pedido a otro local' else 'Esperando proveedor' end
    into motivo from jsonb_array_elements(items) x;
  select * into m from public.op_reserva_motivos where local_nombre=l.nombre and nombre=motivo and activo limit 1;
  antes:=jsonb_build_object('reserva',to_jsonb(r)-'qr_token'-'qr_token_hash','items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at),'[]') from public.op_reserva_items i where i.reserva_id=r.id));

  v_phone:=regexp_replace(coalesce(p_datos#>>'{cliente,telefono}',''),'\D','','g');
  if v_phone<>'' then perform pg_advisory_xact_lock(hashtext('agenda:'||v_phone)); end if;
  if nullif(p_datos#>>'{cliente,id}','') is not null then select * into c from public.clientes_agenda where id=(p_datos#>>'{cliente,id}')::uuid;
  elsif v_phone<>'' then select * into c from public.clientes_agenda where regexp_replace(coalesce(telefono,''),'\D','','g')=v_phone order by updated_at desc limit 1; end if;
  if c.id is null and nullif(trim(concat_ws('',p_datos#>>'{cliente,nombre}',p_datos#>>'{cliente,apellido}',p_datos#>>'{cliente,telefono}',p_datos#>>'{cliente,direccion}',p_datos#>>'{cliente,documento}')),'') is not null then
    insert into public.clientes_agenda(nombre,apellido,telefono,direccion,documento)
    values(nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),''),
      nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')) returning * into c;
  elsif c.id is not null then
    update public.clientes_agenda set nombre=coalesce(nullif(trim(p_datos#>>'{cliente,nombre}'),''),nombre),apellido=coalesce(nullif(trim(p_datos#>>'{cliente,apellido}'),''),apellido),
      telefono=coalesce(nullif(trim(p_datos#>>'{cliente,telefono}'),''),telefono),direccion=coalesce(nullif(trim(p_datos#>>'{cliente,direccion}'),''),direccion),
      documento=coalesce(nullif(trim(p_datos#>>'{cliente,documento}'),''),documento),updated_at=now() where id=c.id returning * into c;
  end if;

  delete from public.pedidos where reserva_id=r.id and generado_desde_reserva and estado='pendiente';
  update public.pedidos set reserva_id=null,updated_at=now() where reserva_id=r.id;
  delete from public.op_reserva_items where reserva_id=r.id;
  update public.op_reservas set motivo_id=m.id,motivo_nombre=motivo,motivo_comentario=nullif(left(trim(coalesce(p_datos->>'motivo_comentario','')),1000),''),
    responsable_nombre=left(trim(p_datos->>'responsable'),80),cliente_id=c.id,cliente_nombre=coalesce(c.nombre,nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),'')),
    cliente_apellido=coalesce(c.apellido,nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),'')),cliente_telefono=coalesce(c.telefono,nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),'')),
    cliente_direccion=coalesce(c.direccion,nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),'')),cliente_documento=coalesce(c.documento,nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')),
    referencia_externa=nullif(left(trim(coalesce(p_datos->>'referencia_externa','')),120),''),estado='buscando',estado_antes_vencido=null,updated_at=now() where id=r.id;
  perform public.op_reserva_insertar_items(r.id,items,a);
  if not exists(select 1 from public.op_reserva_items where reserva_id=r.id and cantidad_local>0) then
    update public.op_reservas set mercaderia_local_at=null,vencimiento_at=null,excepcion_hasta=null,excepcion_motivo=null where id=r.id;
  end if;
  perform public.op_reserva_recalcular(r.id,a->>'name');
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'editar',null,jsonb_build_object('antes',antes,'origen_general',motivo),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

revoke all on function public.op_reserva_crear_v2(jsonb,text) from public;
revoke all on function public.op_reserva_editar(uuid,jsonb,text) from public;
grant execute on function public.op_reserva_crear_v2(jsonb,text) to anon,authenticated;
grant execute on function public.op_reserva_editar(uuid,jsonb,text) to anon,authenticated;

create or replace function public.op_reserva_qr_detalle(p_token text)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare r public.op_reservas; items jsonb;
begin
  select * into r from public.op_reservas where qr_token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex');
  if r.id is null then return jsonb_build_object('ok',false,'error','El QR no es válido o fue reemplazado'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('codigo',codigo,'nombre',nombre,'cantidad',cantidad,'cantidad_local',cantidad_local,
    'cantidad_entregada',cantidad_entregada,'procedencia',procedencia,'origen_local',origen_local,'proveedor_nombre',proveedor_nombre,
    'pedido_local_gestion',pedido_local_gestion,'estado',estado,'fecha_estimada',fecha_estimada,'remito_numero',remito_numero) order by created_at),'[]')
    into items from public.op_reserva_items where reserva_id=r.id;
  return jsonb_build_object('ok',true,'reservation',jsonb_build_object('code',r.codigo,'local',r.local_nombre,'reason',r.motivo_nombre,
    'customer',nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),'phone',r.cliente_telefono,'responsible',r.responsable_nombre,
    'state',r.estado,'created_at',r.created_at,'merchandise_at',r.mercaderia_local_at,'expires_at',r.vencimiento_at,'reference',r.referencia_externa,
    'location',(select ubicacion_reservas from public.op_reserva_config_local where local_nombre=r.local_nombre),'items',items));
end $$;

notify pgrst,'reload schema';
commit;
