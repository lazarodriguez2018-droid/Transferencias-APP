-- Base limpia de TransferApp para un proyecto nuevo de Supabase.
-- Solo staging: producción ya contiene estas tablas.

create extension if not exists pgcrypto;

create table if not exists public.empresa_config (
  id uuid primary key default gen_random_uuid(),
  clave text not null,
  nombre text not null,
  created_at timestamptz default now()
);

create table if not exists public.locales (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  almacen text not null,
  email text,
  created_at timestamptz default now(),
  telefono text,
  direccion text,
  unique (nombre)
);

create table if not exists public.transportes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  created_at timestamptz default now()
);

create table if not exists public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  apellido text not null,
  local_nombre text not null,
  almacen text not null,
  role text not null default 'empleado' check (role in ('empleado','admin','supervisor_general')),
  approved boolean not null default false,
  created_at timestamptz default now(),
  foto_url text,
  nombre_display text
);

create table if not exists public.productos (
  id uuid primary key default gen_random_uuid(),
  codigo text,
  nombre text not null,
  marca text,
  updated_at timestamptz default now()
);

create table if not exists public.padron_extra (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  descripcion text,
  unidad text default 'unidad',
  created_at timestamptz default now(),
  codigo text,
  marca text
);

create table if not exists public.pedidos (
  id uuid primary key default gen_random_uuid(),
  origen_local text not null,
  origen_almacen text not null,
  destino_local text not null,
  destino_almacen text not null,
  cliente text,
  telefono text,
  notas text,
  urgente boolean default false,
  estado text not null default 'pendiente',
  transporte text,
  remito text,
  tracking text,
  foto_url text,
  motivo_denegacion text,
  faltantes text,
  creado_por uuid references public.perfiles(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  faltantes_escala text,
  aceptado_parcial boolean default false,
  nota_parcial text,
  escala_local text,
  escala_almacen text,
  check (origen_local <> destino_local)
);

create table if not exists public.pedido_productos (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references public.pedidos(id) on delete cascade,
  codigo text,
  nombre text not null,
  marca text,
  cantidad integer not null default 1 check (cantidad > 0)
);

create table if not exists public.pedido_historial (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references public.pedidos(id) on delete cascade,
  estado text not null,
  usuario_id uuid references public.perfiles(id) on delete set null,
  created_at timestamptz default now(),
  persona_nombre text
);

create table if not exists public.chat_mensajes (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references public.pedidos(id) on delete cascade,
  usuario_id uuid references public.perfiles(id) on delete set null,
  usuario_nombre text not null,
  local_nombre text not null,
  texto text not null,
  created_at timestamptz default now()
);

create table if not exists public.notificaciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references public.perfiles(id) on delete cascade,
  titulo text not null,
  cuerpo text,
  pedido_id uuid references public.pedidos(id) on delete cascade,
  leida boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.sugerencias (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references public.perfiles(id) on delete cascade,
  usuario_nombre text not null,
  local_nombre text not null,
  email text,
  asunto text not null,
  texto text not null,
  respuesta text,
  respuesta_leida boolean default false,
  leida boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.clientes_agenda (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  telefono text,
  direccion text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.conversaciones (
  id uuid primary key default gen_random_uuid(),
  nombre text,
  es_grupo boolean default false,
  creado_por uuid references public.perfiles(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.conversacion_miembros (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid references public.conversaciones(id) on delete cascade,
  usuario_id uuid references public.perfiles(id) on delete cascade,
  joined_at timestamptz default now(),
  unique (conversacion_id, usuario_id)
);

create table if not exists public.mensajes (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid references public.conversaciones(id) on delete cascade,
  usuario_id uuid references public.perfiles(id) on delete set null,
  usuario_nombre text not null,
  texto text not null,
  created_at timestamptz default now()
);

create index if not exists pedidos_origen_estado_idx on public.pedidos(origen_local, estado, created_at desc);
create index if not exists pedidos_destino_estado_idx on public.pedidos(destino_local, estado, created_at desc);
create index if not exists pedido_productos_pedido_idx on public.pedido_productos(pedido_id);
create index if not exists pedido_productos_codigo_idx on public.pedido_productos(codigo);
create index if not exists pedido_historial_pedido_idx on public.pedido_historial(pedido_id, created_at);
create index if not exists chat_mensajes_pedido_idx on public.chat_mensajes(pedido_id, created_at);
create index if not exists notificaciones_usuario_idx on public.notificaciones(usuario_id, leida, created_at desc);
create index if not exists conversacion_miembros_usuario_idx on public.conversacion_miembros(usuario_id);
create index if not exists mensajes_conversacion_idx on public.mensajes(conversacion_id, created_at);

create or replace function public.is_ops_supervisor()
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.perfiles
    where id=auth.uid() and approved=true and role in ('admin','supervisor_general')
  )
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select public.is_ops_supervisor()
$$;

create or replace function public.my_local()
returns text language sql stable security definer set search_path=public as $$
  select local_nombre from public.perfiles where id=auth.uid() and approved=true limit 1
$$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path=public as $$
  select role from public.perfiles where id=auth.uid() limit 1
$$;

create or replace function public.my_approved()
returns boolean language sql stable security definer set search_path=public as $$
  select approved from public.perfiles where id=auth.uid() limit 1
$$;

create or replace function public.can_access_order(order_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.pedidos p where p.id=order_id and (
      public.is_ops_supervisor() or p.origen_local=public.my_local()
      or p.destino_local=public.my_local() or p.escala_local=public.my_local()
    )
  )
$$;

create or replace function public.is_conversation_member(conversation_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.conversacion_miembros m
    where m.conversacion_id=conversation_id and m.usuario_id=auth.uid()
  )
$$;

create or replace function public.verificar_clave_empresa(clave_input text)
returns table(nombre text)
language sql stable security definer set search_path=public as $$
  select e.nombre from public.empresa_config e where e.clave=clave_input limit 1
$$;

revoke all on public.empresa_config from anon, authenticated;
grant execute on function public.verificar_clave_empresa(text) to anon, authenticated;

alter table public.empresa_config enable row level security;
alter table public.locales enable row level security;
alter table public.transportes enable row level security;
alter table public.perfiles enable row level security;
alter table public.productos enable row level security;
alter table public.padron_extra enable row level security;
alter table public.pedidos enable row level security;
alter table public.pedido_productos enable row level security;
alter table public.pedido_historial enable row level security;
alter table public.chat_mensajes enable row level security;
alter table public.notificaciones enable row level security;
alter table public.sugerencias enable row level security;
alter table public.clientes_agenda enable row level security;
alter table public.conversaciones enable row level security;
alter table public.conversacion_miembros enable row level security;
alter table public.mensajes enable row level security;

create policy locales_public_read on public.locales for select to anon,authenticated using (true);
create policy locales_supervisor_write on public.locales for all to authenticated using (public.is_ops_supervisor()) with check (public.is_ops_supervisor());
create policy transportes_read on public.transportes for select to authenticated using (true);
create policy transportes_supervisor_write on public.transportes for all to authenticated using (public.is_ops_supervisor()) with check (public.is_ops_supervisor());

create policy perfiles_read_authenticated on public.perfiles for select to authenticated using (true);
create policy perfiles_insert_self on public.perfiles for insert to authenticated
with check (id=auth.uid() and approved=false and role in ('empleado','admin'));
create policy perfiles_update_self_or_supervisor on public.perfiles for update to authenticated
using (id=auth.uid() or public.is_ops_supervisor())
with check (
  public.is_ops_supervisor()
  or (id=auth.uid() and role=public.my_role() and approved=public.my_approved() and local_nombre=public.my_local())
);
create policy perfiles_delete_supervisor on public.perfiles for delete to authenticated using (public.is_ops_supervisor());

create policy productos_read on public.productos for select to authenticated using (true);
create policy productos_supervisor_write on public.productos for all to authenticated using (public.is_ops_supervisor()) with check (public.is_ops_supervisor());
create policy padron_extra_read on public.padron_extra for select to authenticated using (true);
create policy padron_extra_supervisor_write on public.padron_extra for all to authenticated using (public.is_ops_supervisor()) with check (public.is_ops_supervisor());

create policy pedidos_read_scope on public.pedidos for select to authenticated
using (public.is_ops_supervisor() or origen_local=public.my_local() or destino_local=public.my_local() or escala_local=public.my_local());
create policy pedidos_insert_destination on public.pedidos for insert to authenticated
with check (public.is_ops_supervisor() or (creado_por=auth.uid() and destino_local=public.my_local()));
create policy pedidos_update_scope on public.pedidos for update to authenticated
using (public.is_ops_supervisor() or origen_local=public.my_local() or destino_local=public.my_local() or escala_local=public.my_local())
with check (public.is_ops_supervisor() or origen_local=public.my_local() or destino_local=public.my_local() or escala_local=public.my_local());
create policy pedidos_delete_supervisor on public.pedidos for delete to authenticated using (public.is_ops_supervisor());

create policy pedido_productos_read on public.pedido_productos for select to authenticated using (public.can_access_order(pedido_id));
create policy pedido_productos_insert on public.pedido_productos for insert to authenticated with check (public.can_access_order(pedido_id));
create policy pedido_productos_update on public.pedido_productos for update to authenticated using (public.can_access_order(pedido_id)) with check (public.can_access_order(pedido_id));
create policy pedido_productos_delete on public.pedido_productos for delete to authenticated using (public.can_access_order(pedido_id));
create policy pedido_historial_scope on public.pedido_historial for all to authenticated using (public.can_access_order(pedido_id)) with check (public.can_access_order(pedido_id));
create policy chat_mensajes_scope on public.chat_mensajes for all to authenticated using (public.can_access_order(pedido_id)) with check (public.can_access_order(pedido_id) and usuario_id=auth.uid());

create policy notificaciones_owner on public.notificaciones for select to authenticated using (usuario_id=auth.uid() or public.is_ops_supervisor());
create policy notificaciones_insert_scope on public.notificaciones for insert to authenticated with check (true);
create policy notificaciones_owner_update on public.notificaciones for update to authenticated using (usuario_id=auth.uid() or public.is_ops_supervisor()) with check (usuario_id=auth.uid() or public.is_ops_supervisor());
create policy notificaciones_owner_delete on public.notificaciones for delete to authenticated using (usuario_id=auth.uid() or public.is_ops_supervisor());

create policy sugerencias_owner_or_supervisor on public.sugerencias for all to authenticated
using (usuario_id=auth.uid() or public.is_ops_supervisor()) with check (usuario_id=auth.uid() or public.is_ops_supervisor());
create policy clientes_agenda_authenticated on public.clientes_agenda for all to authenticated using (true) with check (true);

create policy conversaciones_member_read on public.conversaciones for select to authenticated using (public.is_conversation_member(id));
create policy conversaciones_create on public.conversaciones for insert to authenticated with check (creado_por=auth.uid());
create policy conversaciones_member_update on public.conversaciones for update to authenticated using (public.is_conversation_member(id)) with check (public.is_conversation_member(id));
create policy conversaciones_supervisor_or_creator_delete on public.conversaciones for delete to authenticated using (creado_por=auth.uid() or public.is_ops_supervisor());
create policy conversacion_miembros_read on public.conversacion_miembros for select to authenticated using (public.is_conversation_member(conversacion_id));
create policy conversacion_miembros_insert on public.conversacion_miembros for insert to authenticated
with check (usuario_id=auth.uid() or exists(select 1 from public.conversaciones c where c.id=conversacion_id and c.creado_por=auth.uid()));
create policy conversacion_miembros_delete on public.conversacion_miembros for delete to authenticated using (usuario_id=auth.uid() or public.is_ops_supervisor());
create policy mensajes_member_read on public.mensajes for select to authenticated using (public.is_conversation_member(conversacion_id));
create policy mensajes_member_insert on public.mensajes for insert to authenticated with check (usuario_id=auth.uid() and public.is_conversation_member(conversacion_id));
create policy mensajes_member_delete on public.mensajes for delete to authenticated using (public.is_conversation_member(conversacion_id));

grant usage on schema public to anon, authenticated;
grant select on public.locales to anon;
grant select,insert,update,delete on all tables in schema public to authenticated;
grant usage,select on all sequences in schema public to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.pedidos;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.chat_mensajes;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.notificaciones;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.mensajes;
exception when duplicate_object then null; end $$;

insert into public.empresa_config(clave,nombre)
select 'SUCANEITOR-PRUEBAS', 'Sucaneitor · Entorno de pruebas'
where not exists (select 1 from public.empresa_config);

insert into public.locales(nombre,almacen) values
  ('Punta del Este','PDE'),
  ('Maldonado','MDO')
on conflict (nombre) do update set almacen=excluded.almacen;

insert into public.transportes(nombre) values
  ('Transporte propio'),
  ('Cadetería'),
  ('Otro')
on conflict (nombre) do nothing;
