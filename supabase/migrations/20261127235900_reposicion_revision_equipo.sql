-- Los apartados físicos sobreviven a pérdidas de conexión y cambios de pantalla.
alter table public.op_reposicion_items add column revision_equipo jsonb;

create function public.op_reposicion_custodia() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid;
begin
  if old.revision_equipo is not null and new.revision_equipo is not null and
    (new.asignado_cliente is not null or new.preparado<>old.preparado or
     new.no_encontrado<>old.no_encontrado or new.cerrado_incompleto<>old.cerrado_incompleto) then
    raise exception 'El equipo debe revisar este producto antes de modificarlo';
  end if;
  if new.revision_equipo is null and old.revision_equipo is null and old.asignado_cliente is not null
    and new.asignado_cliente is null and not new.no_encontrado and not new.cerrado_incompleto
    and old.preparado<old.pedido_total and new.preparado=old.preparado then
    select coalesce(old.asignado_a,d.invitado_id) into actor from public.op_reposicion_dispositivos d
      where d.reposicion_id=old.reposicion_id and d.cliente_id=old.asignado_cliente;
    new.revision_equipo:=jsonb_build_object('id',gen_random_uuid(),'actor',actor,'nombre',old.asignado_nombre,
      'motivo','Asignación liberada sin confirmar','automatica',true);
  end if;
  if new.revision_equipo is not null and old.revision_equipo is null then
    insert into public.op_reposicion_eventos(reposicion_id,codigo,accion,usuario_nombre,detalle)
    values(old.reposicion_id,old.codigo,'revision_solicitada',coalesce(new.revision_equipo->>'nombre','Equipo'),new.revision_equipo);
  end if;
  return new;
end $$;
create trigger op_reposicion_custodia before update on public.op_reposicion_items
for each row execute function public.op_reposicion_custodia();

CREATE OR REPLACE FUNCTION public.op_reposicion_reclamar(p_reposicion uuid, p_codigo text, p_cliente text, p_usuario_nombre text DEFAULT 'Usuario'::text, p_excluir_codigo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r public.op_reposicion_items;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
  anterior_cliente text;
begin
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;

  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre_usuario);

  update public.op_reposicion_items i set
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where i.reposicion_id=p_reposicion and i.asignado_cliente is not null
    and not exists (
      select 1 from public.op_reposicion_dispositivos d
      where d.reposicion_id=i.reposicion_id and d.cliente_id=i.asignado_cliente
        and d.last_seen>now()-interval '3 minutes'
    );

  if nullif(trim(coalesce(p_codigo,'')),'') is null then
    select * into r from public.op_reposicion_items i
    where i.reposicion_id=p_reposicion and i.asignado_cliente=cliente
      and i.revision_equipo is null and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
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
      and i.revision_equipo is null and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
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

  if r.revision_equipo is not null then raise exception 'El equipo está revisando este producto'; end if;
    anterior_cliente:=r.asignado_cliente;
  if r.asignado_cliente is not null and r.asignado_cliente<>cliente and exists (
    select 1 from public.op_reposicion_dispositivos d
    where d.reposicion_id=p_reposicion and d.cliente_id=r.asignado_cliente
      and d.last_seen>now()-interval '3 minutes'
  ) then
    raise exception 'Este producto lo esta juntando %',coalesce(r.asignado_nombre,'otra persona');
  end if;

  update public.op_reposicion_items set
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
  where reposicion_id=p_reposicion and asignado_cliente=cliente and codigo<>r.codigo;

  update public.op_reposicion_items set
    asignado_a=auth.uid(),asignado_cliente=cliente,asignado_nombre=nombre_usuario,
    asignado_at=case when asignado_cliente=cliente then coalesce(asignado_at,now()) else now() end
  where reposicion_id=p_reposicion and codigo=r.codigo returning * into r;

  if anterior_cliente is distinct from cliente then
    insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
    values(p_reposicion,auth.uid(),nombre_usuario,'asignado',r.codigo,jsonb_build_object('cliente',cliente));
  end if;
  return to_jsonb(r);
end $function$
;

CREATE OR REPLACE FUNCTION public.op_invitado_operar(p_acceso text, p_accion text, p_codigo text DEFAULT NULL::text, p_cantidad integer DEFAULT NULL::integer, p_detalle jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
          and i.revision_equipo is null and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
          order by i.asignado_at nulls last,i.nombre limit 1 for update;
      else
        select * into repo_item from public.op_reposicion_items i where i.reposicion_id=g.sesion_id and i.codigo=trim(p_codigo) for update;
      end if;
      if repo_item.codigo is null and nullif(trim(coalesce(p_codigo,'')),'') is null then
        select * into repo_item from public.op_reposicion_items i where i.reposicion_id=g.sesion_id
          and i.revision_equipo is null and not i.no_encontrado and not i.cerrado_incompleto and i.preparado<i.pedido_total
          and (i.asignado_cliente is null or i.asignado_cliente=g.cliente_id or not exists(
            select 1 from public.op_reposicion_dispositivos d where d.reposicion_id=i.reposicion_id and d.cliente_id=i.asignado_cliente and d.last_seen>now()-interval '3 minutes'))
          order by case when i.preparado>0 then 0 else 1 end,i.nombre,i.codigo limit 1 for update skip locked;
      end if;
      if repo_item.codigo is not null then
        if repo_item.revision_equipo is not null then raise exception 'El equipo está revisando este producto'; end if;
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
      if detalle ? 'asignado' and (repo_item.asignado_at is distinct from (detalle->>'asignado')::timestamptz
        or repo_item.preparado is distinct from (detalle->>'anterior')::integer) then
        raise exception 'La asignación o la cantidad cambió. Revisá el producto';
      end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.op_reposicion_cantidad_colaborativa(p_reposicion uuid, p_codigo text, p_delta integer DEFAULT NULL::integer, p_absoluta integer DEFAULT NULL::integer, p_origen text DEFAULT 'manual'::text, p_usuario_nombre text DEFAULT 'Usuario'::text, p_cliente text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r public.op_reposicion_items;
  nueva integer;
  anterior integer;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if char_length(cliente)<8 then raise exception 'Identificador de dispositivo invalido'; end if;
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposicion no disponible'; end if;
  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre_usuario);

  select * into r from public.op_reposicion_items
  where reposicion_id=p_reposicion and codigo=p_codigo for update;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  if r.asignado_cliente is distinct from cliente or r.asignado_a is distinct from auth.uid() or r.revision_equipo is not null then
    raise exception 'La asignación cambió. Actualizá antes de continuar';
  end if;

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
    asignado_nombre=case when nueva<pedido_total and not no_encontrado and not cerrado_incompleto then nombre_usuario else null end,
    asignado_at=case when nueva<pedido_total and not no_encontrado and not cerrado_incompleto then coalesce(asignado_at,now()) else null end,
    updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where reposicion_id=p_reposicion and codigo=p_codigo returning * into r;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),nombre_usuario,'cantidad',p_codigo,
    jsonb_build_object('antes',anterior,'despues',nueva,'delta',nueva-anterior,'origen',p_origen,'cliente',cliente));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(r);
end $function$
;

CREATE OR REPLACE FUNCTION public.op_reposicion_marcar_colaborativa(p_reposicion uuid, p_codigo text, p_campo text, p_valor boolean, p_motivo_codigo text DEFAULT NULL::text, p_motivo_label text DEFAULT NULL::text, p_motivo_otro text DEFAULT NULL::text, p_comentario text DEFAULT NULL::text, p_usuario_nombre text DEFAULT 'Usuario'::text, p_cliente text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.op_reposicion_items;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if p_campo not in ('no_encontrado','cerrado_incompleto') then raise exception 'Marca inválida'; end if;
  if char_length(cliente)<8 then raise exception 'Identificador de dispositivo inválido'; end if;
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposición no disponible'; end if;
  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre_usuario);

  select * into r from public.op_reposicion_items
  where reposicion_id=p_reposicion and codigo=trim(coalesce(p_codigo,'')) for update;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  if r.asignado_cliente is distinct from cliente or r.asignado_a is distinct from auth.uid() or r.revision_equipo is not null then
    raise exception 'La asignación cambió. Actualizá antes de continuar';
  end if;

  if p_valor and p_campo='no_encontrado' and r.preparado>0 then
    raise exception 'Ya hay % unidad(es) juntada(s). Usá el cierre con envío parcial',r.preparado;
  end if;
  if p_valor and p_campo='cerrado_incompleto'
    and (r.preparado<=0 or r.preparado>=r.pedido_total) then
    raise exception 'El cierre parcial requiere una cantidad mayor a cero y menor a la solicitada';
  end if;

  update public.op_reposicion_items set
    no_encontrado=case
      when p_campo='no_encontrado' then p_valor
      when p_campo='cerrado_incompleto' and p_valor then false
      else no_encontrado end,
    cerrado_incompleto=case
      when p_campo='cerrado_incompleto' then p_valor
      when p_campo='no_encontrado' and p_valor then false
      else cerrado_incompleto end,
    motivo_codigo=nullif(left(trim(coalesce(p_motivo_codigo,'')),80),''),
    motivo_label=nullif(left(trim(coalesce(p_motivo_label,'')),120),''),
    motivo_otro=nullif(left(trim(coalesce(p_motivo_otro,'')),200),''),
    comentario=nullif(left(trim(coalesce(p_comentario,'')),500),''),
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,
    updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where reposicion_id=p_reposicion and codigo=r.codigo returning * into r;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),nombre_usuario,p_campo,r.codigo,jsonb_build_object(
    'valor',p_valor,'cantidad',r.preparado,'solicitado',r.pedido_total,
    'motivo_codigo',p_motivo_codigo,'motivo_label',p_motivo_label,
    'motivo_otro',p_motivo_otro,'comentario',p_comentario,'cliente',cliente));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(r);
end $function$
;

CREATE OR REPLACE FUNCTION public.op_invitado_estado(p_acceso text, p_completo boolean DEFAULT true, p_codigo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
      'review',i.revision_equipo,
      'assigned_client',coalesce(i.asignado_cliente,''),
      'assigned_name',coalesce(i.asignado_nombre,''),
      'assigned_at',i.asignado_at,
      'orders',coalesce(i.pedidos_asignados,'[]'::jsonb)
    ) order by i.nombre),'[]'::jsonb)
    into items
    from public.op_reposicion_items i
    where i.reposicion_id=g.sesion_id
      and (p_completo or i.codigo=trim(coalesce(p_codigo,'')) or i.asignado_cliente=g.cliente_id or i.revision_equipo is not null);

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
$function$
;

CREATE OR REPLACE FUNCTION public.op_impedir_cierre_sin_verificacion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pendientes integer:=0;
begin
  if tg_table_name='op_reposiciones' and old.estado='preparando' and new.estado='enviado' then
    if exists(select 1 from public.op_reposicion_items where reposicion_id=new.id and revision_equipo is not null) then
      raise exception 'Quedan comprobaciones de equipo pendientes';
    end if;
    select count(*) into pendientes from public.op_reposicion_items where reposicion_id=new.id and requiere_verificacion;
  elsif tg_table_name='op_recepciones' and old.estado='en_control' and new.estado='cerrado' then
    select count(*) into pendientes from public.op_recepcion_items where recepcion_id=new.id and requiere_verificacion;
  end if;
  if pendientes>0 then raise exception 'Falta confirmar la cantidad física de % producto(s) con más de una unidad',pendientes; end if;
  return new;
end $function$
;

-- Una solicitud identifica una única comprobación. Dos respuestas simultáneas
-- se serializan en la línea y la segunda encuentra una solicitud ya resuelta.
create function public.op_reposicion_revision(p_reposicion uuid,p_codigo text,p_revision uuid,
  p_cantidad integer,p_identidad text,p_motivo text,p_acceso text default null)
returns void language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare actor uuid; nombre_actor text; item public.op_reposicion_items; origen text;
begin
  select origen_local into origen from public.op_reposiciones where id=p_reposicion and estado='preparando' for update;
  if not found then raise exception 'Reposición cerrada'; end if;
  if p_acceso is not null then
    select g.id,g.nombre into actor,nombre_actor from public.op_invitados_sesion g
    join public.op_invitaciones_sesion v on v.id=g.invitacion_id and v.activa
    where g.sesion_id=p_reposicion and g.modulo='reposicion' and g.revoked_at is null
      and g.access_hash=encode(digest(p_acceso,'sha256'),'hex');
  else
    select id,concat_ws(' ',nombre,apellido) into actor,nombre_actor from public.perfiles
    where id=auth.uid() and approved and (public.is_ops_supervisor() or local_nombre=origen);
  end if;
  if actor is null then raise exception 'Acceso no disponible'; end if;
  select * into strict item from public.op_reposicion_items where reposicion_id=p_reposicion and codigo=p_codigo for update;
  if p_revision is null then
    if item.revision_equipo is not null then raise exception 'Ya hay una comprobación abierta'; end if;
    if nullif(trim(p_motivo),'') is null then raise exception 'Indicá qué hay que comprobar'; end if;
    update public.op_reposicion_items set revision_equipo=jsonb_build_object('id',gen_random_uuid(),'actor',actor,
      'nombre',nombre_actor,'motivo',left(trim(p_motivo),200),'automatica',false),
      asignado_cliente=null,asignado_a=null,asignado_at=null,asignado_nombre=null where reposicion_id=p_reposicion and codigo=p_codigo;
  else
    if (item.revision_equipo->>'id')::uuid is distinct from p_revision then raise exception 'La comprobación ya cambió'; end if;
    if item.revision_equipo->>'actor'=actor::text and not (item.revision_equipo->>'automatica')::boolean then
      raise exception 'Pedile a otra persona que confirme'; end if;
    if coalesce(trim(p_identidad),'')='' or (trim(p_identidad)<>item.codigo and trim(p_identidad)<>coalesce(item.barras,'')) then
      raise exception 'El código no coincide con el producto'; end if;
    if p_cantidad is null or p_cantidad not between 0 and 999999 then raise exception 'Cantidad inválida'; end if;
    update public.op_reposicion_items set revision_equipo=null,preparado=p_cantidad,
      no_encontrado=false,cerrado_incompleto=false,motivo_codigo=null,motivo_label=null,motivo_otro=null,comentario=null,
      updated_at=now(),updated_by=case when p_acceso is null then actor end,updated_by_name=nombre_actor
      where reposicion_id=p_reposicion and codigo=p_codigo;
    insert into public.op_reposicion_eventos(reposicion_id,codigo,accion,usuario_nombre,detalle)
    values(p_reposicion,p_codigo,'revision_confirmada',nombre_actor,jsonb_build_object('revision',p_revision,'actor',actor,
      'antes',item.preparado,'despues',p_cantidad));
  end if;
end $$;
revoke all on function public.op_reposicion_revision(uuid,text,uuid,integer,text,text,text) from public;
grant execute on function public.op_reposicion_revision(uuid,text,uuid,integer,text,text,text) to anon,authenticated;
CREATE OR REPLACE FUNCTION public.op_reposicion_enviar_pedido(p_reposicion uuid, p_pedido uuid, p_transporte text, p_remito text DEFAULT NULL::text, p_tracking text DEFAULT NULL::text, p_responsable text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad)>0 and (ri.requiere_verificacion or ri.revision_equipo is not null)) then
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
end $function$
;

-- Las acciones tardías y los reintentos llevan la asignación y cantidad originales.
create function public.op_reposicion_cantidad_vigente(p_reposicion uuid,p_codigo text,p_delta integer,
  p_absoluta integer,p_origen text,p_usuario_nombre text,p_cliente text,p_asignado timestamptz,p_anterior integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.op_reposicion_items;
begin
  if not exists(select 1 from public.op_reposiciones r where r.id=p_reposicion and r.estado='preparando'
    and (public.is_ops_supervisor() or r.origen_local=public.my_local())) then raise exception 'Reposición no disponible'; end if;
  select * into item from public.op_reposicion_items where reposicion_id=p_reposicion and codigo=p_codigo for update;
  if item.asignado_at is null or item.asignado_at is distinct from p_asignado or item.preparado is distinct from p_anterior then
    raise exception 'La asignación o la cantidad cambió. Revisá el producto antes de continuar';
  end if;
  return public.op_reposicion_cantidad_colaborativa(p_reposicion,p_codigo,p_delta,p_absoluta,p_origen,p_usuario_nombre,p_cliente);
end $$;
revoke all on function public.op_reposicion_cantidad_vigente(uuid,text,integer,integer,text,text,text,timestamptz,integer) from public,anon;
grant execute on function public.op_reposicion_cantidad_vigente(uuid,text,integer,integer,text,text,text,timestamptz,integer) to authenticated;

-- Cerrar la preparación conserva los envíos individuales de pedidos ya registrados.
create function public.op_reposicion_cerrar_preparacion(p_reposicion uuid,p_transporte text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare origen text;
begin
  perform public.op_bloquear_pedidos_reposicion(p_reposicion);
  select origen_local into origen from public.op_reposiciones where id=p_reposicion and estado='preparando' for update;
  if origen is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved and
    (local_nombre=origen or public.is_ops_supervisor())) then raise exception 'Reposición no disponible'; end if;
  if nullif(trim(p_transporte),'') is null or length(p_transporte)>120 then raise exception 'Ingresá el transporte'; end if;
  if exists(select 1 from public.op_reposicion_items where reposicion_id=p_reposicion and
    (revision_equipo is not null or requiere_verificacion or
    (preparado<pedido_total and not no_encontrado and not cerrado_incompleto))) then
    raise exception 'Quedan productos sin decidir o comprobar'; end if;
  if exists(select 1 from public.pedidos where reposicion_id=p_reposicion and estado in ('aceptado','listo')) then
    raise exception 'Resolvé los pedidos vinculados desde Pedidos antes de cerrar'; end if;
  insert into public.op_despachos(reposicion_id,origen_local,destino_local,transporte,remito_pendiente,enviado_by)
    select id,origen_local,destino_local,trim(p_transporte),true,auth.uid() from public.op_reposiciones where id=p_reposicion;
  update public.op_reposiciones set estado='enviado',enviado_by=auth.uid(),enviado_at=now(),updated_at=now(),
    transporte=trim(p_transporte),remito_pendiente=true where id=p_reposicion;
end $$;
revoke all on function public.op_reposicion_cerrar_preparacion(uuid,text) from public,anon;
grant execute on function public.op_reposicion_cerrar_preparacion(uuid,text) to authenticated;

-- También protege a dispositivos con una versión anterior de la pantalla.
create function public.op_reposicion_preparacion_abierta() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare id_repo uuid:=case when tg_op='DELETE' then old.reposicion_id else new.reposicion_id end;
begin
  perform public.op_bloquear_pedidos_reposicion(id_repo);
  if exists(select 1 from public.op_reposiciones where id=id_repo and estado<>'preparando') then
    raise exception 'La reposición ya salió del local';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger op_preparacion_abierta before insert or update or delete on public.op_reposicion_items
for each row execute function public.op_reposicion_preparacion_abierta();
create trigger op_preparacion_abierta before insert or update or delete on public.op_reposicion_extras
for each row execute function public.op_reposicion_preparacion_abierta();
