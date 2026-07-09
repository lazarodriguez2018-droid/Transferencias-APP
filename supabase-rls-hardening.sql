-- Base de endurecimiento RLS para TransferApp.
-- Ejecutar primero en staging/copia. Ajustar si tus nombres de columnas difieren.

create or replace function public.current_profile()
returns public.perfiles
language sql
stable
security definer
set search_path = public
as $$
  select p.*
  from public.perfiles p
  where p.id = auth.uid()
  limit 1
$$;

create or replace function public.is_admin()
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
      and p.role = 'admin'
  )
$$;

create or replace function public.my_local()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.local_nombre
  from public.perfiles p
  where p.id = auth.uid()
    and p.approved = true
  limit 1
$$;

alter table public.perfiles enable row level security;
alter table public.pedidos enable row level security;
alter table public.pedido_productos enable row level security;
alter table public.pedido_historial enable row level security;
alter table public.chat_mensajes enable row level security;
alter table public.notificaciones enable row level security;
alter table public.sugerencias enable row level security;
alter table public.locales enable row level security;
alter table public.transportes enable row level security;
alter table public.productos enable row level security;
alter table public.padron_extra enable row level security;
alter table public.clientes_agenda enable row level security;

drop policy if exists "perfiles_select_self_or_admin" on public.perfiles;
create policy "perfiles_select_self_or_admin"
on public.perfiles for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "perfiles_update_self_basic_or_admin" on public.perfiles;
create policy "perfiles_update_self_basic_or_admin"
on public.perfiles for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (
  public.is_admin()
  or (
    id = auth.uid()
    and role = (select role from public.perfiles where id = auth.uid())
    and approved = (select approved from public.perfiles where id = auth.uid())
  )
);

drop policy if exists "pedidos_select_by_local_or_admin" on public.pedidos;
create policy "pedidos_select_by_local_or_admin"
on public.pedidos for select
to authenticated
using (
  public.is_admin()
  or origen_local = public.my_local()
  or destino_local = public.my_local()
  or escala_local = public.my_local()
);

drop policy if exists "pedidos_insert_own_destination_or_admin" on public.pedidos;
create policy "pedidos_insert_own_destination_or_admin"
on public.pedidos for insert
to authenticated
with check (
  public.is_admin()
  or (
    creado_por = auth.uid()
    and destino_local = public.my_local()
  )
);

drop policy if exists "pedidos_update_involved_local_or_admin" on public.pedidos;
create policy "pedidos_update_involved_local_or_admin"
on public.pedidos for update
to authenticated
using (
  public.is_admin()
  or origen_local = public.my_local()
  or destino_local = public.my_local()
  or escala_local = public.my_local()
)
with check (
  public.is_admin()
  or origen_local = public.my_local()
  or destino_local = public.my_local()
  or escala_local = public.my_local()
);

drop policy if exists "pedidos_delete_admin_only" on public.pedidos;
create policy "pedidos_delete_admin_only"
on public.pedidos for delete
to authenticated
using (public.is_admin());

drop policy if exists "pedido_productos_select_by_parent" on public.pedido_productos;
create policy "pedido_productos_select_by_parent"
on public.pedido_productos for select
to authenticated
using (exists (
  select 1 from public.pedidos p
  where p.id = pedido_productos.pedido_id
    and (public.is_admin() or p.origen_local = public.my_local() or p.destino_local = public.my_local() or p.escala_local = public.my_local())
));

drop policy if exists "pedido_productos_insert_by_parent" on public.pedido_productos;
create policy "pedido_productos_insert_by_parent"
on public.pedido_productos for insert
to authenticated
with check (exists (
  select 1 from public.pedidos p
  where p.id = pedido_productos.pedido_id
    and (public.is_admin() or p.creado_por = auth.uid() or p.destino_local = public.my_local())
));

drop policy if exists "pedido_productos_admin_delete" on public.pedido_productos;
create policy "pedido_productos_admin_delete"
on public.pedido_productos for delete
to authenticated
using (public.is_admin());

drop policy if exists "catalogos_read_authenticated" on public.locales;
create policy "catalogos_read_authenticated"
on public.locales for select
to authenticated
using (true);

drop policy if exists "locales_admin_write" on public.locales;
create policy "locales_admin_write"
on public.locales for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "transportes_read_authenticated" on public.transportes;
create policy "transportes_read_authenticated"
on public.transportes for select
to authenticated
using (true);

drop policy if exists "transportes_admin_write" on public.transportes;
create policy "transportes_admin_write"
on public.transportes for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "productos_read_authenticated" on public.productos;
create policy "productos_read_authenticated"
on public.productos for select
to authenticated
using (true);

drop policy if exists "productos_admin_write" on public.productos;
create policy "productos_admin_write"
on public.productos for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "padron_extra_read_authenticated" on public.padron_extra;
create policy "padron_extra_read_authenticated"
on public.padron_extra for select
to authenticated
using (true);

drop policy if exists "padron_extra_admin_write" on public.padron_extra;
create policy "padron_extra_admin_write"
on public.padron_extra for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "notificaciones_owner_only" on public.notificaciones;
create policy "notificaciones_owner_only"
on public.notificaciones for all
to authenticated
using (usuario_id = auth.uid() or public.is_admin())
with check (usuario_id = auth.uid() or public.is_admin());

drop policy if exists "sugerencias_owner_or_admin" on public.sugerencias;
create policy "sugerencias_owner_or_admin"
on public.sugerencias for all
to authenticated
using (usuario_id = auth.uid() or public.is_admin())
with check (usuario_id = auth.uid() or public.is_admin());

drop policy if exists "clientes_agenda_owner_or_admin" on public.clientes_agenda;
drop policy if exists "clientes_agenda_all_authenticated" on public.clientes_agenda;
create policy "clientes_agenda_all_authenticated"
on public.clientes_agenda for all
to authenticated
using (true)
with check (true);

-- Recomendacion para empresa_config:
-- 1) No permitir select directo desde anon/authenticated.
-- 2) Guardar hash de clave, no clave plana.
-- 3) Validar por RPC security definer; idealmente sumar rate limit con Edge Function.
-- revoke all on public.empresa_config from anon, authenticated;
