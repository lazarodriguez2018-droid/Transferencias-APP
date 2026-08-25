-- Seguimiento compartible para cualquier pedido, incluido el historial existente.
-- El token continúa almacenándose únicamente como SHA-256.

create or replace function public.can_access_order(order_id uuid)
returns boolean
language sql stable security definer
set search_path=public
as $$
  select exists (
    select 1
    from public.pedidos pedido
    join public.perfiles perfil on perfil.id=auth.uid() and perfil.approved=true
    where pedido.id=order_id
      and (
        perfil.role in ('admin','supervisor_general')
        or pedido.origen_local=perfil.local_nombre
        or pedido.destino_local=perfil.local_nombre
        or pedido.escala_local=perfil.local_nombre
      )
  )
$$;

create or replace function public.pedido_publico_estado_seguimiento(p_pedido uuid)
returns jsonb
language plpgsql security definer
set search_path=public,extensions
as $$
declare seguimiento public.pedido_seguimientos_publicos;
begin
  if auth.uid() is null or not public.can_access_order(p_pedido) then
    raise exception 'Acceso no autorizado';
  end if;
  select * into seguimiento
  from public.pedido_seguimientos_publicos
  where pedido_id=p_pedido and revoked_at is null;
  return jsonb_build_object(
    'ok',true,
    'has_tracking',seguimiento.pedido_id is not null,
    'updated_at',seguimiento.updated_at
  );
end $$;

create or replace function public.pedido_publico_regenerar_seguimiento(p_pedido uuid)
returns jsonb
language plpgsql security definer
set search_path=public,extensions
as $$
declare token text; codigo_pedido text; fecha_actualizacion timestamptz;
begin
  if auth.uid() is null or not public.can_access_order(p_pedido) then
    raise exception 'Acceso no autorizado';
  end if;
  token:=encode(gen_random_bytes(24),'hex');
  insert into public.pedido_seguimientos_publicos(pedido_id,token_hash,created_at,updated_at,revoked_at)
    values(p_pedido,encode(digest(token,'sha256'),'hex'),now(),now(),null)
  on conflict(pedido_id) do update
    set token_hash=excluded.token_hash,updated_at=now(),revoked_at=null
  returning updated_at into fecha_actualizacion;
  codigo_pedido:=upper(substring(p_pedido::text from char_length(p_pedido::text)-7 for 6));
  return jsonb_build_object(
    'ok',true,
    'order_code',codigo_pedido,
    'tracking_token',token,
    'updated_at',fecha_actualizacion
  );
end $$;

revoke all on function public.can_access_order(uuid) from public;
revoke all on function public.pedido_publico_estado_seguimiento(uuid) from public;
revoke all on function public.pedido_publico_regenerar_seguimiento(uuid) from public;
grant execute on function public.can_access_order(uuid) to authenticated;
grant execute on function public.pedido_publico_estado_seguimiento(uuid) to authenticated;
grant execute on function public.pedido_publico_regenerar_seguimiento(uuid) to authenticated;
