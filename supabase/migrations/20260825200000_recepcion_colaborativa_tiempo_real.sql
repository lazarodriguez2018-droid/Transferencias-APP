-- Reserva colaborativa de productos para Control de remitos.
-- Evita que dos dispositivos controlen simultáneamente el mismo SKU.

begin;

alter table public.op_recepcion_items
  add column if not exists asignado_a uuid references public.perfiles(id) on delete set null,
  add column if not exists asignado_cliente text,
  add column if not exists asignado_nombre text,
  add column if not exists asignado_at timestamptz,
  add column if not exists controlado_at timestamptz,
  add column if not exists controlado_by uuid references public.perfiles(id) on delete set null,
  add column if not exists controlado_by_name text;

-- Los productos que ya tenían una decisión registrada no deben reaparecer
-- como pendientes de recorrido después de instalar esta mejora.
update public.op_recepcion_items
set controlado_at=coalesce(controlado_at,updated_at),
    controlado_by=coalesce(controlado_by,updated_by),
    controlado_by_name=coalesce(controlado_by_name,updated_by_name)
where controlado_at is null and (recibido>0 or no_recibido);

create index if not exists op_recepcion_items_asignacion_idx
  on public.op_recepcion_items(recepcion_id,asignado_cliente)
  where asignado_cliente is not null;
create index if not exists op_recepcion_items_control_pendiente_idx
  on public.op_recepcion_items(recepcion_id,controlado_at)
  where controlado_at is null;

create table if not exists public.op_recepcion_dispositivos (
  recepcion_id uuid not null references public.op_recepciones(id) on delete cascade,
  cliente_id text not null,
  usuario_id uuid references public.perfiles(id) on delete cascade,
  invitado_id uuid references public.op_invitados_sesion(id) on delete cascade,
  nombre text not null,
  last_seen timestamptz not null default now(),
  primary key(recepcion_id,cliente_id)
);

create index if not exists op_recepcion_dispositivos_vigencia_idx
  on public.op_recepcion_dispositivos(recepcion_id,last_seen desc);

alter table public.op_recepcion_dispositivos enable row level security;
drop policy if exists recepcion_dispositivos_read on public.op_recepcion_dispositivos;
create policy recepcion_dispositivos_read on public.op_recepcion_dispositivos for select to authenticated
using(exists(select 1 from public.op_recepciones r where r.id=recepcion_id and
  (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())));
drop policy if exists recepcion_dispositivos_own on public.op_recepcion_dispositivos;
create policy recepcion_dispositivos_own on public.op_recepcion_dispositivos for all to authenticated
using(usuario_id=auth.uid()) with check(usuario_id=auth.uid());

create or replace function public.op_recepcion_limpiar_asignaciones(p_recepcion uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare cantidad integer;
begin
  update public.op_recepcion_items i
  set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where i.recepcion_id=p_recepcion and i.asignado_cliente is not null
    and not exists(
      select 1 from public.op_recepcion_dispositivos d
      where d.recepcion_id=i.recepcion_id and d.cliente_id=i.asignado_cliente
        and d.last_seen>now()-interval '3 minutes'
    );
  get diagnostics cantidad=row_count;
  return cantidad;
end $$;

create or replace function public.op_recepcion_tocar(p_recepcion uuid,p_cliente text,p_usuario_nombre text default 'Usuario')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if trim(coalesce(p_cliente,''))='' then raise exception 'Dispositivo no identificado'; end if;
  if not exists(select 1 from public.op_recepciones r where r.id=p_recepcion and r.estado='en_control'
    and (public.is_ops_supervisor() or r.destino_local=public.my_local())) then raise exception 'Recepción no disponible'; end if;
  insert into public.op_recepcion_participantes(recepcion_id,usuario_id,nombre,last_seen)
  values(p_recepcion,auth.uid(),nombre_usuario,now())
  on conflict(recepcion_id,usuario_id) do update set nombre=excluded.nombre,last_seen=now();
  insert into public.op_recepcion_dispositivos(recepcion_id,cliente_id,usuario_id,nombre,last_seen)
  values(p_recepcion,left(trim(p_cliente),120),auth.uid(),nombre_usuario,now())
  on conflict(recepcion_id,cliente_id) do update set usuario_id=excluded.usuario_id,invitado_id=null,nombre=excluded.nombre,last_seen=now();
  perform public.op_recepcion_limpiar_asignaciones(p_recepcion);
  return jsonb_build_object('cliente_id',left(trim(p_cliente),120),'at',now());
end $$;

create or replace function public.op_recepcion_reclamar(
  p_recepcion uuid,p_codigo text default null,p_cliente text default null,p_usuario_nombre text default 'Usuario'
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.op_recepcion_items; cliente text:=left(trim(coalesce(p_cliente,'')),120);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80); anterior text;
begin
  perform public.op_recepcion_tocar(p_recepcion,cliente,nombre_usuario);
  if nullif(trim(coalesce(p_codigo,'')),'') is null then
    select * into item from public.op_recepcion_items i
    where i.recepcion_id=p_recepcion and i.asignado_cliente=cliente and i.controlado_at is null
    order by i.asignado_at nulls last,i.nombre,i.codigo limit 1 for update;
    if item.codigo is null then
      select * into item from public.op_recepcion_items i
      where i.recepcion_id=p_recepcion and i.controlado_at is null
        and (i.asignado_cliente is null or i.asignado_cliente=cliente or not exists(
          select 1 from public.op_recepcion_dispositivos d where d.recepcion_id=i.recepcion_id
            and d.cliente_id=i.asignado_cliente and d.last_seen>now()-interval '3 minutes'))
      order by i.nombre,i.codigo limit 1 for update skip locked;
    end if;
  else
    select * into item from public.op_recepcion_items i
    where i.recepcion_id=p_recepcion and i.codigo=trim(p_codigo) for update;
  end if;
  if item.codigo is null then return null; end if;
  if item.asignado_cliente is not null and item.asignado_cliente<>cliente and exists(
    select 1 from public.op_recepcion_dispositivos d where d.recepcion_id=p_recepcion
      and d.cliente_id=item.asignado_cliente and d.last_seen>now()-interval '3 minutes'
  ) then raise exception 'Este producto lo está controlando %',coalesce(item.asignado_nombre,'otra persona'); end if;
  anterior:=item.asignado_cliente;
  update public.op_recepcion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where recepcion_id=p_recepcion and asignado_cliente=cliente and codigo<>item.codigo;
  update public.op_recepcion_items set asignado_a=auth.uid(),asignado_cliente=cliente,asignado_nombre=nombre_usuario,
    asignado_at=case when asignado_cliente=cliente then coalesce(asignado_at,now()) else now() end
  where recepcion_id=p_recepcion and codigo=item.codigo returning * into item;
  if anterior is distinct from cliente then
    insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
    values(p_recepcion,auth.uid(),nombre_usuario,'asignado_control',item.codigo,jsonb_build_object('cliente',cliente));
  end if;
  return to_jsonb(item);
end $$;

create or replace function public.op_recepcion_liberar(p_recepcion uuid,p_cliente text,p_codigo text default null,p_usuario_nombre text default 'Usuario')
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare cantidad integer;
begin
  if not exists(select 1 from public.op_recepciones r where r.id=p_recepcion and r.estado='en_control'
    and (public.is_ops_supervisor() or r.destino_local=public.my_local())) then raise exception 'Recepción no disponible'; end if;
  update public.op_recepcion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where recepcion_id=p_recepcion and asignado_cliente=left(trim(coalesce(p_cliente,'')),120)
    and (p_codigo is null or codigo=trim(p_codigo));
  get diagnostics cantidad=row_count;
  return cantidad;
end $$;

create or replace function public.op_recepcion_cantidad_colaborativa(
  p_recepcion uuid,p_codigo text,p_delta integer default null,p_absoluta integer default null,
  p_origen text default 'manual',p_usuario_nombre text default 'Usuario',p_cliente text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.op_recepcion_items; nueva integer; cliente text:=left(trim(coalesce(p_cliente,'')),120);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  perform public.op_recepcion_tocar(p_recepcion,cliente,nombre_usuario);
  select * into item from public.op_recepcion_items where recepcion_id=p_recepcion and codigo=trim(p_codigo) for update;
  if item.codigo is null then raise exception 'Producto no incluido en el remito'; end if;
  if item.asignado_cliente is distinct from cliente then raise exception 'Seleccioná este producto antes de modificarlo'; end if;
  nueva:=case when p_absoluta is not null then p_absoluta else item.recibido+coalesce(p_delta,0) end;
  if nueva<0 or nueva>999999 then raise exception 'Cantidad inválida'; end if;
  update public.op_recepcion_items set recibido=nueva,no_recibido=false,
    controlado_at=now(),controlado_by=auth.uid(),controlado_by_name=nombre_usuario,
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,
    updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where recepcion_id=p_recepcion and codigo=item.codigo returning * into item;
  insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_recepcion,auth.uid(),nombre_usuario,'cantidad_controlada',item.codigo,
    jsonb_build_object('antes',coalesce(item.recibido,0),'despues',nueva,'origen',p_origen,'cliente',cliente));
  update public.op_recepciones set updated_at=now() where id=p_recepcion;
  return to_jsonb(item);
end $$;

create or replace function public.op_recepcion_no_recibido_colaborativo(
  p_recepcion uuid,p_codigo text,p_valor boolean,p_observacion text default null,
  p_usuario_nombre text default 'Usuario',p_cliente text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.op_recepcion_items; cliente text:=left(trim(coalesce(p_cliente,'')),120);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  perform public.op_recepcion_tocar(p_recepcion,cliente,nombre_usuario);
  select * into item from public.op_recepcion_items where recepcion_id=p_recepcion and codigo=trim(p_codigo) for update;
  if item.codigo is null then raise exception 'Producto no encontrado'; end if;
  if item.asignado_cliente is distinct from cliente then raise exception 'Seleccioná este producto antes de modificarlo'; end if;
  update public.op_recepcion_items set no_recibido=coalesce(p_valor,false),
    recibido=case when coalesce(p_valor,false) then 0 else recibido end,
    observacion=nullif(trim(coalesce(p_observacion,'')),''),
    controlado_at=case when coalesce(p_valor,false) then now() else null end,
    controlado_by=case when coalesce(p_valor,false) then auth.uid() else null end,
    controlado_by_name=case when coalesce(p_valor,false) then nombre_usuario else null end,
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,
    updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where recepcion_id=p_recepcion and codigo=item.codigo returning * into item;
  insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_recepcion,auth.uid(),nombre_usuario,'no_recibido_controlado',item.codigo,
    jsonb_build_object('valor',p_valor,'observacion',p_observacion,'cliente',cliente));
  update public.op_recepciones set updated_at=now() where id=p_recepcion;
  return to_jsonb(item);
end $$;

-- El estado invitado incluye la reserva para que el celular pueda ocultar
-- los artículos tomados por otros colaboradores.
create or replace function public.op_invitado_estado(p_acceso text,p_completo boolean default true,p_codigo text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare g public.op_invitados_sesion; invitacion public.op_invitaciones_sesion; info jsonb; items jsonb; extras jsonb; aportes jsonb;
begin
  select guest.* into g from public.op_invitados_sesion guest
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex') and guest.revoked_at is null limit 1;
  if g.id is null then return jsonb_build_object('ok',false,'error','El acceso de invitado ya no es válido'); end if;
  select * into invitacion from public.op_invitaciones_sesion where id=g.invitacion_id;
  info:=public.op_sesion_invitada_info(g.modulo,g.sesion_id);
  if not coalesce(invitacion.activa,false) then return jsonb_build_object('ok',false,'error','La invitación fue pausada'); end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then return jsonb_build_object('ok',false,'error','La sesión ya finalizó'); end if;
  update public.op_invitados_sesion set last_seen=now() where id=g.id;
  if g.modulo='inventario' then
    select coalesce(jsonb_agg(jsonb_build_object('code',i.codigo,'name',i.nombre,'barcode',coalesce(i.barras,''),'quantity',i.cantidad,'updated_at',i.updated_at) order by i.updated_at desc),'[]'::jsonb)
      into items from public.op_inventario_items i where i.sesion_id=g.sesion_id and (p_completo or i.codigo=trim(coalesce(p_codigo,'')));
    select coalesce(jsonb_agg(jsonb_build_object('code',a.codigo,'quantity',a.cantidad,'updated_at',a.updated_at) order by a.updated_at desc),'[]'::jsonb)
      into aportes from public.op_invitado_aportes a where a.invitado_id=g.id and (p_completo or a.codigo=trim(coalesce(p_codigo,''))) and (a.cantidad>0 or not p_completo);
  elsif g.modulo='reposicion' then
    insert into public.op_reposicion_dispositivos(reposicion_id,cliente_id,usuario_id,invitado_id,nombre,last_seen)
    values(g.sesion_id,g.cliente_id,null,g.id,g.nombre,now())
    on conflict(reposicion_id,cliente_id) do update set invitado_id=excluded.invitado_id,nombre=excluded.nombre,last_seen=now();
    select coalesce(jsonb_agg(jsonb_build_object('code',i.codigo,'name',i.nombre,'barcode',coalesce(i.barras,''),
      'requested',i.pedido_total,'prepared',i.preparado,'not_found',i.no_encontrado,'closed_incomplete',i.cerrado_incompleto,
      'assigned_client',coalesce(i.asignado_cliente,''),'assigned_name',coalesce(i.asignado_nombre,''),'assigned_at',i.asignado_at,
      'orders',coalesce(i.pedidos_asignados,'[]'::jsonb)) order by i.nombre),'[]'::jsonb)
      into items from public.op_reposicion_items i where i.reposicion_id=g.sesion_id and (p_completo or i.codigo=trim(coalesce(p_codigo,'')) or i.asignado_cliente=g.cliente_id);
    select coalesce(jsonb_agg(jsonb_build_object('code',x.codigo,'name',x.nombre,'barcode',coalesce(x.barras,''),'quantity',x.cantidad) order by x.nombre),'[]'::jsonb)
      into extras from public.op_reposicion_extras x where x.reposicion_id=g.sesion_id and (p_completo or x.codigo=trim(coalesce(p_codigo,''))) and (x.cantidad>0 or not p_completo);
  else
    insert into public.op_recepcion_dispositivos(recepcion_id,cliente_id,usuario_id,invitado_id,nombre,last_seen)
    values(g.sesion_id,g.cliente_id,null,g.id,g.nombre,now())
    on conflict(recepcion_id,cliente_id) do update set invitado_id=excluded.invitado_id,usuario_id=null,nombre=excluded.nombre,last_seen=now();
    perform public.op_recepcion_limpiar_asignaciones(g.sesion_id);
    select coalesce(jsonb_agg(jsonb_build_object('code',i.codigo,'name',i.nombre,'barcode',coalesce(i.barras,''),
      'expected',i.esperado,'received',i.recibido,'not_received',i.no_recibido,'observation',coalesce(i.observacion,''),
      'controlled_at',i.controlado_at,'assigned_client',coalesce(i.asignado_cliente,''),'assigned_name',coalesce(i.asignado_nombre,''),
      'assigned_at',i.asignado_at,'updated_by',coalesce(i.updated_by_name,'')) order by i.nombre),'[]'::jsonb)
      into items from public.op_recepcion_items i where i.recepcion_id=g.sesion_id
      and (p_completo or i.codigo=trim(coalesce(p_codigo,'')) or i.asignado_cliente=g.cliente_id);
    select coalesce(jsonb_agg(jsonb_build_object('code',x.codigo,'name',x.nombre,'barcode',coalesce(x.barras,''),'quantity',x.cantidad) order by x.nombre),'[]'::jsonb)
      into extras from public.op_recepcion_extras x where x.recepcion_id=g.sesion_id and (p_completo or x.codigo=trim(coalesce(p_codigo,''))) and (x.cantidad>0 or not p_completo);
  end if;
  return jsonb_build_object('ok',true,'guest',jsonb_build_object('id',g.id,'name',g.nombre,'client_id',g.cliente_id),
    'session',info,'items',coalesce(items,'[]'::jsonb),'extras',coalesce(extras,'[]'::jsonb),'contributions',coalesce(aportes,'[]'::jsonb),'partial',not p_completo,'server_time',now());
end $$;

create or replace function public.op_invitado_recepcion_operar(
  p_acceso text,p_accion text,p_codigo text default null,p_cantidad integer default null,p_detalle jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare g public.op_invitados_sesion; invitacion public.op_invitaciones_sesion; info jsonb;
  item public.op_recepcion_items; producto record; actual integer:=0; nueva integer; anterior text;
begin
  select guest.* into g from public.op_invitados_sesion guest
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex') and guest.revoked_at is null limit 1;
  if g.id is null or g.modulo<>'recepcion' then raise exception 'El acceso no corresponde a Control de remitos'; end if;
  select * into invitacion from public.op_invitaciones_sesion where id=g.invitacion_id and activa;
  info:=public.op_sesion_invitada_info(g.modulo,g.sesion_id);
  if invitacion.id is null then raise exception 'La invitación fue pausada'; end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then raise exception 'La sesión ya finalizó'; end if;
  update public.op_invitados_sesion set last_seen=now() where id=g.id;
  insert into public.op_recepcion_dispositivos(recepcion_id,cliente_id,invitado_id,nombre,last_seen)
  values(g.sesion_id,g.cliente_id,g.id,g.nombre,now())
  on conflict(recepcion_id,cliente_id) do update set invitado_id=excluded.invitado_id,usuario_id=null,nombre=excluded.nombre,last_seen=now();
  perform public.op_recepcion_limpiar_asignaciones(g.sesion_id);

  if p_accion='receipt_claim' then
    if nullif(trim(coalesce(p_codigo,'')),'') is null then
      select * into item from public.op_recepcion_items i where i.recepcion_id=g.sesion_id and i.asignado_cliente=g.cliente_id and i.controlado_at is null
      order by i.asignado_at nulls last,i.nombre limit 1 for update;
      if item.codigo is null then
        select * into item from public.op_recepcion_items i where i.recepcion_id=g.sesion_id and i.controlado_at is null
          and (i.asignado_cliente is null or i.asignado_cliente=g.cliente_id or not exists(
            select 1 from public.op_recepcion_dispositivos d where d.recepcion_id=i.recepcion_id and d.cliente_id=i.asignado_cliente and d.last_seen>now()-interval '3 minutes'))
        order by i.nombre,i.codigo limit 1 for update skip locked;
      end if;
    else select * into item from public.op_recepcion_items where recepcion_id=g.sesion_id and codigo=trim(p_codigo) for update; end if;
    if item.codigo is not null then
      if item.asignado_cliente is not null and item.asignado_cliente<>g.cliente_id and exists(
        select 1 from public.op_recepcion_dispositivos d where d.recepcion_id=g.sesion_id and d.cliente_id=item.asignado_cliente and d.last_seen>now()-interval '3 minutes')
      then raise exception 'Este producto lo está controlando %',coalesce(item.asignado_nombre,'otra persona'); end if;
      anterior:=item.asignado_cliente;
      update public.op_recepcion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
        where recepcion_id=g.sesion_id and asignado_cliente=g.cliente_id and codigo<>item.codigo;
      update public.op_recepcion_items set asignado_a=null,asignado_cliente=g.cliente_id,asignado_nombre=g.nombre,
        asignado_at=case when asignado_cliente=g.cliente_id then coalesce(asignado_at,now()) else now() end
        where recepcion_id=g.sesion_id and codigo=item.codigo;
      if anterior is distinct from g.cliente_id then
        insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
        values(g.sesion_id,null,g.nombre,'invitado_asignado_control',item.codigo,jsonb_build_object('invitado_id',g.id,'cliente',g.cliente_id));
      end if;
    end if;
  elsif p_accion='receipt_release' then
    update public.op_recepcion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
    where recepcion_id=g.sesion_id and asignado_cliente=g.cliente_id and (p_codigo is null or codigo=trim(p_codigo));
  elsif p_accion in ('receipt_set','receipt_add') then
    select * into item from public.op_recepcion_items where recepcion_id=g.sesion_id and codigo=trim(p_codigo) for update;
    if item.codigo is null then raise exception 'Producto no incluido en el remito'; end if;
    if item.asignado_cliente is distinct from g.cliente_id then raise exception 'Seleccioná este producto antes de modificarlo'; end if;
    nueva:=case when p_accion='receipt_set' then p_cantidad else item.recibido+coalesce(p_cantidad,0) end;
    if nueva<0 or nueva>999999 then raise exception 'Cantidad inválida'; end if;
    update public.op_recepcion_items set recibido=nueva,no_recibido=false,controlado_at=now(),controlado_by=null,controlado_by_name=g.nombre,
      asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,updated_by=null,updated_by_name=g.nombre,updated_at=now()
    where recepcion_id=g.sesion_id and codigo=item.codigo;
    insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
    values(g.sesion_id,null,g.nombre,'invitado_cantidad_controlada',item.codigo,jsonb_build_object('invitado_id',g.id,'antes',item.recibido,'despues',nueva));
  elsif p_accion in ('receipt_extra_set','receipt_extra_add') then
    if p_cantidad is null then raise exception 'Cantidad inválida'; end if;
    select nombre,barras into producto from public.productos where codigo=trim(p_codigo) limit 1;
    select cantidad into actual from public.op_recepcion_extras where recepcion_id=g.sesion_id and codigo=trim(p_codigo) for update;
    actual:=coalesce(actual,0); nueva:=case when p_accion='receipt_extra_set' then p_cantidad else actual+p_cantidad end;
    if nueva<0 or nueva>999999 then raise exception 'Cantidad inválida'; end if;
    insert into public.op_recepcion_extras(recepcion_id,codigo,nombre,barras,cantidad,observacion,updated_by,updated_by_name)
    values(g.sesion_id,trim(p_codigo),coalesce(producto.nombre,left(trim(p_detalle->>'name'),200),trim(p_codigo)),coalesce(producto.barras,left(trim(p_detalle->>'barcode'),80)),nueva,'Fuera del remito · invitado',null,g.nombre)
    on conflict(recepcion_id,codigo) do update set cantidad=case when p_accion='receipt_extra_set' then excluded.cantidad else public.op_recepcion_extras.cantidad+p_cantidad end,
      nombre=excluded.nombre,barras=coalesce(excluded.barras,public.op_recepcion_extras.barras),updated_by=null,updated_by_name=g.nombre,updated_at=now();
  else raise exception 'Operación no permitida para Control de remitos'; end if;
  update public.op_recepciones set updated_at=now() where id=g.sesion_id;
  return public.op_invitado_estado(p_acceso,false,p_codigo);
end $$;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='op_recepcion_dispositivos') then
    alter publication supabase_realtime add table public.op_recepcion_dispositivos;
  end if;
end $$;

revoke all on function public.op_recepcion_limpiar_asignaciones(uuid) from public;
revoke all on function public.op_recepcion_tocar(uuid,text,text) from public;
revoke all on function public.op_recepcion_reclamar(uuid,text,text,text) from public;
revoke all on function public.op_recepcion_liberar(uuid,text,text,text) from public;
revoke all on function public.op_recepcion_cantidad_colaborativa(uuid,text,integer,integer,text,text,text) from public;
revoke all on function public.op_recepcion_no_recibido_colaborativo(uuid,text,boolean,text,text,text) from public;
revoke all on function public.op_invitado_recepcion_operar(text,text,text,integer,jsonb) from public;

grant execute on function public.op_recepcion_tocar(uuid,text,text) to authenticated;
grant execute on function public.op_recepcion_reclamar(uuid,text,text,text) to authenticated;
grant execute on function public.op_recepcion_liberar(uuid,text,text,text) to authenticated;
grant execute on function public.op_recepcion_cantidad_colaborativa(uuid,text,integer,integer,text,text,text) to authenticated;
grant execute on function public.op_recepcion_no_recibido_colaborativo(uuid,text,boolean,text,text,text) to authenticated;
grant execute on function public.op_invitado_recepcion_operar(text,text,text,integer,jsonb) to anon,authenticated;

commit;
