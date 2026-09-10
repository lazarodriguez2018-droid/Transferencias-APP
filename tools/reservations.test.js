const assert=require('assert');
const E=require('../reservas/reserva-engine.js');

assert.equal(E.derive([{cantidad:2,cantidad_local:2,cantidad_entregada:0,estado:'separado'}]),'listo','Una reserva completa queda lista');
assert.equal(E.derive([{cantidad:2,cantidad_local:1,cantidad_entregada:0,estado:'recibido'},{cantidad:1,cantidad_local:0,cantidad_entregada:0,estado:'pendiente'}]),'separando','Una reserva mixta permanece separando');
assert.equal(E.derive([{cantidad:1,cantidad_local:0,cantidad_entregada:0,estado:'en_transito'}]),'en_transito','Un pedido enviado se refleja en tránsito');
assert.equal(E.derive([{cantidad:3,cantidad_local:1,cantidad_entregada:1,estado:'recibido'}]),'parcial','Una entrega parcial no cierra la reserva');
assert.equal(E.derive([{cantidad:1,cantidad_local:0,cantidad_entregada:1,estado:'entregado'}],'completado'),'completado','Los estados terminales no se reabren automáticamente');
assert.equal(E.canMarkReady([{cantidad:2,cantidad_local:1,cantidad_entregada:1}]),true,'Mercadería local más entregada satisface lo solicitado');
assert.equal(E.canMarkReady([{cantidad:2,cantidad_local:1,cantidad_entregada:0}]),false,'No se puede marcar lista con faltantes');
assert.equal(E.needsCorrectionReason(2,1),true,'Reducir una cantidad exige motivo');
assert.equal(E.needsCorrectionReason(1,2),false,'Avanzar cantidad no exige corrección');
const base=Date.UTC(2026,8,9,12,0,0);
assert.equal(E.deadlineInfo(new Date(base+48*3600000).toISOString(),base).kind,'ok','El plazo exacto de 48 horas sigue activo');
assert.equal(E.deadlineInfo(new Date(base-1).toISOString(),base).kind,'late','El plazo vencido se identifica');
assert.equal(E.deadlineInfo(new Date(base+6*3600000).toISOString(),base).kind,'soon','La reserva próxima a vencer se destaca');
assert.equal(E.customer({cliente_nombre:'Ana',cliente_apellido:'Suárez'}),'Ana Suárez');
assert.equal(E.customer({}),'Sin cliente');
console.log('reservations engine ok');
