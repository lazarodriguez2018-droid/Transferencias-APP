/* End-to-end reservation workflows in isolated PostgreSQL (PGlite).
 * Run: PGLITE_PATH=<installed @electric-sql/pglite> node tools/reservations-integration.test.js
 */
const assert=require('node:assert/strict'),{randomUUID:uuid}=require('node:crypto');
const {createDatabase}=require('./postgres-test-setup');

async function main(){
  const db=await createDatabase(),q=async(sql,args=[])=>(await db.query(sql,args)).rows;
  const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
  let checks=0;const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
  const truth=(value,label)=>{assert.ok(value,label);checks++;};
  const fails=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
  const users={employee:uuid(),other:uuid(),supervisor:uuid()};
  for(const [key,local,role] of [['employee','Maldonado','empleado'],['other','Colonia','empleado'],['supervisor','Punta del Este','supervisor_general']]){
    await q('insert into auth.users(id) values($1)',[users[key]]);
    await q('insert into perfiles(id,nombre,apellido,local_nombre,almacen,role,approved) values($1,$2,$3,$4,$5,$6,true)',[users[key],key,'Prueba',local,'TEST',role]);
  }
  const admin=()=>db.exec('reset role');
  const login=async(key='employee',role='authenticated')=>{await admin();await q("select set_config('request.jwt.claim.sub',$1,false)",[users[key]||'']);await db.exec('set role '+role);};
  const motive=async(name='Esperando proveedor',local='Maldonado')=>{await admin();return scalar('select id from op_reserva_motivos where local_nombre=$1 and nombre=$2',[local,name]);};
  const create=async(data,access=null)=>scalar('select op_reserva_crear_v2($1::jsonb,$2)',[JSON.stringify(data),access]);
  const detail=(id,access=null)=>scalar('select op_reserva_detalle($1,$2)',[id,access]);

  await admin();check(await scalar("select count(*)::int from op_reserva_motivos where local_nombre='Maldonado' and activo"),3,'Each shop exposes exactly the three operational reasons');
  check(await scalar("select count(*)::int from op_reserva_motivos where local_nombre='Maldonado' and activo and nombre in ('Pedido a otro local','Esperando proveedor','Ya estaba en local')"),3,'The active reasons match the agreed workflow');

  await login();await fails(()=>scalar("select op_reserva_guardar_recepcion_habitual(null,'Maldonado','proveedor','Distribuidora Prueba',array[1,3]::smallint[],true)"),/Solo administradores/);
  await login('supervisor');const schedule=await scalar("select op_reserva_guardar_recepcion_habitual(null,'Maldonado','proveedor','Distribuidora Prueba',array[1,3]::smallint[],true)");
  check(schedule.dias_recepcion,[1,3],'Administrator configures reception days for one supplier and destination shop');
  await login();const employeeContext=await scalar('select op_reserva_contexto(null)');
  check(employeeContext.reception_schedules.map(row=>row.origen_nombre),['Distribuidora Prueba'],'Employees receive only the schedules for their shop');

  const mixed=await create({local:'Maldonado',responsable:'Empleado Prueba',cliente:{nombre:'Cliente Mixto'},items:[
    {codigo:'MIX-SAME',nombre:'Producto dividido',cantidad:1,cantidad_local:0,procedencia:'local'},
    {codigo:'MIX-SAME',nombre:'Producto dividido',cantidad:2,cantidad_local:0,procedencia:'proveedor',proveedor_nombre:'Distribuidora Prueba'},
    {codigo:'MIX-EXT',nombre:'Gestionado por mensaje',cantidad:1,cantidad_local:0,procedencia:'pedido_local',origen_local:'Punta del Este',pedido_local_gestion:'externo'},
    {codigo:'MIX-CREATE',nombre:'Pedido integrado',cantidad:1,cantidad_local:0,procedencia:'pedido_local',origen_local:'Punta del Este',pedido_local_gestion:'crear'}
  ]});
  const mixedData=await detail(mixed.id);
  check(mixedData.reservation.motivo_nombre,'Origen mixto','Mixed item sources derive the reservation header automatically');
  check(mixedData.items.find(i=>i.procedencia==='proveedor').proveedor_nombre,'Distribuidora Prueba','Supplier is retained on its product line');
  check(mixedData.items.find(i=>i.codigo==='MIX-EXT').pedido_local_gestion,'externo','External inter-shop handling is retained on its product line');
  check(mixedData.items.find(i=>i.codigo==='MIX-EXT').pedido_id,null,'External handling does not create a duplicate inter-shop order');
  truth(mixedData.items.find(i=>i.codigo==='MIX-CREATE').pedido_id,'Only the configured product line creates and links an inter-shop order');
  check(await scalar('select count(*)::int from pedidos where reserva_id=$1',[mixed.id]),1,'Mixed reservation creates exactly the required inter-shop order');
  const mixedQr=await scalar('select op_reserva_qr_detalle($1)',[mixed.qr_token]);
  check(mixedQr.reservation.reason,'Origen mixto','Public QR exposes the derived mixed origin');
  check(mixedQr.reservation.items.find(i=>i.procedencia==='proveedor').proveedor_nombre,'Distribuidora Prueba','Public QR identifies the supplier for each product');
  check(mixedQr.reservation.items.find(i=>i.codigo==='MIX-EXT').pedido_local_gestion,'externo','Public QR identifies external inter-shop handling');

  await login();
  const local=await create({local:'Maldonado',motivo_id:await motive('Ya estaba en local'),responsable:'Empleado Prueba',cliente:{nombre:'Ana',apellido:'Reserva',telefono:'099 111 222',direccion:'Dirección de prueba'},items:[
    {codigo:'LOCAL-1',nombre:'Bolsa disponible',cantidad:2,cantidad_local:2,procedencia:'local'}
  ]});
  truth(local.qr_token,'Creation returns a stable QR token');
  let data=await detail(local.id),r=data.reservation;
  check(r.estado,'listo','Goods already in the shop start ready');
  truth(r.mercaderia_local_at&&r.vencimiento_at,'The 48-hour clock starts when goods are local');
  check(Math.round((new Date(r.vencimiento_at)-new Date(r.mercaderia_local_at))/3600000),48,'Deadline is exactly 48 hours');
  check((await scalar("select count(*)::int from clientes_agenda where regexp_replace(telefono,'\\D','','g')='099111222'")),1,'Customer is stored in the agenda');
  await create({local:'Maldonado',motivo_id:await motive(),responsable:'Empleado Prueba',cliente:{telefono:'099111222',apellido:'Actualizada'},items:[{codigo:'DUP',nombre:'Duplicado',cantidad:1,cantidad_local:0,procedencia:'proveedor'}]});
  check((await scalar("select count(*)::int from clientes_agenda where regexp_replace(telefono,'\\D','','g')='099111222'")),1,'Phone deduplicates the agenda');
  check((await scalar("select apellido from clientes_agenda where regexp_replace(telefono,'\\D','','g')='099111222'")),'Actualizada','Known customer details can be updated');
  await login();const agenda=await scalar("select op_agenda_guardar_cliente(null,$1::jsonb)",[JSON.stringify({nombre:'Ana desde agenda',telefono:'099-111-222',documento:'DOC-1'})]);
  check(agenda.merged,true,'Manual agenda creation merges an existing phone');
  check((await scalar("select count(*)::int from clientes_agenda where regexp_replace(telefono,'\\D','','g')='099111222'")),1,'Manual agenda use cannot create a duplicate phone');
  check(agenda.client.documento,'DOC-1','Merged agenda data is retained');
  const second=(await scalar("select op_agenda_guardar_cliente(null,$1::jsonb)",[JSON.stringify({nombre:'Segundo',telefono:'098000000'})])).client;
  await fails(()=>scalar("select op_agenda_guardar_cliente($1,$2::jsonb)",[second.id,JSON.stringify({nombre:'Segundo',telefono:'099111222'})]),/otro cliente/);

  await login(null,'anon');
  await fails(()=>scalar("select op_agenda_guardar_cliente(null,'{\"nombre\":\"Sin permiso\"}'::jsonb)"),/permission denied/);
  const publicQr=await scalar('select op_reserva_qr_detalle($1)',[local.qr_token]);
  check(publicQr.ok,true,'Public QR is read-only and resolvable');
  check(publicQr.reservation.items.length,1,'QR contains every product');
  await fails(()=>detail(local.id),/acceso rápido|disponible/);
  await login('other');await fails(()=>detail(local.id),/acceso/);

  await login();data=await detail(local.id);const localItem=data.items.find(i=>i.codigo==='LOCAL-1');
  await fails(()=>scalar("select op_reserva_actualizar_item($1,$2::jsonb)",[localItem.id,JSON.stringify({cantidad_local:0})]),/motivo/);
  await scalar("select op_reserva_actualizar_item($1,$2::jsonb)",[localItem.id,JSON.stringify({cantidad_local:0,motivo_correccion:'Corrección de conteo'})]);
  check((await detail(local.id)).items.find(i=>i.id===localItem.id).cantidad_local,0,'Quantity reduction with reason is audited');
  await scalar("select op_reserva_actualizar_item($1,$2::jsonb)",[localItem.id,JSON.stringify({cantidad_local:1})]);
  data=await scalar("select op_reserva_finalizar($1,'retiro_cliente',$2::jsonb,null)",[local.id,JSON.stringify([{id:localItem.id,cantidad:1}])]);
  check(data.reservation.estado,'parcial','A partial delivery remains open');
  check(data.items.find(i=>i.id===localItem.id).cantidad_entregada,1,'Delivered units are recorded');
  data=await scalar("select op_reserva_corregir_cierre($1,$2::jsonb,'Entrega cargada por error')",[local.id,JSON.stringify([{id:localItem.id,cantidad:0}])]);
  check(data.items.find(i=>i.id===localItem.id).cantidad_local,1,'Undo restores wrongly delivered units to local tracking');

  const beforeExpiry=data.reservation.estado;await admin();await q("update op_reservas set vencimiento_at=now()-interval '1 minute' where id=$1",[local.id]);
  check(await scalar('select op_reservas_actualizar_vencidas()'),1,'Expired reservations are advanced automatically');
  check(await scalar('select estado from op_reservas where id=$1',[local.id]),'vencido','Expired state is persisted');
  check(await scalar("select count(*)::int from notificaciones where titulo='Reserva vencida' and cuerpo like '%#'||(select codigo from op_reservas where id=$1)||'%'",[local.id]),3,'Every approved employee receives the alert');
  await login();data=await scalar("select op_reserva_excepcion($1,now()+interval '1 day','Cliente coordinó para mañana')",[local.id]);
  check(data.reservation.estado,beforeExpiry,'Exception restores the state from before expiry');
  await fails(()=>scalar("select op_reserva_finalizar($1,'no_retirado',$2::jsonb,'No vino')",[local.id,JSON.stringify([{id:localItem.id,cantidad:1}])]),/No sumes entregas/);
  data=await scalar("select op_reserva_finalizar($1,'no_retirado',$2::jsonb,'Cliente no retiró')",[local.id,JSON.stringify(data.items.map(i=>({id:i.id,cantidad:i.cantidad_entregada})))]);
  check(data.reservation.estado,'completado','No-retirada closes the reservation');
  check(data.items.map(i=>i.cantidad_local),[0],'No-retirada releases all local goods without stock writes');
  await fails(()=>scalar("select op_reserva_cambiar_estado($1,'buscando','Cambio directo')",[local.id]),/acción específica|cerrada/);
  await fails(()=>scalar("select op_reserva_finalizar($1,'no_retirado','[]'::jsonb,'Segundo cierre')",[local.id]),/cerrada/);

  await login();const cancelled=await create({local:'Maldonado',motivo_id:await motive('Ya estaba en local'),responsable:'Empleado Prueba',items:[{codigo:'CANCEL-1',nombre:'Mercadería a liberar',cantidad:2,cantidad_local:2,procedencia:'local'}]});
  const cancelledItem=(await detail(cancelled.id)).items[0];let cancelledData=await scalar("select op_reserva_cancelar($1,'Cliente desistió')",[cancelled.id]);
  check(cancelledData.reservation.estado,'cancelado','Cancellation closes the reservation with a reason');
  check(cancelledData.items[0].cantidad_local,0,'Cancellation releases separated goods for sale');
  cancelledData=await scalar("select op_reserva_corregir_cierre($1,$2::jsonb,'Cancelación realizada por error')",[cancelled.id,JSON.stringify([{id:cancelledItem.id,cantidad:0}])]);
  check(cancelledData.items[0].cantidad_local,2,'Undoing cancellation restores the previously separated quantity');
  check(cancelledData.reservation.estado,'listo','Undoing cancellation restores the operational state');

  await login();const inter=await create({local:'Maldonado',motivo_id:await motive('Pedido a otro local'),pedido_local_gestion:'crear',pedido_local_origen:'Punta del Este',responsable:'Empleado Prueba',items:[{codigo:'MOVE-1',nombre:'Producto entre locales',cantidad:2,cantidad_local:0,procedencia:'pedido_local',origen_local:'Punta del Este'}]});
  await admin();const orderId=await scalar('select id from pedidos where reserva_id=$1',[inter.id]);truth(orderId,'Inter-store source creates a linked order');
  check(await scalar('select count(*)::int from pedido_productos where pedido_id=$1 and codigo=$2 and cantidad=2',[orderId,'MOVE-1']),1,'Linked order receives the requested product');
  await q("update pedidos set estado='transito' where id=$1",[orderId]);check(await scalar('select estado from op_reservas where id=$1',[inter.id]),'en_transito','Order transit synchronizes into the reservation');
  await q('update pedido_productos set cantidad_recibida=2 where pedido_id=$1',[orderId]);await q("update pedidos set estado='llegado' where id=$1",[orderId]);
  check(await scalar('select estado from op_reservas where id=$1',[inter.id]),'listo','Order arrival makes a fully received reservation ready');

  await login();const editable=await create({local:'Maldonado',motivo_id:await motive(),responsable:'Responsable original',cliente:{nombre:'Cliente original'},referencia_externa:'REF-ANTES',items:[{codigo:'EDIT-1',nombre:'Producto editable',cantidad:1,cantidad_local:0,procedencia:'proveedor'}]});
  let edited=await scalar('select op_reserva_editar($1,$2::jsonb)',[editable.id,JSON.stringify({local:'Maldonado',motivo_id:await motive(),responsable:'Responsable corregido',cliente:{nombre:'Cliente editado'},referencia_externa:'REF-DESPUES',items:[{codigo:'EDIT-1',nombre:'Producto editable',cantidad:3,cantidad_local:0,procedencia:'proveedor',comentario:'Cantidad corregida'}]})]);
  check(edited.reservation.responsable_nombre,'Responsable corregido','Editing updates the responsible person');
  check(edited.reservation.referencia_externa,'REF-DESPUES','Editing updates reservation metadata');
  check(edited.items[0].cantidad,3,'Editing updates product quantities');
  check(edited.events[0].accion,'editar','Editing leaves an audit event');
  const removed=await scalar("select op_reserva_eliminar($1,$2,'Carga de prueba eliminada')",[editable.id,editable.code]);
  check(removed.ok,true,'A newly created reservation can be deleted with its code');
  await admin();check(await scalar('select count(*)::int from op_reservas where id=$1',[editable.id]),0,'Deleted reservation disappears from operational data');
  check(await scalar('select count(*)::int from op_reserva_eliminaciones where reserva_id=$1',[editable.id]),1,'Deletion preserves an audit snapshot');

  await login();const generatedDelete=await create({local:'Maldonado',motivo_id:await motive('Pedido a otro local'),pedido_local_gestion:'crear',pedido_local_origen:'Punta del Este',responsable:'Empleado Prueba',items:[{codigo:'DELETE-MOVE',nombre:'Pedido generado para borrar',cantidad:1,cantidad_local:0,procedencia:'pedido_local'}]});
  await admin();const generatedOrder=await scalar('select id from pedidos where reserva_id=$1',[generatedDelete.id]);
  await login();await scalar("select op_reserva_eliminar($1,$2,'Prueba de eliminación segura')",[generatedDelete.id,generatedDelete.code]);
  await admin();check(await scalar('select count(*)::int from pedidos where id=$1',[generatedOrder]),0,'Deleting a reservation removes only its still-pending generated order');

  await login();const external=await create({local:'Maldonado',motivo_id:await motive('Pedido a otro local'),pedido_local_gestion:'externo',pedido_local_origen:'Punta del Este',responsable:'Empleado Prueba',items:[{codigo:'WHATSAPP-1',nombre:'Pedido por WhatsApp',cantidad:1,cantidad_local:0,procedencia:'pedido_local'}]});
  await admin();check(await scalar('select count(*)::int from pedidos where reserva_id=$1',[external.id]),0,'External inter-store handling does not duplicate an order');
  check(await scalar('select procedencia from op_reserva_items where reserva_id=$1',[external.id]),'pedido_local','External inter-store handling still records the same operational source');

  const existingOrder=uuid();await q("insert into pedidos(id,origen_local,origen_almacen,destino_local,destino_almacen,cliente,estado) values($1,'Punta del Este','TEST','Maldonado','TEST','Cliente existente','pendiente')",[existingOrder]);
  await q("insert into pedido_productos(pedido_id,codigo,nombre,cantidad) values($1,'EXIST-1','Producto ya solicitado',2)",[existingOrder]);
  await login();const candidates=await scalar("select op_reserva_pedidos_candidatos('Maldonado','EXIST-1')");truth(candidates.some(order=>order.id===existingOrder),'The creation form can find a compatible existing order');
  await login();const linkedExisting=await create({local:'Maldonado',motivo_id:await motive('Pedido a otro local'),pedido_local_gestion:'existente',pedido_local_origen:'Punta del Este',pedido_existente_id:existingOrder,responsable:'Empleado Prueba',items:[{codigo:'EXIST-1',nombre:'Producto ya solicitado',cantidad:2,cantidad_local:0,procedencia:'pedido_local'}]});
  await admin();check(await scalar('select reserva_id from pedidos where id=$1',[existingOrder]),linkedExisting.id,'Choosing an existing order links it instead of creating another');
  check(await scalar("select count(*)::int from pedidos p join pedido_productos pp on pp.pedido_id=p.id where pp.codigo='EXIST-1'"),1,'Existing-order creation does not duplicate the order');
  await login();await scalar("select op_reserva_eliminar($1,$2,'Prueba de desvinculación')",[linkedExisting.id,linkedExisting.code]);
  await admin();check(await scalar('select count(*)::int from pedidos where id=$1',[existingOrder]),1,'Deleting the reservation never deletes a pre-existing order');
  check(await scalar('select reserva_id is null from pedidos where id=$1',[existingOrder]),true,'Deleting the reservation unlinks the pre-existing order');

  await login();const supplier=await create({local:'Maldonado',motivo_id:await motive(),responsable:'Empleado Prueba',items:[{codigo:'RECEIPT-1',nombre:'Producto de remito',cantidad:2,cantidad_local:0,procedencia:'proveedor',remito_numero:'R-RESERVA'}]});
  const receipt=uuid();await admin();await q("insert into op_recepciones(id,nombre,numero_remito,fecha_remito,origen_local,destino_local,created_by,estado) values($1,'Remito prueba','R-RESERVA','2026-09-10','Punta del Este','Maldonado',$2,'en_control')",[receipt,users.employee]);
  await q("insert into op_recepcion_items(recepcion_id,codigo,nombre,esperado,recibido) values($1,'RECEIPT-1','Producto de remito',2,2)",[receipt]);
  await login();await scalar('select op_recepcion_confirmar_reserva($1,$2)',[receipt,supplier.id]);
  await scalar("select op_verificar_recepcion_cantidad($1,'RECEIPT-1',2,'Empleado Prueba')",[receipt]);
  await admin();await q("update op_recepciones set estado='cerrado' where id=$1",[receipt]);
  check(await scalar('select estado from op_reservas where id=$1',[supplier.id]),'listo','Closing a linked receipt allocates the received goods');
  check(await scalar('select cantidad_local from op_reserva_items where reserva_id=$1',[supplier.id]),2,'Receipt allocation tracks the exact local quantity');

  await login('supervisor');const config=await scalar("select op_reserva_guardar_config('Maldonado',48,array[1,3]::smallint[],'\\\\DESKTOP-TEST\\Star BSC10','star-bsc10-80-max','Estantería de reservas')");
  check(config.ubicacion_reservas,'Estantería de reservas','Supervisor configures the fixed reservation place per shop');
  await fails(()=>scalar("select op_reserva_guardar_config('Maldonado',24,array[1]::smallint[],null,'star-bsc10-80-max','Estantería')"),/48 horas exactas/);
  await login(null,'anon');const locatedQr=await scalar('select op_reserva_qr_detalle($1)',[inter.qr_token]);
  check(locatedQr.reservation.location,'Estantería de reservas','Public internal QR shows where the shop keeps reservations');
  await login('supervisor');const localId=await scalar("select id from locales where nombre='Maldonado'");
  const link=await scalar('select op_reserva_crear_enlace($1)',[localId]);truth(link.token,'Supervisor can generate the local quick link');
  await login(null,'anon');const guest=await scalar("select op_reserva_invitado_entrar($1,'Empleado sin cuenta','device-reservation-test')",[link.token]);
  const guestReservation=await create({local:'Maldonado',motivo_id:await motive('Ya estaba en local'),responsable:'Empleado sin cuenta',items:[{codigo:'GUEST-1',nombre:'Producto rápido',cantidad:1,cantidad_local:1,procedencia:'local'}]},guest.access);
  await admin();truth(await scalar('select invitado_id is not null from op_reservas where id=$1',[guestReservation.id]),'Quick-link actions retain guest identity');
  check(await scalar('select created_by is null from op_reservas where id=$1',[guestReservation.id]),true,'Quick-link creation does not impersonate an account');
  const guestOrder=await create({local:'Maldonado',motivo_id:await motive('Pedido a otro local'),pedido_local_gestion:'crear',pedido_local_origen:'Punta del Este',responsable:'Empleado sin cuenta',items:[{codigo:'GUEST-MOVE',nombre:'Pedido rápido entre locales',cantidad:1,cantidad_local:0,procedencia:'pedido_local',origen_local:'Punta del Este'}]},guest.access);
  await admin();check(await scalar('select count(*)::int from pedidos where reserva_id=$1',[guestOrder.id]),1,'An employee using the quick link can create the linked inter-store order');
  const otherMotive=await motive('Ya estaba en local','Punta del Este');await fails(()=>create({local:'Punta del Este',motivo_id:otherMotive,responsable:'Empleado sin cuenta',items:[{codigo:'OTHER-SHOP',nombre:'Fuera de local',cantidad:1,cantidad_local:1,procedencia:'local'}]},guest.access),/ese local/);

  console.log(`reservations integration: ${checks} assertions passed`);await db.close();
}
main().catch(error=>{console.error(error);process.exit(1);});
