-- No business data is changed by installing this migration.
begin;

alter table public.op_recepcion_pedidos
  add column if not exists confirmado_at timestamptz,
  add column if not exists confirmado_by uuid references public.perfiles(id),
  add column if not exists procesado_at timestamptz;

-- Physical units allocated to an order in THIS receipt. Existing received
-- quantities remain a baseline; they are never overwritten by another receipt.
create table if not exists public.op_recepcion_pedido_unidades (
  recepcion_id uuid not null references public.op_recepciones(id) on delete restrict,
  producto_id uuid not null references public.pedido_productos(id) on delete restrict,
  pedido_id uuid not null references public.pedidos(id) on delete restrict,
  codigo text not null,
  cantidad integer not null check (cantidad>0),
  actualizado_at timestamptz not null default now(),
  actualizado_by uuid references public.perfiles(id),
  primary key(recepcion_id,producto_id)
);
create index if not exists recepcion_pedido_unidades_sku on public.op_recepcion_pedido_unidades(recepcion_id,codigo);
alter table public.op_recepcion_pedido_unidades enable row level security;
revoke all on public.op_recepcion_pedido_unidades from anon,authenticated;

create or replace function public.op_bloquear_pedidos_recepcion(p_recepcion uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('recepcion-pedidos:'||p_recepcion::text,0)) then
    raise exception 'Otra persona está actualizando este remito. Volvé a intentar';
  end if;
end $$;
revoke all on function public.op_bloquear_pedidos_recepcion(uuid) from public,anon,authenticated;

create or replace function public.op_proteger_unidades_recepcion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare usadas integer;
begin
  perform public.op_bloquear_pedidos_recepcion(old.recepcion_id);
  select coalesce(sum(cantidad),0) into usadas from public.op_recepcion_pedido_unidades
    where recepcion_id=old.recepcion_id and codigo=old.codigo;
  if usadas>0 and (tg_op='DELETE' or new.recibido<usadas or new.codigo<>old.codigo or new.recepcion_id<>old.recepcion_id) then
    raise exception 'Hay % unidades confirmadas en pedidos. No se puede reducir ni eliminar ese registro',usadas;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists proteger_unidades_recepcion on public.op_recepcion_items;
create trigger proteger_unidades_recepcion before update of recibido,codigo,recepcion_id or delete on public.op_recepcion_items
  for each row execute function public.op_proteger_unidades_recepcion();

-- Also serialize closure/deletion with quantity updates made by authenticated
-- users or QR guests. Try-lock avoids reversed row-lock deadlocks.
create or replace function public.op_proteger_cierre_recepcion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.op_bloquear_pedidos_recepcion(old.id);
  if tg_op='DELETE' and exists(select 1 from public.op_recepcion_pedidos where recepcion_id=old.id and procesado_at is not null) then
    raise exception 'Este remito ya tiene recepciones de pedidos registradas y no se puede eliminar';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists proteger_cierre_recepcion on public.op_recepciones;
create trigger proteger_cierre_recepcion before update of estado or delete on public.op_recepciones
  for each row execute function public.op_proteger_cierre_recepcion();

-- Internal DTO, shared by the authenticated panel and the sanitized QR panel.
create or replace function public.op_recepcion_pedidos_datos(p_recepcion uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'cliente',p.cliente,'telefono',p.telefono,'estado',p.estado,'urgente',p.urgente,
    'created_at',p.created_at,'remito',p.remito,'transporte',p.transporte,'tracking',p.tracking,
    'origin',p.origen_local,'destination',p.destino_local,'notas',p.notas,
    'cliente_aviso_pendiente',p.cliente_aviso_pendiente,'cliente_avisado_at',p.cliente_avisado_at,
    'confirmed',rp.confirmado_at is not null,'processed',rp.procesado_at is not null,
    'linked',rp.confirmado_at is not null or (p.estado in ('transito','llegado','incompleto','completo') and nullif(trim(p.remito),'')=trim(r.numero_remito)) or (r.estado<>'en_control' and rp.pedido_id is not null),
    'relation',case when rp.procesado_at is not null or rp.confirmado_at is not null then 'vinculado'
      when p.estado not in ('transito','llegado','incompleto','completo') then 'sin_enviar'
      when nullif(trim(p.remito),'')=trim(r.numero_remito) then 'remito'
      when nullif(trim(p.remito),'') is not null and p.estado<>'incompleto' then 'otro_remito'
      when not exists(select 1 from public.pedido_productos pp join public.op_recepcion_items ri on ri.recepcion_id=r.id and ri.codigo=pp.codigo where pp.pedido_id=p.id) then 'sin_productos'
      when r.fecha_remito<greatest((p.created_at at time zone 'America/Montevideo')::date,
        (select (max(h.created_at) at time zone 'America/Montevideo')::date from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('transito','transito_escala'))) then 'fecha_posterior'
      else 'fecha_productos' end,
    'shipping_responsible',(select h.persona_nombre from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('transito','transito_escala') order by h.created_at desc limit 1),
    'shipped_at',(select h.created_at from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('transito','transito_escala') order by h.created_at desc limit 1),
    'pedido_productos',coalesce((select jsonb_agg(jsonb_build_object(
      'id',pp.id,'codigo',pp.codigo,'nombre',pp.nombre,'cantidad',pp.cantidad,
      'cantidad_aceptada',pp.cantidad_aceptada,'cantidad_preparada',pp.cantidad_preparada,
      'cantidad_recibida',pp.cantidad_recibida,'pendiente',greatest(0,coalesce(pp.cantidad_aceptada,pp.cantidad)-pp.cantidad_recibida),
      'en_remito',ri.codigo is not null,'remito_esperado',coalesce(ri.esperado,0),
      'remito_recibido',coalesce(ri.recibido,0),'verificar',coalesce(ri.requiere_verificacion,false),
      'controlado',ri.controlado_at is not null,
      'disponible',case when ri.controlado_at is not null and not ri.requiere_verificacion then greatest(0,ri.recibido-coalesce((select sum(u.cantidad) from public.op_recepcion_pedido_unidades u where u.recepcion_id=r.id and u.codigo=pp.codigo),0)) else 0 end,
      'asignada_aqui',coalesce((select u.cantidad from public.op_recepcion_pedido_unidades u where u.recepcion_id=r.id and u.producto_id=pp.id),0)
    ) order by pp.nombre,pp.id) from public.pedido_productos pp
      left join public.op_recepcion_items ri on ri.recepcion_id=r.id and ri.codigo=pp.codigo where pp.pedido_id=p.id),'[]'::jsonb)
  ) order by p.urgente desc,p.created_at,p.id),'[]'::jsonb)
  from public.op_recepciones r join public.pedidos p on p.origen_local=r.origen_local and p.destino_local=r.destino_local
  left join public.op_recepcion_pedidos rp on rp.recepcion_id=r.id and rp.pedido_id=p.id
  where r.id=p_recepcion and (
    (r.estado='en_control' and p.estado in ('pendiente','aceptado','listo','transito_escala','en_escala','transito','llegado','incompleto'))
    or rp.pedido_id is not null
  );
$$;
revoke all on function public.op_recepcion_pedidos_datos(uuid) from public,anon,authenticated;

create or replace function public.op_recepcion_panel_pedidos(p_recepcion uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.op_recepciones;
begin
  select * into r from public.op_recepciones where id=p_recepcion;
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved)
    or r.id is null or not(public.is_ops_supervisor() or public.my_local() in(r.origen_local,r.destino_local)) then
    raise exception 'No tenés acceso a los pedidos de este remito';
  end if;
  return jsonb_build_object('orders',public.op_recepcion_pedidos_datos(r.id),
    'can_receive',r.estado='en_control' and (public.is_ops_supervisor() or public.my_local()=r.destino_local),
    'can_notify',public.is_ops_supervisor() or public.my_local()=r.destino_local);
end $$;
revoke all on function public.op_recepcion_panel_pedidos(uuid) from public,anon;
grant execute on function public.op_recepcion_panel_pedidos(uuid) to authenticated;

create or replace function public.op_recepcion_confirmar_pedido(p_recepcion uuid,p_pedido uuid,p_confirmar_vinculo boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_recepciones; p public.pedidos; rp public.op_recepcion_pedidos;
  linea record; nueva integer; libre integer; agregadas integer:=0; total integer; recibidas integer;
  completo boolean; quien text; cambio boolean; exacto boolean;
begin
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved) then raise exception 'No tenés acceso'; end if;
  perform public.op_bloquear_pedidos_recepcion(p_recepcion);
  select * into r from public.op_recepciones where id=p_recepcion for update;
  if r.id is null or r.estado<>'en_control' or not(public.is_ops_supervisor() or public.my_local()=r.destino_local) then
    raise exception 'Solo el local de destino puede confirmar pedidos en un remito abierto';
  end if;
  -- Order lock serializes cumulative quantities even across different receipts.
  select * into p from public.pedidos where id=p_pedido for update;
  if p.id is null or p.origen_local<>r.origen_local or p.destino_local<>r.destino_local then raise exception 'El pedido no pertenece a este recorrido'; end if;
  select * into rp from public.op_recepcion_pedidos where recepcion_id=r.id and pedido_id=p.id;
  if p.estado='completo' and rp.procesado_at is not null then return jsonb_build_object('estado',p.estado,'agregadas',0,'already_processed',true); end if;
  if p.estado not in ('transito','llegado','incompleto') then raise exception 'El pedido todavía no está enviado o ya fue completado'; end if;
  exacto:=coalesce(nullif(trim(p.remito),'')=trim(r.numero_remito),false);
  if not exacto and rp.confirmado_at is null then
    if nullif(trim(p.remito),'') is not null and p.estado<>'incompleto' then raise exception 'El pedido corresponde a otro remito'; end if;
    if r.fecha_remito<greatest((p.created_at at time zone 'America/Montevideo')::date,
      (select (max(h.created_at) at time zone 'America/Montevideo')::date from public.pedido_historial h where h.pedido_id=p.id and h.estado in ('transito','transito_escala'))) then
      raise exception 'La fecha del pedido o de su envío es posterior a este remito';
    end if;
    if not coalesce(p_confirmar_vinculo,false) then raise exception 'Confirmá que esta mercadería corresponde a ese pedido'; end if;
  end if;
  if not exists(select 1 from public.pedido_productos pp join public.op_recepcion_items ri on ri.recepcion_id=r.id and ri.codigo=pp.codigo where pp.pedido_id=p.id) then
    raise exception 'Los productos del pedido no figuran en este remito';
  end if;
  if exists(select 1 from public.pedido_productos pp join public.op_recepcion_items ri on ri.recepcion_id=r.id and ri.codigo=pp.codigo where pp.pedido_id=p.id and ri.requiere_verificacion) then
    raise exception 'Completá el control final de cantidades antes de confirmar este pedido';
  end if;
  select left(trim(nombre||' '||apellido),80) into quien from public.perfiles where id=auth.uid();
  insert into public.op_recepcion_pedidos(recepcion_id,pedido_id,coincidencia,confirmado_at,confirmado_by)
    values(r.id,p.id,case when exacto then 'remito' else 'ruta_sku' end,now(),auth.uid())
    on conflict(recepcion_id,pedido_id) do update set confirmado_at=coalesce(op_recepcion_pedidos.confirmado_at,now()),confirmado_by=coalesce(op_recepcion_pedidos.confirmado_by,auth.uid());
  for linea in select pp.* from public.pedido_productos pp where pp.pedido_id=p.id order by pp.codigo,pp.id for update loop
    select case when ri.controlado_at is not null and not ri.requiere_verificacion then ri.recibido else 0 end into libre
      from public.op_recepcion_items ri where ri.recepcion_id=r.id and ri.codigo=linea.codigo for update;
    libre:=greatest(0,coalesce(libre,0)-coalesce((select sum(u.cantidad) from public.op_recepcion_pedido_unidades u where u.recepcion_id=r.id and u.codigo=linea.codigo),0));
    nueva:=least(libre,greatest(0,coalesce(linea.cantidad_aceptada,linea.cantidad)-linea.cantidad_recibida));
    if nueva>0 then
      insert into public.op_recepcion_pedido_unidades(recepcion_id,producto_id,pedido_id,codigo,cantidad,actualizado_by)
        values(r.id,linea.id,p.id,linea.codigo,nueva,auth.uid()) on conflict(recepcion_id,producto_id) do update
        set cantidad=op_recepcion_pedido_unidades.cantidad+excluded.cantidad,actualizado_at=now(),actualizado_by=auth.uid();
      update public.pedido_productos set cantidad_recibida=cantidad_recibida+nueva where id=linea.id;
      agregadas:=agregadas+nueva;
    end if;
  end loop;
  select coalesce(sum(coalesce(cantidad_aceptada,cantidad)),0),coalesce(sum(least(cantidad_recibida,coalesce(cantidad_aceptada,cantidad))),0)
    into total,recibidas from public.pedido_productos where pedido_id=p.id;
  completo:=total>0 and recibidas>=total;
  cambio:=agregadas>0 or rp.procesado_at is null;
  if cambio then
    update public.pedidos set estado=case when completo then 'completo' else 'incompleto' end,
      recepcion_id=r.id,cliente_aviso_pendiente=case when completo and nullif(trim(cliente),'') is not null and cliente_avisado_at is null then true else cliente_aviso_pendiente end,
      faltantes=case when completo then null else 'Recibidas '||recibidas||' de '||total||' unidades. Último remito: '||r.numero_remito end,updated_at=now() where id=p.id;
    update public.op_recepcion_pedidos set procesado_at=now() where recepcion_id=r.id and pedido_id=p.id;
    insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre)
      values(p.id,case when completo then 'completo' else 'incompleto' end,auth.uid(),quien);
    insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,detalle)
      values(r.id,auth.uid(),quien,'pedido_recibido',jsonb_build_object('pedido_id',p.id,'unidades_agregadas',agregadas,'total_recibido',recibidas,'total_aceptado',total,'completo',completo));
    if completo and not coalesce(p.cliente_aviso_pendiente,false) and p.cliente_avisado_at is null and nullif(trim(p.cliente),'') is not null then
      insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
      select pf.id,'Pedido recibido: avisar al cliente',p.cliente||' · Remito '||r.numero_remito,p.id from public.perfiles pf where pf.approved and pf.local_nombre=r.destino_local;
    end if;
    update public.op_recepciones set updated_at=now() where id=r.id;
  end if;
  return jsonb_build_object('estado',case when completo then 'completo' else 'incompleto' end,'agregadas',agregadas,'recibidas',recibidas,'esperadas',total,'already_processed',not cambio);
end $$;
revoke all on function public.op_recepcion_confirmar_pedido(uuid,uuid,boolean) from public,anon;
grant execute on function public.op_recepcion_confirmar_pedido(uuid,uuid,boolean) to authenticated;

create or replace function public.op_recepcion_cerrar(p_recepcion uuid,p_observaciones text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_recepciones; p record; resultado jsonb; quien text; pendientes integer; completos integer; incompletos integer;
begin
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved) then raise exception 'No tenés acceso'; end if;
  perform public.op_bloquear_pedidos_recepcion(p_recepcion);
  select * into r from public.op_recepciones where id=p_recepcion for update;
  if r.id is null or r.estado<>'en_control' or not(public.is_ops_supervisor() or r.destino_local=public.my_local()) then raise exception 'Recepción no disponible'; end if;
  if exists(select 1 from public.op_recepcion_items where recepcion_id=r.id and requiere_verificacion) then raise exception 'Completá el control final de cantidades antes de cerrar'; end if;
  select left(trim(nombre||' '||apellido),80) into quien from public.perfiles where id=auth.uid();
  select count(*) into pendientes from public.op_recepcion_items where recepcion_id=r.id and recibido<esperado and not no_recibido;
  -- Only exact shipment numbers or explicitly confirmed associations. Pending,
  -- unshipped and other-remit orders are informative, never silently completed.
  for p in select o.id from public.pedidos o left join public.op_recepcion_pedidos rp on rp.recepcion_id=r.id and rp.pedido_id=o.id
    where o.origen_local=r.origen_local and o.destino_local=r.destino_local and o.estado in('transito','llegado','incompleto')
    and (rp.confirmado_at is not null or nullif(trim(o.remito),'')=trim(r.numero_remito))
    and exists(select 1 from public.pedido_productos pp join public.op_recepcion_items ri on ri.recepcion_id=r.id and ri.codigo=pp.codigo where pp.pedido_id=o.id)
    order by o.created_at,o.id
  loop
    resultado:=public.op_recepcion_confirmar_pedido(r.id,p.id,false);
  end loop;
  update public.op_recepcion_items set no_recibido=true,updated_by=auth.uid(),updated_by_name=quien,updated_at=now()
    where recepcion_id=r.id and recibido=0 and not no_recibido;
  update public.op_recepciones set estado='cerrado',observaciones_cierre=nullif(trim(coalesce(p_observaciones,'')),''),closed_by=auth.uid(),closed_at=now(),updated_at=now() where id=r.id;
  select count(*) filter(where o.estado='completo'),count(*) filter(where o.estado='incompleto') into completos,incompletos
    from public.pedidos o join public.op_recepcion_pedidos rp on rp.pedido_id=o.id where rp.recepcion_id=r.id and rp.procesado_at is not null;
  resultado:=jsonb_build_object('id',r.id,'pendientes_al_cerrar',pendientes,'pedidos_vinculados',completos+incompletos,'pedidos_completos',completos,'pedidos_incompletos',incompletos);
  insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,detalle) values(r.id,auth.uid(),quien,'cerrar',resultado);
  return resultado;
end $$;
revoke all on function public.op_recepcion_cerrar(uuid,text) from public,anon;
grant execute on function public.op_recepcion_cerrar(uuid,text) to authenticated;

create or replace function public.op_invitado_recepcion_pedidos(p_acceso text)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare g public.op_invitados_sesion; lista jsonb;
begin
  select guest.* into g from public.op_invitados_sesion guest
    join public.op_invitaciones_sesion inv on inv.id=guest.invitacion_id and inv.activa and inv.revoked_at is null
      and inv.modulo=guest.modulo and inv.sesion_id=guest.sesion_id
    join public.op_recepciones r on r.id=guest.sesion_id and r.estado='en_control'
    where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex') and guest.revoked_at is null and guest.modulo='recepcion';
  if g.id is null then raise exception 'La invitación ya no está disponible'; end if;
  -- QR collaborators see operational identifiers/quantities, not contact details.
  select coalesce(jsonb_agg(jsonb_build_object('id',o->'id','estado',o->'estado','relation',o->'relation',
    'linked',o->'linked','pedido_productos',o->'pedido_productos')),'[]'::jsonb) into lista
    from jsonb_array_elements(public.op_recepcion_pedidos_datos(g.sesion_id)) o;
  return jsonb_build_object('orders',lista,'can_receive',false,'can_notify',false);
end $$;
revoke all on function public.op_invitado_recepcion_pedidos(text) from public;
grant execute on function public.op_invitado_recepcion_pedidos(text) to anon,authenticated;

create or replace function public.op_crear_recepcion(
  p_nombre text,p_numero_remito text,p_fecha_remito date,p_origen text,p_destino text,
  p_items jsonb,p_import_meta jsonb default '{}'::jsonb,p_original_filename text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r uuid; nombre_usuario text;
begin
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved) then raise exception 'No tenés acceso'; end if;
  if trim(coalesce(p_numero_remito,''))='' or p_fecha_remito is null or trim(coalesce(p_origen,''))='' or trim(coalesce(p_destino,''))='' then
    raise exception 'Faltan número, fecha, origen o destino del remito';
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'El remito no contiene productos'; end if;
  if not (public.is_ops_supervisor() or trim(p_destino)=public.my_local()) then raise exception 'Solamente el local destino puede crear esta recepción'; end if;
  if exists(select 1 from public.op_recepciones where numero_remito=trim(p_numero_remito) and fecha_remito=p_fecha_remito and origen_local=trim(p_origen) and destino_local=trim(p_destino)) then
    raise exception 'Este remito ya fue cargado. Abrí la recepción existente';
  end if;
  select left(coalesce(nullif(trim(coalesce(nombre,'')||' '||coalesce(apellido,'')),''),'Usuario'),80) into nombre_usuario from public.perfiles where id=auth.uid();
  nombre_usuario:=coalesce(nombre_usuario,'Usuario');

  insert into public.op_recepciones(nombre,numero_remito,fecha_remito,origen_local,destino_local,original_filename,import_meta,created_by)
  values(coalesce(nullif(trim(p_nombre),''),'Remito '||trim(p_numero_remito)),trim(p_numero_remito),p_fecha_remito,trim(p_origen),trim(p_destino),nullif(trim(p_original_filename),''),coalesce(p_import_meta,'{}'::jsonb),auth.uid())
  returning id into r;

  insert into public.op_recepcion_items(recepcion_id,codigo,nombre,descripcion_archivo,barras,marca,esperado,source_lines,updated_by,updated_by_name)
  select r,trim(x->>'codigo'),coalesce(nullif(trim(x->>'nombre'),''),trim(x->>'codigo')),nullif(trim(x->>'descripcion_archivo'),''),
    nullif(trim(x->>'barras'),''),nullif(trim(x->>'marca'),''),greatest(1,(x->>'esperado')::integer),coalesce(x->'source_lines','[]'::jsonb),auth.uid(),nombre_usuario
  from jsonb_array_elements(p_items) x where trim(coalesce(x->>'codigo',''))<>'' and coalesce((x->>'esperado')::integer,0)>0;

  -- Without a number, date/product candidates stay read-only until confirmed.
  insert into public.op_recepcion_pedidos(recepcion_id,pedido_id,coincidencia)
  select r,p.id,'remito'
  from public.pedidos p
  where p.estado in ('transito','llegado') and p.origen_local=trim(p_origen) and p.destino_local=trim(p_destino)
    and nullif(trim(p.remito),'')=trim(p_numero_remito)
    and exists(
      select 1 from public.pedido_productos pp join public.op_recepcion_items ri on ri.recepcion_id=r and ri.codigo=pp.codigo
      where pp.pedido_id=p.id
    )
  on conflict do nothing;

  update public.pedidos p set recepcion_id=r,updated_at=now()
  where exists(select 1 from public.op_recepcion_pedidos rp where rp.recepcion_id=r and rp.pedido_id=p.id);
  insert into public.op_recepcion_participantes(recepcion_id,usuario_id,nombre) values(r,auth.uid(),nombre_usuario);
  insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,detalle)
  values(r,auth.uid(),nombre_usuario,'crear',jsonb_build_object('numero_remito',trim(p_numero_remito),'productos',jsonb_array_length(p_items)));
  return r;
end $$;
revoke all on function public.op_crear_recepcion(text,text,date,text,text,jsonb,jsonb,text) from public,anon;
grant execute on function public.op_crear_recepcion(text,text,date,text,text,jsonb,jsonb,text) to authenticated;

create or replace function public.op_marcar_cliente_avisado(p_pedido uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare pedido public.pedidos; nombre_usuario text;
begin
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved) then raise exception 'No tenés acceso'; end if;
  select * into pedido from public.pedidos where id=p_pedido for update;
  if pedido.id is null or not (public.is_ops_supervisor() or pedido.destino_local=public.my_local()) then raise exception 'Pedido no disponible'; end if;
  if pedido.estado<>'completo' then raise exception 'El pedido todavía no está completo'; end if;
  if not pedido.cliente_aviso_pendiente then return false; end if;
  select left(coalesce(nullif(trim(coalesce(nombre,'')||' '||coalesce(apellido,'')),''),'Usuario'),80) into nombre_usuario from public.perfiles where id=auth.uid();
  update public.pedidos set cliente_aviso_pendiente=false,cliente_avisado_at=now(),cliente_avisado_by=auth.uid(),updated_at=now() where id=p_pedido;
  insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre) values(p_pedido,'cliente_avisado',auth.uid(),coalesce(nombre_usuario,'Usuario'));
  return true;
end $$;
revoke all on function public.op_marcar_cliente_avisado(uuid) from public,anon;
grant execute on function public.op_marcar_cliente_avisado(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
