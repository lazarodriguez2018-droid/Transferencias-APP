-- Read-only, paginated directory. No session is joined or reserved by searching.
begin;
create or replace function public.op_busqueda_normalizar(p_texto text)
returns text language sql immutable parallel safe set search_path=public,pg_temp as $$
 select lower(translate(coalesce(p_texto,''),'ÁÉÍÓÚÜÑÇáéíóúüñç','AEIOUUNCaeiouunc'));
$$;
create or replace function public.op_busqueda_coincide(p_texto text,p_busqueda text)
returns boolean language sql immutable parallel safe set search_path=public,pg_temp as $$
 select not exists(select 1 from regexp_split_to_table(trim(public.op_busqueda_normalizar(p_busqueda)),'\s+') palabra
 where palabra<>'' and strpos(public.op_busqueda_normalizar(p_texto),palabra)=0);
$$;
create or replace function public.op_busqueda_categorias(p_nombre text)
returns text[] language sql immutable parallel safe set search_path=public,pg_temp as $$
 select coalesce(array_agg(id order by id),'{}'::text[]) from (values
 ('humedos','humedo|wet food|sachet|pouch|sobre|lata|pate'),
 ('snacks','snack|treat|premio|masticable|hueso|bone|barrita|barra funcional'),
 ('chapitas','chapita|tag|identificador|medalla'),
 ('higiene','shampoo|champu|conditioner|acondicionador|perfume|higiene|toallita|wipes'),
 ('arenas','arena|litter|sanitario|piedra sanitaria'),
 ('accesorios','accesorio|collar|correa|leash|pretal|harness|juguete|toy|peluche|cama|bed|comedero|bowl|bebedero|transportadora|carrier|rascador|scratcher|bozal|muzzle|ropa'),
 ('farmacia','antiparasitario|pipeta|comprimido|medicamento|spray|collar antipulgas|flea|tick|easotic'),
 ('raciones','racion|alimento|food|adulto|adult|cachorro|puppy|kitten|baby|senior|kg')
 ) categorias(id,patron) where public.op_busqueda_normalizar(p_nombre)~patron;
$$;

-- These private views may only be read through the scoped RPCs below.
create or replace view public.op_busqueda_sesiones_base as
 select 'inventario'::text modulo,id,nombre,local_nombre,almacen,''::text origen,''::text destino,estado,
 created_by,created_at,updated_at,null::date fecha_documento,null::text documento from public.op_inventario_sesiones
 union all select 'reposicion',id,nombre,''::text,''::text,origen_local,destino_local,estado,created_by,created_at,updated_at,null::date,remito from public.op_reposiciones
 union all select 'recepcion',id,nombre,''::text,''::text,origen_local,destino_local,estado,created_by,created_at,updated_at,fecha_remito,numero_remito from public.op_recepciones;

create or replace view public.op_busqueda_personas_base as
 select s.modulo,s.id sesion_id,'user:'||p.id::text persona_id,trim(p.nombre||' '||p.apellido) nombre,false invitado
 from public.op_busqueda_sesiones_base s join public.perfiles p on p.id=s.created_by
 union select 'inventario',t.sesion_id,'user:'||t.usuario_id::text,t.nombre,false from public.op_inventario_participantes t
 union select 'reposicion',t.reposicion_id,'user:'||t.usuario_id::text,t.nombre,false from public.op_reposicion_participantes t
 union select 'recepcion',t.recepcion_id,'user:'||t.usuario_id::text,t.nombre,false from public.op_recepcion_participantes t
 union select 'inventario',t.sesion_id,'user:'||p.id::text,trim(p.nombre||' '||p.apellido),false from public.op_inventario_eventos t join public.perfiles p on p.id=t.usuario_id
 union select 'reposicion',t.reposicion_id,'user:'||p.id::text,trim(p.nombre||' '||p.apellido),false from public.op_reposicion_eventos t join public.perfiles p on p.id=t.usuario_id
 union select 'recepcion',t.recepcion_id,'user:'||p.id::text,trim(p.nombre||' '||p.apellido),false from public.op_recepcion_eventos t join public.perfiles p on p.id=t.usuario_id
 union select modulo,sesion_id,'guest:'||id::text,nombre,true from public.op_invitados_sesion;

create or replace view public.op_busqueda_productos_base as
 with balances as (
   select b.sesion_id,trim(x->>'codigo') codigo,max(x->>'nombre') nombre,
   max(case when coalesce(x->>'stockActual','')~'^-?[0-9]+(\.[0-9]+)?$' then (x->>'stockActual')::numeric end) stock
   from public.op_inventario_balances b cross join lateral jsonb_array_elements(case when jsonb_typeof(b.balance)='array' then b.balance else '[]'::jsonb end) x
   where nullif(trim(x->>'codigo'),'') is not null group by b.sesion_id,trim(x->>'codigo')
 ), lineas as (
   select 'inventario'::text modulo,coalesce(i.sesion_id,b.sesion_id) sesion_id,coalesce(i.codigo,b.codigo) codigo,
     coalesce(i.nombre,b.nombre,coalesce(i.codigo,b.codigo)) nombre,i.barras,''::text marca,
     coalesce(i.cantidad,0)::numeric cantidad,b.stock esperado,b.stock,i.codigo is not null registrado,false extra,false no_encontrado
   from public.op_inventario_items i full join balances b on b.sesion_id=i.sesion_id and b.codigo=i.codigo
   union all select 'reposicion',reposicion_id,codigo,nombre,barras,marca,preparado,pedido_total,
     case when pedido_reposicion>0 then stock_origen else null end,true,false,no_encontrado from public.op_reposicion_items
   union all select 'reposicion',reposicion_id,codigo,nombre,barras,'',cantidad,null,null,true,true,false from public.op_reposicion_extras where cantidad>0
   union all select 'recepcion',recepcion_id,codigo,nombre,barras,marca,recibido,esperado,null,controlado_at is not null,false,no_recibido from public.op_recepcion_items
   union all select 'recepcion',recepcion_id,codigo,nombre,barras,'',cantidad,null,null,true,true,false from public.op_recepcion_extras where cantidad>0
 ) select l.*,coalesce(nullif(p.barras,''),l.barras,'') barras_actuales,
   public.op_busqueda_categorias(coalesce(nullif(p.nombre,''),l.nombre)) categorias,
   concat_ws(' ',l.codigo,l.nombre,l.barras,l.marca,p.nombre,p.barras,p.marca) texto
 from lineas l left join public.productos p on p.codigo=l.codigo;
revoke all on public.op_busqueda_sesiones_base,public.op_busqueda_personas_base,public.op_busqueda_productos_base from public,anon,authenticated;

create or replace function public.op_buscar_sesiones(p_modulo text,p_filtros jsonb default '{}',p_pagina integer default 0,p_limite integer default 24)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare f jsonb:=coalesce(p_filtros,'{}'); resultado jsonb; desde date; hasta date; minimo numeric; maximo numeric;
  pagina integer:=greatest(0,coalesce(p_pagina,0)); limite integer:=least(60,greatest(1,coalesce(p_limite,24)));
  local_usuario text:=public.my_local(); supervisor boolean:=public.is_ops_supervisor();
begin
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved) then raise exception 'Tu cuenta no tiene acceso a las sesiones'; end if;
  if p_modulo not in ('inventario','reposicion','recepcion') or p_modulo is null then raise exception 'Módulo inválido'; end if;
  if jsonb_typeof(f)<>'object' or pg_column_size(f)>12000 then raise exception 'Filtros inválidos'; end if;
  if coalesce(f->>'date_from','')<>'' then desde:=(f->>'date_from')::date; end if;
  if coalesce(f->>'date_to','')<>'' then hasta:=(f->>'date_to')::date; end if;
  if desde>hasta then raise exception 'La fecha inicial debe ser anterior a la final'; end if;
  if coalesce(f->>'stock_min','')<>'' then minimo:=(f->>'stock_min')::numeric; end if;
  if coalesce(f->>'stock_max','')<>'' then maximo:=(f->>'stock_max')::numeric; end if;
  if minimo>maximo then raise exception 'El stock mínimo debe ser menor o igual al máximo'; end if;
  if f ? 'states' and jsonb_typeof(f->'states')<>'array' then raise exception 'Estados inválidos'; end if;
  if f ? 'categories' and jsonb_typeof(f->'categories')<>'array' then raise exception 'Categorías inválidas'; end if;
  if coalesce(f->>'stock','') not in ('','positive','zero','negative','unknown') or coalesce(f->>'quantity','') not in ('','pending','shortage','excess','exact') then raise exception 'Filtro de cantidades inválido'; end if;
  with accesibles as materialized (
    select s.*,concat_ws(' ',s.nombre,s.id,s.documento,s.local_nombre,s.almacen,s.origen,s.destino,
      (select string_agg(l.almacen,' ') from public.locales l where l.nombre in(s.local_nombre,s.origen,s.destino))) texto
    from public.op_busqueda_sesiones_base s where s.modulo=p_modulo and (supervisor or nullif(local_usuario,'') in (s.local_nombre,s.origen,s.destino))
  ), personas as materialized (
    select p.sesion_id,p.persona_id,max(p.nombre) nombre,bool_or(p.invitado) invitado
    from public.op_busqueda_personas_base p join accesibles s on s.id=p.sesion_id and s.modulo=p.modulo group by p.sesion_id,p.persona_id
  ), candidatas as materialized (
    select s.*,coalesce((select string_agg(nombre,' ') from personas p where p.sesion_id=s.id),'') nombres
    from accesibles s where
      (coalesce(f->>'local','')='' or f->>'local' in(s.local_nombre,s.origen,s.destino))
      and (coalesce(f->>'origin','')='' or s.origen=f->>'origin') and (coalesce(f->>'destination','')='' or s.destino=f->>'destination')
      and (coalesce(f->>'user','')='' or exists(select 1 from personas p where p.sesion_id=s.id and (p.persona_id=f->>'user' or (p.invitado and 'guest-name:'||trim(public.op_busqueda_normalizar(p.nombre))=f->>'user'))))
      and (coalesce(jsonb_array_length(f->'states'),0)=0 or s.estado in(select jsonb_array_elements_text(f->'states')))
      and (desde is null or case f->>'date_field' when 'updated' then (s.updated_at at time zone 'America/Montevideo')::date when 'document' then s.fecha_documento else (s.created_at at time zone 'America/Montevideo')::date end>=desde)
      and (hasta is null or case f->>'date_field' when 'updated' then (s.updated_at at time zone 'America/Montevideo')::date when 'document' then s.fecha_documento else (s.created_at at time zone 'America/Montevideo')::date end<=hasta)
  ), lineas as materialized (
    select i.*,public.op_busqueda_coincide(s.texto||' '||s.nombres||' '||i.texto,f->>'query')
      and public.op_busqueda_coincide(i.texto,f->>'product')
      and (coalesce(jsonb_array_length(f->'categories'),0)=0 or i.categorias && array(select jsonb_array_elements_text(f->'categories')) or (f->'categories' ? 'sin_categoria' and cardinality(i.categorias)=0))
      and case coalesce(f->>'stock','') when 'positive' then i.stock>0 when 'zero' then i.stock=0 when 'negative' then i.stock<0 when 'unknown' then i.stock is null else true end
      and (minimo is null or i.stock>=minimo) and (maximo is null or i.stock<=maximo)
      and case coalesce(f->>'quantity','') when 'pending' then not i.extra and (not i.registrado or i.cantidad<i.esperado)
        when 'shortage' then i.registrado and i.cantidad<i.esperado when 'excess' then i.extra or (i.registrado and i.cantidad>i.esperado)
        when 'exact' then i.registrado and not i.extra and i.cantidad=i.esperado else true end coincide
    from public.op_busqueda_productos_base i join candidatas s on s.id=i.sesion_id and s.modulo=i.modulo
  ), coincidencias as materialized (
    select s.* from candidatas s where exists(select 1 from lineas i where i.sesion_id=s.id and i.coincide)
      or (public.op_busqueda_coincide(s.texto||' '||s.nombres,f->>'query') and coalesce(f->>'product','')='' and coalesce(jsonb_array_length(f->'categories'),0)=0
        and coalesce(f->>'stock','')='' and minimo is null and maximo is null and coalesce(f->>'quantity','')='')
  ), pagina_resultados as (
    select s.* from coincidencias s order by
      case when f->>'sort'='oldest' then s.created_at end asc,
      case when f->>'sort'='name' then public.op_busqueda_normalizar(s.nombre) end asc,
      case when f->>'sort'='created' then s.created_at else s.updated_at end desc,s.id
    limit limite offset pagina*limite
  ) select jsonb_build_object('total',(select count(*) from coincidencias),'page',pagina,'page_size',limite,
    'sessions',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'nombre',s.nombre,'module',s.modulo,'local_nombre',s.local_nombre,'almacen',s.almacen,'origin',s.origen,'destination',s.destino,'estado',s.estado,
      'created_at',s.created_at,'updated_at',s.updated_at,'date',s.fecha_documento,'document_number',s.documento,
      'can_edit',case s.modulo when 'inventario' then s.estado='abierta' when 'reposicion' then s.estado='preparando' and (supervisor or local_usuario=s.origen) else s.estado='en_control' and (supervisor or local_usuario=s.destino) end,
      'can_delete',case s.modulo when 'reposicion' then s.estado='preparando' and (supervisor or local_usuario=s.origen) and not exists(select 1 from public.op_reposicion_eventos e where e.reposicion_id=s.id and e.accion='pedido_enviado') when 'recepcion' then s.estado='en_control' and (supervisor or local_usuario=s.destino) else false end,
      'participants',coalesce((select jsonb_agg(jsonb_build_object('id',p.persona_id,'nombre',p.nombre,'guest',p.invitado) order by p.nombre) from personas p where p.sesion_id=s.id),'[]'::jsonb),
      'summary',(select jsonb_build_object('products',count(*) filter(where not i.extra),'quantity',coalesce(sum(i.cantidad),0),'expected',sum(i.esperado),'extras',count(*) filter(where i.extra),
        'pending',count(*) filter(where not i.extra and (not i.registrado or i.cantidad<i.esperado)),'matches',count(*) filter(where i.coincide)) from lineas i where i.sesion_id=s.id),
      'matches',coalesce((select jsonb_agg(to_jsonb(m)-'sesion_id'-'modulo'-'texto'-'coincide') from (select * from lineas i where i.sesion_id=s.id and i.coincide order by i.extra,i.nombre,i.codigo limit 3) m),'[]'::jsonb)
    )) from pagina_resultados s),'[]'::jsonb),
    'facets',case when coalesce((f->>'facets')::boolean,true) then jsonb_build_object(
      'locals',coalesce((select jsonb_agg(local order by local) from (select distinct unnest(array[local_nombre,origen,destino]) local from accesibles) l where local<>''),'[]'::jsonb),
      'users',coalesce((select jsonb_agg(to_jsonb(p) order by p.nombre) from (select case when invitado then 'guest-name:'||trim(public.op_busqueda_normalizar(nombre)) else persona_id end id,max(nombre) nombre,bool_or(invitado) guest from personas group by 1) p),'[]'::jsonb),
      'states',coalesce((select jsonb_agg(estado order by estado) from (select distinct estado from accesibles) e),'[]'::jsonb)) else null end
  ) into resultado;
  return resultado;
end $$;
revoke all on function public.op_buscar_sesiones(text,jsonb,integer,integer) from public,anon;
grant execute on function public.op_buscar_sesiones(text,jsonb,integer,integer) to authenticated;

create or replace function public.op_consultar_productos_sesion(p_modulo text,p_sesion uuid,p_busqueda text default '',p_pagina integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s record; resultado jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.perfiles where id=auth.uid() and approved) then raise exception 'Acceso no autorizado'; end if;
  select * into s from public.op_busqueda_sesiones_base where modulo=p_modulo and id=p_sesion;
  if s.id is null or not coalesce(public.is_ops_supervisor() or nullif(public.my_local(),'') in(s.local_nombre,s.origen,s.destino),false) then raise exception 'No tenés acceso a esta sesión'; end if;
  with filtrados as materialized (
    select * from public.op_busqueda_productos_base where modulo=p_modulo and sesion_id=p_sesion and public.op_busqueda_coincide(texto,left(p_busqueda,200))
  ) select jsonb_build_object('total',(select count(*) from filtrados),'products',coalesce((select jsonb_agg(to_jsonb(p)-'texto'-'sesion_id'-'modulo') from (
    select * from filtrados order by extra,nombre,codigo limit 40 offset greatest(0,coalesce(p_pagina,0))*40) p),'[]'::jsonb)) into resultado;
  return resultado;
end $$;
revoke all on function public.op_consultar_productos_sesion(text,uuid,text,integer) from public,anon;
grant execute on function public.op_consultar_productos_sesion(text,uuid,text,integer) to authenticated;
create index if not exists op_inv_session_date_idx on public.op_inventario_sesiones(created_at,id);
create index if not exists op_repo_session_date_idx on public.op_reposiciones(created_at,id);
create index if not exists op_rec_session_date_idx on public.op_recepciones(created_at,id);
commit;
