-- Evita que una planilla con encabezado no reconocido elimine silenciosamente
-- todos los códigos de barras del padrón compartido.
create or replace function public.reemplazar_padron_productos(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  total integer;
  total_barras integer;
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

  select count(*), count(*) filter (where barras is not null)
  into total, total_barras
  from nuevo_padron;
  if total = 0 then raise exception 'El padron no contiene productos validos'; end if;
  if total_barras = 0 then
    raise exception 'El padron no contiene codigos de barras; no se modifico el catalogo anterior';
  end if;

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

revoke all on function public.reemplazar_padron_productos(jsonb) from public;
grant execute on function public.reemplazar_padron_productos(jsonb) to authenticated;
