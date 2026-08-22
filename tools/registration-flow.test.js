const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260822020000_registration_profile_trigger.sql', 'utf8');

assert(html.includes('Te enviamos un enlace de confirmación'), 'El registro debe explicar que Supabase envía un enlace');
assert(!html.includes('id="reg-code"'), 'No debe quedar el campo de código OTP');
assert(!app.includes('verifyOtp('), 'El cliente no debe depender de un código OTP');
assert(app.includes('sucaneitor_nombre'), 'Falta enviar el nombre como metadata segura');
assert(app.includes('sucaneitor_tipo_cuenta'), 'Falta enviar el tipo de cuenta como metadata segura');
assert(migration.includes('after insert on auth.users'), 'Falta el trigger de alta de perfil');
assert(migration.includes("values(new.id,v_nombre,v_apellido,v_local,v_almacen,v_role,false)"), 'Las cuentas nuevas deben quedar pendientes');

console.log('registration-flow: OK');
