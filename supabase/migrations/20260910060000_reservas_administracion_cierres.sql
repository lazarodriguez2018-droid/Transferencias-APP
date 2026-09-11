-- Hace visibles y exclusivas de administradores las correcciones de cierre y eliminaciones.

begin;

do $$
begin
  if to_regprocedure('public.op_reserva_corregir_cierre_base(uuid,jsonb,text,text)') is null then
    execute 'alter function public.op_reserva_corregir_cierre(uuid,jsonb,text,text) rename to op_reserva_corregir_cierre_base';
  end if;
end $$;

revoke all on function public.op_reserva_corregir_cierre_base(uuid,jsonb,text,text) from public,anon,authenticated;

create or replace function public.op_reserva_corregir_cierre(
  p_reserva uuid,
  p_entregas jsonb,
  p_motivo text,
  p_acceso text default null
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb;
begin
  a:=public.op_reserva_actor(p_acceso);
  if not coalesce((a->>'supervisor')::boolean,false) then
    raise exception 'Solo un administrador puede reabrir o corregir una reserva cerrada';
  end if;
  return public.op_reserva_corregir_cierre_base(p_reserva,p_entregas,p_motivo,p_acceso);
end $$;

create or replace function public.op_reserva_eliminar(
  p_reserva uuid,
  p_codigo text,
  p_motivo text,
  p_acceso text default null
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; snap jsonb; referencia text;
begin
  a:=public.op_reserva_actor(p_acceso);
  if not coalesce((a->>'supervisor')::boolean,false) then
    raise exception 'Solo un administrador puede eliminar reservas';
  end if;

  select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;

  referencia:=coalesce(r.numero::text,r.codigo);
  if upper(trim(coalesce(p_codigo,'')))<>upper(referencia) then
    raise exception 'Escribí el número de la reserva para confirmar';
  end if;
  if char_length(trim(coalesce(p_motivo,''))) not between 3 and 500 then
    raise exception 'Explicá por qué se elimina';
  end if;
  if exists(
    select 1 from public.pedidos
    where reserva_id=r.id and generado_desde_reserva and estado<>'pendiente'
  ) then
    raise exception 'El pedido entre locales ya avanzó y no se puede eliminar desde Reservas';
  end if;

  snap:=jsonb_build_object(
    'reservation',to_jsonb(r)-'qr_token'-'qr_token_hash',
    'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at),'[]') from public.op_reserva_items i where i.reserva_id=r.id),
    'comments',(select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at),'[]') from public.op_reserva_comentarios c where c.reserva_id=r.id),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at),'[]') from public.op_reserva_eventos e where e.reserva_id=r.id),
    'delete_reason',trim(p_motivo),
    'deleted_by_admin',true
  );
  insert into public.op_reserva_eliminaciones(
    reserva_id,codigo,local_nombre,motivo,snapshot,usuario_id,invitado_id,autor_nombre
  ) values(
    r.id,r.codigo,r.local_nombre,trim(p_motivo),snap,
    (a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name'
  );

  delete from public.pedidos
    where reserva_id=r.id and generado_desde_reserva and estado='pendiente';
  delete from public.op_reservas where id=r.id;

  return jsonb_build_object('ok',true,'id',r.id,'number',r.numero,'code',r.codigo);
end $$;

revoke all on function public.op_reserva_corregir_cierre(uuid,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.op_reserva_eliminar(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.op_reserva_corregir_cierre(uuid,jsonb,text,text) to authenticated;
grant execute on function public.op_reserva_eliminar(uuid,text,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
