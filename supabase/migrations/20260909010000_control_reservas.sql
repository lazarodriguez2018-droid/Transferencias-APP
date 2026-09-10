-- Control de reservas de mercaderia para clientes y usos internos.
-- Cada reserva tiene un unico QR, puede contener varios productos y puede
-- enlazar pedidos entre locales sin convertir este modulo en un stock.

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

alter table public.clientes_agenda add column if not exists apellido text;
alter table public.clientes_agenda add column if not exists documento text;
alter table public.clientes_agenda add column if not exists email text;
alter table public.clientes_agenda alter column nombre drop not null;

create table if not exists public.op_reserva_config_local (
  local_nombre text primary key,
  horas_reserva integer not null default 48 check (horas_reserva between 1 and 720),
  dias_recepcion smallint[] not null default '{}'::smallint[],
  printer_path text,
  printer_profile text not null default 'star-bsc10-80-max',
  updated_by uuid references public.perfiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint op_reserva_config_dias_check check (
    dias_recepcion <@ array[0,1,2,3,4,5,6]::smallint[]
  )
);

create table if not exists public.op_reserva_motivos (
  id uuid primary key default gen_random_uuid(),
  local_nombre text not null,
  nombre text not null check (char_length(trim(nombre)) between 2 and 80),
  activo boolean not null default true,
  orden integer not null default 0,
  created_by uuid references public.perfiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists op_reserva_motivos_local_nombre_idx
  on public.op_reserva_motivos(local_nombre,lower(nombre));

create table if not exists public.op_reserva_enlaces (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales(id) on delete cascade,
  token_hash text not null unique,
  activo boolean not null default true,
  created_by uuid not null references public.perfiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists op_reserva_enlaces_local_activo_idx
  on public.op_reserva_enlaces(local_id) where activo and revoked_at is null;

create table if not exists public.op_reserva_invitados (
  id uuid primary key default gen_random_uuid(),
  enlace_id uuid not null references public.op_reserva_enlaces(id) on delete cascade,
  nombre text not null check (char_length(trim(nombre)) between 2 and 80),
  dispositivo_hash text not null,
  access_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '12 hours'),
  revoked_at timestamptz
);

create index if not exists op_reserva_invitados_enlace_idx
  on public.op_reserva_invitados(enlace_id,created_at desc);

create table if not exists public.op_reservas (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  local_nombre text not null,
  local_almacen text not null,
  motivo_id uuid references public.op_reserva_motivos(id) on delete set null,
  motivo_nombre text not null,
  motivo_comentario text,
  responsable_nombre text not null,
  cliente_id uuid references public.clientes_agenda(id) on delete set null,
  cliente_nombre text,
  cliente_apellido text,
  cliente_telefono text,
  cliente_direccion text,
  cliente_documento text,
  referencia_externa text,
  remito_numero text,
  fecha_estimada date,
  estado text not null default 'buscando' check (estado in (
    'buscando','en_transito','recibido','separando','listo','avisado',
    'parcial','vencido','completado','cancelado'
  )),
  estado_antes_vencido text,
  mercaderia_local_at timestamptz,
  vencimiento_at timestamptz,
  excepcion_hasta timestamptz,
  excepcion_motivo text,
  final_tipo text check (final_tipo is null or final_tipo in (
    'retiro_cliente','reparto','envio_otro_local','uso_interno','no_retirado','otro'
  )),
  final_comentario text,
  completed_at timestamptz,
  created_by uuid references public.perfiles(id) on delete set null,
  created_by_name text not null,
  invitado_id uuid references public.op_reserva_invitados(id) on delete set null,
  qr_token text unique,
  qr_token_hash text unique,
  qr_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pedidos add column if not exists reserva_id uuid references public.op_reservas(id) on delete set null;

create table if not exists public.op_reserva_items (
  id uuid primary key default gen_random_uuid(),
  reserva_id uuid not null references public.op_reservas(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  cantidad integer not null check (cantidad between 1 and 999999),
  cantidad_local integer not null default 0 check (cantidad_local between 0 and 999999),
  cantidad_entregada integer not null default 0 check (cantidad_entregada between 0 and 999999),
  procedencia text not null default 'local' check (procedencia in (
    'local','proveedor','pedido_local','reposicion','remito','otro'
  )),
  origen_local text,
  fecha_estimada date,
  remito_numero text,
  comentario text,
  estado text not null default 'pendiente' check (estado in (
    'pendiente','en_transito','recibido','separado','entregado'
  )),
  pedido_id uuid references public.pedidos(id) on delete set null,
  reposicion_id uuid references public.op_reposiciones(id) on delete set null,
  recepcion_id uuid references public.op_recepciones(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint op_reserva_item_cantidades_check check (
    cantidad_local + cantidad_entregada <= cantidad
  )
);

create table if not exists public.op_reserva_comentarios (
  id uuid primary key default gen_random_uuid(),
  reserva_id uuid not null references public.op_reservas(id) on delete cascade,
  texto text not null check (char_length(trim(texto)) between 1 and 1000),
  usuario_id uuid references public.perfiles(id) on delete set null,
  invitado_id uuid references public.op_reserva_invitados(id) on delete set null,
  autor_nombre text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.op_reserva_eventos (
  id bigint generated by default as identity primary key,
  reserva_id uuid not null references public.op_reservas(id) on delete cascade,
  accion text not null,
  estado text,
  detalle jsonb not null default '{}'::jsonb,
  usuario_id uuid references public.perfiles(id) on delete set null,
  invitado_id uuid references public.op_reserva_invitados(id) on delete set null,
  autor_nombre text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.op_recepcion_reservas (
  recepcion_id uuid not null references public.op_recepciones(id) on delete cascade,
  reserva_id uuid not null references public.op_reservas(id) on delete cascade,
  coincidencia text not null default 'confirmada' check (coincidencia in ('remito','fecha_productos','confirmada')),
  linked_by uuid references public.perfiles(id) on delete set null,
  linked_at timestamptz not null default now(),
  primary key(recepcion_id,reserva_id)
);

create index if not exists op_reservas_local_estado_idx
  on public.op_reservas(local_nombre,estado,updated_at desc);
create index if not exists op_reservas_vencimiento_idx
  on public.op_reservas(vencimiento_at) where estado not in ('completado','cancelado');
create index if not exists op_reserva_items_reserva_idx
  on public.op_reserva_items(reserva_id,created_at);
create index if not exists op_reserva_items_pedido_idx
  on public.op_reserva_items(pedido_id) where pedido_id is not null;
create index if not exists op_reserva_comentarios_reserva_idx
  on public.op_reserva_comentarios(reserva_id,created_at desc);
create index if not exists op_reserva_eventos_reserva_idx
  on public.op_reserva_eventos(reserva_id,created_at desc);
create index if not exists op_recepcion_reservas_reserva_idx
  on public.op_recepcion_reservas(reserva_id,linked_at desc);

insert into public.op_reserva_config_local(local_nombre)
select l.nombre from public.locales l on conflict(local_nombre) do nothing;

insert into public.op_reserva_motivos(local_nombre,nombre,orden)
select l.nombre,m.nombre,m.orden from public.locales l cross join (values
  ('Retiro en tienda',10),('Reparto',20),('Pedido web',30),('Pedido por CX',40),
  ('Envío a otro local',50),('Esperando proveedor',60),('Uso interno',70),('Otro',100)
) as m(nombre,orden)
on conflict do nothing;

create or replace function public.op_reserva_actor(p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare p public.perfiles; g public.op_reserva_invitados; l public.locales;
begin
  if auth.uid() is not null then
    select * into p from public.perfiles where id=auth.uid() and approved=true;
    if p.id is null then raise exception 'La cuenta no está aprobada'; end if;
    return jsonb_build_object('authenticated',true,'user_id',p.id,'guest_id',null,
      'name',coalesce(nullif(trim(p.nombre_display),''),trim(p.nombre||' '||p.apellido)),
      'local',p.local_nombre,'warehouse',p.almacen,
      'supervisor',p.role in ('admin','supervisor_general'),'role',p.role);
  end if;
  select guest.* into g from public.op_reserva_invitados guest
    join public.op_reserva_enlaces e on e.id=guest.enlace_id and e.activo and e.revoked_at is null
    where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex')
      and guest.revoked_at is null and guest.expires_at>now() limit 1;
  if g.id is null then raise exception 'El acceso rápido venció o ya no está disponible'; end if;
  select loc.* into l from public.locales loc join public.op_reserva_enlaces e on e.local_id=loc.id where e.id=g.enlace_id;
  return jsonb_build_object('authenticated',false,'user_id',null,'guest_id',g.id,
    'name',g.nombre,'local',l.nombre,'warehouse',l.almacen,'supervisor',false,'role','invitado');
end $$;

revoke all on function public.op_reserva_actor(text) from public,anon,authenticated;

create or replace function public.op_reserva_puede_ver(p_reserva uuid,p_actor jsonb)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.op_reservas r where r.id=p_reserva and (
    coalesce((p_actor->>'supervisor')::boolean,false) or r.local_nombre=p_actor->>'local'
  ))
$$;
revoke all on function public.op_reserva_puede_ver(uuid,jsonb) from public,anon,authenticated;

create or replace function public.op_reserva_recalcular(p_reserva uuid,p_autor text default 'Sistema')
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.op_reservas; v_total integer; v_local integer; v_entregado integer;
  v_transito boolean; v_recibido boolean; v_nuevo text; v_horas integer;
begin
  select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or r.estado in ('completado','cancelado','vencido') then return; end if;
  select coalesce(sum(cantidad),0),coalesce(sum(cantidad_local),0),coalesce(sum(cantidad_entregada),0),
    coalesce(bool_or(estado='en_transito'),false),coalesce(bool_or(estado='recibido'),false)
    into v_total,v_local,v_entregado,v_transito,v_recibido from public.op_reserva_items where reserva_id=r.id;
  if v_local>0 and r.mercaderia_local_at is null then
    select coalesce(c.horas_reserva,48) into v_horas from public.op_reserva_config_local c where c.local_nombre=r.local_nombre;
    v_horas:=coalesce(v_horas,48);
    update public.op_reservas set mercaderia_local_at=now(),vencimiento_at=now()+make_interval(hours=>v_horas) where id=r.id;
  end if;
  if v_total>0 and v_entregado>0 and v_entregado<v_total then v_nuevo:='parcial';
  elsif v_total>0 and v_local+v_entregado>=v_total then
    v_nuevo:=case when r.estado='avisado' then 'avisado' else 'listo' end;
  elsif v_local>0 then v_nuevo:=case when r.estado='separando' then 'separando' when v_recibido then 'recibido' else 'separando' end;
  elsif v_transito then v_nuevo:='en_transito';
  else v_nuevo:='buscando'; end if;
  if v_nuevo is distinct from r.estado then
    update public.op_reservas set estado=v_nuevo,updated_at=now() where id=r.id;
    insert into public.op_reserva_eventos(reserva_id,accion,estado,autor_nombre,detalle)
      values(r.id,'estado_automatico',v_nuevo,p_autor,jsonb_build_object('estado_anterior',r.estado));
    if v_nuevo='listo' then
      insert into public.notificaciones(usuario_id,titulo,cuerpo)
      select p.id,'Reserva lista: avisar al cliente','#'||r.codigo||' · '||coalesce(nullif(trim(r.cliente_nombre||' '||coalesce(r.cliente_apellido,'')),''),'Sin cliente')
      from public.perfiles p where p.approved=true and p.local_nombre=r.local_nombre;
    end if;
  else update public.op_reservas set updated_at=now() where id=r.id; end if;
end $$;
revoke all on function public.op_reserva_recalcular(uuid,text) from public,anon,authenticated;

create or replace function public.op_reservas_actualizar_vencidas()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare total integer;
begin
  with vencidas as (
    update public.op_reservas set estado_antes_vencido=estado,estado='vencido',updated_at=now()
    where estado not in ('vencido','completado','cancelado') and vencimiento_at is not null and vencimiento_at<=now()
      and (excepcion_hasta is null or excepcion_hasta<=now()) returning *
  ), eventos as (
    insert into public.op_reserva_eventos(reserva_id,accion,estado,autor_nombre,detalle)
      select id,'vencimiento','vencido','Sistema',jsonb_build_object('vencimiento_at',vencimiento_at) from vencidas
  ), avisos as (
    insert into public.notificaciones(usuario_id,titulo,cuerpo)
      select p.id,'Reserva con más de 48 horas','#'||v.codigo||' · '||coalesce(nullif(trim(v.cliente_nombre||' '||coalesce(v.cliente_apellido,'')),''),v.motivo_nombre)
      from vencidas v join public.perfiles p on p.approved=true and p.local_nombre=v.local_nombre
  ) select count(*) into total from vencidas;
  return total;
end $$;
revoke all on function public.op_reservas_actualizar_vencidas() from public,anon,authenticated;

create or replace function public.op_reserva_invitado_entrar(p_enlace text,p_nombre text,p_dispositivo text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.op_reserva_enlaces; l public.locales; token text; g public.op_reserva_invitados;
begin
  if char_length(trim(coalesce(p_nombre,''))) not between 2 and 80 then raise exception 'Escribí tu nombre'; end if;
  if char_length(trim(coalesce(p_dispositivo,''))) not between 8 and 120 then raise exception 'No se pudo identificar el dispositivo'; end if;
  select * into e from public.op_reserva_enlaces where token_hash=encode(digest(coalesce(p_enlace,''),'sha256'),'hex') and activo and revoked_at is null;
  if e.id is null then raise exception 'El enlace rápido ya no está disponible'; end if;
  select * into l from public.locales where id=e.local_id;
  if (select count(*) from public.op_reserva_invitados where enlace_id=e.id and created_at>now()-interval '1 hour')>=100 then
    raise exception 'Se alcanzó temporalmente el límite de accesos';
  end if;
  token:=encode(gen_random_bytes(32),'hex');
  insert into public.op_reserva_invitados(enlace_id,nombre,dispositivo_hash,access_hash)
    values(e.id,left(trim(p_nombre),80),encode(digest(p_dispositivo,'sha256'),'hex'),encode(digest(token,'sha256'),'hex')) returning * into g;
  return jsonb_build_object('ok',true,'access',token,'expires_at',g.expires_at,
    'local',jsonb_build_object('id',l.id,'nombre',l.nombre,'almacen',l.almacen),'name',g.nombre);
end $$;

create or replace function public.op_reserva_contexto(p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; motivos jsonb; locales jsonb; cfg jsonb;
begin
  a:=public.op_reserva_actor(p_acceso);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'nombre',nombre,'almacen',almacen) order by nombre),'[]')
    into locales from public.locales;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'local_nombre',local_nombre,'nombre',nombre,'activo',activo,'orden',orden) order by orden,nombre),'[]')
    into motivos from public.op_reserva_motivos where (local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false));
  select coalesce(jsonb_object_agg(local_nombre,jsonb_build_object('horas_reserva',horas_reserva,'dias_recepcion',dias_recepcion,
    'printer_path',printer_path,'printer_profile',printer_profile)),'{}') into cfg
    from public.op_reserva_config_local where local_nombre=a->>'local' or coalesce((a->>'supervisor')::boolean,false);
  return jsonb_build_object('actor',a,'locals',locales,'reasons',motivos,'config',cfg);
end $$;

create or replace function public.op_reserva_buscar_productos(p_consulta text,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; q text; result jsonb;
begin
  a:=public.op_reserva_actor(p_acceso); q:=lower(unaccent(trim(coalesce(p_consulta,''))));
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
  a:=public.op_reserva_actor(p_acceso); q:=lower(unaccent(trim(coalesce(p_consulta,''))));
  if char_length(q)<2 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.nombre),'[]') into result from (
    select id,nombre,apellido,telefono,direccion,documento,email from public.clientes_agenda
    where lower(unaccent(concat_ws(' ',nombre,apellido,telefono,direccion,documento))) like '%'||q||'%' order by nombre limit 30
  ) x;
  return result;
end $$;

create or replace function public.op_reserva_crear(p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; l public.locales; m public.op_reserva_motivos; r public.op_reservas; c public.clientes_agenda;
  item jsonb; v_cliente uuid; v_phone text; v_token text; origen public.locales; p_id uuid; v_estado text;
begin
  a:=public.op_reserva_actor(p_acceso);
  select * into l from public.locales where nombre=coalesce(nullif(trim(p_datos->>'local'),''),a->>'local');
  if l.id is null or not (coalesce((a->>'supervisor')::boolean,false) or l.nombre=a->>'local') then raise exception 'No podés crear reservas para ese local'; end if;
  select * into m from public.op_reserva_motivos where id=(p_datos->>'motivo_id')::uuid and local_nombre=l.nombre and activo;
  if m.id is null then raise exception 'Elegí un motivo válido'; end if;
  if char_length(trim(coalesce(p_datos->>'responsable',''))) not between 2 and 80 then raise exception 'El responsable es obligatorio'; end if;
  if jsonb_typeof(p_datos->'items')<>'array' or jsonb_array_length(p_datos->'items') not between 1 and 100 then raise exception 'Agregá al menos un producto'; end if;
  if exists(select 1 from jsonb_array_elements(p_datos->'items') x where nullif(trim(x->>'codigo'),'') is null or nullif(trim(x->>'nombre'),'') is null
    or coalesce(x->>'cantidad','')!~'^\d{1,6}$' or (x->>'cantidad')::integer<1
    or coalesce(x->>'cantidad_local','0')!~'^\d{1,6}$' or (x->>'cantidad_local')::integer>(x->>'cantidad')::integer
    or coalesce(x->>'procedencia','') not in ('local','proveedor','pedido_local','reposicion','remito','otro')) then
    raise exception 'Revisá los productos, cantidades y procedencias';
  end if;
  if exists(select 1 from jsonb_array_elements(p_datos->'items') x where x->>'procedencia'='pedido_local'
    and (nullif(trim(x->>'origen_local'),'') is null or x->>'origen_local'=l.nombre
      or not exists(select 1 from public.locales loc where loc.nombre=x->>'origen_local'))) then raise exception 'Elegí otro local válido para los productos solicitados'; end if;

  v_phone:=regexp_replace(coalesce(p_datos#>>'{cliente,telefono}',''),'\D','','g');
  if nullif(p_datos#>>'{cliente,id}','') is not null then
    select * into c from public.clientes_agenda where id=(p_datos#>>'{cliente,id}')::uuid;
    v_cliente:=c.id;
  elsif nullif(trim(concat_ws('',p_datos#>>'{cliente,nombre}',p_datos#>>'{cliente,apellido}',p_datos#>>'{cliente,telefono}',
    p_datos#>>'{cliente,direccion}',p_datos#>>'{cliente,documento}',p_datos#>>'{cliente,email}')),'') is not null then
    if v_phone<>'' then select * into c from public.clientes_agenda where regexp_replace(coalesce(telefono,''),'\D','','g')=v_phone order by updated_at desc limit 1; end if;
    if c.id is null then
      insert into public.clientes_agenda(nombre,apellido,telefono,direccion,documento,email)
      values(nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),''),
        nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),''),
        nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),''),nullif(left(trim(coalesce(p_datos#>>'{cliente,email}','')),160),'')) returning * into c;
    else
      update public.clientes_agenda set
        nombre=coalesce(nullif(trim(p_datos#>>'{cliente,nombre}'),''),nombre),apellido=coalesce(nullif(trim(p_datos#>>'{cliente,apellido}'),''),apellido),
        telefono=coalesce(nullif(trim(p_datos#>>'{cliente,telefono}'),''),telefono),
        direccion=coalesce(nullif(trim(p_datos#>>'{cliente,direccion}'),''),direccion),documento=coalesce(nullif(trim(p_datos#>>'{cliente,documento}'),''),documento),
        email=coalesce(nullif(trim(p_datos#>>'{cliente,email}'),''),email),updated_at=now() where id=c.id returning * into c;
    end if;
    v_cliente:=c.id;
  end if;

  insert into public.op_reservas(local_nombre,local_almacen,motivo_id,motivo_nombre,motivo_comentario,responsable_nombre,
    cliente_id,cliente_nombre,cliente_apellido,cliente_telefono,cliente_direccion,cliente_documento,
    referencia_externa,remito_numero,fecha_estimada,created_by,created_by_name,invitado_id)
  values(l.nombre,l.almacen,m.id,m.nombre,nullif(left(trim(coalesce(p_datos->>'motivo_comentario','')),1000),''),left(trim(p_datos->>'responsable'),80),
    v_cliente,coalesce(c.nombre,nullif(left(trim(coalesce(p_datos#>>'{cliente,nombre}','')),120),'')),
    coalesce(c.apellido,nullif(left(trim(coalesce(p_datos#>>'{cliente,apellido}','')),120),'')),
    coalesce(c.telefono,nullif(left(trim(coalesce(p_datos#>>'{cliente,telefono}','')),40),'')),
    coalesce(c.direccion,nullif(left(trim(coalesce(p_datos#>>'{cliente,direccion}','')),240),'')),
    coalesce(c.documento,nullif(left(trim(coalesce(p_datos#>>'{cliente,documento}','')),50),'')),
    nullif(left(trim(coalesce(p_datos->>'referencia_externa','')),120),''),nullif(left(trim(coalesce(p_datos->>'remito_numero','')),100),''),
    case when coalesce(p_datos->>'fecha_estimada','')~'^\d{4}-\d{2}-\d{2}$' then (p_datos->>'fecha_estimada')::date else null end,
    (a->>'user_id')::uuid,a->>'name',(a->>'guest_id')::uuid) returning * into r;

  insert into public.op_reserva_items(reserva_id,codigo,nombre,cantidad,cantidad_local,procedencia,origen_local,fecha_estimada,remito_numero,comentario,estado)
  select r.id,left(trim(x->>'codigo'),80),left(trim(x->>'nombre'),240),(x->>'cantidad')::integer,coalesce((x->>'cantidad_local')::integer,0),x->>'procedencia',
    nullif(left(trim(coalesce(x->>'origen_local','')),120),''),case when coalesce(x->>'fecha_estimada','')~'^\d{4}-\d{2}-\d{2}$' then (x->>'fecha_estimada')::date else null end,
    nullif(left(trim(coalesce(x->>'remito_numero','')),100),''),nullif(left(trim(coalesce(x->>'comentario','')),500),''),
    case when coalesce((x->>'cantidad_local')::integer,0)>0 then 'separado' when x->>'procedencia'='pedido_local' then 'pendiente' else 'pendiente' end
  from jsonb_array_elements(p_datos->'items') x;

  for origen in select loc.* from public.locales loc where loc.nombre in (
    select distinct x->>'origen_local' from jsonb_array_elements(p_datos->'items') x where x->>'procedencia'='pedido_local'
  ) loop
    insert into public.pedidos(origen_local,origen_almacen,destino_local,destino_almacen,cliente,telefono,notas,estado,creado_por,canal_creacion,reserva_id)
    values(origen.nombre,origen.almacen,l.nombre,l.almacen,nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),r.cliente_telefono,
      'Creado desde Control de reservas · Reserva #'||r.codigo||case when r.motivo_comentario is not null then ' · '||r.motivo_comentario else '' end,
      'pendiente',(a->>'user_id')::uuid,'interno',r.id) returning id into p_id;
    insert into public.pedido_productos(pedido_id,codigo,nombre,cantidad)
      select p_id,codigo,max(nombre),sum(cantidad)::integer from public.op_reserva_items
      where reserva_id=r.id and procedencia='pedido_local' and origen_local=origen.nombre group by codigo;
    update public.op_reserva_items set pedido_id=p_id where reserva_id=r.id and procedencia='pedido_local' and origen_local=origen.nombre;
    insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre) values(p_id,'pendiente',(a->>'user_id')::uuid,a->>'name');
    insert into public.notificaciones(usuario_id,titulo,cuerpo,pedido_id)
      select p.id,'Nuevo pedido vinculado a una reserva','#'||r.codigo||' · '||l.nombre,p_id from public.perfiles p where p.approved=true and p.local_nombre=origen.nombre;
  end loop;

  perform public.op_reserva_recalcular(r.id,a->>'name');
  v_token:=encode(gen_random_bytes(32),'hex');
  update public.op_reservas set qr_token=v_token,qr_token_hash=encode(digest(v_token,'sha256'),'hex'),qr_updated_at=now() where id=r.id returning estado into v_estado;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'crear',v_estado,jsonb_build_object('productos',jsonb_array_length(p_datos->'items')),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return jsonb_build_object('ok',true,'id',r.id,'code',r.codigo,'state',v_estado,'qr_token',v_token);
end $$;

create or replace function public.op_reserva_listar(p_filtros jsonb default '{}'::jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; result jsonb; v_local text; v_history boolean; q text;
begin
  a:=public.op_reserva_actor(p_acceso); perform public.op_reservas_actualizar_vencidas();
  v_local:=case when coalesce((a->>'supervisor')::boolean,false) then nullif(trim(p_filtros->>'local'),'') else a->>'local' end;
  v_history:=coalesce((p_filtros->>'history')::boolean,false); q:=lower(unaccent(trim(coalesce(p_filtros->>'search',''))));
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]') into result from (
    select r.id,r.codigo,r.local_nombre,r.motivo_nombre,r.responsable_nombre,r.cliente_nombre,r.cliente_apellido,r.cliente_telefono,
      r.estado,r.mercaderia_local_at,r.vencimiento_at,r.fecha_estimada,r.referencia_externa,r.created_at,r.updated_at,
      count(i.id)::integer productos,coalesce(sum(i.cantidad),0)::integer unidades,coalesce(sum(i.cantidad_local),0)::integer unidades_local,
      coalesce(sum(i.cantidad_entregada),0)::integer unidades_entregadas
    from public.op_reservas r left join public.op_reserva_items i on i.reserva_id=r.id
    where (coalesce((a->>'supervisor')::boolean,false) or r.local_nombre=a->>'local')
      and (v_local is null or r.local_nombre=v_local)
      and (case when v_history then r.estado in ('completado','cancelado') else r.estado not in ('completado','cancelado') end)
      and (nullif(p_filtros->>'estado','') is null or r.estado=p_filtros->>'estado')
      and (q='' or lower(unaccent(concat_ws(' ',r.codigo,r.cliente_nombre,r.cliente_apellido,r.cliente_telefono,r.motivo_nombre,r.responsable_nombre,
        r.referencia_externa,i.codigo,i.nombre))) like '%'||q||'%')
    group by r.id order by r.updated_at desc limit 300
  ) x;
  return result;
end $$;

create or replace function public.op_reserva_detalle(p_reserva uuid,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; items jsonb; comments jsonb; events jsonb;
begin
  a:=public.op_reserva_actor(p_acceso); perform public.op_reservas_actualizar_vencidas();
  if not public.op_reserva_puede_ver(p_reserva,a) then raise exception 'No tenés acceso a esta reserva'; end if;
  select * into r from public.op_reservas where id=p_reserva;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]') into items from (
    select i.*,p.estado pedido_estado,p.reposicion_id pedido_reposicion_id,p.recepcion_id pedido_recepcion_id
    from public.op_reserva_items i left join public.pedidos p on p.id=i.pedido_id where i.reserva_id=r.id
  ) x;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into comments from (
    select id,texto,autor_nombre,created_at from public.op_reserva_comentarios where reserva_id=r.id order by created_at desc limit 100
  ) x;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into events from (
    select id,accion,estado,detalle,autor_nombre,created_at from public.op_reserva_eventos where reserva_id=r.id order by created_at desc limit 200
  ) x;
  return jsonb_build_object('reservation',to_jsonb(r),'items',items,'comments',comments,'events',events);
end $$;

create or replace function public.op_reserva_actualizar_item(p_item uuid,p_datos jsonb,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; i public.op_reserva_items; nueva integer; estado_nuevo text; motivo text;
begin
  a:=public.op_reserva_actor(p_acceso); select * into i from public.op_reserva_items where id=p_item for update;
  if i.id is null or not public.op_reserva_puede_ver(i.reserva_id,a) then raise exception 'Producto no disponible'; end if;
  nueva:=coalesce((p_datos->>'cantidad_local')::integer,i.cantidad_local);
  if nueva<0 or nueva+i.cantidad_entregada>i.cantidad then raise exception 'La cantidad en el local debe estar entre cero y lo que todavía falta entregar'; end if;
  motivo:=nullif(trim(coalesce(p_datos->>'motivo_correccion','')),'');
  if nueva<i.cantidad_local and motivo is null then raise exception 'Indicá el motivo de la corrección'; end if;
  estado_nuevo:=coalesce(nullif(p_datos->>'estado',''),case when nueva>=i.cantidad then 'separado' when nueva>0 then 'recibido' else i.estado end);
  if estado_nuevo not in ('pendiente','en_transito','recibido','separado','entregado') then raise exception 'Estado de producto inválido'; end if;
  update public.op_reserva_items set cantidad_local=nueva,estado=estado_nuevo,
    fecha_estimada=case when p_datos ? 'fecha_estimada' then case when coalesce(p_datos->>'fecha_estimada','')~'^\d{4}-\d{2}-\d{2}$' then (p_datos->>'fecha_estimada')::date else null end else fecha_estimada end,
    remito_numero=case when p_datos ? 'remito_numero' then nullif(left(trim(coalesce(p_datos->>'remito_numero','')),100),'') else remito_numero end,
    comentario=case when p_datos ? 'comentario' then nullif(left(trim(coalesce(p_datos->>'comentario','')),500),'') else comentario end,updated_at=now() where id=i.id;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(i.reserva_id,'actualizar_producto',estado_nuevo,jsonb_build_object('item_id',i.id,'codigo',i.codigo,'antes',i.cantidad_local,'despues',nueva,'motivo',motivo),
      (a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  perform public.op_reserva_recalcular(i.reserva_id,a->>'name');
  return public.op_reserva_detalle(i.reserva_id,p_acceso);
end $$;

create or replace function public.op_reserva_pedidos_disponibles(p_reserva uuid,p_consulta text default null,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; r public.op_reservas; q text; result jsonb;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  q:=lower(unaccent(trim(coalesce(p_consulta,''))));
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into result from (
    select p.id,p.origen_local,p.destino_local,p.cliente,p.telefono,p.estado,p.created_at,
      coalesce(jsonb_agg(jsonb_build_object('codigo',pp.codigo,'nombre',pp.nombre,'cantidad',coalesce(pp.cantidad_aceptada,pp.cantidad),
        'cantidad_recibida',coalesce(pp.cantidad_recibida,0)) order by pp.nombre),'[]') productos
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    where p.destino_local=r.local_nombre and p.estado<>'denegado' and (p.reserva_id is null or p.reserva_id=r.id)
      and exists(select 1 from public.op_reserva_items i where i.reserva_id=r.id and i.pedido_id is null and i.codigo=pp.codigo)
      and (q='' or lower(unaccent(concat_ws(' ',p.id::text,p.origen_local,p.cliente,p.telefono,pp.codigo,pp.nombre))) like '%'||q||'%')
    group by p.id order by p.created_at desc limit 30
  ) x;
  return result;
end $$;

create or replace function public.op_reserva_vincular_pedido(p_reserva uuid,p_pedido uuid,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; p public.pedidos; vinculados integer;
begin
  a:=public.op_reserva_actor(p_acceso);
  select * into r from public.op_reservas where id=p_reserva for update;
  select * into p from public.pedidos where id=p_pedido for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  if r.estado in ('completado','cancelado') then raise exception 'La reserva ya está cerrada'; end if;
  if p.id is null or p.destino_local<>r.local_nombre or p.estado='denegado' then raise exception 'El pedido no está disponible para este local'; end if;
  if p.reserva_id is not null and p.reserva_id<>r.id then raise exception 'El pedido ya está vinculado a otra reserva'; end if;
  if not exists(select 1 from public.op_reserva_items i join public.pedido_productos pp on pp.pedido_id=p.id and pp.codigo=i.codigo
    where i.reserva_id=r.id and i.pedido_id is null) then raise exception 'El pedido no tiene productos pendientes que coincidan con esta reserva'; end if;

  update public.pedidos set reserva_id=r.id,updated_at=now() where id=p.id;
  with cantidades as (
    select pp.codigo,sum(coalesce(pp.cantidad_recibida,0))::integer recibido,
      sum(coalesce(pp.cantidad_aceptada,pp.cantidad))::integer aceptado
    from public.pedido_productos pp where pp.pedido_id=p.id group by pp.codigo
  )
  update public.op_reserva_items i set pedido_id=p.id,procedencia='pedido_local',origen_local=p.origen_local,
    cantidad_local=greatest(i.cantidad_local,least(greatest(0,i.cantidad-i.cantidad_entregada),
      case when c.recibido>0 then c.recibido when p.estado in ('llegado','completo') then c.aceptado else 0 end)),
    estado=case when p.estado in ('transito','transito_escala','en_escala','listo_escala') then 'en_transito'
      when p.estado in ('llegado','completo','incompleto') then 'recibido' else i.estado end,updated_at=now()
    from cantidades c where i.reserva_id=r.id and i.pedido_id is null and i.codigo=c.codigo;
  get diagnostics vinculados=row_count;
  perform public.op_reserva_recalcular(r.id,a->>'name');
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'vincular_pedido',null,jsonb_build_object('pedido_id',p.id,'origen',p.origen_local,'productos',vinculados),
      (a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

create or replace function public.op_reserva_cambiar_estado(p_reserva uuid,p_estado text,p_comentario text default null,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; orden_anterior integer; orden_nuevo integer;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  if p_estado not in ('buscando','en_transito','recibido','separando','listo','avisado') then raise exception 'Usá la acción específica para completar, cancelar o extender'; end if;
  orden_anterior:=array_position(array['buscando','en_transito','recibido','separando','listo','avisado'],r.estado);
  orden_nuevo:=array_position(array['buscando','en_transito','recibido','separando','listo','avisado'],p_estado);
  if p_estado='listo' and exists(select 1 from public.op_reserva_items where reserva_id=r.id and cantidad_local+cantidad_entregada<cantidad) then
    raise exception 'Todavía faltan productos por tener en el local';
  end if;
  if coalesce(orden_nuevo,0)<coalesce(orden_anterior,0) and nullif(trim(coalesce(p_comentario,'')),'') is null then
    raise exception 'Indicá el motivo para retroceder el estado';
  end if;
  update public.op_reservas set estado=p_estado,estado_antes_vencido=null,updated_at=now() where id=r.id;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,case when coalesce(orden_nuevo,0)<coalesce(orden_anterior,0) then 'retroceder_estado' else 'cambiar_estado' end,p_estado,
      jsonb_build_object('estado_anterior',r.estado,'comentario',nullif(trim(coalesce(p_comentario,'')),'')),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

create or replace function public.op_reserva_comentar(p_reserva uuid,p_texto text,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; c public.op_reserva_comentarios;
begin
  a:=public.op_reserva_actor(p_acceso);
  if not public.op_reserva_puede_ver(p_reserva,a) then raise exception 'Reserva no disponible'; end if;
  if char_length(trim(coalesce(p_texto,''))) not between 1 and 1000 then raise exception 'Escribí un comentario de hasta 1000 caracteres'; end if;
  insert into public.op_reserva_comentarios(reserva_id,texto,usuario_id,invitado_id,autor_nombre)
    values(p_reserva,trim(p_texto),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name') returning * into c;
  update public.op_reservas set updated_at=now() where id=p_reserva;
  return to_jsonb(c);
end $$;

create or replace function public.op_reserva_excepcion(p_reserva uuid,p_hasta timestamptz,p_motivo text,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; restaurar text;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  if p_hasta<=now() or p_hasta>now()+interval '30 days' then raise exception 'La excepción debe vencer dentro de los próximos 30 días'; end if;
  if char_length(trim(coalesce(p_motivo,''))) not between 3 and 500 then raise exception 'Explicá el motivo de la excepción'; end if;
  restaurar:=case when r.estado='vencido' then coalesce(r.estado_antes_vencido,'separando') else r.estado end;
  update public.op_reservas set estado=restaurar,estado_antes_vencido=null,excepcion_hasta=p_hasta,excepcion_motivo=trim(p_motivo),vencimiento_at=p_hasta,updated_at=now() where id=r.id;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'excepcion',restaurar,jsonb_build_object('hasta',p_hasta,'motivo',trim(p_motivo)),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

create or replace function public.op_reserva_finalizar(p_reserva uuid,p_tipo text,p_entregas jsonb,p_comentario text default null,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; x jsonb; i public.op_reserva_items; total integer; entregado integer; nuevo text;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  if p_tipo not in ('retiro_cliente','reparto','envio_otro_local','uso_interno','no_retirado','otro') then raise exception 'Elegí qué ocurrió finalmente'; end if;
  if p_tipo in ('no_retirado','otro') and char_length(trim(coalesce(p_comentario,'')))<3 then raise exception 'Explicá qué ocurrió finalmente'; end if;
  if jsonb_typeof(p_entregas)<>'array' then raise exception 'Confirmá las cantidades entregadas'; end if;
  for x in select * from jsonb_array_elements(p_entregas) loop
    select * into i from public.op_reserva_items where id=(x->>'id')::uuid and reserva_id=r.id for update;
    if i.id is null or coalesce(x->>'cantidad','')!~'^\d{1,6}$' or (x->>'cantidad')::integer<i.cantidad_entregada or (x->>'cantidad')::integer>i.cantidad then
      raise exception 'Cantidad entregada inválida';
    end if;
    update public.op_reserva_items set cantidad_entregada=(x->>'cantidad')::integer,
      cantidad_local=greatest(0,cantidad_local-((x->>'cantidad')::integer-cantidad_entregada)),
      estado=case when (x->>'cantidad')::integer>=cantidad then 'entregado' else estado end,updated_at=now() where id=i.id;
  end loop;
  select sum(cantidad),sum(cantidad_entregada) into total,entregado from public.op_reserva_items where reserva_id=r.id;
  nuevo:=case when entregado>=total or p_tipo in ('no_retirado','uso_interno','envio_otro_local','otro') then 'completado' else 'parcial' end;
  update public.op_reservas set estado=nuevo,final_tipo=p_tipo,final_comentario=nullif(trim(coalesce(p_comentario,'')),''),
    completed_at=case when nuevo='completado' then now() else null end,updated_at=now() where id=r.id;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,case when nuevo='completado' then 'finalizar' else 'entrega_parcial' end,nuevo,
      jsonb_build_object('tipo',p_tipo,'comentario',nullif(trim(coalesce(p_comentario,'')),''),'entregado',entregado,'total',total),
      (a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

create or replace function public.op_reserva_cancelar(p_reserva uuid,p_motivo text,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) or r.estado='completado' then raise exception 'Reserva no disponible'; end if;
  if char_length(trim(coalesce(p_motivo,''))) not between 3 and 500 then raise exception 'Explicá por qué se cancela'; end if;
  update public.op_reservas set estado='cancelado',final_comentario=trim(p_motivo),completed_at=now(),updated_at=now() where id=r.id;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'cancelar','cancelado',jsonb_build_object('motivo',trim(p_motivo),'estado_anterior',r.estado),(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

create or replace function public.op_reserva_corregir_cierre(p_reserva uuid,p_entregas jsonb,p_motivo text,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; r public.op_reservas; x jsonb; i public.op_reserva_items; nueva integer; devueltas integer; cambios jsonb:='[]'::jsonb;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  if r.estado not in ('completado','cancelado','parcial') then raise exception 'Esta reserva no tiene un cierre o entrega para corregir'; end if;
  if char_length(trim(coalesce(p_motivo,''))) not between 3 and 500 then raise exception 'Explicá el motivo de la corrección'; end if;
  if jsonb_typeof(p_entregas)<>'array' then raise exception 'Confirmá las cantidades entregadas correctas'; end if;
  for x in select * from jsonb_array_elements(p_entregas) loop
    select * into i from public.op_reserva_items where id=(x->>'id')::uuid and reserva_id=r.id for update;
    if i.id is null or coalesce(x->>'cantidad','')!~'^\d{1,6}$' then raise exception 'Cantidad entregada inválida'; end if;
    nueva:=(x->>'cantidad')::integer;
    if nueva<0 or nueva>i.cantidad_entregada then raise exception 'Para aumentar una entrega usá Entrega o cierre'; end if;
    devueltas:=i.cantidad_entregada-nueva;
    cambios:=cambios||jsonb_build_array(jsonb_build_object('item_id',i.id,'codigo',i.codigo,'antes',i.cantidad_entregada,'despues',nueva));
    update public.op_reserva_items set cantidad_entregada=nueva,
      cantidad_local=least(cantidad-nueva,cantidad_local+devueltas),
      estado=case when nueva>=cantidad then 'entregado' when cantidad_local+devueltas+nueva>=cantidad then 'separado'
        when cantidad_local+devueltas>0 then 'recibido' else 'pendiente' end,updated_at=now() where id=i.id;
  end loop;
  update public.op_reservas set estado='buscando',final_tipo=null,final_comentario=null,completed_at=null,estado_antes_vencido=null,updated_at=now() where id=r.id;
  perform public.op_reserva_recalcular(r.id,a->>'name');
  insert into public.op_reserva_eventos(reserva_id,accion,estado,detalle,usuario_id,invitado_id,autor_nombre)
    values(r.id,'corregir_cierre',null,jsonb_build_object('estado_anterior',r.estado,'motivo',trim(p_motivo),'entregas',cambios),
      (a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  return public.op_reserva_detalle(r.id,p_acceso);
end $$;

create or replace function public.op_reserva_qr_regenerar(p_reserva uuid,p_acceso text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; r public.op_reservas; token text;
begin
  a:=public.op_reserva_actor(p_acceso); select * into r from public.op_reservas where id=p_reserva for update;
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'Reserva no disponible'; end if;
  token:=r.qr_token;
  if token is null then
    token:=encode(gen_random_bytes(32),'hex');
    update public.op_reservas set qr_token=token,qr_token_hash=encode(digest(token,'sha256'),'hex'),qr_updated_at=now(),updated_at=now() where id=r.id;
    insert into public.op_reserva_eventos(reserva_id,accion,estado,usuario_id,invitado_id,autor_nombre)
      values(r.id,'generar_qr',r.estado,(a->>'user_id')::uuid,(a->>'guest_id')::uuid,a->>'name');
  end if;
  return jsonb_build_object('ok',true,'token',token,'code',r.codigo);
end $$;

create or replace function public.op_reserva_qr_detalle(p_token text)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare r public.op_reservas; items jsonb;
begin
  select * into r from public.op_reservas where qr_token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex');
  if r.id is null then return jsonb_build_object('ok',false,'error','El QR no es válido o fue reemplazado'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('codigo',codigo,'nombre',nombre,'cantidad',cantidad,'cantidad_local',cantidad_local,
    'cantidad_entregada',cantidad_entregada,'procedencia',procedencia,'estado',estado,'fecha_estimada',fecha_estimada,'remito_numero',remito_numero) order by created_at),'[]')
    into items from public.op_reserva_items where reserva_id=r.id;
  return jsonb_build_object('ok',true,'reservation',jsonb_build_object('code',r.codigo,'local',r.local_nombre,'reason',r.motivo_nombre,
    'customer',nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),'phone',r.cliente_telefono,'responsible',r.responsable_nombre,
    'state',r.estado,'created_at',r.created_at,'merchandise_at',r.mercaderia_local_at,'expires_at',r.vencimiento_at,'reference',r.referencia_externa,
    'items',items));
end $$;

create or replace function public.op_reserva_qr_resolver(p_token text,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; r public.op_reservas;
begin
  a:=public.op_reserva_actor(p_acceso);
  select * into r from public.op_reservas where qr_token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex');
  if r.id is null or not public.op_reserva_puede_ver(r.id,a) then raise exception 'No tenés permisos para gestionar este QR'; end if;
  return jsonb_build_object('ok',true,'id',r.id);
end $$;

create or replace function public.op_recepcion_reservas_datos(p_recepcion uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare rec public.op_recepciones; result jsonb;
begin
  select * into rec from public.op_recepciones where id=p_recepcion;
  if rec.id is null or not (public.is_ops_supervisor() or rec.destino_local=public.my_local()) then raise exception 'Recepción no disponible'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]') into result from (
    select r.id,r.codigo,r.cliente_nombre,r.cliente_apellido,r.cliente_telefono,r.motivo_nombre,r.estado,r.created_at,
      lr.reserva_id is not null linked,
      case when lr.reserva_id is not null then 'vinculada' when exists(select 1 from public.op_reserva_items z where z.reserva_id=r.id and trim(coalesce(z.remito_numero,''))=trim(rec.numero_remito)) then 'remito' else 'fecha_productos' end relation,
      coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'codigo',i.codigo,'nombre',i.nombre,'cantidad',i.cantidad,
        'cantidad_local',i.cantidad_local,'cantidad_entregada',i.cantidad_entregada,'remito_numero',i.remito_numero,
        'fecha_estimada',i.fecha_estimada,'en_remito',ri.codigo is not null,'remito_esperado',coalesce(ri.esperado,0),'remito_recibido',coalesce(ri.recibido,0)) order by i.created_at)
        from public.op_reserva_items i left join public.op_recepcion_items ri on ri.recepcion_id=rec.id and ri.codigo=i.codigo
        where i.reserva_id=r.id and i.pedido_id is null),'[]') items
    from public.op_reservas r
    left join public.op_recepcion_reservas lr on lr.recepcion_id=rec.id and lr.reserva_id=r.id
    where r.local_nombre=rec.destino_local and r.estado not in ('completado','cancelado')
      and exists(select 1 from public.op_reserva_items i join public.op_recepcion_items ri on ri.recepcion_id=rec.id and ri.codigo=i.codigo
        where i.reserva_id=r.id and i.pedido_id is null and i.cantidad_local+i.cantidad_entregada<i.cantidad
          and (trim(coalesce(i.remito_numero,''))=trim(rec.numero_remito)
            or (nullif(trim(coalesce(i.remito_numero,'')),'') is null and i.procedencia in ('proveedor','reposicion','remito','otro')
              and (i.fecha_estimada is null or i.fecha_estimada<=rec.fecha_remito+7))))
  ) x;
  return jsonb_build_object('reservations',result,'can_link',rec.estado='en_control' and (public.is_ops_supervisor() or rec.destino_local=public.my_local()));
end $$;

create or replace function public.op_recepcion_confirmar_reserva(p_recepcion uuid,p_reserva uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare rec public.op_recepciones; r public.op_reservas; relation text; actor text;
begin
  select * into rec from public.op_recepciones where id=p_recepcion for update;
  select * into r from public.op_reservas where id=p_reserva for update;
  if rec.id is null or rec.estado<>'en_control' or r.id is null or r.local_nombre<>rec.destino_local
    or not (public.is_ops_supervisor() or rec.destino_local=public.my_local()) then raise exception 'La reserva no está disponible para este remito'; end if;
  if not exists(select 1 from public.op_reserva_items i join public.op_recepcion_items ri on ri.recepcion_id=rec.id and ri.codigo=i.codigo
    where i.reserva_id=r.id and i.pedido_id is null and i.cantidad_local+i.cantidad_entregada<i.cantidad) then raise exception 'No hay productos pendientes coincidentes'; end if;
  relation:=case when exists(select 1 from public.op_reserva_items i where i.reserva_id=r.id and trim(coalesce(i.remito_numero,''))=trim(rec.numero_remito)) then 'remito' else 'confirmada' end;
  select coalesce(nullif(trim(nombre_display),''),trim(nombre||' '||apellido),'Usuario') into actor from public.perfiles where id=auth.uid();
  insert into public.op_recepcion_reservas(recepcion_id,reserva_id,coincidencia,linked_by) values(rec.id,r.id,relation,auth.uid()) on conflict do nothing;
  insert into public.op_reserva_eventos(reserva_id,accion,estado,autor_nombre,usuario_id,detalle)
    values(r.id,'vincular_remito',r.estado,coalesce(actor,'Usuario'),auth.uid(),jsonb_build_object('recepcion_id',rec.id,'remito',rec.numero_remito,'coincidencia',relation));
  return public.op_recepcion_reservas_datos(rec.id);
end $$;

create or replace function public.op_reserva_enlace_estado(p_local uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare e public.op_reserva_enlaces; l public.locales;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo supervisores pueden administrar enlaces'; end if;
  select * into l from public.locales where id=p_local;
  select * into e from public.op_reserva_enlaces where local_id=p_local and revoked_at is null order by created_at desc limit 1;
  return jsonb_build_object('ok',true,'local',to_jsonb(l),'exists',e.id is not null,'active',coalesce(e.activo,false),'created_at',e.created_at);
end $$;

create or replace function public.op_reserva_crear_enlace(p_local uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.op_reserva_enlaces; l public.locales; token text;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo supervisores pueden administrar enlaces'; end if;
  select * into l from public.locales where id=p_local; if l.id is null then raise exception 'El local no existe'; end if;
  update public.op_reserva_enlaces set activo=false,revoked_at=coalesce(revoked_at,now()),updated_at=now() where local_id=p_local and revoked_at is null;
  token:=encode(gen_random_bytes(32),'hex');
  insert into public.op_reserva_enlaces(local_id,token_hash,created_by) values(p_local,encode(digest(token,'sha256'),'hex'),auth.uid()) returning * into e;
  return jsonb_build_object('ok',true,'token',token,'local',to_jsonb(l),'active',true,'created_at',e.created_at);
end $$;

create or replace function public.op_reserva_configurar_enlace(p_local uuid,p_accion text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.op_reserva_enlaces;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo supervisores pueden administrar enlaces'; end if;
  if p_accion not in ('pausar','reactivar') then raise exception 'Acción inválida'; end if;
  select * into e from public.op_reserva_enlaces where local_id=p_local and revoked_at is null order by created_at desc limit 1 for update;
  if e.id is null then raise exception 'Primero generá un enlace'; end if;
  update public.op_reserva_enlaces set activo=p_accion='reactivar',updated_at=now() where id=e.id;
  return public.op_reserva_enlace_estado(p_local);
end $$;

create or replace function public.op_reserva_guardar_motivo(p_id uuid,p_local text,p_nombre text,p_activo boolean default true,p_orden integer default 0)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.op_reserva_motivos;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo supervisores pueden configurar motivos'; end if;
  if not exists(select 1 from public.locales where nombre=trim(p_local)) then raise exception 'El local no existe'; end if;
  if char_length(trim(coalesce(p_nombre,''))) not between 2 and 80 then raise exception 'Escribí un motivo válido'; end if;
  if p_id is null then
    insert into public.op_reserva_motivos(local_nombre,nombre,activo,orden,created_by)
      values(trim(p_local),trim(p_nombre),coalesce(p_activo,true),coalesce(p_orden,0),auth.uid()) returning * into m;
  else
    update public.op_reserva_motivos set nombre=trim(p_nombre),activo=coalesce(p_activo,true),orden=coalesce(p_orden,0),updated_at=now()
      where id=p_id returning * into m;
  end if;
  return to_jsonb(m);
end $$;

create or replace function public.op_reserva_guardar_config(p_local text,p_horas integer,p_dias smallint[],p_printer_path text,p_printer_profile text default 'star-bsc10-80-max')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.op_reserva_config_local;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo supervisores pueden configurar locales'; end if;
  if p_horas not between 1 and 720 or not (coalesce(p_dias,'{}'::smallint[]) <@ array[0,1,2,3,4,5,6]::smallint[]) then raise exception 'Configuración inválida'; end if;
  insert into public.op_reserva_config_local(local_nombre,horas_reserva,dias_recepcion,printer_path,printer_profile,updated_by)
    values(trim(p_local),p_horas,coalesce(p_dias,'{}'),nullif(trim(coalesce(p_printer_path,'')),''),coalesce(nullif(trim(p_printer_profile),''),'star-bsc10-80-max'),auth.uid())
  on conflict(local_nombre) do update set horas_reserva=excluded.horas_reserva,dias_recepcion=excluded.dias_recepcion,
    printer_path=excluded.printer_path,printer_profile=excluded.printer_profile,updated_by=auth.uid(),updated_at=now() returning * into c;
  return to_jsonb(c);
end $$;

create or replace function public.op_reserva_sync_pedido()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid; autor text:='Integración con Pedidos';
begin
  rid:=coalesce(new.reserva_id,old.reserva_id);
  if rid is null then return new; end if;
  update public.op_reserva_items i set
    estado=case
      when new.estado in ('transito','transito_escala','en_escala','listo_escala') then 'en_transito'
      when new.estado in ('llegado','completo','incompleto') then 'recibido'
      else i.estado end,
    cantidad_local=case when new.estado in ('llegado','completo','incompleto') then greatest(i.cantidad_local,
      least(greatest(0,i.cantidad-i.cantidad_entregada),coalesce((
        select nullif(sum(coalesce(pp.cantidad_recibida,0)),0)::integer from public.pedido_productos pp where pp.pedido_id=new.id and pp.codigo=i.codigo
      ),case when new.estado in ('llegado','completo') then (
        select sum(coalesce(pp.cantidad_aceptada,pp.cantidad))::integer from public.pedido_productos pp where pp.pedido_id=new.id and pp.codigo=i.codigo
      ) else 0 end,0))) else i.cantidad_local end,
    reposicion_id=coalesce(new.reposicion_id,i.reposicion_id),recepcion_id=coalesce(new.recepcion_id,i.recepcion_id),updated_at=now()
    where i.pedido_id=new.id;
  perform public.op_reserva_recalcular(rid,autor);
  insert into public.op_reserva_eventos(reserva_id,accion,estado,autor_nombre,detalle)
    values(rid,'sincronizar_pedido',null,autor,jsonb_build_object('pedido_id',new.id,'estado',new.estado));
  return new;
end $$;
revoke all on function public.op_reserva_sync_pedido() from public,anon,authenticated;
drop trigger if exists op_reserva_sync_pedido_estado on public.pedidos;
create trigger op_reserva_sync_pedido_estado after update of estado,reposicion_id,recepcion_id on public.pedidos
for each row when (new.reserva_id is not null and (new.estado is distinct from old.estado or new.reposicion_id is distinct from old.reposicion_id or new.recepcion_id is distinct from old.recepcion_id))
execute function public.op_reserva_sync_pedido();

create or replace function public.op_reserva_sync_recepcion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid;
begin
  if new.estado<>'cerrado' or old.estado='cerrado' then return new; end if;
  with lineas as (
    select i.id,i.reserva_id,i.codigo,i.cantidad,i.cantidad_local,i.cantidad_entregada,coalesce(ri.recibido,0)::integer disponible,
      coalesce(sum(greatest(0,prev.cantidad-prev.cantidad_local-prev.cantidad_entregada)) over(partition by i.codigo order by r.created_at,r.id,i.id rows between unbounded preceding and 1 preceding),0)::integer previa
    from public.op_recepcion_reservas lr join public.op_reservas r on r.id=lr.reserva_id
    join public.op_reserva_items i on i.reserva_id=r.id and i.pedido_id is null
    join public.op_reserva_items prev on prev.id=i.id
    left join public.op_recepcion_items ri on ri.recepcion_id=new.id and ri.codigo=i.codigo
    where lr.recepcion_id=new.id and i.cantidad_local+i.cantidad_entregada<i.cantidad
  ), asignadas as (
    select id,reserva_id,greatest(0,least(cantidad-cantidad_local-cantidad_entregada,disponible-previa))::integer cantidad from lineas
  ) update public.op_reserva_items i set cantidad_local=least(i.cantidad,i.cantidad_local+a.cantidad),
    estado=case when i.cantidad_local+a.cantidad>=i.cantidad then 'separado' when a.cantidad>0 then 'recibido' else i.estado end,
    recepcion_id=new.id,updated_at=now() from asignadas a where i.id=a.id and a.cantidad>0;
  for rid in select reserva_id from public.op_recepcion_reservas where recepcion_id=new.id loop
    perform public.op_reserva_recalcular(rid,'Control de remitos');
    insert into public.op_reserva_eventos(reserva_id,accion,estado,autor_nombre,detalle)
      values(rid,'recibir_remito',null,'Control de remitos',jsonb_build_object('recepcion_id',new.id,'remito',new.numero_remito));
  end loop;
  return new;
end $$;
revoke all on function public.op_reserva_sync_recepcion() from public,anon,authenticated;
drop trigger if exists op_reserva_sync_recepcion_cierre on public.op_recepciones;
create trigger op_reserva_sync_recepcion_cierre after update of estado on public.op_recepciones
for each row when (new.estado is distinct from old.estado and new.estado='cerrado') execute function public.op_reserva_sync_recepcion();

alter table public.op_reserva_config_local enable row level security;
alter table public.op_reserva_motivos enable row level security;
alter table public.op_reserva_enlaces enable row level security;
alter table public.op_reserva_invitados enable row level security;
alter table public.op_reservas enable row level security;
alter table public.op_reserva_items enable row level security;
alter table public.op_reserva_comentarios enable row level security;
alter table public.op_reserva_eventos enable row level security;
alter table public.op_recepcion_reservas enable row level security;

drop policy if exists op_reserva_config_read on public.op_reserva_config_local;
create policy op_reserva_config_read on public.op_reserva_config_local for select to authenticated
  using(public.is_ops_supervisor() or local_nombre=public.my_local());
drop policy if exists op_reserva_config_admin on public.op_reserva_config_local;
create policy op_reserva_config_admin on public.op_reserva_config_local for all to authenticated
  using(public.is_ops_supervisor()) with check(public.is_ops_supervisor());
drop policy if exists op_reserva_motivos_read on public.op_reserva_motivos;
create policy op_reserva_motivos_read on public.op_reserva_motivos for select to authenticated
  using(public.is_ops_supervisor() or local_nombre=public.my_local());
drop policy if exists op_reserva_motivos_admin on public.op_reserva_motivos;
create policy op_reserva_motivos_admin on public.op_reserva_motivos for all to authenticated
  using(public.is_ops_supervisor()) with check(public.is_ops_supervisor());
drop policy if exists op_reservas_read on public.op_reservas;
create policy op_reservas_read on public.op_reservas for select to authenticated
  using(public.is_ops_supervisor() or local_nombre=public.my_local());
drop policy if exists op_reserva_items_read on public.op_reserva_items;
create policy op_reserva_items_read on public.op_reserva_items for select to authenticated
  using(exists(select 1 from public.op_reservas r where r.id=reserva_id and (public.is_ops_supervisor() or r.local_nombre=public.my_local())));
drop policy if exists op_reserva_comentarios_read on public.op_reserva_comentarios;
create policy op_reserva_comentarios_read on public.op_reserva_comentarios for select to authenticated
  using(exists(select 1 from public.op_reservas r where r.id=reserva_id and (public.is_ops_supervisor() or r.local_nombre=public.my_local())));
drop policy if exists op_reserva_eventos_read on public.op_reserva_eventos;
create policy op_reserva_eventos_read on public.op_reserva_eventos for select to authenticated
  using(exists(select 1 from public.op_reservas r where r.id=reserva_id and (public.is_ops_supervisor() or r.local_nombre=public.my_local())));
drop policy if exists op_reserva_enlaces_admin on public.op_reserva_enlaces;
create policy op_reserva_enlaces_admin on public.op_reserva_enlaces for all to authenticated
  using(public.is_ops_supervisor()) with check(public.is_ops_supervisor());
drop policy if exists op_reserva_invitados_admin on public.op_reserva_invitados;
create policy op_reserva_invitados_admin on public.op_reserva_invitados for select to authenticated
  using(public.is_ops_supervisor());
drop policy if exists op_recepcion_reservas_read on public.op_recepcion_reservas;
create policy op_recepcion_reservas_read on public.op_recepcion_reservas for select to authenticated
  using(exists(select 1 from public.op_recepciones r where r.id=recepcion_id and (public.is_ops_supervisor() or r.destino_local=public.my_local())));

grant select on public.op_reserva_config_local,public.op_reserva_motivos,public.op_reservas,public.op_reserva_items,public.op_reserva_comentarios,public.op_reserva_eventos to authenticated;
grant select on public.op_recepcion_reservas to authenticated;

revoke all on function public.op_reserva_invitado_entrar(text,text,text) from public;
revoke all on function public.op_reserva_contexto(text) from public;
revoke all on function public.op_reserva_buscar_productos(text,text) from public;
revoke all on function public.op_reserva_buscar_clientes(text,text) from public;
revoke all on function public.op_reserva_crear(jsonb,text) from public;
revoke all on function public.op_reserva_listar(jsonb,text) from public;
revoke all on function public.op_reserva_detalle(uuid,text) from public;
revoke all on function public.op_reserva_actualizar_item(uuid,jsonb,text) from public;
revoke all on function public.op_reserva_pedidos_disponibles(uuid,text,text) from public;
revoke all on function public.op_reserva_vincular_pedido(uuid,uuid,text) from public;
revoke all on function public.op_reserva_cambiar_estado(uuid,text,text,text) from public;
revoke all on function public.op_reserva_comentar(uuid,text,text) from public;
revoke all on function public.op_reserva_excepcion(uuid,timestamptz,text,text) from public;
revoke all on function public.op_reserva_finalizar(uuid,text,jsonb,text,text) from public;
revoke all on function public.op_reserva_cancelar(uuid,text,text) from public;
revoke all on function public.op_reserva_corregir_cierre(uuid,jsonb,text,text) from public;
revoke all on function public.op_reserva_qr_regenerar(uuid,text) from public;
revoke all on function public.op_reserva_qr_detalle(text) from public;
revoke all on function public.op_reserva_qr_resolver(text,text) from public;
revoke all on function public.op_recepcion_reservas_datos(uuid) from public;
revoke all on function public.op_recepcion_confirmar_reserva(uuid,uuid) from public;
revoke all on function public.op_reserva_enlace_estado(uuid) from public;
revoke all on function public.op_reserva_crear_enlace(uuid) from public;
revoke all on function public.op_reserva_configurar_enlace(uuid,text) from public;
revoke all on function public.op_reserva_guardar_motivo(uuid,text,text,boolean,integer) from public;
revoke all on function public.op_reserva_guardar_config(text,integer,smallint[],text,text) from public;

grant execute on function public.op_reserva_invitado_entrar(text,text,text) to anon,authenticated;
grant execute on function public.op_reserva_contexto(text) to anon,authenticated;
grant execute on function public.op_reserva_buscar_productos(text,text) to anon,authenticated;
grant execute on function public.op_reserva_buscar_clientes(text,text) to anon,authenticated;
grant execute on function public.op_reserva_crear(jsonb,text) to anon,authenticated;
grant execute on function public.op_reserva_listar(jsonb,text) to anon,authenticated;
grant execute on function public.op_reserva_detalle(uuid,text) to anon,authenticated;
grant execute on function public.op_reserva_actualizar_item(uuid,jsonb,text) to anon,authenticated;
grant execute on function public.op_reserva_pedidos_disponibles(uuid,text,text) to anon,authenticated;
grant execute on function public.op_reserva_vincular_pedido(uuid,uuid,text) to anon,authenticated;
grant execute on function public.op_reserva_cambiar_estado(uuid,text,text,text) to anon,authenticated;
grant execute on function public.op_reserva_comentar(uuid,text,text) to anon,authenticated;
grant execute on function public.op_reserva_excepcion(uuid,timestamptz,text,text) to anon,authenticated;
grant execute on function public.op_reserva_finalizar(uuid,text,jsonb,text,text) to anon,authenticated;
grant execute on function public.op_reserva_cancelar(uuid,text,text) to anon,authenticated;
grant execute on function public.op_reserva_corregir_cierre(uuid,jsonb,text,text) to anon,authenticated;
grant execute on function public.op_reserva_qr_regenerar(uuid,text) to anon,authenticated;
grant execute on function public.op_reserva_qr_detalle(text) to anon,authenticated;
grant execute on function public.op_reserva_qr_resolver(text,text) to anon,authenticated;
grant execute on function public.op_recepcion_reservas_datos(uuid) to authenticated;
grant execute on function public.op_recepcion_confirmar_reserva(uuid,uuid) to authenticated;
grant execute on function public.op_reserva_enlace_estado(uuid) to authenticated;
grant execute on function public.op_reserva_crear_enlace(uuid) to authenticated;
grant execute on function public.op_reserva_configurar_enlace(uuid,text) to authenticated;
grant execute on function public.op_reserva_guardar_motivo(uuid,text,text,boolean,integer) to authenticated;
grant execute on function public.op_reserva_guardar_config(text,integer,smallint[],text,text) to authenticated;

do $$ begin alter publication supabase_realtime add table public.op_reservas; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.op_reserva_comentarios; exception when duplicate_object then null; end $$;

select cron.schedule(
  'control-reservas-vencimientos',
  '* * * * *',
  'select public.op_reservas_actualizar_vencidas();'
);

commit;
