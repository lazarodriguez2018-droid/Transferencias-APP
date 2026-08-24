const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260822020000_registration_profile_trigger.sql', 'utf8');
const emailTemplate = fs.readFileSync('supabase/email-templates/confirm-signup.html', 'utf8');

assert(html.includes('Enviamos un enlace y un código'), 'El registro debe ofrecer enlace y código');
assert(html.includes('id="reg-code"'), 'Falta el campo de código OTP');
assert(html.includes('autocomplete="one-time-code"'), 'El código debe integrarse con el autocompletado móvil');
assert(app.includes("verifyOtp({email,token,type:'email'})"), 'Falta verificar el código con Supabase');
assert(app.includes("db.auth.resend({"), 'Falta poder reenviar el correo de registro');
assert(emailTemplate.includes('{{ .ConfirmationURL }}'), 'La plantilla debe incluir el enlace de confirmación');
assert(emailTemplate.includes('{{ .Token }}'), 'La plantilla debe incluir el código de confirmación');
assert(app.includes('sucaneitor_nombre'), 'Falta enviar el nombre como metadata segura');
assert(app.includes('sucaneitor_tipo_cuenta'), 'Falta enviar el tipo de cuenta como metadata segura');
assert(migration.includes('after insert on auth.users'), 'Falta el trigger de alta de perfil');
assert(migration.includes("values(new.id,v_nombre,v_apellido,v_local,v_almacen,v_role,false)"), 'Las cuentas nuevas deben quedar pendientes');

console.log('registration-flow: OK');
