-- Paridad visual y de auditoría para la preparación de Reposición por invitación QR.

create or replace function public.op_invitado_estado(
  p_acceso text,
  p_completo boolean default true,
  p_codigo text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,extensions,pg_temp
as $$
declare
  g public.op_invitados_sesion;
  invitacion public.op_invitaciones_sesion;
  info jsonb;
  items jsonb;
  extras jsonb;
  aportes jsonb;
begin
  select guest.* into g
  from public.op_invitados_sesion guest
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex')
    and guest.revoked_at is null
  limit 1;

  if g.id is null then
    return jsonb_build_object('ok',false,'error','El acceso de invitado ya no es válido');
  end if;

  select * into invitacion from public.op_invitaciones_sesion where id=g.invitacion_id;
  info:=public.op_sesion_invitada_info(g.modulo,g.sesion_id);
  if not coalesce(invitacion.activa,false) then
    return jsonb_build_object('ok',false,'error','La invitación fue pausada');
  end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then
    return jsonb_build_object('ok',false,'error','La sesión ya finalizó');
  end if;

  update public.op_invitados_sesion set last_seen=now() where id=g.id;

  if g.modulo='inventario' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'code',i.codigo,'name',i.nombre,'barcode',coalesce(i.barras,''),
      'quantity',i.cantidad,'updated_at',i.updated_at
    ) order by i.updated_at desc),'[]'::jsonb)
    into items
    from public.op_inventario_items i
    where i.sesion_id=g.sesion_id and (p_completo or i.codigo=trim(coalesce(p_codigo,'')));

    select coalesce(jsonb_agg(jsonb_build_object(
      'code',a.codigo,'quantity',a.cantidad,'updated_at',a.updated_at
    ) order by a.updated_at desc),'[]'::jsonb)
    into aportes
    from public.op_invitado_aportes a
    where a.invitado_id=g.id
      and (p_completo or a.codigo=trim(coalesce(p_codigo,'')))
      and (a.cantidad>0 or not p_completo);

  elsif g.modulo='reposicion' then
    insert into public.op_reposicion_dispositivos(reposicion_id,cliente_id,usuario_id,invitado_id,nombre,last_seen)
    values(g.sesion_id,g.cliente_id,null,g.id,g.nombre,now())
    on conflict(reposicion_id,cliente_id) do update
      set invitado_id=excluded.invitado_id,nombre=excluded.nombre,last_seen=now();

    select coalesce(jsonb_agg(jsonb_build_object(
      'code',i.codigo,
      'name',i.nombre,
      'barcode',coalesce(i.barras,''),
      'file_description',coalesce(i.descripcion_archivo,''),
      'requested',i.pedido_total,
      'requested_reposition',i.pedido_reposicion,
      'requested_customers',i.pedido_clientes,
      'prepared',i.preparado,
      'not_found',i.no_encontrado,
      'closed_incomplete',i.cerrado_incompleto,
      'assigned_client',coalesce(i.asignado_cliente,''),
      'assigned_name',coalesce(i.asignado_nombre,''),
      'assigned_at',i.asignado_at,
      'orders',coalesce(i.pedidos_asignados,'[]'::jsonb)
    ) order by i.nombre),'[]'::jsonb)
    into items
    from public.op_reposicion_items i
    where i.reposicion_id=g.sesion_id
      and (p_completo or i.codigo=trim(coalesce(p_codigo,'')) or i.asignado_cliente=g.cliente_id);

    select coalesce(jsonb_agg(jsonb_build_object(
      'code',x.codigo,'name',x.nombre,'barcode',coalesce(x.barras,''),'quantity',x.cantidad
    ) order by x.nombre),'[]'::jsonb)
    into extras
    from public.op_reposicion_extras x
    where x.reposicion_id=g.sesion_id
      and (p_completo or x.codigo=trim(coalesce(p_codigo,'')))
      and (x.cantidad>0 or not p_completo);

  else
    insert into public.op_recepcion_dispositivos(recepcion_id,cliente_id,usuario_id,invitado_id,nombre,last_seen)
    values(g.sesion_id,g.cliente_id,null,g.id,g.nombre,now())
    on conflict(recepcion_id,cliente_id) do update
      set invitado_id=excluded.invitado_id,usuario_id=null,nombre=excluded.nombre,last_seen=now();

    perform public.op_recepcion_limpiar_asignaciones(g.sesion_id);

    select coalesce(jsonb_agg(jsonb_build_object(
      'code',i.codigo,'name',i.nombre,'barcode',coalesce(i.barras,''),
      'expected',i.esperado,'received',i.recibido,'not_received',i.no_recibido,
      'observation',coalesce(i.observacion,''),'controlled_at',i.controlado_at,
      'assigned_client',coalesce(i.asignado_cliente,''),'assigned_name',coalesce(i.asignado_nombre,''),
      'assigned_at',i.asignado_at,'updated_by',coalesce(i.updated_by_name,'')
    ) order by i.nombre),'[]'::jsonb)
    into items
    from public.op_recepcion_items i
    where i.recepcion_id=g.sesion_id
      and (p_completo or i.codigo=trim(coalesce(p_codigo,'')) or i.asignado_cliente=g.cliente_id);

    select coalesce(jsonb_agg(jsonb_build_object(
      'code',x.codigo,'name',x.nombre,'barcode',coalesce(x.barras,''),'quantity',x.cantidad
    ) order by x.nombre),'[]'::jsonb)
    into extras
    from public.op_recepcion_extras x
    where x.recepcion_id=g.sesion_id
      and (p_completo or x.codigo=trim(coalesce(p_codigo,'')))
      and (x.cantidad>0 or not p_completo);
  end if;

  return jsonb_build_object(
    'ok',true,
    'guest',jsonb_build_object('id',g.id,'name',g.nombre,'client_id',g.cliente_id),
    'session',info,
    'items',coalesce(items,'[]'::jsonb),
    'extras',coalesce(extras,'[]'::jsonb),
    'contributions',coalesce(aportes,'[]'::jsonb),
    'partial',not p_completo,
    'server_time',now()
  );
end
$$;

create or replace function public.op_invitado_reposicion_liberar(
  p_acceso text,
  p_codigo text,
  p_detalle jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,extensions,pg_temp
as $$
declare
  g public.op_invitados_sesion;
  invitacion public.op_invitaciones_sesion;
  info jsonb;
  item public.op_reposicion_items;
  detalle_limpio jsonb;
begin
  select guest.* into g
  from public.op_invitados_sesion guest
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex')
    and guest.revoked_at is null
  limit 1;

  if g.id is null or g.modulo<>'reposicion' then
    raise exception 'El acceso no corresponde a Reposición';
  end if;

  select * into invitacion
  from public.op_invitaciones_sesion
  where id=g.invitacion_id and activa;
  info:=public.op_sesion_invitada_info(g.modulo,g.sesion_id);
  if invitacion.id is null then raise exception 'La invitación fue pausada'; end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then
    raise exception 'La sesión ya finalizó';
  end if;

  select * into item
  from public.op_reposicion_items
  where reposicion_id=g.sesion_id and codigo=trim(coalesce(p_codigo,''))
  for update;

  if item.codigo is null or item.asignado_cliente is distinct from g.cliente_id then
    raise exception 'Este producto ya no está asignado a tu sesión';
  end if;

  detalle_limpio:=jsonb_build_object(
    'reason',nullif(left(trim(coalesce(p_detalle->>'reason','')),80),''),
    'reason_label',nullif(left(trim(coalesce(p_detalle->>'reason_label','')),120),''),
    'comment',nullif(left(trim(coalesce(p_detalle->>'comment','')),500),''),
    'invitado_id',g.id,
    'cliente',g.cliente_id
  );

  update public.op_reposicion_items
  set asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,updated_at=now()
  where reposicion_id=g.sesion_id and codigo=item.codigo;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(g.sesion_id,null,g.nombre,'invitado_salteado',item.codigo,detalle_limpio);

  update public.op_invitados_sesion set last_seen=now() where id=g.id;
  update public.op_reposiciones set updated_at=now() where id=g.sesion_id;

  return public.op_invitado_estado(p_acceso,false,item.codigo);
end
$$;

revoke all on function public.op_invitado_reposicion_liberar(text,text,jsonb) from public;
grant execute on function public.op_invitado_reposicion_liberar(text,text,jsonb) to anon,authenticated;

