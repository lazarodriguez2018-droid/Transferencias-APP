-- Control final dirigido de cantidades múltiples.
-- Las lecturas continúan sin interrupciones; al final solamente se revisan los
-- productos con más de una unidad física registrada.

begin;

alter table public.op_reposicion_items
  add column if not exists requiere_verificacion boolean not null default false,
  add column if not exists verificado_at timestamptz,
  add column if not exists verificado_by uuid references public.perfiles(id) on delete set null,
  add column if not exists verificado_by_name text;

alter table public.op_recepcion_items
  add column if not exists requiere_verificacion boolean not null default false,
  add column if not exists verificado_at timestamptz,
  add column if not exists verificado_by uuid references public.perfiles(id) on delete set null,
  add column if not exists verificado_by_name text;

alter table public.op_inventario_items
  add column if not exists requiere_verificacion boolean not null default false,
  add column if not exists verificado_at timestamptz,
  add column if not exists verificado_by uuid references public.perfiles(id) on delete set null,
  add column if not exists verificado_by_name text;

create index if not exists op_repo_items_verificacion_idx
  on public.op_reposicion_items(reposicion_id) where requiere_verificacion;
create index if not exists op_recepcion_items_verificacion_idx
  on public.op_recepcion_items(recepcion_id) where requiere_verificacion;
create index if not exists op_inventario_items_verificacion_idx
  on public.op_inventario_items(sesion_id) where requiere_verificacion;

create or replace function public.op_detectar_cantidad_en_lote()
returns trigger language plpgsql set search_path=public as $$
declare anterior integer; nueva integer;
begin
  if tg_table_name='op_reposicion_items' then
    anterior:=case when tg_op='INSERT' then 0 else old.preparado end; nueva:=new.preparado;
  elsif tg_table_name='op_recepcion_items' then
    anterior:=case when tg_op='INSERT' then 0 else old.recibido end; nueva:=new.recibido;
  else
    anterior:=case when tg_op='INSERT' then 0 else old.cantidad end; nueva:=new.cantidad;
  end if;

  -- Una verificación explícita puede confirmar y, si corresponde, corregir
  -- la cantidad en una sola operación.
  if tg_op='UPDATE' and new.verificado_at is distinct from old.verificado_at then
    return new;
  end if;

  if nueva<=1 then
    new.requiere_verificacion:=false;
    new.verificado_at:=null; new.verificado_by:=null; new.verificado_by_name:=null;
  elsif nueva is distinct from anterior and nueva>1 then
    new.requiere_verificacion:=true;
    new.verificado_at:=null; new.verificado_by:=null; new.verificado_by_name:=null;
  elsif tg_op='UPDATE' then
    new.requiere_verificacion:=old.requiere_verificacion;
    if old.requiere_verificacion then
      new.verificado_at:=old.verificado_at; new.verificado_by:=old.verificado_by; new.verificado_by_name:=old.verificado_by_name;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists op_reposicion_detectar_lote on public.op_reposicion_items;
create trigger op_reposicion_detectar_lote before insert or update of preparado,verificado_at
  on public.op_reposicion_items for each row execute function public.op_detectar_cantidad_en_lote();
drop trigger if exists op_recepcion_detectar_lote on public.op_recepcion_items;
create trigger op_recepcion_detectar_lote before insert or update of recibido,verificado_at
  on public.op_recepcion_items for each row execute function public.op_detectar_cantidad_en_lote();
drop trigger if exists op_inventario_detectar_lote on public.op_inventario_items;
create trigger op_inventario_detectar_lote before insert or update of cantidad,verificado_at
  on public.op_inventario_items for each row execute function public.op_detectar_cantidad_en_lote();

-- Las sesiones que ya estaban abiertas también quedan protegidas.
update public.op_reposicion_items i set requiere_verificacion=true
where i.preparado>1 and exists(select 1 from public.op_reposiciones r where r.id=i.reposicion_id and r.estado='preparando');
update public.op_recepcion_items i set requiere_verificacion=true
where i.recibido>1 and exists(select 1 from public.op_recepciones r where r.id=i.recepcion_id and r.estado='en_control');
update public.op_inventario_items i set requiere_verificacion=true
where i.cantidad>1 and exists(select 1 from public.op_inventario_sesiones s where s.id=i.sesion_id and s.estado='abierta');

create or replace function public.op_verificar_reposicion_cantidad(
  p_reposicion uuid,p_codigo text,p_cantidad integer,p_usuario_nombre text default 'Usuario'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare item public.op_reposicion_items; nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if p_cantidad<0 or p_cantidad>999999 then raise exception 'Cantidad inválida'; end if;
  if not exists(select 1 from public.op_reposiciones r where r.id=p_reposicion and r.estado='preparando' and (public.is_ops_supervisor() or r.origen_local=public.my_local())) then raise exception 'Reposición no disponible'; end if;
  update public.op_reposicion_items set preparado=p_cantidad,requiere_verificacion=false,verificado_at=now(),verificado_by=auth.uid(),verificado_by_name=nombre_usuario,
    no_encontrado=case when p_cantidad>0 then false else no_encontrado end,updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where reposicion_id=p_reposicion and codigo=trim(p_codigo) returning * into item;
  if item.codigo is null then raise exception 'Producto no encontrado'; end if;
  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),nombre_usuario,'cantidad_verificada',item.codigo,jsonb_build_object('cantidad',p_cantidad));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(item);
end $$;

create or replace function public.op_verificar_recepcion_cantidad(
  p_recepcion uuid,p_codigo text,p_cantidad integer,p_usuario_nombre text default 'Usuario'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare item public.op_recepcion_items; nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if p_cantidad<0 or p_cantidad>999999 then raise exception 'Cantidad inválida'; end if;
  if not exists(select 1 from public.op_recepciones r where r.id=p_recepcion and r.estado='en_control' and (public.is_ops_supervisor() or r.destino_local=public.my_local())) then raise exception 'Recepción no disponible'; end if;
  update public.op_recepcion_items set recibido=p_cantidad,requiere_verificacion=false,verificado_at=now(),verificado_by=auth.uid(),verificado_by_name=nombre_usuario,
    no_recibido=case when p_cantidad>0 then false else no_recibido end,updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where recepcion_id=p_recepcion and codigo=trim(p_codigo) returning * into item;
  if item.codigo is null then raise exception 'Producto no encontrado'; end if;
  insert into public.op_recepcion_eventos(recepcion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_recepcion,auth.uid(),nombre_usuario,'cantidad_verificada',item.codigo,jsonb_build_object('cantidad',p_cantidad));
  update public.op_recepciones set updated_at=now() where id=p_recepcion;
  return to_jsonb(item);
end $$;

create or replace function public.op_verificar_inventario_cantidad(
  p_sesion uuid,p_codigo text,p_cantidad integer
) returns jsonb language plpgsql security definer set search_path=public as $$
declare item public.op_inventario_items;
begin
  if p_cantidad<0 or p_cantidad>999999 then raise exception 'Cantidad inválida'; end if;
  if not exists(select 1 from public.op_inventario_sesiones s where s.id=p_sesion and s.estado='abierta' and (public.is_ops_supervisor() or s.local_nombre=public.my_local())) then raise exception 'Inventario no disponible'; end if;
  update public.op_inventario_items set cantidad=p_cantidad,requiere_verificacion=false,verificado_at=now(),verificado_by=auth.uid(),
    verificado_by_name=left(coalesce((select nullif(trim(coalesce(nombre,'')||' '||coalesce(apellido,'')),'') from public.perfiles where id=auth.uid()),'Usuario'),80),updated_by=auth.uid(),updated_at=now()
  where sesion_id=p_sesion and codigo=trim(p_codigo) returning * into item;
  if item.codigo is null then raise exception 'Producto no encontrado'; end if;
  insert into public.op_inventario_eventos(sesion_id,usuario_id,tipo,codigo,nombre,cantidad,detalle)
  values(p_sesion,auth.uid(),'cantidad_verificada',item.codigo,item.nombre,0,jsonb_build_object('cantidad',p_cantidad));
  if item.cantidad=0 then delete from public.op_inventario_items where sesion_id=p_sesion and codigo=item.codigo; end if;
  update public.op_inventario_sesiones set updated_at=now() where id=p_sesion;
  return to_jsonb(item);
end $$;

create or replace function public.op_impedir_cierre_sin_verificacion()
returns trigger language plpgsql security definer set search_path=public as $$
declare pendientes integer:=0;
begin
  if tg_table_name='op_reposiciones' and old.estado='preparando' and new.estado='enviado' then
    select count(*) into pendientes from public.op_reposicion_items where reposicion_id=new.id and requiere_verificacion;
  elsif tg_table_name='op_recepciones' and old.estado='en_control' and new.estado='cerrado' then
    select count(*) into pendientes from public.op_recepcion_items where recepcion_id=new.id and requiere_verificacion;
  end if;
  if pendientes>0 then raise exception 'Falta confirmar la cantidad física de % producto(s) con más de una unidad',pendientes; end if;
  return new;
end $$;

drop trigger if exists op_reposicion_control_cierre on public.op_reposiciones;
create trigger op_reposicion_control_cierre before update of estado on public.op_reposiciones
  for each row execute function public.op_impedir_cierre_sin_verificacion();
drop trigger if exists op_recepcion_control_cierre on public.op_recepciones;
create trigger op_recepcion_control_cierre before update of estado on public.op_recepciones
  for each row execute function public.op_impedir_cierre_sin_verificacion();

grant execute on function public.op_verificar_reposicion_cantidad(uuid,text,integer,text) to authenticated;
grant execute on function public.op_verificar_recepcion_cantidad(uuid,text,integer,text) to authenticated;
grant execute on function public.op_verificar_inventario_cantidad(uuid,text,integer) to authenticated;

commit;
