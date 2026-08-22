-- Crea el perfil pendiente al registrarse mediante el enlace de Supabase.
-- Evita depender de un código OTP o de una sesión previa a la confirmación.

create or replace function public.crear_perfil_sucaneitor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_nombre text;
  v_apellido text;
  v_tipo text;
  v_local text;
  v_almacen text;
  v_role text;
begin
  -- No intervenir en usuarios creados por otras integraciones.
  if not (meta ? 'sucaneitor_nombre') then
    return new;
  end if;

  v_nombre := left(trim(coalesce(meta->>'sucaneitor_nombre','')), 80);
  v_apellido := left(trim(coalesce(meta->>'sucaneitor_apellido','')), 80);
  v_tipo := lower(trim(coalesce(meta->>'sucaneitor_tipo_cuenta','local')));

  if v_nombre = '' or v_apellido = '' then
    return new;
  end if;

  if v_tipo = 'personal' then
    v_local := 'General';
    v_almacen := 'SUP';
    v_role := 'admin';
  else
    select l.nombre, l.almacen
      into v_local, v_almacen
    from public.locales l
    where l.nombre = trim(coalesce(meta->>'sucaneitor_local_nombre',''))
      and l.almacen = trim(coalesce(meta->>'sucaneitor_almacen',''))
    limit 1;

    if v_local is null then
      return new;
    end if;
    v_role := 'empleado';
  end if;

  insert into public.perfiles(id,nombre,apellido,local_nombre,almacen,role,approved)
  values(new.id,v_nombre,v_apellido,v_local,v_almacen,v_role,false)
  on conflict (id) do nothing;

  return new;
end
$$;

drop trigger if exists crear_perfil_sucaneitor_al_registrarse on auth.users;
create trigger crear_perfil_sucaneitor_al_registrarse
after insert on auth.users
for each row execute function public.crear_perfil_sucaneitor();
