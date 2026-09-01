const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'landing.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(!html.includes('id="landing-page"'), 'La portada comercial ya no debe existir como pantalla pública.');
assert(html.includes('id="company-page"'), 'La clave debe solicitarse en una pantalla independiente.');
assert(html.includes('id="company-page" class="page company-page active" style="display:flex"'), 'El código de empresa debe ser la única pantalla pública inicial.');
assert(html.includes('id="empresa-clave"') && html.includes('placeholder="Ingresá tu clave privada"'), 'La pantalla privada debe solicitar la clave sin mostrar ejemplos.');
assert(!html.includes('Ej.: SUCAN') && !html.toLowerCase().includes('tsucan2026'), 'La portada nunca debe revelar la clave de una organización.');
assert(html.includes('id="auth-forms" style="display:none"'), 'El login y el registro deben permanecer ocultos antes de validar la clave.');
assert(css.includes('@media (max-width: 980px)') && css.includes('@media (max-width: 650px)'), 'El acceso debe adaptarse a tablet y celular.');
assert(css.includes('.company-key-control'), 'Faltan estilos para el acceso de empresa.');
assert(css.includes('.company-gate-main') && css.includes('.company-gate-card'), 'La pantalla privada debe tener diseño propio.');
assert(app.includes("showPage(checkEmpresaClave()?'auth-page':'company-page')"), 'Sin sesión, la navegación debe elegir entre código de empresa y acceso validado.');
assert(app.includes("showPage('auth-page');\n  await populateRegisterLocales()"), 'La clave válida debe revelar el login y el registro.');
assert(app.includes("fetch('/api/company-access'"), 'La clave privada debe validarse del lado del servidor.');
assert(!app.toLowerCase().includes('tsucan2026'), 'La clave privada no debe quedar incluida en el JavaScript público.');
assert(app.includes("!validatedByPrivateEndpoint&&normalizeText(data.nombre).includes('sucan')"), 'Las claves históricas de SUCAN deben quedar deshabilitadas.');
assert(!app.includes("showPage('landing-page');"), 'Ningún flujo debe volver a la portada retirada.');
assert(app.includes("showPage('company-page');"), 'Cerrar sesión debe volver al código de empresa.');

console.log('landing-home: OK');
