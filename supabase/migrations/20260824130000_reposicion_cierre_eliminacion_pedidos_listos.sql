-- Cierre visible del recorrido, eliminación segura de reposiciones abiertas y
-- sincronización del estado "Listo para enviar" de pedidos entre locales.

begin;

create or replace function public.op_sincronizar_pedidos_reposicion(p_reposicion uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare cambios integer:=0;
begin
  -- Los pedidos tienen prioridad sobre las unidades físicas juntadas. Cuando
  -- varios pedidos comparten SKU se asignan por orden de creación, sin duplicar.
  with lineas as (
    select pp.id,pp.pedido_id,pp.codigo,
      coalesce(pp.cantidad_aceptada,pp.cantidad,0)::integer solicitada,
      least(ri.preparado,ri.pedido_clientes)::integer disponible,
      coalesce(sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0)) over(
        partition by pp.codigo order by p.created_at,p.id,pp.id
        rows between unbounded preceding and 1 preceding
      ),0)::integer previa
    from public.pedidos p
    join public.pedido_productos pp on pp.pedido_id=p.id
    join public.op_reposicion_items ri
      on ri.reposicion_id=p_reposicion and ri.codigo=pp.codigo
    where p.reposicion_id=p_reposicion and p.estado in ('aceptado','listo')
  ), asignadas as (
    select id,greatest(0,least(solicitada,disponible-previa))::integer cantidad
    from lineas
  )
  update public.pedido_productos pp
  set cantidad_preparada=a.cantidad
  from asignadas a where pp.id=a.id;

  with totales as (
    select p.id,
      sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0))::integer solicitada,
      sum(coalesce(pp.cantidad_preparada,0))::integer preparada
    from public.pedidos p
    join public.pedido_productos pp on pp.pedido_id=p.id
    where p.reposicion_id=p_reposicion and p.estado in ('aceptado','listo')
    group by p.id
  ), actualizados as (
    update public.pedidos p set
      estado=case when t.solicitada>0 and t.preparada>=t.solicitada then 'listo' else 'aceptado' end,
      updated_at=now()
    from totales t
    where p.id=t.id and p.estado is distinct from
      case when t.solicitada>0 and t.preparada>=t.solicitada then 'listo' else 'aceptado' end
    returning p.id,p.estado
  )
  insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre)
  select id,estado,auth.uid(),'Reposición automática' from actualizados;
  get diagnostics cambios=row_count;
  return cambios;
end $$;

revoke all on function public.op_sincronizar_pedidos_reposicion(uuid) from public;

create or replace function public.op_reposicion_item_sincronizar_pedidos()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.op_sincronizar_pedidos_reposicion(new.reposicion_id);
  return new;
end $$;

revoke all on function public.op_reposicion_item_sincronizar_pedidos() from public;

drop trigger if exists op_reposicion_item_pedidos_listos on public.op_reposicion_items;
create trigger op_reposicion_item_pedidos_listos
after update of preparado on public.op_reposicion_items
for each row when (old.preparado is distinct from new.preparado)
execute function public.op_reposicion_item_sincronizar_pedidos();

create or replace function public.op_eliminar_reposicion(p_reposicion uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_reposiciones;
begin
  select * into r from public.op_reposiciones where id=p_reposicion for update;
  if r.id is null then raise exception 'Reposicion no encontrada'; end if;
  if r.estado<>'preparando' then
    raise exception 'Solo se pueden eliminar reposiciones que todavía están en preparación';
  end if;
  if not (public.is_ops_supervisor() or r.origen_local=public.my_local()) then
    raise exception 'Solo el local de origen o un administrador puede eliminar esta reposicion';
  end if;

  insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre)
  select id,'aceptado',auth.uid(),'Reposición eliminada'
  from public.pedidos where reposicion_id=p_reposicion and estado='listo';

  update public.pedido_productos set cantidad_preparada=0
  where pedido_id in (select id from public.pedidos where reposicion_id=p_reposicion);

  update public.pedidos set
    estado=case when estado='listo' then 'aceptado' else estado end,
    reposicion_id=null,integrado_en_reposicion_at=null,updated_at=now()
  where reposicion_id=p_reposicion;

  delete from public.op_reposiciones where id=p_reposicion;
  return jsonb_build_object(
    'id',r.id,'nombre',r.nombre,'original_path',r.original_path,
    'original_filename',r.original_filename
  );
end $$;

revoke all on function public.op_eliminar_reposicion(uuid) from public;
grant execute on function public.op_eliminar_reposicion(uuid) to authenticated;

-- Los pedidos completos ya pueden estar en "listo" antes del despacho. Al
-- confirmar la salida, tanto aceptados parciales como listos pasan a tránsito.
create or replace function public.op_finalizar_despacho(
  p_reposicion uuid,p_transporte text,p_remito text default null,
  p_remito_pendiente boolean default false,p_observaciones text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare d uuid;
begin
  if trim(coalesce(p_transporte,''))='' then raise exception 'Transporte requerido'; end if;
  if not exists(
    select 1 from public.op_reposiciones r
    where r.id=p_reposicion and r.estado='preparando'
      and (public.is_ops_supervisor() or r.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;

  perform public.op_sincronizar_pedidos_reposicion(p_reposicion);

  insert into public.op_despachos(
    reposicion_id,origen_local,destino_local,transporte,remito,
    remito_pendiente,observaciones,enviado_by
  )
  select id,origen_local,destino_local,p_transporte,nullif(trim(p_remito),''),
    p_remito_pendiente,p_observaciones,auth.uid()
  from public.op_reposiciones where id=p_reposicion returning id into d;

  update public.op_reposiciones set
    estado='enviado',transporte=p_transporte,remito=nullif(trim(p_remito),''),
    remito_pendiente=p_remito_pendiente,observaciones_envio=p_observaciones,
    enviado_at=now(),enviado_by=auth.uid(),updated_at=now()
  where id=p_reposicion;

  with lineas as (
    select pp.id,pp.pedido_id,pp.codigo,
      coalesce(pp.cantidad_aceptada,pp.cantidad,0)::integer solicitada,
      least(ri.preparado,ri.pedido_clientes)::integer disponible,
      coalesce(sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0)) over(
        partition by pp.codigo order by p.created_at,p.id,pp.id
        rows between unbounded preceding and 1 preceding
      ),0)::integer previa
    from public.pedidos p
    join public.pedido_productos pp on pp.pedido_id=p.id
    join public.op_reposicion_items ri
      on ri.reposicion_id=p_reposicion and ri.codigo=pp.codigo
    where p.reposicion_id=p_reposicion and p.estado in ('aceptado','listo')
  ), asignadas as (
    select id,greatest(0,least(solicitada,disponible-previa))::integer cantidad
    from lineas
  )
  update public.pedido_productos pp set cantidad_preparada=a.cantidad
  from asignadas a where pp.id=a.id;

  with totales as (
    select p.id,
      sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0))::integer solicitada,
      sum(coalesce(pp.cantidad_preparada,0))::integer preparada
    from public.pedidos p
    join public.pedido_productos pp on pp.pedido_id=p.id
    where p.reposicion_id=p_reposicion and p.estado in ('aceptado','listo')
    group by p.id
  )
  update public.pedidos p set
    estado=case when t.preparada>0 then 'transito' else 'aceptado' end,
    transporte=case when t.preparada>0 then p_transporte else p.transporte end,
    remito=case when t.preparada>0 then nullif(trim(p_remito),'') else p.remito end,
    remito_pendiente=case when t.preparada>0 then p_remito_pendiente else p.remito_pendiente end,
    enviado_at=case when t.preparada>0 then now() else p.enviado_at end,
    despacho_id=case when t.preparada>0 then d else null end,
    reposicion_id=case when t.preparada>0 then p_reposicion else null end,
    aceptado_parcial=case when t.preparada>0 then t.preparada<t.solicitada else p.aceptado_parcial end,
    nota_parcial=case
      when t.preparada>0 and t.preparada<t.solicitada
        then 'Enviado parcial desde reposicion: '||t.preparada||' de '||t.solicitada||' unidades'
      else p.nota_parcial end,
    updated_at=now()
  from totales t where p.id=t.id;

  insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre)
  select id,'transito',auth.uid(),null from public.pedidos where despacho_id=d;
  return d;
end $$;

grant execute on function public.op_finalizar_despacho(uuid,text,text,boolean,text) to authenticated;

-- El archivo se borra mediante la API de Storage después de eliminar la
-- reposición. Su dueño o un administrador pueden completar esa limpieza.
drop policy if exists op_storage_delete on storage.objects;
create policy op_storage_delete on storage.objects for delete to authenticated
using (
  bucket_id in ('op-reposiciones','op-barras-fotos')
  and (owner_id=auth.uid()::text or public.is_ops_supervisor())
);

commit;
