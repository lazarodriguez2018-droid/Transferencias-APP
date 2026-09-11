-- Expone en la consulta publica los datos que deben imprimirse en la etiqueta.
-- El destino explica por que se separo la mercaderia y motivo_comentario
-- conserva las observaciones generales ingresadas al crear la reserva.
create or replace function public.op_reserva_qr_detalle(p_token text)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare r public.op_reservas; items jsonb;
begin
  select * into r from public.op_reservas where qr_token_hash=encode(digest(coalesce(p_token,''),'sha256'),'hex');
  if r.id is null then return jsonb_build_object('ok',false,'error','El QR no es válido o fue reemplazado'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('codigo',i.codigo,'nombre',i.nombre,'cantidad',i.cantidad,'cantidad_local',i.cantidad_local,'cantidad_entregada',i.cantidad_entregada,
    'cantidad_origen',i.cantidad_origen,'cantidad_preparada_origen',least(greatest(0,i.cantidad-i.cantidad_local-i.cantidad_entregada),greatest(i.cantidad_origen,coalesce((select sum(coalesce(pp.cantidad_preparada,0))::integer from public.pedido_productos pp where pp.pedido_id=i.pedido_id and pp.codigo=i.codigo),0))),
    'procedencia',i.procedencia,'proveedor_nombre',i.proveedor_nombre,'pedido_local_gestion',i.pedido_local_gestion,'origen_local',i.origen_local,'estado',i.estado,
    'traslado_tipo',i.traslado_tipo,'traslado_tipo_actual',case when p.reposicion_id is not null then 'reposicion' when nullif(trim(coalesce(p.transporte,'')),'') is not null then coalesce(i.traslado_tipo,'agencia') else i.traslado_tipo end,
    'traslado_actual',coalesce(nullif(p.transporte,''),i.traslado_detalle),'tracking_actual',coalesce(nullif(p.tracking,''),i.tracking),'fecha_estimada',i.fecha_estimada,'remito_numero',coalesce(nullif(p.remito,''),i.remito_numero)) order by i.created_at),'[]') into items
    from public.op_reserva_items i left join public.pedidos p on p.id=i.pedido_id where i.reserva_id=r.id;
  return jsonb_build_object('ok',true,'reservation',jsonb_build_object('number',r.numero,'code',r.codigo,'local',r.local_nombre,'warehouse',r.local_almacen,
    'reason',r.motivo_nombre,'purpose',r.finalidad,'delivery',r.entrega_tipo,'observations',r.motivo_comentario,
    'customer',nullif(trim(concat_ws(' ',r.cliente_nombre,r.cliente_apellido)),''),'phone',r.cliente_telefono,
    'responsible',r.responsable_nombre,'state',r.estado,'created_at',r.created_at,'merchandise_at',r.mercaderia_local_at,'expires_at',r.vencimiento_at,'reference',r.referencia_externa,
    'location',(select ubicacion_reservas from public.op_reserva_config_local where local_nombre=r.local_nombre),'items',items));
end $$;

-- Mantiene para productos agregados al padrón de la base la misma búsqueda por
-- palabras en cualquier orden que usa el conteo de Control de inventario.
create or replace function public.op_reserva_buscar_productos(p_consulta text,p_acceso text default null)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare a jsonb; q text; result jsonb;
begin
  a:=public.op_reserva_actor_creacion(p_acceso);
  q:=lower(unaccent(trim(coalesce(p_consulta,''))));
  if char_length(q)<2 then return '[]'::jsonb; end if;
  with catalogo as (
    select codigo,nombre,coalesce(marca,'') marca,coalesce(barras,'') barras,coalesce(fabricante,'') fabricante,1 prioridad
      from public.productos where nullif(trim(codigo),'') is not null
    union all
    select codigo,nombre,coalesce(marca,'') marca,'' barras,'' fabricante,2 prioridad
      from public.padron_extra where nullif(trim(codigo),'') is not null
  ), unicos as (
    select distinct on (codigo) codigo,nombre,marca,barras,fabricante
      from catalogo order by codigo,prioridad
  ), coincidencias as (
    select c.*,
      case when lower(unaccent(c.codigo))=q or lower(unaccent(c.barras))=q then 0
           when lower(unaccent(c.codigo)) like q||'%' or lower(unaccent(c.barras)) like q||'%' then 1
           else 2 end orden
      from unicos c
     where not exists (
       select 1 from regexp_split_to_table(q,'\s+') palabra
        where lower(unaccent(concat_ws(' ',c.codigo,c.barras,c.nombre,c.marca,c.fabricante))) not like '%'||palabra||'%'
     )
  )
  select coalesce(jsonb_agg(jsonb_build_object('codigo',x.codigo,'nombre',x.nombre,'marca',x.marca,'barras',x.barras,'fabricante',x.fabricante) order by x.orden,x.nombre),'[]')
    into result from (select * from coincidencias order by orden,nombre limit 80) x;
  return result;
end $$;

revoke all on function public.op_reserva_qr_detalle(text) from public;
revoke all on function public.op_reserva_buscar_productos(text,text) from public;
grant execute on function public.op_reserva_qr_detalle(text) to anon,authenticated;
grant execute on function public.op_reserva_buscar_productos(text,text) to anon,authenticated;
