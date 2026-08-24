-- Reparto colaborativo de reposiciones en tiempo real.
-- Cada dispositivo reserva un SKU distinto. Las reservas abandonadas vencen
-- cuando el dispositivo deja de enviar actividad durante tres minutos.

begin;

alter table public.op_reposicion_items
  add column if not exists asignado_a uuid references public.perfiles(id),
  add column if not exists asignado_cliente text,
  add column if not exists asignado_nombre text,
  add column if not exists asignado_at timestamptz;

create index if not exists op_reposicion_items_asignacion_idx
  on public.op_reposicion_items(reposicion_id, asignado_cliente)
  where asignado_cliente is not null;

create table if not exists public.op_reposicion_dispositivos (
  reposicion_id uuid not null references public.op_reposiciones(id) on delete cascade,
  cliente_id text not null,
  usuario_id uuid not null references public.perfiles(id),
  nombre text not null,
  last_seen timestamptz not null default now(),
  primary key(reposicion_id, cliente_id),
  check (char_length(cliente_id) between 8 and 100)
);

alter table public.op_reposicion_dispositivos enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='op_reposicion_dispositivos'
  ) then
    alter publication supabase_realtime add table public.op_reposicion_dispositivos;
  end if;
end $$;

drop policy if exists reposicion_dispositivos_read on public.op_reposicion_dispositivos;
create policy reposicion_dispositivos_read on public.op_reposicion_dispositivos
for select to authenticated using (
  exists (
    select 1 from public.op_reposiciones r
    where r.id=reposicion_id
      and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())
  )
);

drop policy if exists reposicion_dispositivos_own on public.op_reposicion_dispositivos;
create policy reposicion_dispositivos_own on public.op_reposicion_dispositivos
for all to authenticated
using (usuario_id=auth.uid())
with check (usuario_id=auth.uid());

create or replace function public.op_reposicion_tocar(
  p_reposicion uuid,
  p_cliente text,
  p_usuario_nombre text default 'Usuario'
) returns void language plpgsql security definer set search_path=public as $$
declare cliente text:=left(trim(coalesce(p_cliente,'')),100);
begin
  if char_length(cliente)<8 then raise exception 'Identificador de dispositivo invalido'; end if;
  if not exists (
    select 1 from public.op_reposiciones r
    where r.id=p_reposicion
      and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;

  insert into public.op_reposicion_dispositivos(reposicion_id,cliente_id,usuario_id,nombre,last_seen)
  values(p_reposicion,cliente,auth.uid(),left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80),now())
  on conflict(reposicion_id,cliente_id) do update set
    usuario_id=auth.uid(),nombre=excluded.nombre,last_seen=now();

  insert into public.op_reposicion_participantes(reposicion_id,usuario_id,nombre,last_seen)
  values(p_reposicion,auth.uid(),left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80),now())
  on conflict(reposicion_id,usuario_id) do update set nombre=excluded.nombre,last_seen=now();
end $$;

create or replace function public.op_reposicion_reclamar(
  p_reposicion uuid,
  p_codigo text,
  p_cliente text,
  p_usuario_nombre text default 'Usuario',
  p_excluir_codigo text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.op_reposicion_items;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
  anterior_cliente text;
begin
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;

  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre);

  -- Libera dispositivos que dejaron de informar actividad.
  update public.op_reposicion_items i set
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where i.reposicion_id=p_reposicion and i.asignado_cliente is not null
    and not exists (
      select 1 from public.op_reposicion_dispositivos d
      where d.reposicion_id=i.reposicion_id and d.cliente_id=i.asignado_cliente
        and d.last_seen>now()-interval '3 minutes'
    );

  if nullif(trim(coalesce(p_codigo,'')),'') is null then
    -- Mantiene el trabajo actual del dispositivo si todavía está pendiente.
    select * into r from public.op_reposicion_items i
    where i.reposicion_id=p_reposicion and i.asignado_cliente=cliente
      and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
      and (p_excluir_codigo is null or i.codigo<>p_excluir_codigo)
    order by i.asignado_at nulls last,i.nombre,i.codigo
    limit 1 for update;
  else
    select * into r from public.op_reposicion_items i
    where i.reposicion_id=p_reposicion and i.codigo=p_codigo
    for update;
  end if;

  if r.codigo is null and nullif(trim(coalesce(p_codigo,'')),'') is null then
    select * into r from public.op_reposicion_items i
    where i.reposicion_id=p_reposicion
      and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
      and (p_excluir_codigo is null or i.codigo<>p_excluir_codigo)
      and (
        i.asignado_cliente is null or i.asignado_cliente=cliente or not exists (
          select 1 from public.op_reposicion_dispositivos d
          where d.reposicion_id=i.reposicion_id and d.cliente_id=i.asignado_cliente
            and d.last_seen>now()-interval '3 minutes'
        )
      )
    order by case when i.preparado>0 then 0 else 1 end,i.nombre,i.codigo
    limit 1 for update skip locked;
  end if;

  if r.codigo is null then return null; end if;

  anterior_cliente:=r.asignado_cliente;
  if r.asignado_cliente is not null and r.asignado_cliente<>cliente and exists (
    select 1 from public.op_reposicion_dispositivos d
    where d.reposicion_id=p_reposicion and d.cliente_id=r.asignado_cliente
      and d.last_seen>now()-interval '3 minutes'
  ) then
    raise exception 'Este producto lo esta juntando %',coalesce(r.asignado_nombre,'otra persona');
  end if;

  -- Un dispositivo trabaja en un solo SKU a la vez.
  update public.op_reposicion_items set
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where reposicion_id=p_reposicion and asignado_cliente=cliente and codigo<>r.codigo;

  update public.op_reposicion_items set
    asignado_a=auth.uid(),asignado_cliente=cliente,asignado_nombre=nombre,
    asignado_at=case when asignado_cliente=cliente then coalesce(asignado_at,now()) else now() end
  where reposicion_id=p_reposicion and codigo=r.codigo returning * into r;

  if anterior_cliente is distinct from cliente then
    insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
    values(p_reposicion,auth.uid(),nombre,'asignado',r.codigo,jsonb_build_object('cliente',cliente));
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.op_reposicion_liberar(
  p_reposicion uuid,
  p_cliente text,
  p_codigo text default null,
  p_usuario_nombre text default 'Usuario'
) returns integer language plpgsql security definer set search_path=public as $$
declare liberados integer;
begin
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;
  perform public.op_reposicion_tocar(p_reposicion,p_cliente,p_usuario_nombre);
  update public.op_reposicion_items set
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where reposicion_id=p_reposicion and asignado_cliente=left(trim(p_cliente),100)
    and (p_codigo is null or codigo=p_codigo);
  get diagnostics liberados=row_count;
  if liberados>0 then
    insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
    values(p_reposicion,auth.uid(),left(p_usuario_nombre,80),'liberado',p_codigo,jsonb_build_object('cliente',left(trim(p_cliente),100)));
  end if;
  if p_codigo is null then
    delete from public.op_reposicion_dispositivos
    where reposicion_id=p_reposicion and cliente_id=left(trim(p_cliente),100) and usuario_id=auth.uid();
  end if;
  return liberados;
end $$;

create or replace function public.op_reposicion_cantidad_colaborativa(
  p_reposicion uuid,p_codigo text,p_delta integer default null,p_absoluta integer default null,
  p_origen text default 'manual',p_usuario_nombre text default 'Usuario',p_cliente text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.op_reposicion_items;
  nueva integer;
  anterior integer;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if char_length(cliente)<8 then raise exception 'Identificador de dispositivo invalido'; end if;
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;
  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre);

  select * into r from public.op_reposicion_items
  where reposicion_id=p_reposicion and codigo=p_codigo for update;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  if r.asignado_cliente is not null and r.asignado_cliente<>cliente and exists (
    select 1 from public.op_reposicion_dispositivos d
    where d.reposicion_id=p_reposicion and d.cliente_id=r.asignado_cliente
      and d.last_seen>now()-interval '3 minutes'
  ) then raise exception 'Este producto lo esta juntando %',coalesce(r.asignado_nombre,'otra persona'); end if;

  update public.op_reposicion_items set
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where reposicion_id=p_reposicion and asignado_cliente=cliente and codigo<>p_codigo;

  anterior=r.preparado;
  nueva=case when p_absoluta is not null then p_absoluta else r.preparado+coalesce(p_delta,0) end;
  if nueva<0 or nueva>999999 then raise exception 'Cantidad invalida'; end if;

  update public.op_reposicion_items set
    preparado=nueva,
    no_encontrado=case when nueva>0 then false else no_encontrado end,
    cerrado_incompleto=case when nueva>=pedido_total then false else cerrado_incompleto end,
    asignado_a=case when nueva<pedido_total and not no_encontrado and not cerrado_incompleto then auth.uid() else null end,
    asignado_cliente=case when nueva<pedido_total and not no_encontrado and not cerrado_incompleto then cliente else null end,
    asignado_nombre=case when nueva<pedido_total and not no_encontrado and not cerrado_incompleto then nombre else null end,
    asignado_at=case when nueva<pedido_total and not no_encontrado and not cerrado_incompleto then coalesce(asignado_at,now()) else null end,
    updated_by=auth.uid(),updated_by_name=nombre,updated_at=now()
  where reposicion_id=p_reposicion and codigo=p_codigo returning * into r;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),nombre,'cantidad',p_codigo,
    jsonb_build_object('antes',anterior,'despues',nueva,'delta',nueva-anterior,'origen',p_origen,'cliente',cliente));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(r);
end $$;

create or replace function public.op_reposicion_marcar_colaborativa(
  p_reposicion uuid,p_codigo text,p_campo text,p_valor boolean,
  p_motivo_codigo text default null,p_motivo_label text default null,p_motivo_otro text default null,
  p_comentario text default null,p_usuario_nombre text default 'Usuario',p_cliente text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.op_reposicion_items;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if p_campo not in ('no_encontrado','cerrado_incompleto') then raise exception 'Marca invalida'; end if;
  if char_length(cliente)<8 then raise exception 'Identificador de dispositivo invalido'; end if;
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;
  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre);

  select * into r from public.op_reposicion_items
  where reposicion_id=p_reposicion and codigo=p_codigo for update;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  if r.asignado_cliente is not null and r.asignado_cliente<>cliente and exists (
    select 1 from public.op_reposicion_dispositivos d
    where d.reposicion_id=p_reposicion and d.cliente_id=r.asignado_cliente
      and d.last_seen>now()-interval '3 minutes'
  ) then raise exception 'Este producto lo esta juntando %',coalesce(r.asignado_nombre,'otra persona'); end if;

  update public.op_reposicion_items set
    no_encontrado=case when p_campo='no_encontrado' then p_valor else no_encontrado end,
    cerrado_incompleto=case when p_campo='cerrado_incompleto' then p_valor when p_campo='no_encontrado' and p_valor then true else cerrado_incompleto end,
    motivo_codigo=nullif(left(trim(coalesce(p_motivo_codigo,'')),80),''),
    motivo_label=nullif(left(trim(coalesce(p_motivo_label,'')),120),''),
    motivo_otro=nullif(left(trim(coalesce(p_motivo_otro,'')),200),''),
    comentario=nullif(left(trim(coalesce(p_comentario,'')),500),''),
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,
    updated_by=auth.uid(),updated_by_name=nombre,updated_at=now()
  where reposicion_id=p_reposicion and codigo=p_codigo returning * into r;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),nombre,p_campo,p_codigo,jsonb_build_object(
    'valor',p_valor,'motivo_codigo',p_motivo_codigo,'motivo_label',p_motivo_label,
    'motivo_otro',p_motivo_otro,'comentario',p_comentario,'cliente',cliente));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(r);
end $$;

revoke all on function public.op_reposicion_tocar(uuid,text,text) from public;
revoke all on function public.op_reposicion_reclamar(uuid,text,text,text,text) from public;
revoke all on function public.op_reposicion_liberar(uuid,text,text,text) from public;
revoke all on function public.op_reposicion_cantidad_colaborativa(uuid,text,integer,integer,text,text,text) from public;
revoke all on function public.op_reposicion_marcar_colaborativa(uuid,text,text,boolean,text,text,text,text,text,text) from public;
grant execute on function public.op_reposicion_tocar(uuid,text,text) to authenticated;
grant execute on function public.op_reposicion_reclamar(uuid,text,text,text,text) to authenticated;
grant execute on function public.op_reposicion_liberar(uuid,text,text,text) to authenticated;
grant execute on function public.op_reposicion_cantidad_colaborativa(uuid,text,integer,integer,text,text,text) to authenticated;
grant execute on function public.op_reposicion_marcar_colaborativa(uuid,text,text,boolean,text,text,text,text,text,text) to authenticated;

commit;
