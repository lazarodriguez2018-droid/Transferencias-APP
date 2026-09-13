-- Cierre explícito de cantidades parciales y normalización del atajo histórico
-- "cargar cantidad y luego marcar no encontrado".

begin;

-- Evita que una versión anterior escriba otra combinación contradictoria entre
-- el backfill y la instalación del trigger dentro de esta misma migración.
lock table public.op_reposicion_items in share row exclusive mode;

-- Conserva una pista auditable antes de corregir las filas históricas. El remito
-- ya usaba preparado; la normalización alinea el estado y la planilla procesada.
insert into public.op_reposicion_eventos(
  reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle
)
select i.reposicion_id,null,'Normalización automática','estado_normalizado',i.codigo,
  jsonb_build_object(
    'origen','backfill_20260912020000',
    'preparado',i.preparado,
    'solicitado',i.pedido_total,
    'estado_anterior','no_encontrado',
    'estado_nuevo',case when i.preparado<i.pedido_total then 'cerrado_incompleto' else 'cantidad_registrada' end
  )
from public.op_reposicion_items i
where i.no_encontrado and i.preparado>0;

update public.op_reposicion_items
set no_encontrado=false,
    cerrado_incompleto=preparado<pedido_total,
    motivo_codigo=case
      when preparado<pedido_total then coalesce(nullif(trim(motivo_codigo),''),'cantidad_incompleta')
      else null end,
    motivo_label=case
      when preparado<pedido_total then coalesce(nullif(trim(motivo_label),''),'Cantidad incompleta')
      else null end,
    motivo_otro=case when preparado<pedido_total then motivo_otro else null end,
    comentario=case when preparado<pedido_total then comentario else null end,
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null
where no_encontrado and preparado>0;

-- `cerrado_incompleto` era redundante en los no encontrados genuinos (cantidad 0).
update public.op_reposicion_items
set cerrado_incompleto=false
where no_encontrado and preparado=0 and cerrado_incompleto;

-- También corrige cierres antiguos que luego fueron editados a cero, completos o
-- excedidos. En esos estados ya no existe un faltante parcial que cerrar.
update public.op_reposicion_items
set cerrado_incompleto=false,
    motivo_codigo=null,motivo_label=null,motivo_otro=null,comentario=null
where cerrado_incompleto
  and not no_encontrado
  and (preparado<=0 or preparado>=pedido_total);

-- Los clientes que todavía tengan el JavaScript anterior en caché siguen usando
-- el atajo cantidad + "No encontrado". Normalizamos esa escritura dentro de la
-- misma transacción antes de aplicar la restricción, sin depender de la pantalla.
create or replace function public.op_reposicion_normalizar_estado_item()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare
  solicitado integer;
  solicitado_anterior integer;
begin
  -- Los valores de columnas generadas todavía no están disponibles en un
  -- trigger BEFORE; se calcula el mismo total desde sus dos componentes.
  solicitado:=greatest(coalesce(new.pedido_reposicion,0),coalesce(new.pedido_clientes,0));
  solicitado_anterior:=case when tg_op='UPDATE'
    then greatest(coalesce(old.pedido_reposicion,0),coalesce(old.pedido_clientes,0))
    else solicitado end;

  -- Una decisión de faltante sólo cubre la demanda que existía cuando se tomó.
  -- Si entra un pedido urgente y aumenta el total físico, el producto vuelve a
  -- quedar pendiente para que alguien controle las unidades nuevas.
  if tg_op='UPDATE' and solicitado>solicitado_anterior
    and (coalesce(old.no_encontrado,false) or coalesce(old.cerrado_incompleto,false)) then
    new.no_encontrado:=false;
    new.cerrado_incompleto:=false;
    new.motivo_codigo:=null;
    new.motivo_label:=null;
    new.motivo_otro:=null;
    new.comentario:=null;
  end if;
  if new.no_encontrado and new.preparado>0 then
    new.no_encontrado:=false;
    if new.preparado<solicitado then
      new.cerrado_incompleto:=true;
      new.motivo_codigo:=coalesce(nullif(trim(new.motivo_codigo),''),'cantidad_incompleta');
      new.motivo_label:=coalesce(nullif(trim(new.motivo_label),''),'Cantidad incompleta');
    else
      new.cerrado_incompleto:=false;
      new.motivo_codigo:=null;
      new.motivo_label:=null;
      new.motivo_otro:=null;
      new.comentario:=null;
    end if;
  end if;
  if new.cerrado_incompleto and (new.preparado<=0 or new.preparado>=solicitado) then
    new.cerrado_incompleto:=false;
    if not new.no_encontrado then
      new.motivo_codigo:=null;
      new.motivo_label:=null;
      new.motivo_otro:=null;
      new.comentario:=null;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists op_reposicion_normalizar_estado on public.op_reposicion_items;
create trigger op_reposicion_normalizar_estado
before insert or update of preparado,no_encontrado,cerrado_incompleto,pedido_reposicion,pedido_clientes
on public.op_reposicion_items
for each row execute function public.op_reposicion_normalizar_estado_item();

-- Defensa final para llamadas directas: después de normalizar, un producto con
-- unidades físicas nunca puede quedar clasificado como no encontrado.
alter table public.op_reposicion_items
  add constraint op_reposicion_no_encontrado_sin_cantidad
  check (not no_encontrado or preparado=0);

alter table public.op_reposicion_items
  add constraint op_reposicion_cierre_parcial_con_cantidad
  check (not cerrado_incompleto or (preparado>0 and preparado<pedido_total));

create or replace function public.op_reposicion_marcar_colaborativa(
  p_reposicion uuid,p_codigo text,p_campo text,p_valor boolean,
  p_motivo_codigo text default null,p_motivo_label text default null,p_motivo_otro text default null,
  p_comentario text default null,p_usuario_nombre text default 'Usuario',p_cliente text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.op_reposicion_items;
  cliente text:=left(trim(coalesce(p_cliente,'')),100);
  nombre_usuario text:=left(coalesce(nullif(trim(p_usuario_nombre),''),'Usuario'),80);
begin
  if p_campo not in ('no_encontrado','cerrado_incompleto') then raise exception 'Marca inválida'; end if;
  if char_length(cliente)<8 then raise exception 'Identificador de dispositivo inválido'; end if;
  if not exists (
    select 1 from public.op_reposiciones x
    where x.id=p_reposicion and x.estado='preparando'
      and (public.is_ops_supervisor() or x.origen_local=public.my_local())
  ) then raise exception 'Reposición no disponible'; end if;
  perform public.op_reposicion_tocar(p_reposicion,cliente,nombre_usuario);

  select * into r from public.op_reposicion_items
  where reposicion_id=p_reposicion and codigo=trim(coalesce(p_codigo,'')) for update;
  if r.codigo is null then raise exception 'Producto no encontrado'; end if;
  if r.asignado_cliente is not null and r.asignado_cliente<>cliente and exists (
    select 1 from public.op_reposicion_dispositivos d
    where d.reposicion_id=p_reposicion and d.cliente_id=r.asignado_cliente
      and d.last_seen>now()-interval '3 minutes'
  ) then raise exception 'Este producto lo está juntando %',coalesce(r.asignado_nombre,'otra persona'); end if;

  if p_valor and p_campo='no_encontrado' and r.preparado>0 then
    raise exception 'Ya hay % unidad(es) juntada(s). Usá el cierre con envío parcial',r.preparado;
  end if;
  if p_valor and p_campo='cerrado_incompleto'
    and (r.preparado<=0 or r.preparado>=r.pedido_total) then
    raise exception 'El cierre parcial requiere una cantidad mayor a cero y menor a la solicitada';
  end if;

  update public.op_reposicion_items set
    no_encontrado=case
      when p_campo='no_encontrado' then p_valor
      when p_campo='cerrado_incompleto' and p_valor then false
      else no_encontrado end,
    cerrado_incompleto=case
      when p_campo='cerrado_incompleto' then p_valor
      when p_campo='no_encontrado' and p_valor then false
      else cerrado_incompleto end,
    motivo_codigo=nullif(left(trim(coalesce(p_motivo_codigo,'')),80),''),
    motivo_label=nullif(left(trim(coalesce(p_motivo_label,'')),120),''),
    motivo_otro=nullif(left(trim(coalesce(p_motivo_otro,'')),200),''),
    comentario=nullif(left(trim(coalesce(p_comentario,'')),500),''),
    asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,
    updated_by=auth.uid(),updated_by_name=nombre_usuario,updated_at=now()
  where reposicion_id=p_reposicion and codigo=r.codigo returning * into r;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(p_reposicion,auth.uid(),nombre_usuario,p_campo,r.codigo,jsonb_build_object(
    'valor',p_valor,'cantidad',r.preparado,'solicitado',r.pedido_total,
    'motivo_codigo',p_motivo_codigo,'motivo_label',p_motivo_label,
    'motivo_otro',p_motivo_otro,'comentario',p_comentario,'cliente',cliente));
  update public.op_reposiciones set updated_at=now() where id=p_reposicion;
  return to_jsonb(r);
end $$;

revoke all on function public.op_reposicion_marcar_colaborativa(uuid,text,text,boolean,text,text,text,text,text,text) from public,anon;
grant execute on function public.op_reposicion_marcar_colaborativa(uuid,text,text,boolean,text,text,text,text,text,text) to authenticated;

-- El QR no puede invocar la función autenticada. Esta operación dedicada valida
-- invitación, sesión, asignación y cantidad antes de cerrar el producto.
create or replace function public.op_invitado_reposicion_cerrar_incompleto(
  p_acceso text,
  p_codigo text,
  p_detalle jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,extensions,pg_temp
as $$
declare
  g public.op_invitados_sesion;
  invitacion public.op_invitaciones_sesion;
  info jsonb;
  item public.op_reposicion_items;
  detalle_limpio jsonb;
begin
  select guest.* into g
  from public.op_invitados_sesion guest
  where guest.access_hash=encode(digest(coalesce(p_acceso,''),'sha256'),'hex')
    and guest.revoked_at is null
  limit 1;

  if g.id is null or g.modulo<>'reposicion' then
    raise exception 'El acceso no corresponde a Reposición';
  end if;

  select * into invitacion
  from public.op_invitaciones_sesion
  where id=g.invitacion_id and activa and revoked_at is null;
  info:=public.op_sesion_invitada_info(g.modulo,g.sesion_id);
  if invitacion.id is null then raise exception 'La invitación fue pausada'; end if;
  if info is null or not coalesce((info->>'active')::boolean,false) then
    raise exception 'La sesión ya finalizó';
  end if;

  select * into item
  from public.op_reposicion_items
  where reposicion_id=g.sesion_id and codigo=trim(coalesce(p_codigo,''))
  for update;

  if item.codigo is null or item.asignado_cliente is distinct from g.cliente_id then
    raise exception 'Este producto ya no está asignado a tu sesión';
  end if;
  if item.preparado<=0 or item.preparado>=item.pedido_total then
    raise exception 'El cierre parcial requiere una cantidad mayor a cero y menor a la solicitada';
  end if;
  if pg_column_size(coalesce(p_detalle,'{}'::jsonb))>12000 then
    raise exception 'Detalle demasiado extenso';
  end if;

  detalle_limpio:=jsonb_build_object(
    'reason',coalesce(nullif(left(trim(coalesce(p_detalle->>'reason','')),80),''),'cantidad_incompleta'),
    'reason_label',coalesce(nullif(left(trim(coalesce(p_detalle->>'reason_label','')),120),''),'Cantidad incompleta'),
    'comment',nullif(left(trim(coalesce(p_detalle->>'comment','')),500),''),
    'cantidad',item.preparado,
    'solicitado',item.pedido_total,
    'invitado_id',g.id,
    'cliente',g.cliente_id
  );

  update public.op_reposicion_items
  set no_encontrado=false,cerrado_incompleto=true,
      motivo_codigo=detalle_limpio->>'reason',motivo_label=detalle_limpio->>'reason_label',
      motivo_otro=null,comentario=detalle_limpio->>'comment',
      asignado_a=null,asignado_cliente=null,asignado_nombre=null,asignado_at=null,
      updated_by=null,updated_by_name=g.nombre,updated_at=now()
  where reposicion_id=g.sesion_id and codigo=item.codigo;

  insert into public.op_reposicion_eventos(reposicion_id,usuario_id,usuario_nombre,accion,codigo,detalle)
  values(g.sesion_id,null,g.nombre,'invitado_cerrado_incompleto',item.codigo,detalle_limpio);
  update public.op_invitados_sesion set last_seen=now() where id=g.id;
  update public.op_reposiciones set updated_at=now() where id=g.sesion_id;

  return public.op_invitado_estado(p_acceso,false,item.codigo);
end
$$;

revoke all on function public.op_invitado_reposicion_cerrar_incompleto(text,text,jsonb) from public;
grant execute on function public.op_invitado_reposicion_cerrar_incompleto(text,text,jsonb) to anon,authenticated;

commit;
