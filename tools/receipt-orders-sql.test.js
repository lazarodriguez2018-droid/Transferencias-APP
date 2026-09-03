const {createDatabase}=require('./postgres-test-setup');
const assert=require('node:assert/strict'),{randomUUID:uuid}=require('node:crypto');
async function main(){
  const db=await createDatabase(),q=async(s,p=[]) =>(await db.query(s,p)).rows;
  const scalar=async(s,p=[])=>Object.values((await q(s,p))[0])[0];
  let checks=0;const check=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
  const fails=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
  const admin=()=>db.exec('reset role');
  const users={};
  for(const [key,local,role,approved] of [['origin','Punta del Este','empleado',true],['dest','Maldonado','empleado',true],['other','Colonia','empleado',true],['unapproved','Maldonado','empleado',false],['supervisor','Colonia','supervisor_general',true]]){
    const id=users[key]=uuid();await q('insert into auth.users(id) values($1)',[id]);await q('insert into perfiles(id,nombre,apellido,local_nombre,almacen,role,approved) values($1,$2,$3,$4,$5,$6,$7)',[id,'Prueba','Local',local,'01',role,approved]);
  }
  const login=async(key='dest',role='authenticated')=>{await admin();await q("select set_config('request.jwt.claim.sub',$1,false)",[users[key]||'']);await db.exec('set role '+role);};
  const order=async({sku='A',qty=2,remito=null,status='transito',created='2026-09-01T12:00:00Z',to='Maldonado',accepted=null}={})=>{
    await admin();const id=uuid(),product=uuid();
    await q("insert into pedidos(id,origen_local,origen_almacen,destino_local,destino_almacen,cliente,telefono,notas,remito,estado,created_at) values($1,'Punta del Este','01',$2,'02','Cliente ficticio','PHONE-PRIVATE','NOTE-PRIVATE',$3,$4,$5)",[id,to,remito,status,created]);
    await q('insert into pedido_productos(id,pedido_id,codigo,nombre,cantidad,cantidad_aceptada,cantidad_preparada) values($1,$2,$3,$4,$5,$6,0)',[product,id,sku,'Producto ficticio',qty,accepted]);return {id,product,sku,qty};
  };
  const receipt=async(number,items=[{codigo:'A',nombre:'Prueba',esperado:4}],date='2026-09-05')=>{await login();return scalar("select op_crear_recepcion('Control ficticio',$1,$2,'Punta del Este','Maldonado',$3::jsonb)",[number,date,JSON.stringify(items)]);};
  const panel=r=>scalar('select op_recepcion_panel_pedidos($1)',[r]);
  const confirm=(r,o,manual=false)=>scalar('select op_recepcion_confirmar_pedido($1,$2,$3)',[r,o.id,manual]);
  const setQty=async(r,sku,qty,verify=true)=>{
    await login();await scalar("select op_recepcion_reclamar($1,$2,'test-device','Prueba')",[r,sku]);
    await scalar("select op_recepcion_cantidad_colaborativa($1,$2,null,$3,'test','Prueba','test-device')",[r,sku,qty]);
    if(verify)await scalar("select op_verificar_recepcion_cantidad($1,$2,$3,'Prueba')",[r,sku,qty]);
  };
  const exact=await order({remito:'R1'}),candidate=await order(),wrong=await order({remito:'OTRO'}),future=await order({created:'2026-09-06T12:00:00Z'}),pending=await order({status:'pendiente'}),outside=await order({sku:'Z'}),route=await order({to:'Colonia'});
  const r=await receipt('R1');let data=await panel(r);
  check(data.orders.length,6,'Only route orders');
  check(data.orders.find(o=>o.id===exact.id).linked,true,'Exact number links, even manual shipment without prepared quantity');
  check(data.orders.find(o=>o.id===candidate.id).relation,'fecha_productos','No number: date/product candidate');
  check(data.orders.find(o=>o.id===future.id).relation,'fecha_posterior','Future request not candidate');
  check(data.orders.find(o=>o.id===wrong.id).relation,'otro_remito','Different number not candidate');
  check(data.orders.find(o=>o.id===pending.id).relation,'sin_enviar','Pending visible but cannot receive');
  check(data.orders.find(o=>o.id===outside.id).pedido_productos[0].en_remito,false,'Shows absent products');
  await admin();check(await scalar('select count(*)::int from op_recepcion_pedidos where recepcion_id=$1',[r]),1,'Creation does not attach ambiguous orders');
  await login('origin');check((await panel(r)).can_receive,false,'Origin read-only');await fails(()=>confirm(r,exact),/Solo el local/);
  for(const user of ['other','unapproved']){await login(user);await fails(()=>panel(r),/acceso/);await fails(()=>confirm(r,exact),/acceso|Solo el local/);}
  await login('supervisor');check((await panel(r)).can_receive,true,'Supervisor can receive');
  await login(null,'anon');await fails(()=>panel(r),/permission denied/);await fails(()=>confirm(r,exact),/permission denied/);
  await login();await fails(()=>confirm(r,route),/recorrido/);await fails(()=>confirm(r,pending,true),/enviado/);await fails(()=>confirm(r,future,true),/posterior/);await fails(()=>confirm(r,wrong,true),/otro remito/);await fails(()=>confirm(r,outside,true),/no figuran/);await fails(()=>confirm(r,candidate),/Confirmá/);
  await setQty(r,'A',3,false);await fails(()=>confirm(r,exact),/control final/);
  await scalar("select op_verificar_recepcion_cantidad($1,'A',3,'Prueba')",[r]);
  check((await confirm(r,exact)).estado,'completo','Confirm full order during control');
  check((await confirm(r,exact)).agregadas,0,'Idempotent full confirmation');
  data=await panel(r);check(data.orders.find(o=>o.id===exact.id).cliente_aviso_pendiente,true,'Full order queues customer notice');
  const partial=await confirm(r,candidate,true);check([partial.estado,partial.agregadas],['incompleto',1],'Shared SKU cannot use physical units twice');
  check((await confirm(r,candidate)).agregadas,0,'Idempotent partial confirmation');
  await fails(()=>setQty(r,'A',2),/unidades confirmadas/);
  await login();await fails(()=>scalar('select op_eliminar_recepcion($1)',[r]),/no se puede eliminar/);
  await login(null,'anon');await fails(()=>scalar('select op_marcar_cliente_avisado($1)',[exact.id]),/permission denied/);
  await login('unapproved');await fails(()=>scalar('select op_marcar_cliente_avisado($1)',[exact.id]),/acceso/);
  await login('origin');await fails(()=>scalar('select op_marcar_cliente_avisado($1)',[exact.id]),/no disponible/);
  await login();await fails(()=>scalar('select op_marcar_cliente_avisado($1)',[candidate.id]),/completo/);
  await scalar('select op_marcar_cliente_avisado($1)',[exact.id]);
  await scalar("select op_recepcion_cerrar($1,'Prueba aislada')",[r]);
  data=await panel(r);check(data.orders.find(o=>o.id===exact.id).cliente_aviso_pendiente,false,'Closing does not reset notified flag');
  check(!!data.orders.find(o=>o.id===exact.id).cliente_avisado_at,true,'Notified timestamp retained');
  await admin();check(await scalar('select count(*)::int from notificaciones where pedido_id=$1',[exact.id]),1,'Customer notification generated once');
  const r2=await receipt('R2');await setQty(r2,'A',1);check((await confirm(r2,candidate,true)).estado,'completo','Partial order completed by later receipt');
  await admin();check(await scalar('select cantidad_recibida from pedido_productos where id=$1',[candidate.product]),2,'Cumulative quantities across receipts');
  const delayed=await order({sku:'D'});await q("insert into pedido_historial(pedido_id,estado,created_at) values($1,'transito','2026-09-07T12:00:00Z')",[delayed.id]);
  const dated=await receipt('DATED',[{codigo:'D',nombre:'D',esperado:2}]);check((await panel(dated)).orders.find(o=>o.id===delayed.id).relation,'fecha_posterior','Shipping date used, not just request');await fails(()=>confirm(dated,delayed,true),/posterior/);
  const auto=await order({sku:'AUTO',remito:'AUTO'}),ambiguous=await order({sku:'AUTO'});
  const ar=await receipt('AUTO',[{codigo:'AUTO',nombre:'Automático',esperado:2}]);await setQty(ar,'AUTO',2);
  check((await scalar('select op_recepcion_cerrar($1)',[ar])).pedidos_completos,1,'Close auto-completes exact numbered order');
  await admin();check(await scalar('select estado from pedidos where id=$1',[ambiguous.id]),'transito','Close never completes suggested order without confirmation');
  // Guests receive only session-scoped operational data, not customer contacts.
  await login();const invitation=await scalar("select op_crear_invitacion_sesion('recepcion',$1)",[r2]);
  await login(null,'anon');const guest=await scalar("select op_invitacion_unirse($1,'Invitado ficticio',$2,'receipt-test-device')",[invitation.token,'data:image/png;base64,'+'A'.repeat(120)]);
  const access=guest.access_token;const guestPanel=()=>scalar('select op_invitado_recepcion_pedidos($1)',[access]);
  const gd=await guestPanel();check(gd.can_receive,false,'Guest cannot confirm orders');check(gd.orders.some(o=>o.id===candidate.id),true,'Guest sees order in this receipt');
  check(/PHONE-PRIVATE|NOTE-PRIVATE|Cliente ficticio|telefono|tracking|transporte/.test(JSON.stringify(gd)),false,'No private contact or shipment data to QR');
  await fails(()=>scalar('select op_invitado_recepcion_pedidos($1)',['wrong-token']),/invitación/);
  await admin();await q('update op_invitaciones_sesion set activa=false where id=$1',[invitation.invite_id]);await login(null,'anon');await fails(guestPanel,/invitación/);
  console.log(`receipt-orders-sql: ${checks} assertions passed`);await db.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
