-- Acceso temporal por QR/enlace para colaborar en una única sesión operativa.
-- Los invitados no crean usuarios de Auth y solamente trabajan mediante RPC
-- SECURITY DEFINER que validan un token aleatorio en cada operación.

begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.op_invitaciones_sesion (
  id uuid primary key default gen_random_uuid(),
  modulo text not null check (modulo in ('inventario','reposicion','recepcion')),
  sesion_id uuid not null,
  token_hash text not null unique,
  activa boolean not null default true,
  created_by uuid not null references public.perfiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists op_invitaciones_sesion_activa_idx
  on public.op_invitaciones_sesion(modulo,sesion_id,created_at desc);
create unique index if not exists op_invitaciones_sesion_unica_activa_idx
  on public.op_invitaciones_sesion(modulo,sesion_id) where activa;

create table if not exists public.op_invitados_sesion (
  id uuid primary key default gen_random_uuid(),
  invitacion_id uuid not null references public.op_invitaciones_sesion(id) on delete cascade,
  modulo text not null check (modulo in ('inventario','reposicion','recepcion')),
  sesion_id uuid not null,
  nombre text not null check (char_length(nombre) between 2 and 80),
  foto_data text,
  access_hash text not null unique,
  dispositivo_id text not null,
  cliente_id text not null unique,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  revoked_at timestamptz,
  check (char_length(dispositivo_id) between 8 and 120),
  check (foto_data is null or char_length(foto_data) <= 350000)
);

create index if not exists op_invitados_sesion_lookup_idx
  on public.op_invitados_sesion(invitacion_id,last_seen desc);
create index if not exists op_invitados_sesion_access_idx
  on public.op_invitados_sesion(access_hash) where revoked_at is null;
create index if not exists op_invitados_sesion_fotos_antiguas_idx
  on public.op_invitados_sesion(last_seen) where foto_data is not null;

create table if not exists public.op_invitado_aportes (
  invitado_id uuid not null references public.op_invitados_sesion(id) on delete cascade,
  codigo text not null,
  cantidad integer not null default 0 check (cantidad >= 0),
  updated_at timestamptz not null default now(),
  primary key(invitado_id,codigo)
);

alter table public.op_reposicion_dispositivos
  alter column usuario_id drop not null,
  add column if not exists invitado_id uuid references public.op_invitados_sesion(id) on delete cascade;

alter table public.op_invitaciones_sesion enable row level security;
alter table public.op_invitados_sesion enable row level security;
alter table public.op_invitado_aportes enable row level security;

revoke all on table public.op_invitaciones_sesion from anon,authenticated;
revoke all on table public.op_invitados_sesion from anon,authenticated;
revoke all on table public.op_invitado_aportes from anon,authenticated;

create or replace function public.op_sesion_invitada_info(p_modulo text,p_sesion uuid)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare resultado jsonb;
begin
  if p_modulo='inventario' then
    select jsonb_build_object('module','inventario','session_id',s.id,'name',s.nombre,
      'location',s.local_nombre,'route',coalesce(nullif(s.almacen,''),s.local_nombre),
      'status',s.estado,'active',s.estado='abierta') into resultado
    from public.op_inventario_sesiones s where s.id=p_sesion;
  elsif p_modulo='reposicion' then
    select jsonb_build_object('module','reposicion','session_id',r.id,'name',r.nombre,
      'location',r.origen_local,'origin',r.origen_local,'destination',r.destino_local,
      'route',r.origen_local||' → '||r.destino_local,'status',r.estado,'active',r.estado='preparando') into resultado
    from public.op_reposiciones r where r.id=p_sesion;
  elsif p_modulo='recepcion' then
    select jsonb_build_object('module','recepcion','session_id',r.id,'name',r.nombre,
      'location',r.destino_local,'origin',r.origen_local,'destination',r.destino_local,
      'route',r.origen_local||' → '||r.destino_local,'document_number',r.numero_remito,
      'status',r.estado,'active',r.estado='en_control') into resultado
    from public.op_recepciones r where r.id=p_sesion;
  end if;
  return resultado;
end $$;

create or replace function public.op_puede_gestionar_invitacion(p_modulo text,p_sesion uuid)
returns boolean language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
begin
  if auth.uid() is null then return false; end if;
  if public.is_ops_supervisor() then return true; end if;
  if p_modulo='inventario' then return exists(select 1 from public.op_inventario_sesiones where id=p_sesion and created_by=auth.uid()); end if;
  if p_modulo='reposicion' then return exists(select 1 from public.op_reposiciones where id=p_sesion and created_by=auth.uid()); end if;
  if p_modulo='recepcion' then return exists(select 1 from public.op_recepciones where id=p_sesion and created_by=auth.uid()); end if;
  return false;
end $$;

create or replace function public.op_invitado_limpiar_fotos()
returns void language plpgsql security definer set search_path=public,extensions,pg_temp as $$
begin
  update public.op_invitados_sesion g set foto_data=null
  where g.foto_data is not null and g.last_seen<now()-interval '30 days' and (
    (g.modulo='inventario' and not exists(select 1 from public.op_inventario_sesiones s where s.id=g.sesion_id and s.estado='abierta')) or
    (g.modulo='reposicion' and not exists(select 1 from public.op_reposiciones r where r.id=g.sesion_id and r.estado='preparando')) or
    (g.modulo='recepcion' and not exists(select 1 from public.op_recepciones r where r.id=g.sesion_id and r.estado='en_control'))
  );
end $$;

create or replace function public.op_crear_invitacion_sesion(p_modulo text,p_sesion uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare token text; invitacion public.op_invitaciones_sesion; info jsonb;
begin
  if p_modulo not in ('inventario','reposicion','recepcion') then raise exception 'Módulo inválido'; end if;
  if not public.op_puede_gestionar_invitacion(p_modulo,p_sesion) then raise exception 'Solamente el creador o un administrador puede invitar colaboradores'; end if;
  info:=public.op_sesion_invitada_info(p_modulo,p_sesion);
  if info is null or not coalesce((info->>'active')::boolean,false) then raise exception 'La sesión ya no está disponible'; end if;
  update public.op_invitaciones_sesion set activa=false,revoked_at=now(),updated_at=now()
  where modulo=p_modulo and sesion_id=p_sesion and activa;
  token:=encode(gen_random_bytes(24),'hex');
  insert into public.op_invitaciones_sesion(modulo,sesion_id,token_hash,created_by)
  values(p_modulo,p_sesion,encode(digest(token,'sha256'),'hex'),auth.uid()) returning * into invitacion;
  return jsonb_build_object('ok',true,'token',token,'invite_id',invitacion.id,'session',info,'active',true);
end $$;

create or replace function public.op_invitacion_anfitrion(p_modulo text,p_sesion uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare invitacion public.op_invitaciones_sesion; info jsonb; invitados jsonb;
begin
  if not public.op_puede_gestionar_invitacion(p_modulo,p_sesion) then raise exception 'Acceso no autorizado'; end if;
  perform public.op_invitado_limpiar_fotos();
  info:=public.op_sesion_invitada_info(p_modulo,p_sesion);
  select * into invitacion from public.op_invitaciones_sesion
  where modulo=p_modulo and sesion_id=p_sesion order by created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.nombre,'photo',g.foto_data,
    'joined_at',g.joined_at,'last_seen',g.last_seen,'online',g.last_seen>now()-interval '2 minutes') order by g.joined_at),'[]'::jsonb)
  into invitados from public.op_invitados_sesion g where g.invitacion_id=invitacion.id and g.revoked_at is null;
  return jsonb_build_object('ok',true,'can_manage',true,'session',info,'invite_id',invitacion.id,
    'active',coalesce(invitacion.activa,false) and coalesce((info->>'active')::boolean,false),'created_at',invitacion.created_at,'guests',coalesce(invitados,'[]'::jsonb));
end $$;

create or replace function public.op_configurar_invitacion_sesion(p_modulo text,p_sesion uuid,p_accion text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare invitacion public.op_invitaciones_sesion; info jsonb;
begin
  if not public.op_puede_gestionar_invitacion(p_modulo,p_sesion) then raise exception 'Acceso no autorizado'; end if;
  info:=public.op_sesion_invitada_info(p_modulo,p_sesion);
  select * into invitacion from public.op_invitaciones_sesion where modulo=p_modulo and sesion_id=p_sesion order by created_at desc limit 1 for update;
  if invitacion.id is null then raise exception 'Todavía no existe una invitación'; end if;
  if p_accion='activar' then
    if not coalesce((info->>'active')::boolean,false) then raise exception 'La sesión está cerrada'; end if;
    update public.op_invitaciones_sesion set activa=true,revoked_at=null,updated_at=now() where id=invitacion.id;
  elsif p_accion in ('pausar','revocar') then
    update public.op_invitaciones_sesion set activa=false,revoked_at=case when p_accion='revocar' then now() else revoked_at end,updated_at=now() where id=invitacion.id;
  else raise exception 'Acción inválida'; end if;
  return public.op_invitacion_anfitrion(p_modulo,p_sesion);
end $$;

create or replace function public.op_expulsar_invitado_sesion(p_invitado uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare g public.op_invitados_sesion;
begin
  select * into g from public.op_invitados_sesion where id=p_invitado;
  if g.id is null or not public.op_puede_gestionar_invitacion(g.modulo,g.sesion_id) then raise exception 'Acceso no autorizado'; end if;
  update public.op_invitados_sesion set revoked_at=now(),last_seen=now() where id=g.id;
  if g.modulo='reposicion' then
    update public.op_reposicion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
    where reposicion_id=g.sesion_id and asignado_cliente=g.cliente_id;
    delete from public.op_reposicion_dispositivos where reposicion_id=g.sesion_id and cliente_id=g.cliente_id;
  end if;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.op_invitacion_preview(p_token text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare invitacion public.op_invitaciones_sesion; info jsonb;
begin
  perform public.op_invitado_limpiar_fotos();
  select * into invitacion from public.op_invitaciones_sesion
  where token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex') order by created_at desc limit 1;
  if invitacion.id is null then return jsonb_build_object('ok',false,'error','Enlace de invitación inválido'); end if;
  info:=public.op_sesion_invitada_info(invitacion.modulo,invitacion.sesion_id);
  if not invitacion.activa then return jsonb_build_object('ok',false,'error','La invitación está pausada o fue reemplazada','session',info); end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then return jsonb_build_object('ok',false,'error','La sesión ya finalizó','session',info); end if;
  return jsonb_build_object('ok',true,'session',info);
end $$;

create or replace function public.op_invitacion_unirse(p_token text,p_nombre text,p_foto text,p_dispositivo text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare invitacion public.op_invitaciones_sesion; info jsonb; access_token text; gid uuid; cliente text;
begin
  select * into invitacion from public.op_invitaciones_sesion
  where token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex') and activa order by created_at desc limit 1 for update;
  if invitacion.id is null then raise exception 'La invitación no está disponible'; end if;
  info:=public.op_sesion_invitada_info(invitacion.modulo,invitacion.sesion_id);
  if info is null or not coalesce((info->>'active')::boolean,false) then raise exception 'La sesión ya finalizó'; end if;
  if char_length(trim(coalesce(p_nombre,'')))<2 or char_length(trim(p_nombre))>80 then raise exception 'Ingresá un nombre válido'; end if;
  if char_length(trim(coalesce(p_dispositivo,'')))<8 or char_length(trim(p_dispositivo))>120 then raise exception 'Dispositivo inválido'; end if;
  if p_foto is null or char_length(p_foto)<100 or char_length(p_foto)>350000 or p_foto !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then
    raise exception 'La fotografía es obligatoria o no tiene un formato válido';
  end if;
  if (select count(*) from public.op_invitados_sesion where invitacion_id=invitacion.id and revoked_at is null)>=100 then raise exception 'La sesión alcanzó el máximo de invitados'; end if;
  perform pg_advisory_xact_lock(hashtextextended(invitacion.id::text||':'||left(trim(p_dispositivo),120),0));
  access_token:=encode(gen_random_bytes(24),'hex');
  select id into gid from public.op_invitados_sesion
  where invitacion_id=invitacion.id and dispositivo_id=left(trim(p_dispositivo),120) and revoked_at is null order by joined_at desc limit 1;
  if gid is null then gid:=gen_random_uuid(); end if;
  cliente:='guest:'||gid::text;
  insert into public.op_invitados_sesion(id,invitacion_id,modulo,sesion_id,nombre,foto_data,access_hash,dispositivo_id,cliente_id)
  values(gid,invitacion.id,invitacion.modulo,invitacion.sesion_id,left(trim(p_nombre),80),p_foto,encode(digest(access_token,'sha256'),'hex'),left(trim(p_dispositivo),120),cliente)
  on conflict(id) do update set nombre=excluded.nombre,foto_data=excluded.foto_data,access_hash=excluded.access_hash,last_seen=now(),revoked_at=null;
  return jsonb_build_object('ok',true,'access_token',access_token,'guest_id',gid,'name',left(trim(p_nombre),80),'session',info);
end $$;

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
    select coalesce(jsonb_agg(jsonb_build_object('code',i.codigo,'name',i.nombre,'barcode',coalesce(i.barras,''),
      'expected',i.esperado,'received',i.recibido,'not_received',i.no_recibido,'observation',coalesce(i.observacion,''),'updated_by',coalesce(i.updated_by_name,'')) order by i.nombre),'[]'::jsonb)
      into items from public.op_recepcion_items i where i.recepcion_id=g.sesion_id and (p_completo or i.codigo=trim(coalesce(p_codigo,'')));
    select coalesce(jsonb_agg(jsonb_build_object('code',x.codigo,'name',x.nombre,'barcode',coalesce(x.barras,''),'quantity',x.cantidad) order by x.nombre),'[]'::jsonb)
      into extras from public.op_recepcion_extras x where x.recepcion_id=g.sesion_id and (p_completo or x.codigo=trim(coalesce(p_codigo,''))) and (x.cantidad>0 or not p_completo);
  end if;
  return jsonb_build_object('ok',true,'guest',jsonb_build_object('id',g.id,'name',g.nombre,'client_id',g.cliente_id),
    'session',info,'items',coalesce(items,'[]'::jsonb),'extras',coalesce(extras,'[]'::jsonb),'contributions',coalesce(aportes,'[]'::jsonb),'partial',not p_completo,'server_time',now());
end $$;

create or replace function public.op_invitado_operar(
  p_acceso text,p_accion text,p_codigo text default null,p_cantidad integer default null,p_detalle jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare
  g public.op_invitados_sesion; invitacion public.op_invitaciones_sesion; info jsonb;
  producto record; inv_item public.op_inventario_items; repo_item public.op_reposicion_items; rec_item public.op_recepcion_items;
  aporte_actual integer:=0; aporte_nuevo integer; cantidad_actual integer:=0; cantidad_nueva integer;
  anterior_cliente text; nombre_producto text; barras_producto text; detalle jsonb:=coalesce(p_detalle,'{}'::jsonb);
begin
  if pg_column_size(detalle)>12000 then raise exception 'Detalle demasiado extenso'; end if;
  select guest.* into g from public.op_invitados_sesion guest
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex') and guest.revoked_at is null limit 1;
  if g.id is null then raise exception 'El acceso de invitado ya no es válido'; end if;
  select * into invitacion from public.op_invitaciones_sesion where id=g.invitacion_id and activa;
  info:=public.op_sesion_invitada_info(g.modulo,g.sesion_id);
  if invitacion.id is null then raise exception 'La invitación fue pausada'; end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then raise exception 'La sesión ya finalizó'; end if;
  update public.op_invitados_sesion set last_seen=now() where id=g.id;

  if g.modulo='inventario' then
    if p_accion<>'inventory_delta' then raise exception 'Operación no permitida para Inventario'; end if;
    if p_cantidad is null or p_cantidad=0 or abs(p_cantidad)>999 then raise exception 'Cantidad inválida'; end if;
    select codigo,nombre,barras into producto from public.productos where codigo=trim(p_codigo) limit 1;
    nombre_producto:=coalesce(producto.nombre,nullif(left(trim(detalle->>'name'),200),''),trim(p_codigo));
    barras_producto:=coalesce(producto.barras,nullif(left(trim(detalle->>'barcode'),80),''));
    if trim(coalesce(p_codigo,''))='' then raise exception 'Producto inválido'; end if;
    perform pg_advisory_xact_lock(hashtextextended(g.id::text||':'||trim(p_codigo),0));
    select cantidad into aporte_actual from public.op_invitado_aportes where invitado_id=g.id and codigo=trim(p_codigo) for update;
    aporte_actual:=coalesce(aporte_actual,0); aporte_nuevo:=aporte_actual+p_cantidad;
    if aporte_nuevo<0 then raise exception 'Solamente podés descontar unidades registradas por vos'; end if;
    select * into inv_item from public.op_inventario_items where sesion_id=g.sesion_id and codigo=trim(p_codigo) for update;
    cantidad_actual:=coalesce(inv_item.cantidad,0); cantidad_nueva:=cantidad_actual+p_cantidad;
    if cantidad_nueva<0 or cantidad_nueva>999999 then raise exception 'Cantidad inválida'; end if;
    insert into public.op_inventario_items(sesion_id,codigo,nombre,barras,cantidad,tipos,updated_by,updated_at)
    values(g.sesion_id,trim(p_codigo),nombre_producto,barras_producto,cantidad_nueva,jsonb_build_object('invitado',greatest(0,p_cantidad)),null,now())
    on conflict(sesion_id,codigo) do update set cantidad=public.op_inventario_items.cantidad+p_cantidad,nombre=excluded.nombre,
      barras=coalesce(excluded.barras,public.op_inventario_items.barras),
      tipos=jsonb_set(coalesce(public.op_inventario_items.tipos,'{}'::jsonb),'{invitado}',
        to_jsonb(greatest(0,coalesce((public.op_inventario_items.tipos->>'invitado')::integer,0)+p_cantidad)),true),
      updated_by=null,updated_at=now();
    select cantidad into cantidad_nueva from public.op_inventario_items where sesion_id=g.sesion_id and codigo=trim(p_codigo);
    insert into public.op_invitado_aportes(invitado_id,codigo,cantidad,updated_at)
    values(g.id,trim(p_codigo),aporte_nuevo,now()) on conflict(invitado_id,codigo) do update set cantidad=excluded.cantidad,updated_at=now();
    insert into public.op_inventario_eventos(sesion_id,usuario_id,tipo,codigo,nombre,cantidad,detalle)
    values(g.sesion_id,null,'invitado',trim(p_codigo),nombre_producto,p_cantidad,jsonb_build_object('invitado_id',g.id,'invitado',g.nombre,'resultado',cantidad_nueva));
    update public.op_inventario_sesiones set updated_at=now() where id=g.sesion_id;

  elsif g.modulo='reposicion' then
    insert into public.op_reposicion_dispositivos(reposicion_id,cliente_id,usuario_id,invitado_id,nombre,last_seen)
    values(g.sesion_id,g.cliente_id,null,g.id,g.nombre,now())
    on conflict(reposicion_id,cliente_id) do update set invitado_id=excluded.invitado_id,nombre=excluded.nombre,last_seen=now();
    update public.op_reposicion_items i set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
    where i.reposicion_id=g.sesion_id and i.asignado_cliente is not null and not exists(
      select 1 from public.op_reposicion_dispositivos d where d.reposicion_id=i.reposicion_id and d.cliente_id=i.asignado_cliente and d.last_seen>now()-interval '3 minutes');

    if p_accion='repo_claim' then
      if nullif(trim(coalesce(p_codigo,'')),'') is null then
        select * into repo_item from public.op_reposicion_items i where i.reposicion_id=g.sesion_id and i.asignado_cliente=g.cliente_id
          and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
          order by i.asignado_at nulls last,i.nombre limit 1 for update;
      else
        select * into repo_item from public.op_reposicion_items i where i.reposicion_id=g.sesion_id and i.codigo=trim(p_codigo) for update;
      end if;
      if repo_item.codigo is null and nullif(trim(coalesce(p_codigo,'')),'') is null then
        select * into repo_item from public.op_reposicion_items i where i.reposicion_id=g.sesion_id
          and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
          and (i.asignado_cliente is null or i.asignado_cliente=g.cliente_id or not exists(
            select 1 from public.op_reposicion_dispositivos d where d.reposicion_id=i.reposicion_id and d.cliente_id=i.asignado_cliente and d.last_seen>now()-interval '3 minutes'))
          order by case when i.preparado>0 then 0 else 1 end,i.nombre,i.codigo limit 1 for update skip locked;
      end if;
      if repo_item.codigo is not null then
        anterior_cliente:=repo_item.asignado_cliente;
        if repo_item.asignado_cliente is not null and repo_item.asignado_cliente<>g.cliente_id and exists(
          select 1 from public.op_reposicion_dispositivos d where d.reposicion_id=g.sesion_id and d.cliente_id=repo_item.asignado_cliente and d.last_seen>now()-interval '3 minutes')
        then raise exception 'Este producto lo está preparando %',coalesce(repo_item.asignado_nombre,'otra persona'); end if;
        update public.op_reposicion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
          where reposicion_id=g.sesion_id and asignado_cliente=g.cliente_id and codigo<>repo_item.codigo;
        update public.op_reposicion_items set asignado_a=null,asignado_cliente=g.cliente_id,asignado_nombre=g.nombre,
          asignado_at=case when asignado_cliente=g.cliente_id then coalesce(asignado_at,now()) else now() end
          where reposicion_id=g.sesion_id and codigo=repo_item.codigo;
        if anterior_cliente is distinct from g.cliente_id then
          insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
          values(g.sesion_id,null,g.nombre,'invitado_asignado',repo_item.codigo,jsonb_build_object('invitado_id',g.id,'cliente',g.cliente_id));
        end if;
      end if;
    elsif p_accion='repo_release' then
      update public.op_reposicion_items set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
      where reposicion_id=g.sesion_id and asignado_cliente=g.cliente_id and (p_codigo is null or codigo=trim(p_codigo));
    elsif p_accion='repo_set' then
      if p_cantidad is null or p_cantidad<0 or p_cantidad>999999 then raise exception 'Cantidad inválida'; end if;
      select * into repo_item from public.op_reposicion_items where reposicion_id=g.sesion_id and codigo=trim(p_codigo) for update;
      if repo_item.codigo is null then raise exception 'Producto no encontrado'; end if;
      if repo_item.asignado_cliente is distinct from g.cliente_id then raise exception 'Seleccioná este producto antes de modificarlo'; end if;
      cantidad_actual:=repo_item.preparado; cantidad_nueva:=p_cantidad;
      update public.op_reposicion_items set preparado=cantidad_nueva,no_encontrado=case when cantidad_nueva>0 then false else no_encontrado end,
        cerrado_incompleto=case when cantidad_nueva>=pedido_total then false else cerrado_incompleto end,
        asignado_a=null,asignado_cliente=case when cantidad_nueva<pedido_total then g.cliente_id else null end,
        asignado_nombre=case when cantidad_nueva<pedido_total then g.nombre else null end,
        asignado_at=case when cantidad_nueva<pedido_total then coalesce(asignado_at,now()) else null end,
        updated_by=null,updated_by_name=g.nombre,updated_at=now()
      where reposicion_id=g.sesion_id and codigo=repo_item.codigo;
      insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
      values(g.sesion_id,null,g.nombre,'invitado_cantidad',repo_item.codigo,jsonb_build_object('invitado_id',g.id,'antes',cantidad_actual,'despues',cantidad_nueva));
    elsif p_accion='repo_not_found' then
      select * into repo_item from public.op_reposicion_items where reposicion_id=g.sesion_id and codigo=trim(p_codigo) for update;
      if repo_item.codigo is null or repo_item.asignado_cliente is distinct from g.cliente_id then raise exception 'Seleccioná este producto antes de marcarlo'; end if;
      update public.op_reposicion_items set no_encontrado=true,cerrado_incompleto=true,
        motivo_codigo=nullif(left(trim(detalle->>'reason'),80),''),motivo_label=nullif(left(trim(detalle->>'reason_label'),120),''),
        motivo_otro=nullif(left(trim(detalle->>'other'),200),''),comentario=nullif(left(trim(detalle->>'comment'),500),''),
        asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,updated_by=null,updated_by_name=g.nombre,updated_at=now()
      where reposicion_id=g.sesion_id and codigo=repo_item.codigo;
      insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
      values(g.sesion_id,null,g.nombre,'invitado_no_encontrado',repo_item.codigo,detalle||jsonb_build_object('invitado_id',g.id));
    elsif p_accion in ('repo_extra_set','repo_extra_add') then
      if p_cantidad is null then raise exception 'Cantidad inválida'; end if;
      select nombre,barras into producto from public.productos where codigo=trim(p_codigo) limit 1;
      select cantidad into cantidad_actual from public.op_reposicion_extras where reposicion_id=g.sesion_id and codigo=trim(p_codigo) for update;
      cantidad_actual:=coalesce(cantidad_actual,0);
      cantidad_nueva:=case when p_accion='repo_extra_set' then p_cantidad else cantidad_actual+p_cantidad end;
      if cantidad_nueva<0 or cantidad_nueva>999999 then raise exception 'Cantidad inválida'; end if;
      insert into public.op_reposicion_extras(reposicion_id,codigo,nombre,barras,cantidad,nota,updated_by,updated_by_name)
      values(g.sesion_id,trim(p_codigo),coalesce(producto.nombre,left(trim(detalle->>'name'),200),trim(p_codigo)),coalesce(producto.barras,left(trim(detalle->>'barcode'),80)),cantidad_nueva,'Agregado por invitado',null,g.nombre)
      on conflict(reposicion_id,codigo) do update set cantidad=case when p_accion='repo_extra_set' then excluded.cantidad else public.op_reposicion_extras.cantidad+p_cantidad end,nombre=excluded.nombre,barras=coalesce(excluded.barras,public.op_reposicion_extras.barras),updated_by=null,updated_by_name=g.nombre,updated_at=now();
      select cantidad into cantidad_nueva from public.op_reposicion_extras where reposicion_id=g.sesion_id and codigo=trim(p_codigo);
      insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
      values(g.sesion_id,null,g.nombre,'invitado_extra',trim(p_codigo),jsonb_build_object('invitado_id',g.id,'despues',cantidad_nueva));
    else raise exception 'Operación no permitida para Reposición'; end if;
    update public.op_reposiciones set updated_at=now() where id=g.sesion_id;

  elsif g.modulo='recepcion' then
    if p_accion in ('receipt_set','receipt_add') then
      select * into rec_item from public.op_recepcion_items where recepcion_id=g.sesion_id and codigo=trim(p_codigo) for update;
      if rec_item.codigo is null then raise exception 'Producto no incluido en el remito'; end if;
      cantidad_actual:=rec_item.recibido;
      cantidad_nueva:=case when p_accion='receipt_set' then p_cantidad else cantidad_actual+coalesce(p_cantidad,0) end;
      if cantidad_nueva<0 or cantidad_nueva>999999 then raise exception 'Cantidad inválida'; end if;
      update public.op_recepcion_items set recibido=cantidad_nueva,no_recibido=case when cantidad_nueva>0 then false else no_recibido end,
        updated_by=null,updated_by_name=g.nombre,updated_at=now() where recepcion_id=g.sesion_id and codigo=rec_item.codigo;
      insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
      values(g.sesion_id,null,g.nombre,'invitado_cantidad',rec_item.codigo,jsonb_build_object('invitado_id',g.id,'antes',cantidad_actual,'despues',cantidad_nueva));
    elsif p_accion in ('receipt_extra_set','receipt_extra_add') then
      if p_cantidad is null then raise exception 'Cantidad inválida'; end if;
      select nombre,barras into producto from public.productos where codigo=trim(p_codigo) limit 1;
      select cantidad into cantidad_actual from public.op_recepcion_extras where recepcion_id=g.sesion_id and codigo=trim(p_codigo) for update;
      cantidad_actual:=coalesce(cantidad_actual,0);
      cantidad_nueva:=case when p_accion='receipt_extra_set' then p_cantidad else cantidad_actual+p_cantidad end;
      if cantidad_nueva<0 or cantidad_nueva>999999 then raise exception 'Cantidad inválida'; end if;
      insert into public.op_recepcion_extras(recepcion_id,codigo,nombre,barras,cantidad,observacion,updated_by,updated_by_name)
      values(g.sesion_id,trim(p_codigo),coalesce(producto.nombre,left(trim(detalle->>'name'),200),trim(p_codigo)),coalesce(producto.barras,left(trim(detalle->>'barcode'),80)),cantidad_nueva,'Fuera del remito · invitado',null,g.nombre)
      on conflict(recepcion_id,codigo) do update set cantidad=case when p_accion='receipt_extra_set' then excluded.cantidad else public.op_recepcion_extras.cantidad+p_cantidad end,nombre=excluded.nombre,barras=coalesce(excluded.barras,public.op_recepcion_extras.barras),updated_by=null,updated_by_name=g.nombre,updated_at=now();
      select cantidad into cantidad_nueva from public.op_recepcion_extras where recepcion_id=g.sesion_id and codigo=trim(p_codigo);
      insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
      values(g.sesion_id,null,g.nombre,'invitado_extra',trim(p_codigo),jsonb_build_object('invitado_id',g.id,'despues',cantidad_nueva));
    else raise exception 'Operación no permitida para Control de remitos'; end if;
    update public.op_recepciones set updated_at=now() where id=g.sesion_id;
  end if;
  return public.op_invitado_estado(p_acceso,false,p_codigo);
end $$;

create or replace function public.op_cerrar_invitaciones_sesion()
returns trigger language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_modulo text:=tg_argv[0]; sid uuid; sigue_activa boolean:=false;
begin
  sid:=case when tg_op='DELETE' then old.id else new.id end;
  if tg_op<>'DELETE' then
    sigue_activa:=case when v_modulo='inventario' then new.estado='abierta' when v_modulo='reposicion' then new.estado='preparando' else new.estado='en_control' end;
  end if;
  if not sigue_activa then
    update public.op_invitaciones_sesion i
    set activa=false,revoked_at=coalesce(revoked_at,now()),updated_at=now()
    where i.modulo=v_modulo and i.sesion_id=sid and i.activa;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists op_inventario_cerrar_invitaciones on public.op_inventario_sesiones;
create trigger op_inventario_cerrar_invitaciones after update of estado or delete on public.op_inventario_sesiones
for each row execute function public.op_cerrar_invitaciones_sesion('inventario');
drop trigger if exists op_reposicion_cerrar_invitaciones on public.op_reposiciones;
create trigger op_reposicion_cerrar_invitaciones after update of estado or delete on public.op_reposiciones
for each row execute function public.op_cerrar_invitaciones_sesion('reposicion');
drop trigger if exists op_recepcion_cerrar_invitaciones on public.op_recepciones;
create trigger op_recepcion_cerrar_invitaciones after update of estado or delete on public.op_recepciones
for each row execute function public.op_cerrar_invitaciones_sesion('recepcion');

revoke all on function public.op_sesion_invitada_info(text,uuid) from public;
revoke all on function public.op_puede_gestionar_invitacion(text,uuid) from public;
revoke all on function public.op_invitado_limpiar_fotos() from public;
revoke all on function public.op_crear_invitacion_sesion(text,uuid) from public;
revoke all on function public.op_invitacion_anfitrion(text,uuid) from public;
revoke all on function public.op_configurar_invitacion_sesion(text,uuid,text) from public;
revoke all on function public.op_expulsar_invitado_sesion(uuid) from public;
revoke all on function public.op_invitacion_preview(text) from public;
revoke all on function public.op_invitacion_unirse(text,text,text,text) from public;
revoke all on function public.op_invitado_estado(text,boolean,text) from public;
revoke all on function public.op_invitado_operar(text,text,text,integer,jsonb) from public;
revoke all on function public.op_cerrar_invitaciones_sesion() from public;

grant execute on function public.op_crear_invitacion_sesion(text,uuid) to authenticated;
grant execute on function public.op_invitacion_anfitrion(text,uuid) to authenticated;
grant execute on function public.op_configurar_invitacion_sesion(text,uuid,text) to authenticated;
grant execute on function public.op_expulsar_invitado_sesion(uuid) to authenticated;
grant execute on function public.op_invitacion_preview(text) to anon,authenticated;
grant execute on function public.op_invitacion_unirse(text,text,text,text) to anon,authenticated;
grant execute on function public.op_invitado_estado(text,boolean,text) to anon,authenticated;
grant execute on function public.op_invitado_operar(text,text,text,integer,jsonb) to anon,authenticated;

commit;
