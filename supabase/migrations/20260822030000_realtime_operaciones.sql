-- Sincronización en tiempo real para todos los módulos de Sucaneitor.
-- Es aditiva e idempotente: no modifica datos existentes.

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'catalogo_version',
    'locales',
    'transportes',
    'pedido_productos',
    'op_inventario_sesiones',
    'op_inventario_items',
    'op_inventario_eventos',
    'op_inventario_balances',
    'op_inventario_participantes',
    'op_reposiciones',
    'op_reposicion_items',
    'op_reposicion_extras',
    'op_reposicion_participantes'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I',table_name);
    end if;
  end loop;
end $$;
