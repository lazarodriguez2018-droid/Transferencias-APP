const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const downloads = read('downloads.js');
const portal = read('index.html');
const operations = read('operaciones/index.html');
const orders = read('app.js');
const repo = read('operaciones/reposition-app.js');

// User guidance must retain privacy, expiry and practical next actions.
assert.match(downloads, /esta versión del archivo durante 7 días, sin iniciar sesión/);
assert.match(downloads, /Compartilo solo con personas autorizadas/);
assert.match(downloads, /50 MB/);
assert.match(downloads, /Disponible hasta el/);
assert.match(downloads, /podrás elegir dónde guardar/);
assert.match(downloads, /según la configuración de tu navegador/);
assert.match(downloads, /Copiá el enlace seleccionado/);
assert.doesNotMatch(downloads, /Se sube una copia|mientras se activa|navegador iniciará la descarga/);
assert.doesNotMatch(orders, /el token no se guarda en Supabase|políticas RLS para DELETE|aumentar buffer a/);
assert.match(orders, /Esta referencia no descuenta el stock disponible/);

// Navigation and instructions name the same views; internal routing IDs stay stable.
assert.match(portal, /id="nav-dashboard" data-nav="dashboard"/);
assert.match(portal, /Resumen de pedidos/);
assert.match(operations, /id="tab-dashboard"><span class="tab-icon">▦<\/span><span>Resumen<\/span>/);
assert.match(operations, /Cargá el balance en Resumen/);
assert.match(operations, /estas sugerencias no cambian el conteo/);
assert.match(operations, /podés marcar varios/);
assert.match(operations, /sin reservar productos/);
assert.match(operations, /Reemplazará el padrón de todos los módulos/);
assert.doesNotMatch(operations, /Descargas verificables|Control verificable|El informe analiza todo/);
assert.match(repo, /Ver este producto no lo reserva para vos/);
assert.doesNotMatch(repo, /Este producto está libre para los colaboradores/);

for (const file of ['index.html', 'operaciones/index.html']) {
  assert.match(read(file), /downloads\.js\?v=user-copy-v1/);
}
assert.match(read('operaciones/invitado.html'), /invitado\.js\?v=user-copy-v1/);
assert.match(operations, /session-invite\.js\?v=user-copy-v1/);
console.log('user-copy: OK — actionable guidance, consistent labels, privacy and honest messages');
