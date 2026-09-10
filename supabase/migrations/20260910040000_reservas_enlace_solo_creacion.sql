-- El enlace de cada local abre solamente la creación de una reserva.
-- Consultar, editar y controlar reservas requiere una cuenta aprobada.

begin;

alter table public.op_reservas
  add column if not exists created_via_link_id uuid references public.op_reserva_enlaces(id) on delete set null;

create index if not exists op_reservas_created_via_link_idx
  on public.op_reservas(created_via_link_id,created_at desc)
  where created_via_link_id is not null;

create or replace function public.op_reserva_actor(p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.perfiles;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión para consultar o gestionar reservas'; end if;
  select * into p from public.perfiles where id=auth.uid() and approved=true;
  if p.id is null then raise exception 'La cuenta no está aprobada'; end if;
  return jsonb_build_object('authenticated',true,'user_id',p.id,'guest_id',null,
    'name',coalesce(nullif(trim(p.nombre_display),''),trim(p.nombre||' '||p.apellido)),
    'local',p.local_nombre,'warehouse',p.almacen,
    'supervisor',p.role in ('admin','supervisor_general'),'role',p.role,
    'public_create',false,'link_id',null);
end $$;
revoke all on function public.op_reserva_actor(text) from public,anon,authenticated;

create or replace function public.op_reserva_actor_creacion(p_enlace text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.op_reserva_enlaces; l public.locales; a jsonb;
begin
  if nullif(trim(coalesce(p_enlace,'')),'') is null then
    return public.op_reserva_actor(null);
  end if;
  select * into e from public.op_reserva_enlaces
    where token_hash=encode(digest(p_enlace,'sha256'),'hex') and activo and revoked_at is null;
  if e.id is null then raise exception 'El enlace de creación no está disponible'; end if;
  select * into l from public.locales where id=e.local_id;
  if l.id is null then raise exception 'El local del enlace ya no está disponible'; end if;
  return jsonb_build_object('authenticated',false,'user_id',null,'guest_id',null,
    'name','Acceso de creación','local',l.nombre,'warehouse',l.almacen,
    'supervisor',false,'role','creador','public_create',true,'link_id',e.id);
end $$;
revoke all on function public.op_reserva_actor_creacion(text) from public,anon,authenticated;

create or replace function public.op_reserva_contexto(p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; motivos jsonb; locales jsonb; cfg jsonb; recepciones jsonb;
begin
  a:=public.op_reserva_actor_creacion(p_acceso);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'nombre',nombre,'almacen',almacen) order by nombre),'[]')
    into locales from public.locales;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'local_nombre',local_nombre,'nombre',nombre,'activo',activo,'orden',orden) order by orden,nombre),'[]')
    into motivos from public.op_reserva_motivos where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  select coalesce(jsonb_object_agg(local_nombre,jsonb_build_object('horas_reserva',horas_reserva,
    'ubicacion_reservas',ubicacion_reservas,'printer_path',printer_path,'printer_profile',printer_profile)),'{}') into cfg
    from public.op_reserva_config_local where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'local_nombre',local_nombre,'origen_tipo',origen_tipo,
    'origen_nombre',origen_nombre,'dias_recepcion',dias_recepcion,'activo',activo) order by local_nombre,origen_tipo,origen_nombre),'[]')
    into recepciones from public.op_reserva_recepciones_habituales
    where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  return jsonb_build_object('actor',a,'locals',locales,'reasons',motivos,'config',cfg,'reception_schedules',recepciones);
end $$;

create or replace function public.op_reserva_buscar_productos(p_consulta text,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; q text; result jsonb;
begin
  a:=public.op_reserva_actor_creacion(p_acceso); q:=lower(unaccent(trim(coalesce(p_consulta,''))));
  if char_length(q)<2 then return '[]'::jsonb; end if;
  with catalogo as (
    select codigo,nombre,coalesce(marca,'') marca,1 prioridad from public.productos where nullif(trim(codigo),'') is not null
    union all select codigo,nombre,coalesce(marca,'') marca,2 from public.padron_extra where nullif(trim(codigo),'') is not null
  ), unicos as (
    select distinct on (codigo) codigo,nombre,marca from catalogo c
    where lower(unaccent(concat_ws(' ',codigo,nombre,marca))) like '%'||q||'%' order by codigo,prioridad
  ) select coalesce(jsonb_agg(to_jsonb(x) order by x.nombre),'[]') into result from (select * from unicos order by nombre limit 30) x;
  return result;
end $$;

create or replace function public.op_reserva_buscar_clientes(p_consulta text,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; q text; result jsonb;
begin
  a:=public.op_reserva_actor_creacion(p_acceso); q:=lower(unaccent(trim(coalesce(p_consulta,''))));
  if char_length(q)<2 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.nombre),'[]') into result from (
    select id,nombre,apellido,telefono,direccion,documento,email from public.clientes_agenda
    where lower(unaccent(concat_ws(' ',nombre,apellido,telefono,direccion,documento))) like '%'||q||'%' order by nombre limit 30
  ) x;
  return result;
end $$;

create or replace function public.op_reserva_pedidos_candidatos(p_local text,p_consulta text default null,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; q text; result jsonb;
begin
  a:=public.op_reserva_actor_creacion(p_acceso);
  if not (coalesce((a->>'supervisor')::boolean,false) or p_local=a->>'local') then raise exception 'No podés gestionar pedidos para ese local'; end if;
  q:=lower(unaccent(trim(coalesce(p_consulta,''))));
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into result from (
    select p.id,p.origen_local,p.destino_local,p.cliente,p.telefono,p.estado,p.created_at,
      coalesce(jsonb_agg(jsonb_build_object('codigo',pp.codigo,'nombre',pp.nombre,'cantidad',coalesce(pp.cantidad_aceptada,pp.cantidad)) order by pp.nombre),'[]') productos
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    where p.destino_local=p_local and p.estado<>'denegado' and p.reserva_id is null
      and (q='' or lower(unaccent(concat_ws(' ',p.id::text,p.origen_local,p.cliente,p.telefono,pp.codigo,pp.nombre))) like '%'||q||'%')
    group by p.id order by p.created_at desc limit 40
  ) x;
  return result;
end $$;

create or replace function public.op_reserva_crear_v2(p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; l public.locales; m public.op_reserva_motivos; r public.op_reservas; c public.clientes_agenda;
  items jsonb; motivo text; v_phone text; v_token text; v_estado text; v_public boolean; v_link uuid;
begin
  a:=public.op_reserva_actor_creacion(p_acceso);
  v_public:=coalesce((a->>'public_create')::boolean,false);
  v_link:=nullif(a->>'link_id','')::uuid;
  select * into l from public.locales where nombre=coalesce(nullif(trim(p_datos->>'local'),''),a->>'local');
  if l.id is null or not (coalesce((a->>'supervisor')::boolean,false) or l.nombre=a->>'local') then raise exception 'No podés crear reservas para ese local'; end if;
  if char_length(trim(coalesce(p_datos->>'responsable',''))) not between 2 and 80 then raise exception 'El responsable es obligatorio'; end if;
  if v_public then
    perform pg_advisory_xact_lock(hashtext('reserva-enlace:'||v_link::text));
    if (select count(*) from public.op_reservas where created_via_link_id=v_link and created_at>now()-interval '1 hour')>=100 then
      raise exception 'Se alcanzó temporalmente el límite de reservas para este enlace';
    end if;
    a:=jsonb_set(a,'{name}',to_jsonb(left(trim(p_datos->>'responsable'),80)),true);
  end if;
  select coalesce(jsonb_agg(x||jsonb_build_object(
    'pedido_local_gestion',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'pedido_local_gestion',''),nullif(p_datos->>'pedido_local_gestion',''),'externo') end,
    'pedido_existente_id',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'pedido_existente_id',''),nullif(p_datos->>'pedido_existente_id','')) end,
    'origen_local',case when x->>'procedencia'='pedido_local' then coalesce(nullif(x->>'origen_local',''),nullif(p_datos->>'pedido_local_origen','')) end,
    'proveedor_nombre',case when x->>'procedencia'='proveedor' then coalesce(nullif(trim(x->>'proveedor_nombre'),''),'Proveedor no especificado') end
  ) order by ord),'[]') into items from jsonb_array_elements(coalesce(p_datos->'items','[]')) with ordinality item(x,ord);
  select case when count(distinct x->>'procedencia')>1 then 'Origen mixto'
    when max(x->>'procedencia')='local' then 'Ya estaba en local'
    when max(x->>'procedencia')='pedido_local' then 'Pedido a otro local' else 'Esperando proveedor' end
    into motivo from jsonb_array_elements(items) x;
  select * into m from public.op_reserva_motivos where local_nombre=l.nombre and nombre=motivo and activo limit 1;

  v_phone:=regexp_replace(coalesce(p_datos#>>'{cliente,telefono}',''),'\D','','g');
  if v_phone<>'' then perform pg_advisory_xact_lock(hashtext('agenda:'||v_phone)); end if;
  if nullif(p_datos#>>'{cliente,id}','') is not null then
    select * into c from public.clientes_agenda where id=(p_datos#>>'{cliente,id}')::uuid;
  elsif v_phone<>'' then
    select * into c from public.clientes_agenda where regexp_replace(coalesce(telefono,''),'\D','','g')=v_phone order by updated_at desc limit 1;
  end if;
  if c.id is null and nullif(trim(concat_ws('',p_datos#>>'{cliente,nombre}',p_datos#>>'{cliente,apellido}',p_datos#>>'{cliente,telefono}',p_datos#>>'{cliente,direccion}',p_datos#>>'{cliente,documento}')),'') is not null then
    insert into public.clientes_agenda(nombre,apellido,telefono,direccion,documento)
    values(nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),''),
      nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),''),
      nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')) returning * into c;
  elsif c.id is not null then
    update public.clientes_agenda set nombre=coalesce(nullif(trim(p_datos#>>'{cliente,nombre}'),''),nombre),apellido=coalesce(nullif(trim(p_datos#>>'{cliente,apellido}'),''),apellido),
      telefono=coalesce(nullif(trim(p_datos#>>'{cliente,telefono}'),''),telefono),direccion=coalesce(nullif(trim(p_datos#>>'{cliente,direccion}'),''),direccion),
      documento=coalesce(nullif(trim(p_datos#>>'{cliente,documento}'),''),documento),updated_at=now() where id=c.id returning * into c;
  end if;

  insert into public.op_reservas(local_nombre,local_almacen,motivo_id,motivo_nombre,motivo_comentario,responsable_nombre,
    cliente_id,cliente_nombre,cliente_apellido,cliente_telefono,cliente_direccion,cliente_documento,referencia_externa,
    created_by,created_by_name,invitado_id,created_via_link_id)
  values(l.nombre,l.almacen,m.id,motivo,nullif(left(trim(coalesce(p_datos->>'motivo_comentario','')),1000),''),left(trim(p_datos->>'responsable'),80),
    c.id,coalesce(c.nombre,nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),'')),coalesce(c.apellido,nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),'')),
    coalesce(c.telefono,nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),'')),coalesce(c.direccion,nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),'')),
    coalesce(c.documento,nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')),nullif(left(trim(coalesce(p_datos->>'referencia_externa','')),120),''),
    (a->>'user_id')::uuid,a->>'name',(a->>'guest_id')::uuid,v_link) returning * into r;
  perform public.op_reserva_insertar_items(r.id,items,a);
  perform public.op_reserva_recalcular(r.id,a->>'name');
  v_token:=encode(gen_random_bytes(32),'hex');
  update public.op_reservas set qr_token=v_token,qr_token_hash=encode(digest(v_token,'sha256'),'hex'),qr_updated_at=now() where id=r.id returning estado into v_estado;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'crear',v_estado,jsonb_build_object('productos',jsonb_array_length(items),'origen_general',motivo,'canal',case when v_public then 'enlace_local' else 'cuenta' end),(a->>'user_id')::uuid,null,a->>'name');
  return jsonb_build_object('ok',true,'id',r.id,'code',r.codigo,'state',v_estado,'qr_token',v_token,
    'label',jsonb_build_object('id',r.id,'codigo',r.codigo,'local_nombre',r.local_nombre,'local_almacen',r.local_almacen,
      'motivo_nombre',r.motivo_nombre,'cliente_nombre',r.cliente_nombre,'cliente_apellido',r.cliente_apellido,'created_at',r.created_at));
end $$;

-- El rol anónimo conserva únicamente contexto de creación, búsquedas necesarias,
-- creación y consulta pública del QR. Todas las operaciones de gestión exigen login.
revoke execute on function public.op_reserva_invitado_entrar(text,text,text) from anon,authenticated;
revoke execute on function public.op_reserva_crear(jsonb,text) from anon;
revoke execute on function public.op_reserva_listar(jsonb,text) from anon;
revoke execute on function public.op_reserva_detalle(uuid,text) from anon;
revoke execute on function public.op_reserva_actualizar_item(uuid,jsonb,text) from anon;
revoke execute on function public.op_reserva_pedidos_disponibles(uuid,text,text) from anon;
revoke execute on function public.op_reserva_vincular_pedido(uuid,uuid,text) from anon;
revoke execute on function public.op_reserva_cambiar_estado(uuid,text,text,text) from anon;
revoke execute on function public.op_reserva_comentar(uuid,text,text) from anon;
revoke execute on function public.op_reserva_excepcion(uuid,timestamptz,text,text) from anon;
revoke execute on function public.op_reserva_finalizar(uuid,text,jsonb,text,text) from anon;
revoke execute on function public.op_reserva_cancelar(uuid,text,text) from anon;
revoke execute on function public.op_reserva_corregir_cierre(uuid,jsonb,text,text) from anon;
revoke execute on function public.op_reserva_qr_regenerar(uuid,text) from anon;
revoke execute on function public.op_reserva_qr_resolver(text,text) from anon;
revoke execute on function public.op_reserva_editar(uuid,jsonb,text) from anon;
revoke execute on function public.op_reserva_eliminar(uuid,text,text,text) from anon;

revoke all on function public.op_reserva_contexto(text) from public;
revoke all on function public.op_reserva_buscar_productos(text,text) from public;
revoke all on function public.op_reserva_buscar_clientes(text,text) from public;
revoke all on function public.op_reserva_pedidos_candidatos(text,text,text) from public;
revoke all on function public.op_reserva_crear_v2(jsonb,text) from public;
grant execute on function public.op_reserva_contexto(text) to anon,authenticated;
grant execute on function public.op_reserva_buscar_productos(text,text) to anon,authenticated;
grant execute on function public.op_reserva_buscar_clientes(text,text) to anon,authenticated;
grant execute on function public.op_reserva_pedidos_candidatos(text,text,text) to anon,authenticated;
grant execute on function public.op_reserva_crear_v2(jsonb,text) to anon,authenticated;

commit;
