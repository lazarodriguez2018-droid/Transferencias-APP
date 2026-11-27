const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {createDatabase} = require('./postgres-test-setup');

async function main() {
  const db = await createDatabase();
  const query = async (sql,args=[]) => (await db.query(sql,args)).rows;
  const one = async (sql,args=[]) => Object.values((await query(sql,args))[0])[0];
  const staff = randomUUID();
  const login = async guest => {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub',$1,false)",[guest?'':staff]);
    await db.exec(guest?'set role anon':'set role authenticated');
  };
  await query('insert into auth.users(id) values($1)',[staff]);
  await query("insert into perfiles(id,nombre,apellido,local_nombre,almacen,role,approved) values($1,'Ana','Equipo','Punta del Este','01','empleado',true)",[staff]);
  await login(false);
  const repo = await one("select op_crear_reposicion('Prueba','Punta del Este','Maldonado',$1::jsonb)",
    [JSON.stringify([{codigo:'TEST-1',nombre:'Producto',pedido:2}])]);
  const invite = await one("select op_crear_invitacion_sesion('reposicion',$1)",[repo]);
  const claim = () => one("select op_reposicion_reclamar($1,'TEST-1','dispositivo-A','Ana')",[repo]);
  const save = (time,qty) => one("select op_reposicion_cantidad_vigente($1,'TEST-1',1,null,'encontrado','Ana','dispositivo-A',$2,$3)",[repo,time,qty]);
  const assigned = await claim();
  await save(assigned.asignado_at,0);
  await assert.rejects(()=>save(assigned.asignado_at,0),/cambió/);
  await db.exec('reset role');
  await query("update op_reposicion_dispositivos set last_seen=now()-interval '4 minutes' where reposicion_id=$1",[repo]);
  await login(true);
  const guest = await one("select op_invitacion_unirse($1,'Bruno',$2,'dispositivo-B')",[invite.token,'data:image/png;base64,'+'A'.repeat(120)]);
  const operate = (act,code,qty=null) => one('select op_invitado_operar($1,$2,$3,$4)',[guest.access_token,act,code,qty]);
  await operate('repo_claim',null);
  const state = await one('select op_invitado_estado($1,true)',[guest.access_token]);
  const item = state.items[0];
  assert.equal(item.assigned_client,'');
  assert.equal(item.review.automatica,true);
  const respond = (id,count,sku,token) => one("select op_reposicion_revision($1,'TEST-1',$2,$3,$4,null,$5)",[repo,id,count,sku,token]);
  await assert.rejects(()=>operate('repo_set','TEST-1',2),/Seleccioná/);
  await assert.rejects(()=>respond(item.review.id,1,'OTRO',guest.access_token),/no coincide/);
  await respond(item.review.id,1,'TEST-1',guest.access_token);
  await assert.rejects(()=>respond(item.review.id,2,'TEST-1',guest.access_token),/cambió/);
  await login(false);
  await assert.rejects(()=>save(assigned.asignado_at,1),/cambió/);
  await claim();
  await one("select op_reposicion_revision($1,'TEST-1',null,null,null,'Revisar variante')",[repo]);
  await db.exec('reset role');
  const id = await one("select revision_equipo->>'id' from op_reposicion_items where reposicion_id=$1",[repo]);
  await login(false);
  await assert.rejects(()=>respond(id,2,'TEST-1',null),/otra persona/);
  await assert.rejects(()=>one("select op_reposicion_cerrar_preparacion($1,'Camión')",[repo]),/sin decidir/);
  await login(true);
  await respond(id,2,'TEST-1',guest.access_token);
  await login(false);
  await one("select op_verificar_reposicion_cantidad($1,'TEST-1',2,'Ana')",[repo]);
  await one("select op_reposicion_cerrar_preparacion($1,'Camión')",[repo]);
  await assert.rejects(claim,/no disponible/);
  await db.close();
  console.log('Staff / QR handoff, stale writes, SKU, second opinion, export control and shipment closure passed.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
