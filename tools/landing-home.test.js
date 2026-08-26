const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'landing.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('id="landing-page"'), 'La portada comercial debe ser la primera pantalla.');
assert(html.includes('Entrar a la web de mi empresa'), 'Debe existir el acceso destacado para clientes.');
assert(html.includes('id="empresa-clave"') && html.includes('placeholder="Ej.: SUCAN"'), 'La portada debe solicitar la clave de empresa.');
assert(html.includes('id="auth-forms" style="display:none"'), 'El login y el registro deben permanecer ocultos antes de validar la clave.');
assert(html.includes('id="contact-form"'), 'Debe existir un formulario de contacto al final de la portada.');
assert(html.includes('No obligamos a tu empresa a adaptarse al sistema.'), 'Debe comunicarse claramente el enfoque personalizado.');

['INVENTARIO', 'REPOSICIÓN', 'CONTROL DE REMITOS', 'PEDIDOS ENTRE LOCALES'].forEach(moduleName => {
  assert(html.includes(moduleName), `Falta presentar el módulo ${moduleName}.`);
});

['inventory-search.png', 'modules-overview.svg', 'final-reports.png', 'public-access-qr.svg'].forEach(file => {
  assert(html.includes(file), `Falta la captura ${file} en la portada.`);
  assert(fs.existsSync(path.join(root, 'assets', 'showcase', file)), `No existe el archivo visual ${file}.`);
});

assert(css.includes('@media (max-width: 980px)') && css.includes('@media (max-width: 650px)'), 'La portada debe adaptarse a tablet y celular.');
assert(css.includes('.company-key-control') && css.includes('.contact-form-grid'), 'Faltan estilos para acceso o contacto.');
assert(app.includes("showPage(checkEmpresaClave()?'auth-page':'landing-page')"), 'Sin sesión, la navegación debe elegir entre portada y acceso validado.');
assert(app.includes("showPage('auth-page');\n  await populateRegisterLocales()"), 'La clave válida debe revelar el login y el registro.');
assert(app.includes("claveNormalizada==='SUCAN'"), 'La clave comercial SUCAN debe estar disponible aunque la configuración histórica todavía no esté normalizada.');
assert(app.includes("showPage('landing-page');"), 'Debe poder volver desde el acceso a la portada.');
assert(app.includes('function enviarConsultaComercial(event)'), 'El formulario de contacto debe tener una acción funcional.');

console.log('landing-home: OK');
