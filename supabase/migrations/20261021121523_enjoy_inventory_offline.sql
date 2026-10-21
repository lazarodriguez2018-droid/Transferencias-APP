-- Enjoy uses the existing Auth identities, with independent company memberships.
-- Private data is never exposed through direct table grants or a blind download.
create schema if not exists enjoy_private;
revoke all on schema enjoy_private from public,anon;
grant usage on schema enjoy_private to authenticated;

create table enjoy_private.members (
 user_id uuid primary key references auth.users(id), name text not null,
 role text not null default 'contador' check(role in ('contador','responsable','auditor','supervisor','finanzas')),
 approved boolean not null default false, can_manage boolean not null default false,
 warehouses text[] not null default '{}', created_at timestamptz not null default now()
);
create table enjoy_private.inventories (
 id uuid primary key default gen_random_uuid(), data jsonb not null,
 reference jsonb not null default '{}', approvals jsonb not null default '{}',
 documents jsonb not null default '[]', report jsonb, adjustments jsonb not null default '[]',
 submissions jsonb not null default '{}', closed_at timestamptz,
 join_token uuid not null default gen_random_uuid() unique, join_enabled boolean not null default false,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), version bigint not null default 1
);
create index enjoy_inventory_warehouse_idx on enjoy_private.inventories ((data->>'warehouse'),updated_at desc);
create table enjoy_private.counts (
 inventory_id uuid not null references enjoy_private.inventories(id), user_id uuid not null references auth.users(id),
 actor text not null check(actor in ('contador','responsable','auditor','supervisor')), item_id text not null,
 quantity numeric(20,6) not null check(quantity>=0), version bigint not null default 1,
 updated_at timestamptz not null default now(), primary key(inventory_id,user_id,actor,item_id)
);
create table enjoy_private.events (
 id uuid primary key, inventory_id uuid not null references enjoy_private.inventories(id),
 user_id uuid not null references auth.users(id), actor text not null, device_id text not null,
 client_sequence bigint not null, occurred_at timestamptz not null, received_at timestamptz not null default now(),
 action text not null, item_id text, before_quantity numeric, after_quantity numeric, payload jsonb not null
);
create index enjoy_events_inventory_idx on enjoy_private.events(inventory_id,received_at desc);
create index enjoy_events_device_idx on enjoy_private.events(inventory_id,user_id,device_id,client_sequence);
create table enjoy_private.management_log (
 id bigint generated always as identity primary key, inventory_id uuid references enjoy_private.inventories(id),
 user_id uuid not null references auth.users(id), action text not null, detail jsonb not null default '{}',
 received_at timestamptz not null default now()
);
alter table enjoy_private.members enable row level security;
alter table enjoy_private.inventories enable row level security;
alter table enjoy_private.counts enable row level security;
alter table enjoy_private.events enable row level security;
alter table enjoy_private.management_log enable row level security;
revoke all on all tables in schema enjoy_private from public,anon,authenticated;
revoke all on all sequences in schema enjoy_private from public,anon,authenticated;

create function enjoy_private.is_manager(p_warehouse text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from enjoy_private.members m where m.user_id=auth.uid() and m.approved
 and (m.role='finanzas' or ((m.role='supervisor' or m.can_manage) and p_warehouse=any(m.warehouses))))
$$;
create function enjoy_private.has_inventory(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from enjoy_private.inventories i join enjoy_private.members m on m.user_id=auth.uid() and m.approved
 where i.id=p_id and (enjoy_private.is_manager(i.data->>'warehouse') or exists(
 select 1 from jsonb_array_elements(i.data->'assignments') a where a->>'user_id'=auth.uid()::text
 and coalesce(i.data->>'status','draft')<>'draft' and (i.data->>'scheduled_date')::date <= (now() at time zone 'America/Montevideo')::date)))
$$;
create function enjoy_private.snapshot(p_id uuid,p_pending jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare i enjoy_private.inventories; manager boolean; see_stock boolean; ct jsonb; inv jsonb;
begin
 if auth.uid() is null or not enjoy_private.has_inventory(p_id) then raise exception 'Inventario no autorizado'; end if;
 select * into i from enjoy_private.inventories where id=p_id;
 manager:=enjoy_private.is_manager(i.data->>'warehouse');
 select manager or exists(select 1 from jsonb_array_elements(i.data->'assignments') a
 where a->>'user_id'=auth.uid()::text and (a->>'see_stock')::boolean) into see_stock;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into ct from enjoy_private.counts c
 where c.inventory_id=p_id and (manager or c.user_id=auth.uid());
 inv:=i.data||jsonb_build_object('id',i.id,'version',i.version,'closed_at',i.closed_at,'updated_at',i.updated_at);
 inv:=jsonb_set(inv,'{assignments}',(select coalesce(jsonb_agg(a||jsonb_build_object('name',me.name)),'[]') from jsonb_array_elements(inv->'assignments') a join enjoy_private.members me on me.user_id=(a->>'user_id')::uuid));
 if not manager then inv:=inv-'management_notes'; end if;
 return jsonb_build_object('inventory',inv,'reference',case when see_stock then i.reference else '{}'::jsonb end,
 'counts',ct,'manager',manager,'see_stock',see_stock,'started',exists(select 1 from enjoy_private.events ev where ev.inventory_id=p_id),
 'invitation',case when manager then jsonb_build_object('enabled',i.join_enabled,'token',i.join_token) else null end,
 'approvals',case when manager then i.approvals else '{}'::jsonb end,
 'documents',case when manager then i.documents else '[]'::jsonb end,
 'report',case when manager then i.report else null end,
 'adjustments',case when manager then i.adjustments else '[]'::jsonb end,
 'submissions',i.submissions,'receipts',(select coalesce(jsonb_agg(ev.id::text),'[]') from enjoy_private.events ev where ev.inventory_id=p_id and ev.user_id=auth.uid() and ev.id::text in(select jsonb_array_elements_text(p_pending))));
end $$;

create function enjoy_private.dispatch(p_action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid(); m enjoy_private.members; i enjoy_private.inventories; inv_id uuid;
 d jsonb; v_assignment jsonb; e jsonb; old_event enjoy_private.events; c enjoy_private.counts;
 item text; v_actor text; val numeric; new_qty numeric; ismgr boolean; out jsonb; title text; expected bigint;
begin
 if uid is null then raise exception 'Iniciá sesión'; end if;
 select * into m from enjoy_private.members where user_id=uid;
 if p_action='request_access' then
  insert into enjoy_private.members(user_id,name) values(uid,left(trim(coalesce(p->>'name','Usuario')),150)) on conflict do nothing;
  select * into m from enjoy_private.members where user_id=uid;
  return to_jsonb(m);
 end if;
 if p_action='profile' then return coalesce(to_jsonb(m),'null'::jsonb); end if;
 if m.user_id is null or not m.approved then raise exception 'Tu acceso a Enjoy está pendiente de aprobación'; end if;
 if p_action='join' then
  if coalesce(p->>'token','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'El enlace no está disponible. Solicitá uno vigente al encargado'; end if;
  select * into i from enjoy_private.inventories where join_token=(p->>'token')::uuid for update;
  if not found or not i.join_enabled or i.closed_at is not null or i.data->>'status'='draft' then raise exception 'El enlace no está disponible. Solicitá uno vigente al encargado'; end if;
  if not (i.data->>'warehouse'=any(m.warehouses) or m.role='finanzas') then raise exception 'Finanzas debe habilitarte este almacén'; end if;
  if (i.data->>'scheduled_date')::date>(now() at time zone 'America/Montevideo')::date then raise exception 'El inventario estará disponible el %',i.data->>'scheduled_date'; end if;
  if p->>'confirm'='true' then
   if not exists(select 1 from jsonb_array_elements(i.data->'assignments') a where a->>'user_id'=uid::text) then
    update enjoy_private.inventories set data=jsonb_set(data,'{assignments}',data->'assignments'||jsonb_build_array(jsonb_build_object('user_id',uid,'actor','contador','see_stock',false,'counts_enabled',true,'absent',false))),version=version+1,updated_at=now() where id=i.id;
    insert into enjoy_private.management_log(inventory_id,user_id,action,detail) values(i.id,uid,'join',jsonb_build_object('method','link','actor','contador'));
   end if;
   return enjoy_private.snapshot(i.id);
  end if;
  return jsonb_build_object('id',i.id,'title',i.data->>'title','warehouse',i.data->>'warehouse','scheduled_date',i.data->>'scheduled_date');
 end if;
 if p_action='members' then
  select coalesce(jsonb_agg(to_jsonb(v)),'[]') into out from (
   select user_id,name,role,approved,can_manage,warehouses from enjoy_private.members x
   where (m.role='finanzas' or (x.approved and (m.role='supervisor' or m.can_manage) and x.warehouses && m.warehouses) or x.user_id=uid)
   order by name) v; return out;
 end if;
 if p_action='save_member' then
  if m.role<>'finanzas' then raise exception 'Solo Finanzas administra permisos'; end if;
  if (p->>'user_id')::uuid=uid and (not (p->>'approved')::boolean or p->>'role'<>'finanzas') then raise exception 'No podés quitar tu propio acceso de Finanzas'; end if;
  update enjoy_private.members set role=p->>'role',approved=(p->>'approved')::boolean,
   can_manage=coalesce((p->>'can_manage')::boolean,false),warehouses=array(select jsonb_array_elements_text(p->'warehouses'))
   where user_id=(p->>'user_id')::uuid;
  insert into enjoy_private.management_log(user_id,action,detail) values(uid,p_action,p);
  return jsonb_build_object('ok',true);
 end if;
 if p_action='list' then
  select coalesce(jsonb_agg(v order by v->>'scheduled_date' desc),'[]') into out from (
   select jsonb_build_object('id',x.id,'title',x.data->>'title','warehouse',x.data->>'warehouse','scheduled_date',x.data->>'scheduled_date',
   'status',x.data->>'status','procedure',x.data->>'procedure','assigned_to_me',exists(select 1 from jsonb_array_elements(x.data->'assignments') ass where ass->>'user_id'=uid::text),'updated_at',x.updated_at,'closed_at',x.closed_at) v
   from enjoy_private.inventories x where enjoy_private.has_inventory(x.id)) t;
  return out;
 end if;
 if p_action='save_inventory' then
  d:=p->'inventory';
  if coalesce(jsonb_typeof(d->'items'),'')<>'array' or coalesce(jsonb_typeof(d->'assignments'),'')<>'array' or length(trim(coalesce(d->>'title','')))=0
  or coalesce(d->>'warehouse','') !~ '^AL[0-9A-Z]{2,8}$' or coalesce(d->>'procedure','') not in ('principal','otro')
  or coalesce(d->>'status','') not in ('draft','scheduled','ready') then raise exception 'Configuración de inventario inválida'; end if;
  if not enjoy_private.is_manager(d->>'warehouse') then raise exception 'No tenés permiso para este almacén'; end if;
  if nullif(d->>'scheduled_date','') is null or jsonb_typeof(p->'reference') is distinct from 'object' then raise exception 'Falta fecha o referencia'; end if;
  perform (d->>'scheduled_date')::date;
  for v_assignment in select value from jsonb_array_elements(d->'assignments') loop
   if coalesce(v_assignment->>'actor','') not in ('contador','responsable','auditor','supervisor') or not exists(select 1 from enjoy_private.members x where x.user_id=(v_assignment->>'user_id')::uuid and x.approved and (d->>'warehouse'=any(x.warehouses) or x.role='finanzas')) then raise exception 'Participante no autorizado para el almacén'; end if;
  end loop;
  if jsonb_array_length(d->'assignments')<>(select count(distinct a->>'user_id') from jsonb_array_elements(d->'assignments') a) then raise exception 'Participante duplicado. Cada persona tiene un único conteo'; end if;
  d:=jsonb_set(d,'{assignments}',(select coalesce(jsonb_agg(jsonb_build_object('user_id',a->>'user_id','actor',a->>'actor','see_stock',coalesce((a->>'see_stock')::boolean,false),'counts_enabled',not coalesce((a->>'absent')::boolean,false) and coalesce((a->>'counts_enabled')::boolean,true),'absent',coalesce((a->>'absent')::boolean,false))),'[]') from jsonb_array_elements(d->'assignments') a));
  for v_assignment in select value from jsonb_array_elements(d->'items') loop
   if jsonb_typeof(v_assignment) is distinct from 'object' or v_assignment ? 'stock' or v_assignment ? 'value' or v_assignment ? 'reference' or v_assignment->>'warehouse'<>d->>'warehouse' or coalesce(v_assignment->>'id','')='' then raise exception 'La mercadería contiene datos inválidos'; end if;
  end loop;
  if jsonb_array_length(d->'items')<>(select count(distinct z->>'id') from jsonb_array_elements(d->'items') z) then raise exception 'Material o lote duplicado'; end if;
  if d->>'status'='ready' and (jsonb_array_length(d->'items')=0 or coalesce((d->>'sap_blocked')::boolean,false)=false and d->>'procedure'='principal'
   or d->>'procedure'='principal' and (coalesce(d->>'mb52_date','')<>d->>'scheduled_date')) then raise exception 'Falta MB52 del día, mercadería o confirmación del bloqueo SAP'; end if;
  if nullif(d->>'id','') is not null then
   inv_id:=(d->>'id')::uuid;select * into i from enjoy_private.inventories where id=inv_id for update;
   if not found or not enjoy_private.is_manager(i.data->>'warehouse') or i.closed_at is not null then raise exception 'Inventario no editable'; end if;
   if i.version<>coalesce((p->>'version')::bigint,0) then raise exception 'El inventario cambió. Actualizá antes de guardar'; end if;
   if exists(select 1 from enjoy_private.events where inventory_id=inv_id) and (d->'items' is distinct from i.data->'items' or p->'reference' is distinct from i.reference or d->>'warehouse'<>i.data->>'warehouse' or d->>'scheduled_date'<>i.data->>'scheduled_date') then raise exception 'La base queda protegida al comenzar el conteo'; end if;
   if exists(select 1 from enjoy_private.events ev where ev.inventory_id=inv_id and not exists(select 1 from jsonb_array_elements(d->'assignments') a where a->>'user_id'=ev.user_id::text and a->>'actor'=ev.actor)) then raise exception 'Conservá la persona y función que tienen actividad. Podés marcarla ausente o sin conteo'; end if;
   if d->'assignments' is distinct from i.data->'assignments' then
    if exists(select 1 from enjoy_private.events where inventory_id=inv_id) and length(trim(coalesce(p->>'participant_change_reason','')))<3 then raise exception 'Indicá el motivo del cambio de participantes'; end if;
    update enjoy_private.inventories set approvals='{}',report=null where id=inv_id;
    insert into enjoy_private.management_log(inventory_id,user_id,action,detail) values(inv_id,uid,'participants',jsonb_build_object('before',i.data->'assignments','after',d->'assignments','reason',p->>'participant_change_reason'));
   end if;
   update enjoy_private.inventories set data=d-'id'-'version'-'closed_at'-'updated_at',reference=p->'reference',version=version+1,updated_at=now() where id=inv_id;
  else
   insert into enjoy_private.inventories(data,reference,created_by) values(d-'id'-'version',coalesce(p->'reference','{}'),uid) returning id into inv_id;
  end if;
  insert into enjoy_private.management_log(inventory_id,user_id,action,detail) values(inv_id,uid,p_action,jsonb_build_object('title',d->>'title','status',d->>'status'));
  return enjoy_private.snapshot(inv_id);
 end if;
 inv_id:=(p->>'inventory_id')::uuid;
 if not enjoy_private.has_inventory(inv_id) then raise exception 'Inventario no autorizado'; end if;
 select * into i from enjoy_private.inventories where id=inv_id for update;
 ismgr:=enjoy_private.is_manager(i.data->>'warehouse');
 if p_action='open' then return enjoy_private.snapshot(inv_id,coalesce(p->'pending_ids','[]')); end if;
 if p_action='activity' then
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc),'[]') into out from (
   select ev.*,me.name from enjoy_private.events ev join enjoy_private.members me on me.user_id=ev.user_id
   where ev.inventory_id=inv_id and (ismgr or ev.user_id=uid) order by ev.received_at desc limit 1000) x;
  return out;
 end if;
 if p_action='discard_event' then
  e:=p->'event';
  if not exists(select 1 from jsonb_array_elements(i.data->'assignments') z where z->>'user_id'=uid::text and z->>'actor'=e->>'actor') then raise exception 'Función no autorizada'; end if;
  if length(trim(coalesce(p->>'reason','')))<3 then raise exception 'Indicá el motivo del descarte'; end if;
  if exists(select 1 from enjoy_private.events where id=(e->>'id')::uuid) then raise exception 'El movimiento ya fue recibido. Sincronizá para verificarlo'; end if;
  insert into enjoy_private.events(id,inventory_id,user_id,actor,device_id,client_sequence,occurred_at,action,payload)
  values((e->>'id')::uuid,inv_id,uid,e->>'actor',e->>'device_id',(e->>'sequence')::bigint,(e->>'occurred_at')::timestamptz,'discarded',jsonb_build_object('original',e,'reason',p->>'reason'));
  return jsonb_build_object('ok',true);
 end if;
 if p_action='event' then
  e:=p->'event';v_actor:=e->>'actor';item:=e->>'item_id';
  if not exists(select 1 from jsonb_array_elements(i.data->'assignments') a where a->>'user_id'=uid::text and a->>'actor'=v_actor)
   then raise exception 'No estás asignado a esta función'; end if;
  select * into old_event from enjoy_private.events where id=(e->>'id')::uuid;
  if found then
   if old_event.user_id<>uid or old_event.inventory_id<>inv_id or old_event.payload<>e then raise exception 'Identificador de movimiento reutilizado'; end if;
   return jsonb_build_object('ok',true,'duplicate',true);
  end if;
  if not exists(select 1 from jsonb_array_elements(i.data->'assignments') a where a->>'user_id'=uid::text and a->>'actor'=v_actor and coalesce((a->>'counts_enabled')::boolean,true) and not coalesce((a->>'absent')::boolean,false)) then raise exception 'Tu participación no incluye conteo. El encargado puede habilitarlo'; end if;
  if i.closed_at is not null or i.data->>'status'<>'ready' then raise exception 'El inventario no admite movimientos. Se conserva tu carga para revisión'; end if;
  if (i.data->>'scheduled_date')::date<>(now() at time zone 'America/Montevideo')::date and not coalesce((i.data->>'allow_late_sync')::boolean,false) then raise exception 'La fecha del inventario requiere revisión del supervisor para recibir cargas tardías'; end if;
  if coalesce((i.submissions->(uid::text||':'||v_actor)->>'submitted')::boolean,false) then raise exception 'Conteo entregado. Solicitá su reapertura'; end if;
  if nullif(e->>'device_id','') is null or (e->>'sequence')::bigint<1 then raise exception 'Dispositivo o secuencia inválidos'; end if;
  if exists(select 1 from enjoy_private.events x where x.inventory_id=inv_id and x.user_id=uid and x.device_id=e->>'device_id' and x.client_sequence>=(e->>'sequence')::bigint) then raise exception 'Secuencia fuera de orden'; end if;
  if e->>'action' in ('add','subtract','set') then
   if not exists(select 1 from jsonb_array_elements(i.data->'items') x where x->>'id'=item) then raise exception 'Material o lote no pertenece al inventario'; end if;
   val:=(e->>'value')::numeric;if val is null or val<0 or val>1000000000 or val<>round(val,6) then raise exception 'Cantidad inválida'; end if;
   select * into c from enjoy_private.counts where inventory_id=inv_id and user_id=uid and counts.actor=v_actor and item_id=item;
   if e->>'action'='set' and coalesce(c.version,0)<>coalesce((e->>'base_version')::bigint,0) then raise exception 'CONFLICTO: el total cambió en otro dispositivo. Revisá la corrección'; end if;
   new_qty:=case e->>'action' when 'add' then coalesce(c.quantity,0)+val when 'subtract' then coalesce(c.quantity,0)-val else val end;
   if new_qty>1000000000 then raise exception 'El total excede el límite de cantidad'; end if;
   if new_qty<0 then raise exception 'El total no puede ser negativo'; end if;
   insert into enjoy_private.counts(inventory_id,user_id,actor,item_id,quantity) values(inv_id,uid,v_actor,item,new_qty)
   on conflict(inventory_id,user_id,actor,item_id) do update set quantity=excluded.quantity,version=counts.version+1,updated_at=now();
  elsif e->>'action' not in ('start','pause','resume','gps','finish') then raise exception 'Acción inválida';
  end if;
  insert into enjoy_private.events(id,inventory_id,user_id,actor,device_id,client_sequence,occurred_at,action,item_id,before_quantity,after_quantity,payload)
   values((e->>'id')::uuid,inv_id,uid,v_actor,e->>'device_id',(e->>'sequence')::bigint,(e->>'occurred_at')::timestamptz,e->>'action',item,c.quantity,new_qty,e);
  if e->>'action'='finish' then
   if not exists(select 1 from enjoy_private.counts x where x.inventory_id=inv_id and x.user_id=uid and x.actor=v_actor) then raise exception 'Registrá al menos un producto o solicitá participar sin conteo'; end if;
   update enjoy_private.inventories set submissions=jsonb_set(submissions,array[uid::text||':'||v_actor],jsonb_build_object('submitted',true,'at',now()),true) where id=inv_id;
  end if;
  update enjoy_private.inventories set updated_at=now() where id=inv_id;
  return jsonb_build_object('ok',true,'quantity',new_qty);
 end if;
 if not ismgr then raise exception 'Esta acción requiere permisos de gestión'; end if;
 if i.closed_at is not null and p_action not in ('adjustments','document') then raise exception 'Inventario cerrado'; end if;
 if p_action='invitation' then
  if coalesce((p->>'enabled')::boolean,false) and (i.approvals<>'{}'::jsonb or i.report is not null) then raise exception 'La revisión de cantidades ya comenzó. Revisá los participantes antes de habilitar nuevos ingresos'; end if;
  update enjoy_private.inventories set join_enabled=coalesce((p->>'enabled')::boolean,false),join_token=case when coalesce((p->>'rotate')::boolean,false) then gen_random_uuid() else join_token end where id=inv_id;
 elsif p_action in ('approve','approve_many') then
  for d in select value from jsonb_array_elements(case when p_action='approve_many' then p->'approvals' else jsonb_build_array(p) end) loop
  item:=d->>'item_id';val:=(d->>'quantity')::numeric;
  if val is null or val<0 or val>1000000000 or val<>round(val,6) or not exists(select 1 from jsonb_array_elements(i.data->'items') x where x->>'id'=item) then raise exception 'Cantidad o material inválido'; end if;
  if not exists(select 1 from enjoy_private.counts ct where ct.inventory_id=inv_id) then raise exception 'Faltan conteos'; end if;
  if exists(select 1 from jsonb_array_elements(i.data->'assignments') z where coalesce((z->>'counts_enabled')::boolean,true) and not coalesce((z->>'absent')::boolean,false) and not coalesce((i.submissions->((z->>'user_id')||':'||(z->>'actor'))->>'submitted')::boolean,false)) then raise exception 'Primero deben entregarse los conteos de quienes cuentan'; end if;
  if length(trim(coalesce(d->>'comment','')))=0 then raise exception 'Indicá el criterio de autorización'; end if;
  update enjoy_private.inventories set join_enabled=false,approvals=jsonb_set(approvals,array[item],jsonb_build_object('quantity',val,'reason',d->>'reason','comment',d->>'comment','user_id',uid,'at',now()),true),updated_at=now() where id=inv_id;
  end loop;
 elsif p_action='document' then
  d:=p->'document';if d->>'kind' not in ('csv','csv_2','mb52','reporte','acta','ajustes','consolidado','evidencia') then raise exception 'Tipo de archivo inválido'; end if;
  if i.closed_at is not null and d->>'kind' not in ('acta','ajustes','evidencia','consolidado') then raise exception 'El cierre conserva los documentos SAP originales'; end if;
  if d->>'kind'='reporte' then
   if not (p->'report'->'warehouses' @> jsonb_build_array(i.data->>'warehouse')) then raise exception 'Reporte de otro almacén'; end if;
   if not exists(select 1 from jsonb_array_elements(i.documents) x, jsonb_array_elements_text(x->'documents') doc where exists(select 1 from jsonb_array_elements_text(p->'report'->'documents') rd where ltrim(rd,'0')=ltrim(doc,'0'))) then raise exception 'El documento del Reporte no coincide con los CSV vinculados'; end if;
   update enjoy_private.inventories set report=p->'report' where id=inv_id;
  end if;
  update enjoy_private.inventories set documents=documents||jsonb_build_array(d||jsonb_build_object('at',now(),'user_id',uid)),updated_at=now() where id=inv_id;
 elsif p_action='adjustments' then
  if jsonb_typeof(p->'adjustments') is distinct from 'array' or jsonb_array_length(p->'adjustments')<jsonb_array_length(i.adjustments) or exists(select 1 from jsonb_array_elements(i.adjustments) with ordinality x(v,n) where x.v is distinct from (p->'adjustments')->(x.n::int-1)) then raise exception 'Los ajustes se agregan sin alterar el historial'; end if;
  update enjoy_private.inventories set adjustments=p->'adjustments',updated_at=now() where id=inv_id;
 elsif p_action='reopen' then
  update enjoy_private.inventories set approvals='{}',report=null,submissions=submissions-(p->>'assignment'),updated_at=now() where id=inv_id;
 elsif p_action='late_sync' then
  update enjoy_private.inventories set data=jsonb_set(data,'{allow_late_sync}',to_jsonb((p->>'enabled')::boolean)),updated_at=now(),version=version+1 where id=inv_id;
 elsif p_action='close' then
  if (select count(*) from jsonb_object_keys(i.approvals))<>jsonb_array_length(i.data->'items') then raise exception 'Faltan cantidades autorizadas'; end if;
  for v_assignment in select value from jsonb_array_elements(i.data->'assignments') loop
   if coalesce((v_assignment->>'counts_enabled')::boolean,true) and not coalesce((v_assignment->>'absent')::boolean,false) and not coalesce((i.submissions->((v_assignment->>'user_id')||':'||(v_assignment->>'actor'))->>'submitted')::boolean,false) then raise exception 'Faltan conteos entregados'; end if;
  end loop;
  if i.data->>'procedure'='principal' and i.report is null then raise exception 'Falta incorporar el Reporte SAP'; end if;
  if not coalesce((p->>'confirmed')::boolean,false) then raise exception 'Confirmá la revisión final'; end if;
  update enjoy_private.inventories set join_enabled=false,closed_at=now(),data=jsonb_set(data,'{status}','"closed"'),updated_at=now(),version=version+1 where id=inv_id;
 else raise exception 'Acción desconocida'; end if;
 insert into enjoy_private.management_log(inventory_id,user_id,action,detail) values(inv_id,uid,p_action,p-'document'-'report');
 return enjoy_private.snapshot(inv_id);
end $$;
-- Only the checked dispatcher is granted. Table owners execute internal helpers.
revoke all on all functions in schema enjoy_private from public,anon,authenticated;
grant execute on function enjoy_private.dispatch(text,jsonb) to authenticated;
create function public.enjoy_api(p_action text,p_payload jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select enjoy_private.dispatch(p_action,p_payload)$$;
revoke all on function public.enjoy_api(text,jsonb) from public,anon;
grant execute on function public.enjoy_api(text,jsonb) to authenticated;

-- Enjoy registration never grants a role supplied in editable auth metadata.
create function enjoy_private.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.raw_user_meta_data->>'company'='ENJOY' then
  insert into enjoy_private.members(user_id,name) values(new.id,left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Usuario'),150)) on conflict do nothing;
 end if;return new;
end $$;
revoke all on function enjoy_private.on_signup() from public,anon,authenticated;
create trigger enjoy_member_on_signup after insert on auth.users for each row execute function enjoy_private.on_signup();

-- Restrict Enjoy-only accounts from legacy SUCAN tables; existing SUCAN identities retain their access.
create function enjoy_private.legacy_allowed() returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from enjoy_private.members where user_id=auth.uid()) or exists(select 1 from public.perfiles where id=auth.uid() and approved)
$$;
revoke all on function enjoy_private.legacy_allowed() from public,anon;
grant execute on function enjoy_private.legacy_allowed() to authenticated;
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('create policy enjoy_company_boundary on public.%I as restrictive for all to authenticated using (enjoy_private.legacy_allowed()) with check (enjoy_private.legacy_allowed())',t.tablename);
 end loop;
end $$;
create function enjoy_private.guard_legacy_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null and not enjoy_private.legacy_allowed() and (new.approved or new.role<>'empleado') then raise exception 'Los permisos de Enjoy se administran por separado'; end if;return new;
end $$;
revoke all on function enjoy_private.guard_legacy_profile() from public,anon,authenticated;
create trigger enjoy_guard_legacy_profile before insert or update on public.perfiles for each row execute function enjoy_private.guard_legacy_profile();

insert into storage.buckets(id,name,public,file_size_limit) values('enjoy-inventarios','enjoy-inventarios',false,20971520) on conflict do nothing;
create function enjoy_private.can_manage_file(p_name text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare inv uuid;begin inv:=split_part(p_name,'/',1)::uuid;return exists(select 1 from enjoy_private.inventories where id=inv and enjoy_private.is_manager(data->>'warehouse'));exception when invalid_text_representation then return false;end $$;
revoke all on function enjoy_private.can_manage_file(text) from public,anon;
grant execute on function enjoy_private.can_manage_file(text) to authenticated;
create policy enjoy_file_read on storage.objects for select to authenticated using(bucket_id='enjoy-inventarios' and enjoy_private.can_manage_file(name));
create policy enjoy_file_create on storage.objects for insert to authenticated with check(bucket_id='enjoy-inventarios' and enjoy_private.can_manage_file(name) and (storage.foldername(name))[2]=auth.uid()::text);
create policy enjoy_storage_boundary on storage.objects as restrictive for all to authenticated using(bucket_id='enjoy-inventarios' or enjoy_private.legacy_allowed()) with check(bucket_id='enjoy-inventarios' or enjoy_private.legacy_allowed());
notify pgrst,'reload schema';
