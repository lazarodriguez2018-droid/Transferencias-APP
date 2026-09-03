/* Real PostgreSQL (PGlite), isolated in memory. No production data or credentials.
 * Run: PGLITE_PATH=<installed @electric-sql/pglite> node tools/reposition-orders-sql.test.js
 * Supabase platform auth/storage schemas and pgcrypto hashing are test shims only.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let PGlite;
try{({PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite'));}catch(error){if(error.code!=='MODULE_NOT_FOUND'||process.env.PGLITE_PATH)throw error;console.log('SKIP PostgreSQL integration: install @electric-sql/pglite or set PGLITE_PATH.');process.exit(0);}
const root=path.resolve(__dirname,'..');
async function main(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;create schema extensions;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select current_user::text$$;
 create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
 create function public.digest(text,text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;
 create function public.gen_random_bytes(integer) returns bytea language sql volatile as $$select substring(sha256(convert_to(gen_random_uuid()::text,'UTF8')) from 1 for $1)$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key,name text,bucket_id text,owner_id text);
 create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
 create publication supabase_realtime;`);
 const files=['supabase/staging/000_transferapp_base.sql',...fs.readdirSync(path.join(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')).sort().map(n=>'supabase/migrations/'+n)];
 for(const f of files){
   const sql=fs.readFileSync(path.join(root,f),'utf8').replace(/create extension if not exists pgcrypto(?: with schema extensions)?;/gi,'');
   try{await db.exec(sql);}catch(e){console.error('Migration failed:',f,e.message);throw e;}
 }
 console.log('All production schema migrations parsed and executed in isolated PostgreSQL.');
 const q=async(sql,args=[])=> (await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const uuid=()=>require('node:crypto').randomUUID();
 const origin=uuid(),dest=uuid(),other=uuid(),unapproved=uuid(),supervisor=uuid();
 for(const [id,local,role,approved] of [[origin,'Punta del Este','empleado',true],[dest,'Maldonado','empleado',true],[other,'Colonia','empleado',true],[unapproved,'Punta del Este','empleado',false],[supervisor,'Colonia','supervisor_general',true]]){
   await q('insert into auth.users(id) values($1)',[id]);
   await q('insert into perfiles(id,nombre,apellido,local_nombre,almacen,role,approved) values($1,$2,$3,$4,$5,$6,$7)',[id,'Prueba','Equipo',local,'00',role,approved]);
 }
 const login=async(id=origin,role='authenticated')=>{await db.exec('reset role');await q("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);};
 const admin=()=>db.exec('reset role');
 const order=async({status='pendiente',sku='TEST-1',qty=1,to='Maldonado',name='Cliente ficticio'}={})=>{
   await admin();const id=uuid(),product=uuid();
   await q('insert into pedidos(id,origen_local,origen_almacen,destino_local,destino_almacen,cliente,telefono,notas,estado) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,'Punta del Este','01',to,'02',name,'NO-EXPOSURE','private note',status]);
   await q('insert into pedido_productos(id,pedido_id,codigo,nombre,cantidad) values($1,$2,$3,$4,$5)',[product,id,sku,'Producto de prueba',qty]);return {id,product,qty,sku};
 };
 let checks=0;
 const check=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
 const fails=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
 const pending=await order({qty:2}),accepted=await order({status:'aceptado',sku:'TEST-2'}),wrongRoute=await order({to:'Colonia'});
 await login();
 const repo=await scalar("select op_crear_reposicion('Viernes PDE MDO','Punta del Este','Maldonado',$1::jsonb)",[JSON.stringify([{codigo:'TEST-1',nombre:'Producto de prueba',pedido:3}])]);
 const panel=()=>scalar('select op_reposicion_panel_pedidos($1)',[repo]);
 let data=await panel();
 check(data.orders.find(o=>o.id===accepted.id).reposicion_id,repo,'Accepted orders auto-import on creation');
 check(data.orders.find(o=>o.id===pending.id).reposicion_id,null,'Pending stays unaccepted');
 check(data.orders.some(o=>o.id===wrongRoute.id),false,'Route filtering');
 check(data.can_accept,true,'Origin accepts');
 const add=(o,accept=false,values=null)=>scalar('select op_reposicion_aceptar_agregar_pedido($1,$2,$3,$4::jsonb)',[repo,o.id,accept,values===null?null:JSON.stringify(values)]);
 await fails(()=>add(pending),/confirmá/);
 await fails(()=>add(pending,true,[{id:pending.product,cantidad:0}]),/al menos/);
 await fails(()=>add(pending,true,[{id:pending.product,cantidad:3}]),/cantidades/);
 await fails(()=>add(pending,true,[{id:pending.product,cantidad:1.5}]),/cantidades/);
 await fails(()=>add(pending,true,[{id:uuid(),cantidad:1}]),/cantidades/);
 await fails(()=>add(wrongRoute,true,[{id:wrongRoute.product,cantidad:1}]),/recorrido/);
 await login(dest);check((await panel()).can_accept,false,'Destination reads only');await fails(()=>add(pending,true,[{id:pending.product,cantidad:1}]),/Solo el local/);
 for(const id of [other,unapproved]){await login(id);await fails(panel,/acceso/);await fails(()=>add(pending,true,[{id:pending.product,cantidad:1}]),/Solo el local/);}
 await login(null,'anon');await fails(panel,/permission denied/);await fails(()=>add(pending),/permission denied/);
 await login(supervisor);check((await panel()).can_accept,true,'Supervisor can accept other routes');
 await login();await add(pending,true,[{id:pending.product,cantidad:1}]);
 await admin();check(await scalar('select aceptado_parcial from pedidos where id=$1',[pending.id]),true,'Partial acceptance recorded');
 let item=(await q('select * from op_reposicion_items where reposicion_id=$1 and codigo=$2',[repo,pending.sku]))[0];
 check([item.pedido_reposicion,item.pedido_clientes,item.pedido_total],[3,1,3],'No double physical units');
 await login();check((await add(pending,true,[{id:pending.product,cantidad:1}])).already_added,true,'Idempotent acceptance');
 await admin();check(await scalar('select pedido_clientes from op_reposicion_items where reposicion_id=$1 and codigo=$2',[repo,pending.sku]),1,'No double import');
 const late=await order({status:'aceptado',sku:'TEST-3'});await login();await add(late);check((await panel()).orders.find(o=>o.id===late.id).reposicion_id,repo,'Late accepted order added without accepting again');
 const outstanding=await order({sku:'TEST-4'});
 // Guest tests use the real invitation/token RPC and real quantity mutation.
 await login();const invite=await scalar("select op_crear_invitacion_sesion('reposicion',$1)",[repo]);
 await login(null,'anon');const guest=await scalar("select op_invitacion_unirse($1,'Colaborador ficticio',$2,'test-device-0001')",[invite.token,'data:image/png;base64,'+'A'.repeat(120)]);
 assert.equal(guest.ok,true,JSON.stringify(guest));const access=guest.access_token||guest.access;
 const detail=sku=>scalar('select op_invitado_pedidos_producto($1,$2)',[access,sku]);
 let gd=await detail(pending.sku);check(gd.can_accept,false,'Guest cannot accept');check(gd.pending_count,1,'Guest receives pending notice');check(gd.orders[0].id,pending.id,'Guest gets linked order');
 check(/NO-EXPOSURE|private note|shipping|tracking/.test(JSON.stringify(gd)),false,'Minimal guest data');
 check((await detail('TEST-4')).orders.length,0,'Unlinked pending order not exposed');
 await fails(()=>scalar('select op_invitado_pedidos_producto($1,$2)',['invalid',pending.sku]),/invitación/);
 const guestOp=(action,sku,qty=null)=>scalar('select op_invitado_operar($1,$2,$3,$4)',[access,action,sku,qty]);
 await guestOp('repo_claim',pending.sku);await guestOp('repo_set',pending.sku,1);
 check((await detail(pending.sku)).orders[0].estado,'listo','Guest count completes accepted units');
 await guestOp('repo_claim',pending.sku);await guestOp('repo_set',pending.sku,0);
 check((await detail(pending.sku)).orders[0].estado,'aceptado','Correction reopens order');
 await guestOp('repo_claim',pending.sku);await guestOp('repo_set',pending.sku,1);
 await admin();check(await scalar("select count(*)::int from notificaciones where pedido_id=$1 and titulo='Pedido listo para enviar'",[pending.id]),4,'Each completion transition notifies two locations');
 await login();
 const ship=(o,transport='Transportista de prueba',responsible='Responsable ficticio')=>scalar('select op_reposicion_enviar_pedido($1,$2,$3,$4,$5,$6)',[repo,o.id,transport,'R-TEST','TRACK-TEST',responsible]);
 await fails(()=>ship(late),/listo/);await fails(()=>ship(pending,''),/Completá/);
 await login(dest);await fails(()=>ship(pending),/Solo el local/);await login(null,'anon');await fails(()=>ship(pending),/permission denied/);
 await login();await ship(pending);check((await ship(pending)).already_sent,true,'Retry cannot duplicate dispatch');
 const sent=(await panel()).orders.find(o=>o.id===pending.id);check(sent.estado,'transito','Shipping moves only this order to transit');check(sent.shipping.transport,'Transportista de prueba','Transportation persisted');check(sent.shipping.receipt,'R-TEST','Receipt persisted');check(sent.shipping.tracking,'TRACK-TEST','Tracking persisted');check(sent.shipping.responsible,'Responsable ficticio','Responsible persisted in timeline');assert.ok(sent.shipping.sent_at);checks++;
 // Shipping respects mandatory physical quantity verification and routed stops.
 await admin();await q('update op_reposicion_items set preparado=3 where reposicion_id=$1 and codigo=$2',[repo,late.sku]);
 await login();await fails(()=>ship(late),/control final/);
 await scalar('select op_verificar_reposicion_cantidad($1,$2,3,$3)',[repo,late.sku,'Verificador ficticio']);
 await admin();await q('update pedidos set escala_local=$1 where id=$2',['Colonia',late.id]);await login();await fails(()=>ship(late),/escala/);
 await admin();await q('update pedidos set escala_local=null where id=$1',[late.id]);await login();await ship(late);
 const sameSku=await order({status:'aceptado',sku:pending.sku});await login();await add(sameSku);
 check((await panel()).orders.find(o=>o.id===sameSku.id).estado,'aceptado','Shipped units never fulfill another order');
 await login(null,'anon');await guestOp('repo_claim',pending.sku);await fails(()=>guestOp('repo_set',pending.sku,0),/ya enviadas/);
 await guestOp('repo_set',pending.sku,2);check((await detail(pending.sku)).orders.find(o=>o.id===sameSku.id).estado,'listo','New physical unit fulfills next order');
 await login();await fails(()=>scalar('select op_eliminar_reposicion($1)',[repo]),/envíos registrados/);
 check((await panel()).orders.find(o=>o.id===pending.id).estado,'transito','Delete rollback preserves shipped order');
 await admin();await q('update op_invitaciones_sesion set activa=false where sesion_id=$1',[repo]);await login(null,'anon');await fails(()=>detail(pending.sku),/invitación/);
 console.log(`${checks} workflow assertions passed: acceptance, permissions, QR preparation, notifications, shipping, rollback and unit allocation.`);
 await db.close();
}
main().catch(e=>{console.error(e.message,e.detail||'',e.where||'');process.exit(1);});
