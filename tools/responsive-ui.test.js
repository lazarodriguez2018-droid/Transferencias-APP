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
assert.match(portalCss, /@media \(pointer:coarse\)/);
assert.match(portalCss, /min-height:46px/);
assert.match(portalCss, /@media \(min-width:769px\) and \(max-width:1100px\)/);
assert.match(operationsHtml, /@media\(max-width:700px\)/);
assert.match(operationsHtml, /@media\(max-width:900px\)/);
assert.match(operationsHtml, /env\(safe-area-inset-bottom\)/);
assert.match(operationsHtml, /DM Sans/);
assert.doesNotMatch(operationsHtml, /Sora|JetBrains Mono/);
assert.doesNotMatch(operationsHtml, /data:image\//,
  'Los logotipos deben cargarse como recursos reutilizables, no duplicarse dentro del HTML');

console.log('responsive-ui: OK');
