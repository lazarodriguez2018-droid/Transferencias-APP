-- Sucaneitor Operaciones: Inventario + Reposicion + Pedidos.
-- Migracion aditiva. No borra pedidos, sesiones ni catalogo de produccion.

create extension if not exists pgcrypto;

-- Supervisores y administradores tienen los mismos permisos operativos.
create or replace function public.is_ops_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.perfiles p
    where p.id = auth.uid()
      and p.approved = true
      and p.role in ('admin', 'supervisor_general')
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.is_ops_supervisor() $$;

-- Local efectivo del usuario autenticado. Esto mantiene la migración
-- autocontenida incluso al probarla en un proyecto nuevo.
create or replace function public.my_local()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.local_nombre
  from public.perfiles p
  where p.id = auth.uid() and p.approved = true
  limit 1
$$;

-- El padron de Sucaneitor pasa a ser el unico catalogo central.
alter table public.productos add column if not exists barras text;
alter table public.productos add column if not exists fabricante text;
alter table public.productos add column if not exists updated_at timestamptz not null default now();
update public.productos set updated_at=now() where updated_at is null;
alter table public.productos alter column updated_at set default now();
alter table public.productos alter column updated_at set not null;
create unique index if not exists productos_codigo_uidx on public.productos (codigo);
create index if not exists productos_barras_idx on public.productos (barras) where barras is not null and barras <> '';

create table if not exists public.catalogo_version (
  id boolean primary key default true check (id),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.perfiles(id)
);
insert into public.catalogo_version(id) values (true) on conflict (id) do nothing;

create or replace function public.reemplazar_padron_productos(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  total integer;
begin
  if not public.is_ops_supervisor() then
    raise exception 'Solo supervisores pueden reemplazar el padron';
  end if;
  if jsonb_typeof(payload) <> 'array' then
    raise exception 'Padron invalido';
  end if;

  create temporary table nuevo_padron (
    codigo text primary key,
    barras text,
    nombre text not null,
    fabricante text,
    marca text
  ) on commit drop;

  insert into nuevo_padron(codigo, barras, nombre, fabricante, marca)
  select
    trim(x->>'codigo'), nullif(trim(x->>'barras'), ''), trim(x->>'nombre'),
    nullif(trim(x->>'fabricante'), ''), nullif(trim(x->>'marca'), '')
  from jsonb_array_elements(payload) x
  where trim(coalesce(x->>'codigo','')) <> ''
    and trim(coalesce(x->>'nombre','')) <> ''
  on conflict (codigo) do update set
    barras = excluded.barras, nombre = excluded.nombre,
    fabricante = excluded.fabricante, marca = excluded.marca;

  select count(*) into total from nuevo_padron;
  if total = 0 then raise exception 'El padron no contiene productos validos'; end if;

  delete from public.productos p
  where not exists (select 1 from nuevo_padron n where n.codigo = p.codigo);

  insert into public.productos(codigo, barras, nombre, fabricante, marca, updated_at)
  select codigo, barras, nombre, fabricante, marca, now() from nuevo_padron
  on conflict (codigo) do update set
    barras = excluded.barras, nombre = excluded.nombre,
    fabricante = excluded.fabricante, marca = excluded.marca, updated_at = now();

  update public.catalogo_version
  set version = version + 1, updated_at = now(), updated_by = auth.uid()
  where id = true;
  return total;
end
$$;

-- TransferApp: cantidades aceptadas estructuradas e integracion operativa.
alter table public.pedido_productos add column if not exists cantidad_aceptada integer;
alter table public.pedido_productos add column if not exists cantidad_preparada integer not null default 0;
alter table public.pedidos add column if not exists duplicado_confirmado boolean not null default false;
alter table public.pedidos add column if not exists integrado_en_reposicion_at timestamptz;
alter table public.pedidos add column if not exists enviado_at timestamptz;
alter table public.pedidos add column if not exists remito_pendiente boolean not null default false;

-- Calendarios configurables por recorrido.
create table if not exists public.op_rutas_transferencia (
  id uuid primary key default gen_random_uuid(),
  origen_local text not null,
  destino_local text not null,
  dias_semana smallint[] not null default '{}',
  activa boolean not null default true,
  permite_urgentes_fuera_de_inicio boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(origen_local, destino_local)
);

insert into public.op_rutas_transferencia(origen_local, destino_local, dias_semana)
values ('Punta del Este', 'Maldonado', array[1,3,4]::smallint[])
on conflict (origen_local, destino_local) do update set dias_semana = excluded.dias_semana;

-- Sesiones web de inventario.
create table if not exists public.op_inventario_sesiones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  local_nombre text not null,
  almacen text,
  estado text not null default 'abierta' check (estado in ('abierta','cerrada','archivada')),
  created_by uuid not null references public.perfiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.op_inventario_participantes (
  sesion_id uuid not null references public.op_inventario_sesiones(id) on delete cascade,
  usuario_id uuid not null references public.perfiles(id),
  nombre text not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key(sesion_id, usuario_id)
);

create table if not exists public.op_inventario_items (
  sesion_id uuid not null references public.op_inventario_sesiones(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  barras text,
  cantidad integer not null default 0 check (cantidad >= 0),
  tipos jsonb not null default '{}'::jsonb,
  updated_by uuid references public.perfiles(id),
  updated_at timestamptz not null default now(),
  primary key(sesion_id, codigo)
);

create table if not exists public.op_inventario_eventos (
  id bigint generated by default as identity primary key,
  sesion_id uuid not null references public.op_inventario_sesiones(id) on delete cascade,
  usuario_id uuid references public.perfiles(id),
  tipo text not null,
  codigo text,
  nombre text,
  cantidad integer,
  detalle jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.op_inventario_balances (
  sesion_id uuid primary key references public.op_inventario_sesiones(id) on delete cascade,
  balance jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  updated_by uuid references public.perfiles(id),
  updated_at timestamptz not null default now()
);

-- Preparaciones de reposicion integradas con pedidos aceptados.
create table if not exists public.op_reposiciones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  origen_local text not null,
  destino_local text not null,
  estado text not null default 'preparando' check (estado in ('preparando','enviado','cerrado','archivado')),
  started_at timestamptz not null default now(),
  created_by uuid not null references public.perfiles(id),
  original_filename text,
  original_path text,
  import_meta jsonb not null default '{}'::jsonb,
  transporte text,
  remito text,
  remito_pendiente boolean not null default false,
  observaciones_envio text,
  enviado_at timestamptz,
  enviado_by uuid references public.perfiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.op_reposicion_items (
  reposicion_id uuid not null references public.op_reposiciones(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  descripcion_archivo text,
  barras text,
  marca text,
  pedido_reposicion integer not null default 0 check (pedido_reposicion >= 0),
  pedido_clientes integer not null default 0 check (pedido_clientes >= 0),
  pedido_total integer generated always as (greatest(pedido_reposicion, pedido_clientes)) stored,
  stock_origen integer not null default 0,
  preparado integer not null default 0 check (preparado >= 0),
  no_encontrado boolean not null default false,
  cerrado_incompleto boolean not null default false,
  motivo_codigo text,
  motivo_label text,
  motivo_otro text,
  comentario text,
  pedidos_asignados jsonb not null default '[]'::jsonb,
  updated_by uuid references public.perfiles(id),
  updated_by_name text,
  updated_at timestamptz not null default now(),
  primary key(reposicion_id, codigo)
);

create table if not exists public.op_reposicion_extras (
  reposicion_id uuid not null references public.op_reposiciones(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  barras text,
  cantidad integer not null default 0 check (cantidad >= 0),
  nota text,
  updated_by uuid references public.perfiles(id),
  updated_by_name text,
  updated_at timestamptz not null default now(),
  primary key(reposicion_id, codigo)
);

create table if not exists public.op_reposicion_participantes (
  reposicion_id uuid not null references public.op_reposiciones(id) on delete cascade,
  usuario_id uuid not null references public.perfiles(id),
  nombre text not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key(reposicion_id, usuario_id)
);

create table if not exists public.op_reposicion_eventos (
  id bigint generated by default as identity primary key,
  reposicion_id uuid not null references public.op_reposiciones(id) on delete cascade,
  usuario_id uuid references public.perfiles(id),
  usuario_nombre text,
  accion text not null,
  codigo text,
  detalle jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.op_reposicion_pedidos (
  reposicion_id uuid not null references public.op_reposiciones(id) on delete cascade,
  pedido_id uuid not null references public.pedidos(id),
  urgente_agregado_despues boolean not null default false,
  agregado_by uuid references public.perfiles(id),
  agregado_at timestamptz not null default now(),
  primary key(reposicion_id, pedido_id)
);

create table if not exists public.op_despachos (
  id uuid primary key default gen_random_uuid(),
  reposicion_id uuid unique references public.op_reposiciones(id) on delete set null,
  origen_local text not null,
  destino_local text not null,
  transporte text not null,
  remito text,
  remito_pendiente boolean not null default false,
  observaciones text,
  enviado_by uuid not null references public.perfiles(id),
  enviado_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pedidos add column if not exists reposicion_id uuid references public.op_reposiciones(id) on delete set null;
alter table public.pedidos add column if not exists despacho_id uuid references public.op_despachos(id) on delete set null;

-- Propuestas globales de codigos de barras (no cambian el SKU).
create table if not exists public.op_asignaciones_barras (
  id uuid primary key default gen_random_uuid(),
  barcode text not null,
  product_code text not null,
  product_name text not null,
  official_barcode text,
  status text not null default 'pending' check (status in ('pending','incorporated','conflict','product_missing','superseded','discarded')),
  photo_path text,
  created_by uuid not null references public.perfiles(id),
  session_id uuid,
  session_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists op_asignaciones_barcode_idx on public.op_asignaciones_barras(barcode, status);
create index if not exists op_asignaciones_producto_idx on public.op_asignaciones_barras(product_code, status);

-- Operaciones atomicas para evitar perder escaneos simultaneos.
create or replace function public.op_crear_reposicion(
  p_nombre text,p_origen text,p_destino text,p_items jsonb,
  p_import_meta jsonb default '{}'::jsonb,p_original_filename text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r uuid; pedidos_integrados integer:=0;
begin
  if trim(coalesce(p_nombre,''))='' or trim(coalesce(p_origen,''))='' or trim(coalesce(p_destino,''))='' then raise exception 'Datos de reposicion incompletos'; end if;
  if p_origen=p_destino then raise exception 'Origen y destino deben ser diferentes'; end if;
  if not (public.is_ops_supervisor() or p_origen=public.my_local()) then raise exception 'El usuario no pertenece al local de origen'; end if;
  if jsonb_typeof(p_items)<>'array' then raise exception 'Productos invalidos'; end if;

  insert into public.op_reposiciones(nombre,origen_local,destino_local,created_by,original_filename,import_meta)
  values(trim(p_nombre),trim(p_origen),trim(p_destino),auth.uid(),nullif(trim(p_original_filename),''),coalesce(p_import_meta,'{}'::jsonb))
  returning id into r;

  insert into public.op_reposicion_items(reposicion_id,codigo,nombre,descripcion_archivo,barras,marca,pedido_reposicion,stock_origen,updated_by,updated_by_name)
  select r,trim(x->>'codigo'),trim(x->>'nombre'),nullif(trim(x->>'descripcion_archivo'),''),nullif(trim(x->>'barras'),''),nullif(trim(x->>'marca'),''),
    greatest(0,coalesce((x->>'pedido')::integer,0)),coalesce((x->>'stock_origen')::integer,0),auth.uid(),left(coalesce((select trim(coalesce(nombre,'')||' '||coalesce(apellido,'')) from public.perfiles where id=auth.uid()),'Usuario'),80)
  from jsonb_array_elements(p_items) x
  where trim(coalesce(x->>'codigo',''))<>'' and trim(coalesce(x->>'nombre',''))<>'' and coalesce((x->>'pedido')::integer,0)>0;

  -- El bloqueo evita que dos preparaciones simultaneas capturen el mismo pedido.
  perform p.id from public.pedidos p
  where p.estado='aceptado' and p.origen_local=p_origen and p.destino_local=p_destino and p.reposicion_id is null
    and exists(select 1 from public.pedido_productos pp where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad,0)>0)
  for update;

  insert into public.op_reposicion_pedidos(reposicion_id,pedido_id,agregado_by)
  select r,p.id,auth.uid() from public.pedidos p
  where p.estado='aceptado' and p.origen_local=p_origen and p.destino_local=p_destino and p.reposicion_id is null
    and exists(select 1 from public.pedido_productos pp where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad,0)>0);
  get diagnostics pedidos_integrados=row_count;

  insert into public.op_reposicion_items(reposicion_id,codigo,nombre,barras,marca,pedido_clientes,pedidos_asignados,updated_by,updated_by_name)
  select r,pp.codigo,coalesce(max(pr.nombre),max(pp.nombre),pp.codigo),max(pr.barras),coalesce(max(pr.marca),max(pp.marca)),
    sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0))::integer,
    jsonb_agg(jsonb_build_object('pedido_id',p.id,'cliente',coalesce(p.cliente,'Sin nombre'),'telefono',coalesce(p.telefono,''),'cantidad',coalesce(pp.cantidad_aceptada,pp.cantidad,0),'urgente',coalesce(p.urgente,false)) order by p.created_at),
    auth.uid(),left(coalesce((select trim(coalesce(nombre,'')||' '||coalesce(apellido,'')) from public.perfiles where id=auth.uid()),'Usuario'),80)
  from public.op_reposicion_pedidos l join public.pedidos p on p.id=l.pedido_id
  join public.pedido_productos pp on pp.pedido_id=p.id
  left join public.productos pr on pr.codigo=pp.codigo
  where l.reposicion_id=r and coalesce(pp.cantidad_aceptada,pp.cantidad,0)>0
  group by pp.codigo
  on conflict(reposicion_id,codigo) do update set
    pedido_clientes=excluded.pedido_clientes,pedidos_asignados=excluded.pedidos_asignados,
    barras=coalesce(excluded.barras,public.op_reposicion_items.barras),marca=coalesce(excluded.marca,public.op_reposicion_items.marca),updated_at=now();

  update public.pedidos p set reposicion_id=r,integrado_en_reposicion_at=now(),updated_at=now()
  where exists(select 1 from public.op_reposicion_pedidos l where l.reposicion_id=r and l.pedido_id=p.id);
  insert into public.op_reposicion_participantes(reposicion_id,usuario_id,nombre)
  values(r,auth.uid(),left(coalesce((select trim(coalesce(nombre,'')||' '||coalesce(apellido,'')) from public.perfiles where id=auth.uid()),'Usuario'),80));
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,detalle)
  values(r,auth.uid(),left(coalesce((select trim(coalesce(nombre,'')||' '||coalesce(apellido,'')) from public.perfiles where id=auth.uid()),'Usuario'),80),'crear',jsonb_build_object('pedidos_integrados',pedidos_integrados));
  return r;
end $$;

create or replace function public.op_agregar_pedido_urgente(p_reposicion uuid,p_pedido uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.op_reposiciones; p public.pedidos; agregado integer;
begin
  if not public.is_ops_supervisor() then raise exception 'Solo supervisores pueden agregar pedidos urgentes'; end if;
  select * into r from public.op_reposiciones where id=p_reposicion and estado='preparando' for update;
  if r.id is null then raise exception 'Reposicion no disponible'; end if;
  select * into p from public.pedidos where id=p_pedido and estado='aceptado' and urgente=true and reposicion_id is null and updated_at>r.started_at for update;
  if p.id is null or p.origen_local<>r.origen_local or p.destino_local<>r.destino_local then raise exception 'Pedido urgente no disponible para este recorrido'; end if;
  insert into public.op_reposicion_pedidos(reposicion_id,pedido_id,urgente_agregado_despues,agregado_by)
  values(r.id,p.id,true,auth.uid()) on conflict do nothing;
  get diagnostics agregado=row_count;
  if agregado=0 then return false; end if;
  insert into public.op_reposicion_items(reposicion_id,codigo,nombre,barras,marca,pedido_clientes,pedidos_asignados,updated_by,updated_by_name)
  select r.id,pp.codigo,coalesce(max(pr.nombre),max(pp.nombre),pp.codigo),max(pr.barras),coalesce(max(pr.marca),max(pp.marca)),sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0))::integer,
    jsonb_agg(jsonb_build_object('pedido_id',p.id,'cliente',coalesce(p.cliente,'Sin nombre'),'telefono',coalesce(p.telefono,''),'cantidad',coalesce(pp.cantidad_aceptada,pp.cantidad,0),'urgente',true)),
    auth.uid(),left(coalesce((select trim(coalesce(nombre,'')||' '||coalesce(apellido,'')) from public.perfiles where id=auth.uid()),'Usuario'),80)
  from public.pedido_productos pp left join public.productos pr on pr.codigo=pp.codigo
  where pp.pedido_id=p.id and coalesce(pp.cantidad_aceptada,pp.cantidad,0)>0 group by pp.codigo
  on conflict(reposicion_id,codigo) do update set
    pedido_clientes=public.op_reposicion_items.pedido_clientes+excluded.pedido_clientes,
    pedidos_asignados=public.op_reposicion_items.pedidos_asignados||excluded.pedidos_asignados,
    barras=coalesce(excluded.barras,public.op_reposicion_items.barras),marca=coalesce(excluded.marca,public.op_reposicion_items.marca),updated_at=now();
  update public.pedidos set reposicion_id=r.id,integrado_en_reposicion_at=now(),updated_at=now() where id=p.id;
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,detalle)
  values(r.id,auth.uid(),left(coalesce((select trim(coalesce(nombre,'')||' '||coalesce(apellido,'')) from public.perfiles where id=auth.uid()),'Usuario'),80),'pedido_urgente',jsonb_build_object('pedido_id',p.id));
  return true;
end $$;

create or replace function public.op_inventario_sumar(
  p_sesion uuid, p_codigo text, p_nombre text, p_barras text,
  p_cantidad integer default 1, p_tipo text default 'scanner'
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare r public.op_inventario_items;
begin
  if p_cantidad < 1 or p_cantidad > 9999 then raise exception 'Cantidad invalida'; end if;
  if not exists(select 1 from public.op_inventario_sesiones s where s.id=p_sesion and s.estado='abierta' and (public.is_ops_supervisor() or s.local_nombre=public.my_local())) then
    raise exception 'Sesion no disponible';
  end if;
  insert into public.op_inventario_items(sesion_id,codigo,nombre,barras,cantidad,tipos,updated_by)
  values(p_sesion,trim(p_codigo),trim(p_nombre),nullif(trim(p_barras),''),p_cantidad,jsonb_build_object(p_tipo,p_cantidad),auth.uid())
  on conflict(sesion_id,codigo) do update set
    cantidad=public.op_inventario_items.cantidad+p_cantidad,
    nombre=excluded.nombre,
    barras=coalesce(excluded.barras,public.op_inventario_items.barras),
    tipos=jsonb_set(public.op_inventario_items.tipos,array[p_tipo],to_jsonb(coalesce((public.op_inventario_items.tipos->>p_tipo)::integer,0)+p_cantidad),true),
    updated_by=auth.uid(), updated_at=now()
  returning * into r;
  insert into public.op_inventario_eventos(sesion_id,usuario_id,tipo,codigo,nombre,cantidad)
  values(p_sesion,auth.uid(),p_tipo,p_codigo,p_nombre,p_cantidad);
  update public.op_inventario_sesiones set updated_at=now() where id=p_sesion;
  return to_jsonb(r);
end $$;

create or replace function public.op_actualizar_remito(p_reposicion uuid,p_remito text)
returns void language plpgsql security definer set search_path=public as $$
declare valor text:=trim(coalesce(p_remito,''));
begin
  if valor='' then raise exception 'Numero de remito requerido'; end if;
  if not exists(select 1 from public.op_reposiciones r where r.id=p_reposicion and (public.is_ops_supervisor() or r.origen_local=public.my_local())) then raise exception 'Reposicion no disponible'; end if;
  update public.op_reposiciones set remito=valor,remito_pendiente=false,updated_at=now() where id=p_reposicion;
  update public.op_despachos set remito=valor,remito_pendiente=false,updated_at=now() where reposicion_id=p_reposicion;
  update public.pedidos set remito=valor,remito_pendiente=false,updated_at=now() where reposicion_id=p_reposicion;
end $$;

create or replace function public.op_inventario_ajustar(p_sesion uuid,p_codigo text,p_delta integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.op_inventario_items;
begin
  if p_delta < -9999 or p_delta > 9999 then raise exception 'Variacion invalida'; end if;
  if not exists(select 1 from public.op_inventario_sesiones s where s.id=p_sesion and s.estado='abierta' and (public.is_ops_supervisor() or s.local_nombre=public.my_local())) then raise exception 'Sesion no disponible'; end if;
  update public.op_inventario_items set cantidad=greatest(0,cantidad+p_delta),updated_by=auth.uid(),updated_at=now()
  where sesion_id=p_sesion and codigo=p_codigo returning * into r;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  if r.cantidad=0 then delete from public.op_inventario_items where sesion_id=p_sesion and codigo=p_codigo; end if;
  insert into public.op_inventario_eventos(sesion_id,usuario_id,tipo,codigo,nombre,cantidad,detalle)
  values(p_sesion,auth.uid(),'ajuste',p_codigo,r.nombre,p_delta,jsonb_build_object('resultado',r.cantidad));
  return to_jsonb(r);
end $$;

create or replace function public.op_reposicion_cantidad(
  p_reposicion uuid,p_codigo text,p_delta integer default null,p_absoluta integer default null,
  p_origen text default 'manual',p_usuario_nombre text default 'Usuario'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.op_reposicion_items; nueva integer;
begin
  if not exists(select 1 from public.op_reposiciones x where x.id=p_reposicion and x.estado='preparando' and (public.is_ops_supervisor() or x.origen_local=public.my_local())) then raise exception 'Reposicion no disponible'; end if;
  select * into r from public.op_reposicion_items where reposicion_id=p_reposicion and codigo=p_codigo for update;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  nueva=case when p_absoluta is not null then p_absoluta else r.preparado+coalesce(p_delta,0) end;
  if nueva<0 or nueva>999999 then raise exception 'Cantidad invalida'; end if;
  update public.op_reposicion_items set preparado=nueva,no_encontrado=case when nueva>0 then false else no_encontrado end,
    updated_by=auth.uid(),updated_by_name=left(p_usuario_nombre,80),updated_at=now()
  where reposicion_id=p_reposicion and codigo=p_codigo returning * into r;
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),left(p_usuario_nombre,80),'cantidad',p_codigo,jsonb_build_object('despues',nueva,'origen',p_origen));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(r);
end $$;

create or replace function public.op_finalizar_despacho(
  p_reposicion uuid,p_transporte text,p_remito text default null,p_remito_pendiente boolean default false,p_observaciones text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare d uuid;
begin
  if trim(coalesce(p_transporte,''))='' then raise exception 'Transporte requerido'; end if;
  if not exists(select 1 from public.op_reposiciones r where r.id=p_reposicion and r.estado='preparando' and (public.is_ops_supervisor() or r.origen_local=public.my_local())) then raise exception 'Reposicion no disponible'; end if;
  insert into public.op_despachos(reposicion_id,origen_local,destino_local,transporte,remito,remito_pendiente,observaciones,enviado_by)
  select id,origen_local,destino_local,p_transporte,nullif(trim(p_remito),''),p_remito_pendiente,p_observaciones,auth.uid()
  from public.op_reposiciones where id=p_reposicion returning id into d;
  update public.op_reposiciones set estado='enviado',transporte=p_transporte,remito=nullif(trim(p_remito),''),remito_pendiente=p_remito_pendiente,
    observaciones_envio=p_observaciones,enviado_at=now(),enviado_by=auth.uid(),updated_at=now() where id=p_reposicion;

  -- Distribuye primero las unidades juntadas entre pedidos de clientes por orden
  -- de aceptación/creación. Así ninguna unidad se duplica entre pedidos.
  with lineas as (
    select pp.id,pp.pedido_id,pp.codigo,coalesce(pp.cantidad_aceptada,pp.cantidad,0)::integer solicitada,
      least(ri.preparado,ri.pedido_clientes)::integer disponible,
      coalesce(sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0)) over(partition by pp.codigo order by p.created_at,p.id,pp.id rows between unbounded preceding and 1 preceding),0)::integer previa
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    join public.op_reposicion_items ri on ri.reposicion_id=p_reposicion and ri.codigo=pp.codigo
    where p.reposicion_id=p_reposicion and p.estado='aceptado'
  ), asignadas as (
    select id,greatest(0,least(solicitada,disponible-previa))::integer cantidad from lineas
  )
  update public.pedido_productos pp set cantidad_preparada=a.cantidad from asignadas a where pp.id=a.id;

  with totales as (
    select p.id,sum(coalesce(pp.cantidad_aceptada,pp.cantidad,0))::integer solicitada,sum(coalesce(pp.cantidad_preparada,0))::integer preparada
    from public.pedidos p join public.pedido_productos pp on pp.pedido_id=p.id
    where p.reposicion_id=p_reposicion and p.estado='aceptado' group by p.id
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
    nota_parcial=case when t.preparada>0 and t.preparada<t.solicitada then 'Enviado parcial desde reposicion: '||t.preparada||' de '||t.solicitada||' unidades' else p.nota_parcial end,
    updated_at=now()
  from totales t where p.id=t.id;
  insert into public.pedido_historial(pedido_id,estado,usuario_id,persona_nombre)
  select id,'transito',auth.uid(),null from public.pedidos where despacho_id=d;
  return d;
end $$;

-- RLS.
alter table public.catalogo_version enable row level security;
alter table public.op_rutas_transferencia enable row level security;
alter table public.op_inventario_sesiones enable row level security;
alter table public.op_inventario_participantes enable row level security;
alter table public.op_inventario_items enable row level security;
alter table public.op_inventario_eventos enable row level security;
alter table public.op_inventario_balances enable row level security;
alter table public.op_reposiciones enable row level security;
alter table public.op_reposicion_items enable row level security;
alter table public.op_reposicion_extras enable row level security;
alter table public.op_reposicion_participantes enable row level security;
alter table public.op_reposicion_eventos enable row level security;
alter table public.op_reposicion_pedidos enable row level security;
alter table public.op_despachos enable row level security;
alter table public.op_asignaciones_barras enable row level security;

drop policy if exists catalogo_version_read on public.catalogo_version;
create policy catalogo_version_read on public.catalogo_version for select to authenticated using (true);

drop policy if exists rutas_read on public.op_rutas_transferencia;
create policy rutas_read on public.op_rutas_transferencia for select to authenticated using (true);
drop policy if exists rutas_supervisor_write on public.op_rutas_transferencia;
create policy rutas_supervisor_write on public.op_rutas_transferencia for all to authenticated
using (public.is_ops_supervisor()) with check (public.is_ops_supervisor());

drop policy if exists inventario_sesiones_scope on public.op_inventario_sesiones;
create policy inventario_sesiones_scope on public.op_inventario_sesiones for select to authenticated
using (public.is_ops_supervisor() or local_nombre = public.my_local());
drop policy if exists inventario_sesiones_create on public.op_inventario_sesiones;
create policy inventario_sesiones_create on public.op_inventario_sesiones for insert to authenticated
with check (created_by = auth.uid() and (public.is_ops_supervisor() or local_nombre = public.my_local()));
drop policy if exists inventario_sesiones_update on public.op_inventario_sesiones;
create policy inventario_sesiones_update on public.op_inventario_sesiones for update to authenticated
using (public.is_ops_supervisor() or local_nombre = public.my_local())
with check (public.is_ops_supervisor() or local_nombre = public.my_local());

drop policy if exists inventario_participantes_scope on public.op_inventario_participantes;
create policy inventario_participantes_scope on public.op_inventario_participantes for all to authenticated
using (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())))
with check (usuario_id=auth.uid() and exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())));

drop policy if exists inventario_items_scope on public.op_inventario_items;
create policy inventario_items_scope on public.op_inventario_items for all to authenticated
using (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())))
with check (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())));

drop policy if exists inventario_eventos_scope on public.op_inventario_eventos;
create policy inventario_eventos_scope on public.op_inventario_eventos for all to authenticated
using (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())))
with check (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())));

drop policy if exists inventario_balances_scope on public.op_inventario_balances;
create policy inventario_balances_scope on public.op_inventario_balances for all to authenticated
using (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())))
with check (exists(select 1 from public.op_inventario_sesiones s where s.id=sesion_id and (public.is_ops_supervisor() or s.local_nombre=public.my_local())));

drop policy if exists reposiciones_scope on public.op_reposiciones;
create policy reposiciones_scope on public.op_reposiciones for select to authenticated
using (public.is_ops_supervisor() or origen_local=public.my_local() or destino_local=public.my_local());
drop policy if exists reposiciones_create on public.op_reposiciones;
create policy reposiciones_create on public.op_reposiciones for insert to authenticated
with check (created_by=auth.uid() and (public.is_ops_supervisor() or origen_local=public.my_local()));
drop policy if exists reposiciones_update on public.op_reposiciones;
create policy reposiciones_update on public.op_reposiciones for update to authenticated
using (public.is_ops_supervisor() or origen_local=public.my_local())
with check (public.is_ops_supervisor() or origen_local=public.my_local());

drop policy if exists reposicion_items_scope on public.op_reposicion_items;
drop policy if exists reposicion_items_read on public.op_reposicion_items;
drop policy if exists reposicion_items_mutate on public.op_reposicion_items;
create policy reposicion_items_read on public.op_reposicion_items for select to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())));
create policy reposicion_items_mutate on public.op_reposicion_items for all to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and r.estado='preparando' and (public.is_ops_supervisor() or r.origen_local=public.my_local())))
with check (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and r.estado='preparando' and (public.is_ops_supervisor() or r.origen_local=public.my_local())));

drop policy if exists reposicion_extras_scope on public.op_reposicion_extras;
drop policy if exists reposicion_extras_read on public.op_reposicion_extras;
drop policy if exists reposicion_extras_mutate on public.op_reposicion_extras;
create policy reposicion_extras_read on public.op_reposicion_extras for select to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())));
create policy reposicion_extras_mutate on public.op_reposicion_extras for all to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and r.estado='preparando' and (public.is_ops_supervisor() or r.origen_local=public.my_local())))
with check (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and r.estado='preparando' and (public.is_ops_supervisor() or r.origen_local=public.my_local())));

drop policy if exists reposicion_participantes_scope on public.op_reposicion_participantes;
create policy reposicion_participantes_scope on public.op_reposicion_participantes for all to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())))
with check (usuario_id=auth.uid() and exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())));

drop policy if exists reposicion_eventos_scope on public.op_reposicion_eventos;
create policy reposicion_eventos_scope on public.op_reposicion_eventos for all to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())))
with check (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local())));

drop policy if exists reposicion_pedidos_scope on public.op_reposicion_pedidos;
create policy reposicion_pedidos_scope on public.op_reposicion_pedidos for all to authenticated
using (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())))
with check (exists(select 1 from public.op_reposiciones r where r.id=reposicion_id and (public.is_ops_supervisor() or r.origen_local=public.my_local())));

drop policy if exists despachos_scope on public.op_despachos;
create policy despachos_scope on public.op_despachos for all to authenticated
using (public.is_ops_supervisor() or origen_local=public.my_local() or destino_local=public.my_local())
with check (public.is_ops_supervisor() or origen_local=public.my_local());

drop policy if exists asignaciones_barras_read on public.op_asignaciones_barras;
create policy asignaciones_barras_read on public.op_asignaciones_barras for select to authenticated using (true);
drop policy if exists asignaciones_barras_create on public.op_asignaciones_barras;
create policy asignaciones_barras_create on public.op_asignaciones_barras for insert to authenticated with check (created_by=auth.uid());
drop policy if exists asignaciones_barras_update on public.op_asignaciones_barras;
create policy asignaciones_barras_update on public.op_asignaciones_barras for update to authenticated
using (created_by=auth.uid() or public.is_ops_supervisor()) with check (created_by=auth.uid() or public.is_ops_supervisor());

-- Buckets privados para originales y comprobantes.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('op-reposiciones','op-reposiciones',false,31457280,array['application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream'])
on conflict(id) do nothing;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('op-barras-fotos','op-barras-fotos',false,4194304,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;

drop policy if exists op_storage_read on storage.objects;
create policy op_storage_read on storage.objects for select to authenticated
using (
  (bucket_id='op-barras-fotos' and (owner_id=auth.uid()::text or public.is_ops_supervisor()))
  or
  (bucket_id='op-reposiciones' and exists(
    select 1 from public.op_reposiciones r
    where r.id::text=split_part(name,'/',1)
      and (public.is_ops_supervisor() or r.origen_local=public.my_local() or r.destino_local=public.my_local())
  ))
);
drop policy if exists op_storage_insert on storage.objects;
create policy op_storage_insert on storage.objects for insert to authenticated
with check (bucket_id in ('op-reposiciones','op-barras-fotos'));
drop policy if exists op_storage_update on storage.objects;
create policy op_storage_update on storage.objects for update to authenticated
using (bucket_id in ('op-reposiciones','op-barras-fotos') and (owner_id=auth.uid()::text or public.is_ops_supervisor()));

-- Corrige el aviso del asesor de seguridad sin fallar en proyectos donde la vista no exista.
do $$ begin
  if to_regclass('public.v_pedido_recepcion_auditoria') is not null then
    execute 'alter view public.v_pedido_recepcion_auditoria set (security_invoker = true)';
  end if;
end $$;

-- Realtime para celulares/PC concurrentes.
do $$
declare t text;
begin
  foreach t in array array['op_inventario_items','op_inventario_eventos','op_reposicion_items','op_reposicion_extras','op_reposicion_eventos','pedidos'] loop
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

grant execute on function public.reemplazar_padron_productos(jsonb) to authenticated;
grant execute on function public.op_crear_reposicion(text,text,text,jsonb,jsonb,text) to authenticated;
grant execute on function public.op_agregar_pedido_urgente(uuid,uuid) to authenticated;
grant execute on function public.op_inventario_sumar(uuid,text,text,text,integer,text) to authenticated;
grant execute on function public.op_inventario_ajustar(uuid,text,integer) to authenticated;
grant execute on function public.op_reposicion_cantidad(uuid,text,integer,integer,text,text) to authenticated;
grant execute on function public.op_finalizar_despacho(uuid,text,text,boolean,text) to authenticated;
grant execute on function public.op_actualizar_remito(uuid,text) to authenticated;
