const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const portalHtml = read('index.html');
const portalCss = read('style.css');
const operationsHtml = read('operaciones/index.html');

for (const html of [portalHtml, operationsHtml]) {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable/);
}
assert.match(portalCss, /env\(safe-area-inset-top\)/);
assert.match(portalCss, /env\(safe-area-inset-bottom\)/);
assert.match(portalCss, /@media \(pointer:coarse\) and \(max-width:768px\)/);
assert.match(portalCss, /min-height:46px/);
assert.match(portalCss, /@media \(min-width:769px\) and \(max-width:1100px\)/);
assert.match(portalCss, /\.public-links-modal\{max-width:560px\}/);
assert.match(portalCss, /\.public-link-share\{display:grid;grid-template-columns:132px minmax\(0,1fr\)/);
assert.match(portalCss, /@media\(max-width:420px\)/);
assert.match(portalCss, /@media\(min-width:769px\)\{[\s\S]*\.sidebar\{width:218px\}/);
assert.doesNotMatch(portalCss, /@media \(pointer:coarse\) \{[\s\S]{0,180}\.nav-item[^}]*min-height:46px/,
  'Una PC táctil no debe recibir automáticamente la densidad grande de celular');
assert.match(operationsHtml, /@media\(max-width:700px\)/);
assert.match(operationsHtml, /@media\(max-width:900px\)/);
assert.match(operationsHtml, /env\(safe-area-inset-bottom\)/);
assert.match(operationsHtml, /DM Sans/);
assert.doesNotMatch(operationsHtml, /Sora|JetBrains Mono/);
assert.doesNotMatch(operationsHtml, /data:image\//,
  'Los logotipos deben cargarse como recursos reutilizables, no duplicarse dentro del HTML');
assert.match(portalHtml, /id="global-spinner"[\s\S]*spinner-icon[\s\S]*📦[\s\S]*spinner-ring/,
  'Pedidos debe conservar el indicador corporativo de carga');
assert.match(operationsHtml, /id="operations-boot"[\s\S]*operations-boot-icon[\s\S]*📦[\s\S]*operations-boot-spinner/,
  'Inventario, Reposición y Recepción deben usar el mismo indicador de carga que Pedidos');
assert.match(operationsHtml, /id="operations-boot-text">Cargando\.\.\.<\/span>/,
  'El mensaje base de carga debe ser uniforme');

console.log('responsive-ui: OK');
