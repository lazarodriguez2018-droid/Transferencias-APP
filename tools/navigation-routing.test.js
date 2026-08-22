const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const portalHtml = read('index.html');
const portalJs = read('app.js');
const portalCss = read('style.css');
const operationsHtml = read('operaciones/index.html');
const operationsJs = read('operaciones/app.js');
const cloudConfig = read('operaciones/cloud-config.js');

assert.match(operationsHtml, /<base href="\/operaciones\/">/,
  'Operaciones debe conservar su base al publicarse como URL limpia');
assert.match(portalHtml, /href="\/operaciones\?module=inventario"/);
assert.match(portalHtml, /href="\/operaciones\?module=reposicion"/);
assert.match(operationsHtml, /href="\/\?module=pedidos"/,
  'Pedidos entre locales debe ser un enlace normal y funcionar sin JavaScript inline');
assert.match(operationsHtml, /href="\/">Volver al inicio<\/a>/);
assert.match(operationsJs, /const requestedModule = new URLSearchParams\(location\.search\)\.get\('module'\);[\s\S]*document\.getElementById\('module-screen'\)\.style\.display = 'none';/,
  'El módulo solicitado debe ocultar el selector antes de cargar el padrón');
assert.match(cloudConfig, /portalUrl:\s*'\/'/);
assert.match(cloudConfig, /pedidosUrl:\s*'\/\?module=pedidos'/);
assert.ok(portalJs.includes("if(/^\\/operaciones\\/?(?:\\?[^#]*)?$/.test(returnTo)){"),
  'El retorno autenticado debe aceptar /operaciones con o sin barra final');
assert.match(portalJs, /classList\.toggle\('hub-mode',view==='hub'\)/);
assert.match(portalCss, /#app-page\.hub-mode \.sidebar[\s\S]*display:none !important/,
  'El selector inicial no debe mostrar la barra lateral');

console.log('navigation-routing: OK');
