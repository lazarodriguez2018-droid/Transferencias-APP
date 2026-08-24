const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('supabase/migrations/20260824200000_acceso_invitado_qr.sql');
const operations=read('operaciones/index.html');
const host=read('operaciones/session-invite.js');
const guestHtml=read('operaciones/invitado.html');
const guestJs=read('operaciones/invitado.js');
const guestCss=read('operaciones/invitado.css');

assert.match(migration,/token_hash text not null unique/,'La base solo debe guardar el hash del QR');
assert.match(migration,/access_hash text not null unique/,'La credencial del invitado debe guardarse cifrada como hash');
assert.match(migration,/revoke all on table public\.op_invitaciones_sesion from anon,authenticated/,'Las tablas de invitaciones no deben exponerse directamente');
assert.match(migration,/grant execute on function public\.op_invitacion_preview\(text\) to anon,authenticated/,'El enlace debe poder validarse sin iniciar sesión');
assert.match(migration,/grant execute on function public\.op_invitado_operar\(text,text,text,integer,jsonb\) to anon,authenticated/,'El invitado debe operar solo mediante la función controlada');
assert.match(migration,/grant execute on function public\.op_invitado_estado\(text,boolean,text\) to anon,authenticated/,'El invitado debe consultar únicamente el estado controlado');
assert.doesNotMatch(migration,/grant (select|insert|update|delete).*op_invit/i,'Anon no debe recibir permisos directos de lectura o escritura');
assert.match(migration,/La fotografía es obligatoria/,'El ingreso debe exigir foto');
assert.match(migration,/Solamente el creador o un administrador puede invitar colaboradores/,'Solo el creador o administrador debe generar accesos');
assert.match(migration,/repo_claim[\s\S]*for update skip locked/,'Reposición debe asignar productos distintos de forma concurrente');
assert.match(migration,/op_cerrar_invitaciones_sesion[\s\S]*activa=false/,'Cerrar una sesión debe invalidar su invitación');
assert.match(migration,/last_seen<now\(\)-interval '30 days'/,'Las fotos deben tener limpieza por antigüedad');

assert.match(operations,/id="session-invite-fab"/,'El creador debe tener el acceso flotante');
assert.match(operations,/qrcodejs@1\.0\.0/,'Debe poder generar QR en el navegador');
assert.match(host,/\/operaciones\/invitado#/,'El token debe viajar en el fragmento y no en registros del servidor');
assert.match(host,/Compartir enlace/,'Además del QR debe existir un enlace compartible');
assert.match(host,/Pausar acceso|Reactivar acceso/,'El creador debe poder pausar y reactivar');
assert.match(host,/removeSessionGuest/,'El creador debe poder expulsar invitados');

assert.match(guestHtml,/capture="user"/,'El teléfono debe abrir la cámara frontal para la identificación');
assert.match(guestHtml,/Acceso limitado a esta sesión/,'La limitación debe ser visible');
assert.doesNotMatch(guestHtml,/<button[^>]*>[^<]*(descargar|configuración|cambiar de módulo)/i,'La pantalla operativa no debe ofrecer acciones privilegiadas');
assert.match(guestJs,/setInterval\(\(\)=>loadState\(true\),1250\)/,'El estado debe sincronizarse continuamente');
assert.match(guestJs,/p_completo:complete/,'Después de la primera carga se deben pedir actualizaciones livianas');
assert.match(guestJs,/repo_claim/,'El invitado debe poder recibir un producto de reposición');
assert.match(guestJs,/inventory_delta/,'El invitado debe poder contar inventario');
assert.match(guestJs,/receipt_set/,'El invitado debe poder controlar cantidades recibidas');
assert.match(guestJs,/Producto fuera de la lista/,'Los extras deben registrarse de forma explícita');
assert.match(guestJs,/matchesBarcode/,'El escáner debe usar las variantes del código de barras central');
assert.match(guestCss,/@media\(max-width:620px\)/,'La vista debe adaptarse a teléfonos');
assert.match(guestCss,/@media\(max-width:370px\)/,'La vista debe contemplar teléfonos angostos');

console.log('guest-access: OK');
