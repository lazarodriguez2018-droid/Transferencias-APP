const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'company-access.js'), 'utf8');
const handler = require('../api/company-access.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(method, body) {
  let statusCode = 200;
  let payload = null;
  const headers = {};
  const req = { method, body };
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status(value) { statusCode = value; return this; },
    json(value) { payload = value; return this; }
  };
  handler(req, res);
  return { statusCode, payload, headers };
}

assert(!source.toLowerCase().includes('tsucan2026'), 'La clave privada no debe aparecer en el endpoint.');
assert(/SUCAN_KEY_HASH\s*=\s*'[a-f0-9]{64}'/.test(source), 'El endpoint debe comparar un hash SHA-256.');

const wrongMethod = run('GET', null);
assert(wrongMethod.statusCode === 405, 'El endpoint solo debe admitir POST.');

const wrongKey = run('POST', { key: 'clave-invalida' });
assert(wrongKey.statusCode === 401 && wrongKey.payload?.ok === false, 'Una clave incorrecta debe rechazarse sin revelar detalles.');
assert(wrongKey.headers['Cache-Control'] === 'no-store, max-age=0', 'La respuesta de acceso no debe guardarse en caché.');

if (process.env.LABAMA_COMPANY_TEST_KEY) {
  const validKey = run('POST', { key: process.env.LABAMA_COMPANY_TEST_KEY });
  assert(validKey.statusCode === 200 && validKey.payload?.nombre === 'SUCAN', 'La clave configurada debe habilitar SUCAN.');
}

console.log('company-access: OK');
