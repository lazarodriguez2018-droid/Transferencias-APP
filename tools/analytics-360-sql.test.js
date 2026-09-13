/* Real PostgreSQL (PGlite), isolated in memory. No production data or credentials.
 * Run: PGLITE_PATH=<installed @electric-sql/pglite> node tools/analytics-360-sql.test.js
 */
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createDatabase}=require('./postgres-test-setup');

const MODULES=['global','inventario','reposicion','recepcion','pedidos','reservas'];

async function main(){
  const db=await createDatabase();
  const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
  const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
  const id=()=>randomUUID();
  let checks=0;
  const check=(actual,expected,message)=>{assert.deepStrictEqual(actual,expected,message);checks++;};
  const ok=(value,message)=>{assert.ok(value,message);checks++;};
  const rejects=async(fn,pattern,message)=>{
    await assert.rejects(fn,pattern,message);
    checks++;
  };
  const admin=async()=>{await db.exec('reset role');};
  const login=async(userId,role='authenticated')=>{
    await admin();
    await q("select set_config('request.jwt.claim.sub',$1,false)",[userId||'']);
    if(role==='authenticated'||role==='anon') await db.exec(`set role ${role}`);
    else throw new Error(`Rol de prueba inválido: ${role}`);
  };
  const dashboard=async(module,filters={})=>{
    const value=await scalar('select public.op_dashboard_360($1,$2::jsonb) as result',[module,JSON.stringify(filters)]);
    return typeof value==='string'?JSON.parse(value):value;
  };
  const rawKpi=(result,key)=>result.kpis.find(item=>item.key===key);
  const kpis=result=>Object.fromEntries(result.kpis.map(item=>[item.key,Number(item.value)]));
  const crosses=result=>Object.fromEntries(result.cross_module.map(item=>[item.key,Number(item.primary)]));
  const breakdown=(result,key)=>result.breakdowns.find(item=>item.key===key);

  const employeePunta=id(),employeeColonia=id(),supervisor=id(),administrator=id(),unapproved=id();
  const users=[
    [employeePunta,'Empleado','Punta','Punta del Este','empleado',true],
    [employeeColonia,'Empleado','Colonia','Colonia','empleado',true],
    [supervisor,'Super','General','Maldonado','supervisor_general',true],
    [administrator,'Admin','Prueba','Punta del Este','admin',true],
    [unapproved,'Sin','Aprobar','Punta del Este','empleado',false]
  ];

  await admin();
  for(const local of ['Punta del Este','Maldonado','Colonia','Rocha']){
    await q('insert into public.locales(nombre,almacen) values($1,$2) on conflict(nombre) do update set almacen=excluded.almacen',[local,`A-${local}`]);
  }
  for(const [userId,name,lastName,local,role,approved] of users){
    await q('insert into auth.users(id,email) values($1,$2)',[userId,`${userId}@example.invalid`]);
    await q('insert into public.perfiles(id,nombre,apellido,local_nombre,almacen,role,approved) values($1,$2,$3,$4,$5,$6,$7)',[userId,name,lastName,local,'01',role,approved]);
  }

  const invPunta=id(),invColonia=id();
  await q(`insert into public.op_inventario_sesiones(id,nombre,local_nombre,almacen,estado,created_by,created_at,updated_at)
    values($1,'Inventario Punta','Punta del Este','01','cerrada',$3,$5,$5),
          ($2,'Inventario Colonia','Colonia','03','cerrada',$4,$6,$6)`,
    [invPunta,invColonia,employeePunta,employeeColonia,'2025-01-10T12:00:00Z','2025-02-10T12:00:00Z']);
  await q(`insert into public.op_inventario_items(sesion_id,codigo,nombre,barras,cantidad,tipos,updated_by,updated_at) values
    ($1,'SKU-360','Producto Central','779000000001',4,'{"scanner":3,"manual":1}'::jsonb,$3,$5),
    ($1,'OTRO-360','Producto Secundario','779000000002',2,'{"manual":2}'::jsonb,$3,$5),
    ($2,'SKU-360','Producto Central','779000000001',9,'{"scanner":9}'::jsonb,$4,$6)`,
    [invPunta,invColonia,employeePunta,employeeColonia,'2025-01-10T13:00:00Z','2025-02-10T13:00:00Z']);
  await q(`insert into public.op_inventario_balances(sesion_id,balance,updated_by,updated_at) values
    ($1,$3::jsonb,$5,'2025-01-10T13:00:00Z'),($2,$4::jsonb,$6,'2025-02-10T13:00:00Z')`,[
    invPunta,invColonia,
    JSON.stringify([{codigo:'SKU-360',nombre:'Producto Central',stockActual:5},{codigo:'OTRO-360',nombre:'Producto Secundario',stockActual:2}]),
    JSON.stringify([{codigo:'SKU-360',nombre:'Producto Central',stockActual:9}]),employeePunta,employeeColonia
  ]);

  const repoPunta=id(),repoColonia=id();
  await q(`insert into public.op_reposiciones(id,nombre,origen_local,destino_local,estado,started_at,created_by,enviado_at,created_at,updated_at) values
    ($1,'Reposición Punta','Punta del Este','Maldonado','enviado',$5,$3,$6,$5,$6),
    ($2,'Reposición Colonia','Colonia','Rocha','cerrado',$7,$4,$8,$7,$8)`,[
    repoPunta,repoColonia,employeePunta,employeeColonia,
    '2025-01-10T09:00:00Z','2025-01-10T15:00:00Z','2025-02-10T09:00:00Z','2025-02-10T15:00:00Z'
  ]);
  await q(`insert into public.op_reposicion_items(reposicion_id,codigo,nombre,barras,marca,pedido_reposicion,pedido_clientes,stock_origen,preparado,cerrado_incompleto,motivo_codigo,motivo_label,updated_by,updated_at) values
    ($1,'SKU-360','Producto Central','779000000001','Marca Uno',5,3,20,4,true,'faltante_stock','Faltante de stock',$3,'2025-01-10T14:00:00Z'),
    ($1,'OTRO-360','Producto Secundario','779000000002','Marca Dos',2,1,10,3,false,null,null,$3,'2025-01-10T14:00:00Z'),
    ($2,'SKU-360','Producto Central','779000000001','Marca Uno',10,0,20,10,false,null,null,$4,'2025-02-10T14:00:00Z')`,
    [repoPunta,repoColonia,employeePunta,employeeColonia]);
  await q(`insert into public.op_reposicion_extras(reposicion_id,codigo,nombre,barras,cantidad,updated_by,updated_at)
    values($1,'EXTRA-360','Producto Extra','779000000099',2,$2,'2025-01-10T14:00:00Z')`,[repoPunta,employeePunta]);

  const receiptPunta=id(),receiptColonia=id();
  await q(`insert into public.op_recepciones(id,nombre,numero_remito,fecha_remito,origen_local,destino_local,estado,created_by,closed_by,closed_at,created_at,updated_at) values
    ($1,'Remito Punta','R-360-A','2025-01-10','Punta del Este','Maldonado','cerrado',$3,$3,'2025-01-10T18:00:00Z','2025-01-10T16:00:00Z','2025-01-10T18:00:00Z'),
    ($2,'Remito Colonia','R-360-B','2025-02-10','Colonia','Rocha','cerrado',$4,$4,'2025-02-10T18:00:00Z','2025-02-10T16:00:00Z','2025-02-10T18:00:00Z')`,
    [receiptPunta,receiptColonia,employeePunta,employeeColonia]);
  await q(`insert into public.op_recepcion_items(recepcion_id,codigo,nombre,barras,marca,esperado,recibido,controlado_at,controlado_by,updated_by,updated_at) values
    ($1,'SKU-360','Producto Central','779000000001','Marca Uno',5,4,'2025-01-10T17:00:00Z',$3,$3,'2025-01-10T17:00:00Z'),
    ($1,'OTRO-360','Producto Secundario','779000000002','Marca Dos',2,3,'2025-01-10T17:00:00Z',$3,$3,'2025-01-10T17:00:00Z'),
    ($2,'SKU-360','Producto Central','779000000001','Marca Uno',10,10,'2025-02-10T17:00:00Z',$4,$4,'2025-02-10T17:00:00Z')`,
    [receiptPunta,receiptColonia,employeePunta,employeeColonia]);
  await q(`insert into public.op_recepcion_extras(recepcion_id,codigo,nombre,barras,cantidad,updated_by,updated_at)
    values($1,'EXTRA-360','Producto Extra','779000000099',2,$2,'2025-01-10T17:00:00Z')`,[receiptPunta,employeePunta]);

  const orderPunta=id(),orderColonia=id(),orderProductPunta=id(),orderProductOtherPunta=id(),orderProductColonia=id();
  await q(`insert into public.pedidos(id,origen_local,origen_almacen,destino_local,destino_almacen,estado,urgente,canal_creacion,cliente_aviso_pendiente,creado_por,created_at,updated_at) values
    ($1,'Punta del Este','01','Maldonado','02','completo',false,'interno',true,$3,'2025-01-10T08:00:00Z','2025-01-12T08:00:00Z'),
    ($2,'Colonia','03','Rocha','04','pendiente',true,'publico',false,$4,'2025-02-11T08:00:00Z','2025-02-11T08:00:00Z')`,
    [orderPunta,orderColonia,employeePunta,employeeColonia]);
  await q(`insert into public.pedido_productos(id,pedido_id,codigo,nombre,marca,cantidad,cantidad_aceptada,cantidad_preparada,cantidad_recibida) values
    ($1,$4,'SKU-360','Zeta Pedido Histórico','Zeta Marca',5,4,4,0),
    ($2,$4,'OTRO-360','Producto Secundario','Marca Dos',2,2,2,2),
    ($3,$5,'SKU-360','Actual Pedido','Actual Marca',10,null,0,0)`,
    [orderProductPunta,orderProductOtherPunta,orderProductColonia,orderPunta,orderColonia]);
  await q(`insert into public.pedido_historial(pedido_id,estado,usuario_id,created_at,persona_nombre)
    values($1,'completo',$2,'2025-01-12T08:00:00Z','Empleado Punta')`,[orderPunta,employeePunta]);

  const reservationPunta=id(),reservationColonia=id(),reservationDeleted=id();
  await q(`insert into public.op_reservas(id,codigo,local_nombre,local_almacen,motivo_nombre,responsable_nombre,estado,finalidad,entrega_tipo,final_tipo,completed_at,created_by,created_by_name,created_at,updated_at) values
    ($1,'RES-360-A','Punta del Este','01','Retiro en tienda','Empleado Punta','completado','retiro_cliente','retiro_local','retiro_cliente','2025-01-13T07:00:00Z',$3,'Empleado Punta','2025-01-10T07:00:00Z','2025-01-13T07:00:00Z'),
    ($2,'RES-360-B','Colonia','03','Retiro en tienda','Empleado Colonia','buscando','retiro_cliente','retiro_local',null,null,$4,'Empleado Colonia','2025-02-10T07:00:00Z','2025-02-10T07:00:00Z'),
    ($5,'RES-360-DEL','Punta del Este','01','Otro','Admin Prueba','cancelado','otro',null,'no_retirado','2025-01-13T06:00:00Z',$6,'Admin Prueba','2025-01-12T06:00:00Z','2025-01-13T06:00:00Z')`,
    [reservationPunta,reservationColonia,employeePunta,employeeColonia,reservationDeleted,administrator]);
  await q(`insert into public.op_reserva_items(id,reserva_id,codigo,nombre,cantidad,cantidad_local,cantidad_entregada,procedencia,estado,pedido_id,reposicion_id,recepcion_id,created_at,updated_at) values
    ($1,$4,'SKU-360','Producto Central',5,0,4,'reposicion','entregado',$7,$8,$9,'2025-01-10T07:00:00Z','2025-01-13T07:00:00Z'),
    ($2,$5,'SKU-360','Producto Central',10,2,0,'local','separado',null,null,null,'2025-02-10T07:00:00Z','2025-02-10T07:00:00Z'),
    ($3,$6,'ELIM-360','Producto Eliminado',3,1,2,'otro','entregado',null,null,null,'2025-01-12T06:00:00Z','2025-01-13T06:00:00Z')`,
    [id(),id(),id(),reservationPunta,reservationColonia,reservationDeleted,orderPunta,repoPunta,receiptPunta]);
  await q(`insert into public.op_reserva_eventos(reserva_id,accion,estado,autor_nombre,usuario_id,created_at) values
    ($1,'vencimiento','vencido','Empleado Punta',$3,'2025-01-11T07:00:00Z'),
    ($2,'vencimiento','vencido','Admin Prueba',$4,'2025-01-12T18:00:00Z')`,
    [reservationPunta,reservationDeleted,employeePunta,administrator]);

  await q('update public.pedidos set reposicion_id=$2,recepcion_id=$3,reserva_id=$4 where id=$1',[orderPunta,repoPunta,receiptPunta,reservationPunta]);
  await q('insert into public.op_reposicion_pedidos(reposicion_id,pedido_id,agregado_by) values($1,$2,$3)',[repoPunta,orderPunta,employeePunta]);
  await q('insert into public.op_recepcion_pedidos(recepcion_id,pedido_id,coincidencia,confirmado_at,confirmado_by) values($1,$2,$3,$4,$5)',[receiptPunta,orderPunta,'remito','2025-01-10T17:00:00Z',employeePunta]);
  await q('insert into public.op_recepcion_pedido_unidades(recepcion_id,producto_id,pedido_id,codigo,cantidad,actualizado_by) values($1,$2,$3,$4,$5,$6)',[receiptPunta,orderProductPunta,orderPunta,'SKU-360',4,employeePunta]);
  await q('insert into public.op_recepcion_reservas(recepcion_id,reserva_id,coincidencia,linked_by,linked_at) values($1,$2,$3,$4,$5)',[receiptPunta,reservationPunta,'confirmada',employeePunta,'2025-01-10T17:00:00Z']);

  await login(administrator);
  const deletedNumber=String(await scalar('select numero from public.op_reservas where id=$1',[reservationDeleted]));
  const deletedResult=await scalar('select public.op_reserva_eliminar($1,$2,$3,null) as result',[reservationDeleted,deletedNumber,'Limpieza histórica de prueba']);
  ok(deletedResult&&deletedResult.ok===true,'La eliminación auditada debe completar el flujo real de Reservas');
  await admin();
  check(Number(await scalar('select count(*) from public.op_reservas where id=$1',[reservationDeleted])),0,'La reserva eliminada no debe permanecer activa');
  check(Number(await scalar('select count(*) from public.op_reserva_eliminaciones where reserva_id=$1',[reservationDeleted])),1,'La eliminación debe conservar exactamente un snapshot');

  // Los procesos conservan nombres históricos aunque el catálogo de locales
  // cambie. Un supervisor debe poder seguir aislando esa actividad antigua.
  const historicalLocal='Local histórico cerrado',historicalInventory=id();
  await q('insert into public.locales(nombre,almacen) values($1,$2)',[historicalLocal,'A-HIST']);
  await q(`insert into public.op_inventario_sesiones(id,nombre,local_nombre,almacen,estado,created_by,created_at,updated_at)
    values($1,'Inventario de local cerrado',$2,'A-HIST','cerrada',$3,'2024-06-10T12:00:00Z','2024-06-10T13:00:00Z')`,[historicalInventory,historicalLocal,administrator]);
  await q(`insert into public.op_inventario_items(sesion_id,codigo,nombre,barras,cantidad,tipos,updated_by,updated_at)
    values($1,'HIST-360','Producto histórico','779000000088',7,'{"manual":7}'::jsonb,$2,'2024-06-10T13:00:00Z')`,[historicalInventory,administrator]);
  await q('delete from public.locales where nombre=$1',[historicalLocal]);

  await login(supervisor);
  const allByModule={};
  for(const module of MODULES){
    const result=await dashboard(module,{});
    allByModule[module]=result;
    check(result.module,module,`El RPC debe identificar el módulo ${module}`);
    ok(Array.isArray(result.kpis)&&result.kpis.length>=8,`${module} debe devolver sus indicadores`);
    ok(Array.isArray(result.breakdowns)&&result.breakdowns.length>0,`${module} debe devolver desgloses`);
    ok(result.trend&&Array.isArray(result.trend.points),`${module} debe devolver una serie histórica`);
    ok(breakdown(result,'recent')&&breakdown(result,'recent').rows.length>0,`${module} debe permitir bajar desde el agregado a registros individuales`);
    check(result.scope.supervisor,true,`${module} debe informar alcance supervisor`);
  }
  check(kpis(allByModule.inventario).sessions,3,'El supervisor debe ver inventarios actuales e históricos');
  check(kpis(allByModule.reposicion).sessions,2,'El supervisor debe ver ambas reposiciones');
  check(kpis(allByModule.recepcion).receipts,2,'El supervisor debe ver ambos remitos');
  check(kpis(allByModule.pedidos).orders,2,'El supervisor debe ver ambos pedidos');
  check(kpis(allByModule.reservas).reservations,3,'Las reservas deben incluir la eliminada auditada');
  check(kpis(allByModule.global).processes,12,'La visión global debe contar los procesos de todos los módulos sin sumar etapas como stock');
  const historicalOption=allByModule.inventario.scope.locations.find(row=>row.nombre===historicalLocal);
  ok(historicalOption&&historicalOption.historical===true,'Un local eliminado debe volver como opción histórica del módulo');
  ok(allByModule.global.scope.locations.some(row=>row.nombre===historicalLocal&&row.historical===true),'La visión global debe ofrecer el local histórico');
  const historicalResult=await dashboard('inventario',{local:historicalLocal});
  check(kpis(historicalResult).sessions,1,'El filtro debe aislar la actividad de un local eliminado');
  check(kpis(historicalResult).counted,7,'El local eliminado debe conservar sus unidades históricas');
  const latestOrderProduct=breakdown(allByModule.pedidos,'products').rows.find(row=>row.codigo==='SKU-360');
  check(latestOrderProduct.product,'Actual Pedido','Pedidos debe mostrar el nombre del registro más reciente, no el máximo alfabético');
  check(latestOrderProduct.brand,'Actual Marca','Pedidos debe mostrar la marca del registro más reciente, no el máximo alfabético');
  check(breakdown(allByModule.global,'products').rows.find(row=>row.codigo==='SKU-360').product,'Actual Pedido','La visión global debe conservar el nombre de la operación más reciente');
  check(breakdown(allByModule.inventario,'methods').rows.map(row=>row.method),['scanner','manual'],'Los agregados JSON deben conservar el orden documentado aun sin depender del plan del motor');

  const punta={};
  for(const module of MODULES) punta[module]=await dashboard(module,{local:'Punta del Este'});
  check(kpis(punta.inventario).sessions,1,'El filtro local debe aislar el inventario de Punta');
  check(kpis(punta.inventario).counted,6,'Inventario debe sumar las unidades físicas históricas');
  check(kpis(punta.inventario).accuracy,50,'Inventario debe comparar SKU exactos contra el balance');
  check(kpis(punta.inventario).absolute_difference,1,'Inventario debe medir desvío absoluto');
  check(kpis(punta.reposicion).requested,7,'Reposición debe usar el mayor entre demanda general y de clientes por SKU');
  check(kpis(punta.reposicion).prepared,7,'Reposición debe sumar lo efectivamente preparado');
  check(kpis(punta.reposicion).shortage,1,'Reposición debe conservar el faltante aunque el proceso esté cerrado');
  check(kpis(punta.reposicion).overage,3,'Reposición debe separar excedente de línea y productos extra');
  check(kpis(punta.reposicion).fulfillment,85.7,'Reposición debe limitar cada SKU al 100 % sin compensar su faltante con el excedente de otro');
  check(Number(breakdown(punta.reposicion,'routes').rows[0].fulfillment),85.7,'El cumplimiento por ruta debe conservar el cálculo por SKU');
  check(kpis(punta.recepcion).expected,7,'Recepción debe sumar lo esperado');
  check(kpis(punta.recepcion).received,7,'Recepción debe sumar lo recibido');
  check(kpis(punta.recepcion).shortage,1,'Recepción debe conservar faltantes por SKU');
  check(kpis(punta.recepcion).overage,3,'Recepción debe separar excedentes y extras');
  check(kpis(punta.recepcion).fulfillment,85.7,'Recepción debe limitar cada SKU al 100 % sin compensar su faltante con el excedente de otro');
  check(Number(breakdown(punta.recepcion,'routes').rows[0].fulfillment),85.7,'El nivel de recepción por ruta debe conservar el cálculo por SKU');
  check(kpis(punta.pedidos).requested,7,'Pedidos debe sumar las unidades solicitadas');
  check(kpis(punta.pedidos).accepted,6,'Pedidos debe sumar las unidades aceptadas');
  check(kpis(punta.pedidos).received,6,'Pedidos debe sumar las unidades recibidas');
  check(kpis(punta.pedidos).inferred_received,1,'Pedidos debe contar los cierres históricos cuya recepción fue inferida');
  check(kpis(punta.pedidos).complete_rate,100,'Pedidos debe medir cierres completos sobre cierres finales');
  check(rawKpi(punta.pedidos,'complete_rate').tone,'good','Un cierre completo debe usar una señal positiva');
  check(kpis(punta.pedidos).lead_time,48,'Pedidos debe calcular horas hasta el cierre');
  const inferredProduct=breakdown(punta.pedidos,'products').rows.find(row=>row.codigo==='SKU-360');
  check(Number(inferredProduct.inferred_units),4,'El desglose por producto debe separar las unidades recibidas inferidas');
  check(breakdown(punta.pedidos,'recent').rows[0].receipt_basis,'Inferida (histórico)','El registro individual debe exponer la base de su cantidad recibida');
  check(kpis(punta.reservas).reservations,2,'Reservas locales debe incluir el snapshot eliminado');
  check(kpis(punta.reservas).requested,8,'Reservas debe sumar unidades actuales y eliminadas auditadas');
  check(kpis(punta.reservas).local_units,1,'Mercadería separada actual debe excluir la reserva eliminada y conservar la unidad sincronizada del pedido');
  check(kpis(punta.reservas).delivered,6,'Entregas históricas deben conservar lo entregado antes de eliminar');
  check(kpis(punta.reservas).delivery_rate,75,'Reservas debe calcular entrega sobre demanda histórica');
  check(rawKpi(punta.reservas,'delivery_rate').tone,'warning','Una entrega parcial no debe mostrarse como resultado positivo completo');
  check(kpis(punta.reservas).overdue,2,'Los eventos de vencimiento actuales y eliminados deben conservarse');
  check(crosses(punta.reservas).deleted,1,'El cruce de Reservas debe exponer eliminaciones auditadas');
  check(crosses(punta.recepcion).linked_orders,1,'Recepción debe cruzar pedidos por vínculo confirmado');
  check(crosses(punta.recepcion).allocated_order_units,4,'Recepción debe sumar la asignación confirmada a pedidos');
  check(crosses(punta.recepcion).linked_reservations,1,'Recepción debe cruzar reservas confirmadas');
  check(crosses(punta.reposicion).linked_orders,1,'Reposición debe cruzar pedidos vinculados');
  check(kpis(punta.global).processes,6,'La visión Punta debe incluir cinco procesos activos/históricos y una reserva eliminada');
  check(kpis(punta.global).reposition_fulfillment,85.7,'La visión global debe conservar el cumplimiento de reposición por SKU');
  check(kpis(punta.global).reception_fulfillment,85.7,'La visión global debe conservar el nivel de recepción por SKU');
  check(breakdown(punta.global,'modules').rows.map(row=>Number(row.records)),[1,1,1,1,2],'El resumen global debe mantener separados los módulos');
  check(Number(breakdown(punta.global,'modules').rows[1].rate),85.7,'El resumen global de Reposición no debe compensar faltantes con excedentes');
  check(Number(breakdown(punta.global,'modules').rows[2].rate),85.7,'El resumen global de Recepción no debe compensar faltantes con excedentes');
  check(Number(breakdown(punta.global,'modules').rows[3].actual),6,'El resumen global debe aplicar la misma inferencia documentada para pedidos completos antiguos');
  const inferredAttention=breakdown(punta.global,'attention').rows.find(row=>row.signal==='Pedidos con recepción inferida');
  check(Number(inferredAttention.value),1,'La visión global debe advertir cuántos pedidos usan una recepción inferida');
  const globalRecentText=JSON.stringify(breakdown(punta.global,'recent').rows);
  ok(!/Inventario Punta|Reposición Punta|Remito Punta|Empleado Punta/.test(globalRecentText),'La actividad global reciente debe usar referencias neutras y no exponer nombres operativos o personales');

  const productFiltered={};
  for(const module of MODULES) productFiltered[module]=await dashboard(module,{local:'Punta del Este',product:'SKU-360'});
  check(kpis(productFiltered.inventario).counted,4,'El filtro SKU debe excluir otras líneas de inventario');
  check(kpis(productFiltered.reposicion).requested,5,'El filtro SKU debe excluir otras líneas de reposición');
  check(kpis(productFiltered.recepcion).expected,5,'El filtro SKU debe excluir otras líneas de recepción');
  check(kpis(productFiltered.pedidos).requested,5,'El filtro SKU debe excluir otras líneas de pedidos');
  check(kpis(productFiltered.reservas).reservations,1,'El filtro SKU debe excluir la reserva eliminada de otro producto');
  check(kpis(productFiltered.global).processes,5,'El filtro SKU global debe retener un proceso coincidente por módulo');

  const extraRepo=await dashboard('reposicion',{local:'Punta del Este',product:'EXTRA-360'});
  const extraReceipt=await dashboard('recepcion',{local:'Punta del Este',product:'EXTRA-360'});
  const extraGlobal=await dashboard('global',{local:'Punta del Este',product:'EXTRA-360'});
  check(kpis(extraRepo).sessions,1,'Un producto agregado como extra debe hacer coincidir su reposición');
  check(kpis(extraRepo).overage,2,'El filtro de reposición debe cuantificar el extra coincidente');
  check(kpis(extraReceipt).receipts,1,'Un producto recibido como extra debe hacer coincidir su remito');
  check(kpis(extraReceipt).overage,2,'El filtro de recepción debe cuantificar el extra coincidente');
  check(kpis(extraGlobal).processes,2,'La búsqueda global debe encontrar procesos cuyo SKU existe solamente como extra');
  const extraProductRow=breakdown(extraGlobal,'products').rows.find(row=>row.codigo==='EXTRA-360');
  ok(extraProductRow,'La matriz global debe incluir el SKU extra');
  check(Number(extraProductRow.reposition_prepared),2,'La matriz global debe ubicar el extra en Reposición');
  check(Number(extraProductRow.reception_received),2,'La matriz global debe ubicar el extra en Recepción');
  check(rawKpi(extraRepo,'fulfillment').value,null,'Un proceso compuesto sólo por extras no tiene denominador de cumplimiento');
  check(rawKpi(extraReceipt,'fulfillment').value,null,'Un remito compuesto sólo por extras no tiene denominador de recepción');
  check(rawKpi(extraGlobal,'reposition_fulfillment').value,null,'La visión global no debe convertir un cumplimiento inexistente en 0 %');
  check(rawKpi(extraGlobal,'reception_fulfillment').value,null,'La visión global no debe convertir un nivel de recepción inexistente en 0 %');

  const onlyDeleted=await dashboard('global',{local:'Punta del Este',date_from:'2025-01-11',date_to:'2025-01-31'});
  check(kpis(onlyDeleted).processes,1,'El filtro de fecha debe usar la creación reconstruida del snapshot eliminado');
  check(kpis(onlyDeleted).reservation_delivery,66.7,'La entrega global debe incluir cantidades del snapshot eliminado');
  const january10=await dashboard('global',{local:'Punta del Este',date_from:'2025-01-10',date_to:'2025-01-10'});
  check(kpis(january10).processes,5,'El límite final del filtro debe ser inclusivo en la fecha seleccionada');

  const coloniaOrders=await dashboard('pedidos',{local:'Colonia'});
  check(rawKpi(coloniaOrders,'complete_rate').value,null,'Sin pedidos finalizados la tasa de cierres debe quedar sin datos');
  check(rawKpi(coloniaOrders,'complete_rate').tone,'info','Una tasa sin denominador debe usar tono neutral');
  check(rawKpi(coloniaOrders,'lead_time').value,null,'Sin cierres no se debe informar un tiempo ficticio de cero minutos');
  const coloniaReservations=await dashboard('reservas',{local:'Colonia'});
  check(rawKpi(coloniaReservations,'delivery_rate').value,0,'Una reserva con demanda y ninguna entrega sí tiene una tasa real de 0 %');
  check(rawKpi(coloniaReservations,'delivery_rate').tone,'danger','Una tasa real de entrega de 0 % no debe mostrarse en verde');
  check(rawKpi(coloniaReservations,'lead_time').value,null,'Una reserva todavía abierta no tiene tiempo de cierre');

  const emptyGlobal=await dashboard('global',{date_from:'2035-01-01',date_to:'2035-01-02'});
  for(const key of ['inventory_accuracy','reposition_fulfillment','reception_fulfillment','order_completion','reservation_delivery']){
    check(rawKpi(emptyGlobal,key).value,null,`El indicador ${key} debe quedar sin datos cuando no existe denominador`);
  }

  const openReceipt=id();
  await admin();
  await q(`insert into public.op_recepciones(id,nombre,numero_remito,fecha_remito,origen_local,destino_local,estado,created_by,created_at,updated_at)
    values($1,'Control todavía abierto','R-OPEN-360','2026-06-15','Maldonado','Rocha','en_control',$2,'2026-06-15T14:00:00Z','2026-06-15T14:00:00Z')`,[openReceipt,administrator]);
  await q(`insert into public.op_recepcion_items(recepcion_id,codigo,nombre,marca,esperado,recibido,updated_by,updated_at)
    values($1,'PEND-360','Producto sin revisar','Marca Pendiente',10,0,$2,'2026-06-15T14:00:00Z')`,[openReceipt,administrator]);
  await login(supervisor);
  const openReceiptDashboard=await dashboard('recepcion',{local:'Maldonado',date_from:'2026-06-15',date_to:'2026-06-15'});
  check(kpis(openReceiptDashboard).receipts,1,'Un control abierto debe figurar como proceso, no como remito ya controlado');
  check(kpis(openReceiptDashboard).shortage,10,'El avance abierto debe mostrar unidades pendientes de revisión');
  check(kpis(openReceiptDashboard).controlled_lines,0,'Una línea sin controlado_at ni marca no recibida todavía no fue revisada');
  check(rawKpi(openReceiptDashboard,'accuracy').value,null,'La coincidencia no debe penalizar una línea que nadie revisó todavía');
  check(rawKpi(openReceiptDashboard,'lead_time').value,null,'Un control abierto no tiene tiempo de cierre');
  check(Number(breakdown(openReceiptDashboard,'differences').rows[0].controlled),0,'El desglose debe distinguir la diferencia pendiente de una revisión terminada');

  await login(employeePunta);
  const employeeInventory=await dashboard('inventario',{local:'Colonia'});
  check(employeeInventory.filters.local,'Punta del Este','Un empleado no debe poder reemplazar su alcance con el filtro enviado');
  check(employeeInventory.scope.supervisor,false,'El RPC debe informar alcance restringido');
  check(kpis(employeeInventory).sessions,1,'El empleado sólo debe ver inventario de su local');
  const employeeGlobal=await dashboard('global',{});
  check(kpis(employeeGlobal).processes,6,'El empleado debe ver procesos donde su local participa y reservas propias');
  check(breakdown(employeeGlobal,'modules').rows.map(row=>Number(row.records)),[1,1,1,1,2],'El alcance del empleado no debe filtrar accidentalmente la reserva auditada propia');
  await rejects(()=>q('select count(*) from public.op_analytics_reservas_base'),/permission denied/i,'Las vistas auxiliares no deben quedar expuestas a clientes autenticados');

  await login(employeeColonia);
  check(kpis(await dashboard('global',{})).processes,5,'Otro empleado sólo debe ver el circuito de Colonia');

  await login(unapproved);
  await rejects(()=>dashboard('global',{}),/no está habilitada/i,'Una cuenta sin aprobar no debe consultar el tablero');
  await login('', 'authenticated');
  await rejects(()=>dashboard('global',{}),/Iniciá sesión/i,'Una sesión sin usuario no debe consultar el tablero');
  await login('', 'anon');
  await rejects(()=>dashboard('global',{}),/(permission denied|Iniciá sesión)/i,'Anon no debe ejecutar el RPC');

  await login(supervisor);
  await rejects(()=>dashboard('desconocido',{}),/Módulo de análisis inválido/i,'El módulo debe validarse');
  await rejects(()=>dashboard('global',{date_from:'2025-02-01',date_to:'2025-01-01'}),/fecha inicial/i,'El rango de fechas debe validarse');
  await rejects(()=>dashboard('global',{local:'Local inexistente'}),/local seleccionado no existe/i,'El supervisor no debe filtrar por un local inexistente');
  await rejects(()=>dashboard('global',[]),/Filtros inválidos/i,'Los filtros deben ser un objeto JSON');
  check(await scalar("select has_function_privilege('anon','public.op_dashboard_360(text,jsonb)','EXECUTE')"),false,'Anon no debe tener permiso EXECUTE');
  check(await scalar("select has_function_privilege('authenticated','public.op_dashboard_360(text,jsonb)','EXECUTE')"),true,'Authenticated debe tener permiso EXECUTE');

  await admin();
  await db.close();
  console.log(`analytics 360 sql integration ok (${checks} checks)`);
}

main().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
