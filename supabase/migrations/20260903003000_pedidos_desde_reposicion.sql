-- Acceptance is explicit; already accepted orders still enter automatically
-- through op_crear_reposicion. No existing order is accepted by this migration.
begin;

-- Fail fast instead of deadlocking when two devices change linked quantities.
create or replace function public.op_bloquear_pedidos_reposicion(p_reposicion uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('repo-pedidos:'||p_reposicion::text,0)) then
    raise exception 'Otro usuario está actualizando esta reposición. Volvé a intentar';
  end if;
end $$;
revoke all on function public.op_bloquear_pedidos_reposicion(uuid) from public,anon,authenticated;

create or replace function public.op_pedido_resumen_preparacion(p_pedido uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'id',p.id,'cliente',coalesce(p.cliente,'Sin nombre'),'estado',p.estado,
    'origin',p.origen_local,'destination',p.destino_local,'urgente',coalesce(p.urgente,false),
    'reposicion_id',p.reposicion_id,'created_at',p.created_at,
    'products',coalesce((select jsonb_agg(jsonb_build_object(
      'id',pp.id,'codigo',pp.codigo,'nombre',pp.nombre,'solicitada',pp.cantidad,
      'aceptada',coalesce(pp.cantidad_aceptada,pp.cantidad),'preparada',pp.cantidad_preparada
    ) order by pp.nombre,pp.id) from public.pedido_productos pp where pp.pedido_id=p.id),'[]'::jsonb)
  ) from public.pedidos p where p.id=p_pedido;
$$;
revoke all on function public.op_pedido_resumen_preparacion(uuid) from public,anon,authenticated;

create or replace function public.op_reposicion_panel_pedidos(p_reposicion uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.op_reposiciones; lista jsonb;
begin
  select * into r from public.op_reposiciones where id=p_reposicion;
  if r.id is null or not coalesce(public.is_ops_supervisor() or public.my_local() in (r.origen_local,r.destino_local),false) then
    raise exception 'No tenés acceso a los pedidos de esta reposición';
  end if;
  select coalesce(jsonb_agg(public.op_pedido_resumen_preparacion(p.id)||jsonb_build_object(
    'has_scale',nullif(trim(p.escala_local),'') is not null or coalesce(p.notas,'')~'__escala_queue__:\s*\[\s*\{',
    'needs_verification',exists(select 1 from public.pedido_productos pp join public.op_reposicion_items ri on ri.reposicion_id=r.id and ri.codigo=pp.codigo where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad)>0 and ri.requiere_verificacion),
    'shipping',jsonb_build_object('transport',p.transporte,'receipt',p.remito,'tracking',p.tracking,
      'sent_at',(select max(h.created_at) from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('transito','transito_escala')),
      'responsible',(select h.persona_nombre from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('transito','transito_escala') order by h.created_at desc limit 1))
    ) order by p.created_at,p.id),'[]'::jsonb)
  into lista from public.pedidos p
  where p.reposicion_id=r.id or (r.estado='preparando' and p.reposicion_id is null
    and p.origen_local=r.origen_local and p.destino_local=r.destino_local and p.estado in ('pendiente','aceptado'));
  return jsonb_build_object('orders',lista,'can_accept',r.estado='preparando' and (public.is_ops_supervisor() or public.my_local()=r.origen_local),
    'transports',(select coalesce(jsonb_agg(nombre order by nombre),'[]'::jsonb) from public.transportes),
    'responsible',(select trim(nombre||' '||apellido) from public.perfiles where id=auth.uid()));
end $$;
revoke all on function public.op_reposicion_panel_pedidos(uuid) from public,anon;
grant execute on function public.op_reposicion_panel_pedidos(uuid) to authenticated;

create or replace function public.op_reposicion_aceptar_agregar_pedido(
  p_reposicion uuid,p_pedido uuid,p_aceptar boolean default false,p_cantidades jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_reposiciones; p public.pedidos; quien text; parcial boolean;
begin
  perform public.op_bloquear_pedidos_reposicion(p_reposicion);
  select * into r from public.op_reposiciones where id=p_reposicion for update;
  if r.id is null or r.estado<>'preparando' or not coalesce(public.is_ops_supervisor() or public.my_local()=r.origen_local,false) then
    raise exception 'Solo el local de origen o un supervisor puede aceptar pedidos en una reposición abierta';
  end if;
  select * into p from public.pedidos where id=p_pedido for update;
  if p.id is null or p.origen_local<>r.origen_local or p.destino_local<>r.destino_local then
    raise exception 'El pedido no corresponde a este recorrido';
  end if;
  if p.reposicion_id=r.id then return jsonb_build_object('already_added',true,'order',public.op_pedido_resumen_preparacion(p.id)); end if;
  if p.reposicion_id is not null then raise exception 'Otra reposición ya incorporó este pedido. Actualizá la lista'; end if;
  if p.estado not in ('pendiente','aceptado') then raise exception 'El pedido cambió de estado. Actualizá la lista'; end if;
  select left(trim(nombre||' '||apellido),80) into quien from public.perfiles where id=auth.uid() and approved=true;
  quien:=coalesce(nullif(quien,''),'Usuario');
  perform id from public.pedido_productos where pedido_id=p.id order by id for update;
  if not exists(select 1 from public.pedido_productos where pedido_id=p.id) then raise exception 'El pedido no tiene productos'; end if;

  if p.estado='pendiente' then
    if not coalesce(p_aceptar,false) then raise exception 'Revisá y confirmá la aceptación del pedido'; end if;
    if p_cantidades is null or jsonb_typeof(p_cantidades)<>'array' then raise exception 'Confirmá las cantidades de cada producto'; end if;
    if jsonb_array_length(p_cantidades)<>(select count(*) from public.pedido_productos where pedido_id=p.id)
      or (select count(distinct x->>'id') from jsonb_array_elements(p_cantidades) x)<>jsonb_array_length(p_cantidades)
      or exists(select 1 from jsonb_array_elements(p_cantidades) x
        left join public.pedido_productos pp on pp.id::text=x->>'id' and pp.pedido_id=p.id
        where pp.id is null or coalesce(x->>'cantidad','')!~'^[0-9]{1,6}$'
          or case when coalesce(x->>'cantidad','')~'^[0-9]{1,6}$' then (x->>'cantidad')::integer>pp.cantidad else true end)
    then raise exception 'Las cantidades deben ser enteras entre cero y lo solicitado, sin repetir productos'; end if;
    if not exists(select 1 from jsonb_array_elements(p_cantidades) x where (x->>'cantidad')::integer>0) then
      raise exception 'Aceptá al menos una unidad o dejá el pedido pendiente';
    end if;
    update public.pedido_productos pp set cantidad_aceptada=(x->>'cantidad')::integer
    from jsonb_array_elements(p_cantidades) x where pp.id::text=x->>'id' and pp.pedido_id=p.id;
    select bool_or(cantidad_aceptada<cantidad) into parcial from public.pedido_productos where pedido_id=p.id;
    update public.pedidos set estado='aceptado',aceptado_parcial=parcial,
      nota_parcial=case when parcial then 'Cantidades aceptadas desde Reposición' else null end,updated_at=now() where id=p.id;
    insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre) values(p.id,'aceptado',auth.uid(),quien);
    insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
    select pf.id,'Pedido aceptado para reposición',coalesce(p.cliente,'Cliente')||' · '||r.origen_local||' → '||r.destino_local,p.id
    from public.perfiles pf where pf.approved=true and pf.local_nombre=r.destino_local;
  end if;

  if not exists(select 1 from public.pedido_productos where pedido_id=p.id and coalesce(cantidad_aceptada,cantidad)>0) then
    raise exception 'El pedido no tiene unidades aceptadas para preparar';
  end if;
  if exists(select 1 from public.pedido_productos where pedido_id=p.id and coalesce(cantidad_aceptada,cantidad)>0 and nullif(trim(codigo),'') is null) then
    raise exception 'Un producto del pedido no tiene código. Corregilo en Pedidos antes de agregarlo';
  end if;
  insert into public.op_reposicion_pedidos(reposicion_id,pedido_id,agregado_by) values(r.id,p.id,auth.uid());
  update public.pedidos set reposicion_id=r.id,integrado_en_reposicion_at=now(),updated_at=now() where id=p.id;

  -- Merge into the physical picking item, preserving quantities already counted.
  insert into public.op_reposicion_items(reposicion_id,codigo,nombre,barras,marca,pedido_clientes,pedidos_asignados,updated_by,updated_by_name)
  select r.id,pp.codigo,coalesce(max(pr.nombre),max(pp.nombre),pp.codigo),max(pr.barras),coalesce(max(pr.marca),max(pp.marca)),
    sum(coalesce(pp.cantidad_aceptada,pp.cantidad))::integer,
    jsonb_agg(jsonb_build_object('pedido_id',p.id,'cliente',coalesce(p.cliente,'Sin nombre'),
      'cantidad',coalesce(pp.cantidad_aceptada,pp.cantidad),'urgente',coalesce(p.urgente,false))),auth.uid(),quien
  from public.pedido_productos pp left join public.productos pr on pr.codigo=pp.codigo
  where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad)>0 group by pp.codigo order by pp.codigo
  on conflict(reposicion_id,codigo) do update set
    pedido_clientes=public.op_reposicion_items.pedido_clientes+excluded.pedido_clientes,
    pedidos_asignados=public.op_reposicion_items.pedidos_asignados||excluded.pedidos_asignados,
    no_encontrado=false,cerrado_incompleto=false,updated_at=now(),updated_by=auth.uid(),updated_by_name=quien;
  perform public.op_sincronizar_pedidos_reposicion(r.id);
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,detalle)
  values(r.id,auth.uid(),quien,'pedido_incorporado',jsonb_build_object('pedido_id',p.id,'aceptado_desde_reposicion',p.estado='pendiente'));
  return jsonb_build_object('already_added',false,'order',public.op_pedido_resumen_preparacion(p.id));
end $$;
revoke all on function public.op_reposicion_aceptar_agregar_pedido(uuid,uuid,boolean,jsonb) from public,anon;
grant execute on function public.op_reposicion_aceptar_agregar_pedido(uuid,uuid,boolean,jsonb) to authenticated;

-- Guest detail is read-only, scoped to this invitation and linked orders only.
-- No phone, address, notes, share tokens or unrelated order data is returned.
create or replace function public.op_invitado_pedidos_producto(p_acceso text,p_codigo text)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare g public.op_invitados_sesion; r public.op_reposiciones; lista jsonb; pendientes integer;
begin
  select guest.* into g from public.op_invitados_sesion guest
  join public.op_invitaciones_sesion inv on inv.id=guest.invitacion_id and inv.activa=true and inv.revoked_at is null
    and inv.modulo=guest.modulo and inv.sesion_id=guest.sesion_id
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex') and guest.revoked_at is null and guest.modulo='reposicion';
  select * into r from public.op_reposiciones where id=g.sesion_id and estado='preparando';
  if g.id is null or r.id is null then raise exception 'La invitación ya no está disponible'; end if;
  select count(*) into pendientes from public.pedidos where origen_local=r.origen_local and destino_local=r.destino_local and estado='pendiente' and reposicion_id is null;
  select coalesce(jsonb_agg(public.op_pedido_resumen_preparacion(p.id) order by p.created_at,p.id),'[]'::jsonb) into lista
  from public.pedidos p where p.reposicion_id=r.id
    and exists(select 1 from public.op_reposicion_pedidos rp where rp.reposicion_id=r.id and rp.pedido_id=p.id)
    and exists(select 1 from public.pedido_productos pp join public.op_reposicion_items ri on ri.reposicion_id=r.id and ri.codigo=pp.codigo
      where pp.pedido_id=p.id and pp.codigo=trim(coalesce(p_codigo,'')));
  return jsonb_build_object('orders',lista,'can_accept',false,'pending_count',pendientes);
end $$;
revoke all on function public.op_invitado_pedidos_producto(text,text) from public;
grant execute on function public.op_invitado_pedidos_producto(text,text) to anon,authenticated;

-- Status notifications are generated by the database, including guest updates.
create or replace function public.op_avisar_pedido_preparado()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare titulo text;
begin
  if new.reposicion_id is null or new.estado=old.estado then return new; end if;
  if new.estado='listo' and old.estado='aceptado' then titulo:='Pedido listo para enviar';
  elsif new.estado='aceptado' and old.estado='listo' then titulo:='Pedido nuevamente pendiente de preparación';
  else return new; end if;
  insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
  select pf.id,titulo,coalesce(new.cliente,'Cliente')||' · '||new.origen_local||' → '||new.destino_local,new.id
  from public.perfiles pf where pf.approved=true and pf.local_nombre in (new.origen_local,new.destino_local);
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,detalle)
  values(new.reposicion_id,auth.uid(),'Preparación de pedidos','pedido_estado',jsonb_build_object('pedido_id',new.id,'estado',new.estado));
  return new;
end $$;
revoke all on function public.op_avisar_pedido_preparado() from public,anon,authenticated;
drop trigger if exists op_pedido_aviso_preparacion on public.pedidos;
create trigger op_pedido_aviso_preparacion after update of estado on public.pedidos
for each row when (new.estado is distinct from old.estado) execute function public.op_avisar_pedido_preparado();

-- Sending a single order updates the same fields and history used by Pedidos.
-- It does not dispatch the entire replenishment or confirm arrival at destination.
create or replace function public.op_reposicion_enviar_pedido(
  p_reposicion uuid,p_pedido uuid,p_transporte text,p_remito text default null,
  p_tracking text default null,p_responsable text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_reposiciones; p public.pedidos;
begin
  perform public.op_bloquear_pedidos_reposicion(p_reposicion);
  select * into r from public.op_reposiciones where id=p_reposicion for update;
  if r.id is null or r.estado<>'preparando' or not coalesce(public.is_ops_supervisor() or public.my_local()=r.origen_local,false) then
    raise exception 'Solo el local de origen o un supervisor puede registrar el envío';
  end if;
  select * into p from public.pedidos where id=p_pedido for update;
  if p.id is null or p.reposicion_id is distinct from r.id or p.origen_local<>r.origen_local or p.destino_local<>r.destino_local then
    raise exception 'El pedido no pertenece a esta reposición';
  end if;
  if p.estado='transito' then return jsonb_build_object('already_sent',true); end if;
  if p.estado<>'listo' then raise exception 'El pedido debe estar listo para enviar. Actualizá las cantidades'; end if;
  if nullif(trim(p.escala_local),'') is not null or coalesce(p.notas,'')~'__escala_queue__:\s*\[\s*\{' then
    raise exception 'Este pedido tiene una escala. Registrá el envío desde Pedidos entre locales';
  end if;
  if nullif(trim(p_transporte),'') is null or length(p_transporte)>120 or nullif(trim(p_responsable),'') is null or length(p_responsable)>80
    or length(coalesce(p_remito,''))>100 or length(coalesce(p_tracking,''))>160 then
    raise exception 'Completá el transporte y el responsable; revisá la longitud de los datos';
  end if;
  if not exists(select 1 from public.pedido_productos where pedido_id=p.id and coalesce(cantidad_aceptada,cantidad)>0)
    or exists(select 1 from public.pedido_productos where pedido_id=p.id and coalesce(cantidad_preparada,0)<coalesce(cantidad_aceptada,cantidad)) then
    raise exception 'Las cantidades del pedido todavía no están completas';
  end if;
  if exists(select 1 from public.pedido_productos pp join public.op_reposicion_items ri on ri.reposicion_id=r.id and ri.codigo=pp.codigo
    where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad)>0 and ri.requiere_verificacion) then
    raise exception 'Las cantidades necesitan el control final antes de registrar el envío';
  end if;
  update public.pedidos set estado='transito',transporte=trim(p_transporte),remito=nullif(trim(p_remito),''),
    tracking=nullif(trim(p_tracking),''),updated_at=now() where id=p.id;
  insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre) values(p.id,'transito',auth.uid(),trim(p_responsable));
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,detalle)
  values(r.id,auth.uid(),trim(p_responsable),'pedido_enviado',jsonb_build_object('pedido_id',p.id,'transporte',trim(p_transporte),'remito',nullif(trim(p_remito),''),'tracking',nullif(trim(p_tracking),'')));
  insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
  select pf.id,'Pedido en viaje',coalesce(p.cliente,'Cliente')||' · '||r.origen_local||' → '||r.destino_local||' · '||trim(p_transporte),p.id
  from public.perfiles pf where pf.approved=true and pf.local_nombre=r.destino_local;
  return jsonb_build_object('already_sent',false);
end $$;
revoke all on function public.op_reposicion_enviar_pedido(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.op_reposicion_enviar_pedido(uuid,uuid,text,text,text,text) to authenticated;

-- Once an order leaves the warehouse its units cannot be counted for another.
create or replace function public.op_sincronizar_pedidos_reposicion(p_reposicion uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare cambios integer:=0;
begin
  perform public.op_bloquear_pedidos_reposicion(p_reposicion);
  with enviadas as (
    select pp.codigo,sum(coalesce(pp.cantidad_preparada,0))::integer cantidad
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    where p.reposicion_id=p_reposicion and p.estado not in ('pendiente','aceptado','listo','denegado') group by pp.codigo
  ), lineas as (
    select pp.id,pp.pedido_id,pp.codigo,coalesce(pp.cantidad_aceptada,pp.cantidad,0)::integer solicitada,
      greatest(0,least(ri.preparado,ri.pedido_clientes)-coalesce(e.cantidad,0))::integer disponible,
      coalesce(sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0)) over(
        partition by pp.codigo order by p.created_at,p.id,pp.id rows between unbounded preceding and 1 preceding
      ),0)::integer previa
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    join public.op_reposicion_items ri on ri.reposicion_id=p_reposicion and ri.codigo=pp.codigo
    left join enviadas e on e.codigo=pp.codigo
    where p.reposicion_id=p_reposicion and p.estado in ('aceptado','listo')
  ), asignadas as (select id,greatest(0,least(solicitada,disponible-previa))::integer cantidad from lineas)
  update public.pedido_productos pp set cantidad_preparada=a.cantidad from asignadas a where pp.id=a.id;
  with totales as (
    select p.id,sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0))::integer solicitada,sum(coalesce(pp.cantidad_preparada,0))::integer preparada
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    where p.reposicion_id=p_reposicion and p.estado in ('aceptado','listo') group by p.id
  ), actualizados as (
    update public.pedidos p set estado=case when t.solicitada>0 and t.preparada>=t.solicitada then 'listo' else 'aceptado' end,updated_at=now()
    from totales t where p.id=t.id and p.estado is distinct from case when t.solicitada>0 and t.preparada>=t.solicitada then 'listo' else 'aceptado' end
    returning p.id,p.estado
  ) insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre)
  select id,estado,auth.uid(),'Reposición automática' from actualizados;
  get diagnostics cambios=row_count;
  return cambios;
end $$;
revoke all on function public.op_sincronizar_pedidos_reposicion(uuid) from public,anon,authenticated;

create or replace function public.op_proteger_unidades_enviadas()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare enviadas integer;
begin
  perform public.op_bloquear_pedidos_reposicion(case when tg_op='DELETE' then old.reposicion_id else new.reposicion_id end);
  if tg_op='INSERT' then return new; end if;
  select coalesce(sum(pp.cantidad_preparada),0)::integer into enviadas
  from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
  where p.reposicion_id=old.reposicion_id and pp.codigo=old.codigo and p.estado not in ('pendiente','aceptado','listo','denegado');
  if (tg_op='DELETE' and enviadas>0) or (tg_op='UPDATE' and new.preparado<enviadas) then
    raise exception 'El producto tiene % unidades ya enviadas. No se pueden quitar de la preparación',enviadas;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.op_proteger_unidades_enviadas() from public,anon,authenticated;
drop trigger if exists op_item_proteger_enviadas on public.op_reposicion_items;
create trigger op_item_proteger_enviadas before insert or update or delete on public.op_reposicion_items
for each row execute function public.op_proteger_unidades_enviadas();

create or replace function public.op_proteger_reposicion_enviada()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.op_bloquear_pedidos_reposicion(old.id);
  if exists(select 1 from public.op_reposicion_eventos where reposicion_id=old.id and accion='pedido_enviado') then
    raise exception 'Esta reposición tiene envíos registrados y no se puede eliminar';
  end if;
  return old;
end $$;
revoke all on function public.op_proteger_reposicion_enviada() from public,anon,authenticated;
drop trigger if exists op_repo_proteger_enviada on public.op_reposiciones;
create trigger op_repo_proteger_enviada before delete on public.op_reposiciones for each row execute function public.op_proteger_reposicion_enviada();
commit;
