const assert = require('assert');
const fs = require('fs');
const path = require('path');
const barcode = require('../barcode-utils.js');

const rows = [
  [],
  ['', 'Padrón de Mercaderías'],
  [],
  ['', 'Código', 'Código de Barras', 'Nombre', 'Merc. Padre', 'Unidad Base', 'Envase', 'Impuesto', 'Fabricante', 'Marca', 'Tipo Producto'],
  ['', '.5411388910006', '.5411388910006', 'NESTOR', '', '', '', 'I1', 'DISHER LTDA', 'SAVIC', 'Mercadería / Simple'],
  ['', '010031110010408', '7908253608628', 'CORREA ZEE DOG - SELVA - XS', '', '', '', 'I1', 'A Y N', 'ZEE DOG', 'Mercadería / Simple'],
  ['', '10502199BL', '5415341000551BL', 'COMEDERO M-PETS SLOW - BLANCO', '', '', '', 'I1', 'IMPORTADOR', 'M-PETS', 'Mercadería / Simple'],
  ['', '10502199CE', '5415341000551CE', 'COMEDERO M-PETS SLOW - CELESTE', '', '', '', 'I1', 'IMPORTADOR', 'M-PETS', 'Mercadería / Simple'],
  ['', 'SINBARRA', '', 'PRODUCTO SIN BARRAS', '', '', '', 'I1', '', '', 'Mercadería / Simple']
];

const parsed = barcode.parseCatalogRows(rows);
assert.strictEqual(parsed.ok, true);
assert.strictEqual(parsed.products.length, 5);
assert.strictEqual(parsed.stats.barcodeProducts, 4);
assert.strictEqual(parsed.stats.withoutBarcode, 1);
assert.strictEqual(parsed.stats.duplicateBarcodes, 0);
assert.strictEqual(parsed.products[0].codigo, '.5411388910006', 'Debe conservar puntos y ceros del identificador');
assert.strictEqual(parsed.products[1].codigo, '010031110010408', 'Debe conservar ceros iniciales del SKU');
assert.strictEqual(parsed.products[1].barras, '7908253608628');

assert.strictEqual(barcode.matchesBarcode('.5411388910006', '5411388910006'), true, 'El lector puede omitir el punto inicial heredado');
assert.strictEqual(barcode.matchesBarcode('5415341000551BL', '5415341000551'), true, 'El código base debe reconocer variantes de color');
assert.strictEqual(barcode.matchesBarcode(']E07908253608628', '7908253608628'), true, 'Debe ignorar el prefijo de simbología del escáner');
assert.strictEqual(barcode.matchesBarcode('07908253608628', '7908253608628'), true, 'Debe tolerar el cero de EAN/UPC');
assert.strictEqual(barcode.cleanIdentifier('7.908253608628E+12'), '7908253608628', 'Debe expandir notación científica sin redondear');

const withoutBarcodeColumn = barcode.parseCatalogRows([
  ['Código', 'Nombre'],
  ['A1', 'Producto']
]);
assert.strictEqual(withoutBarcodeColumn.ok, false);
assert.match(withoutBarcodeColumn.error, /Código de Barras/);

const emptyBarcodeColumn = barcode.parseCatalogRows([
  ['Código', 'Código de Barras', 'Nombre'],
  ['A1', '', 'Producto']
]);
assert.strictEqual(emptyBarcodeColumn.ok, false);
assert.match(emptyBarcodeColumn.error, /está vacía/);

const root = path.resolve(__dirname, '..');
const official = JSON.parse(fs.readFileSync(path.join(root, 'products.json'), 'utf8'));
const officialWithBarcode = official.filter(product => barcode.normalizeBarcode(product.barras));
assert.strictEqual(official.length, 6476, 'El padrón oficial adjunto debe quedar incluido completo');
assert.strictEqual(officialWithBarcode.length, 5547, 'Debe conservar todos los códigos de barras detectados');

const exactScan = official.filter(product => barcode.matchesBarcode(product.barras, '7908253608628'));
assert.deepStrictEqual(exactScan.map(product => product.codigo), ['010031110010408']);
const wipes = official.find(product => product.codigo === '60106501');
assert.strictEqual(wipes?.barras, '6953182766674',
  'La reposición debe reconocer la barra vigente de las toallitas MPETS por su SKU');
const colorScan = official.filter(product => barcode.matchesBarcode(product.barras, '5415341000551'));
assert.deepStrictEqual(colorScan.map(product => product.codigo).sort(), ['10502199BL','10502199CE','10502199VE']);
assert.strictEqual(official.some(product => barcode.matchesBarcode(product.barras, '9999999999999')), false);

const portalHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const operationsHtml = fs.readFileSync(path.join(root, 'operaciones', 'index.html'), 'utf8');
const portalApp = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const operationsApp = fs.readFileSync(path.join(root, 'operaciones', 'app.js'), 'utf8');
const cloudApi = fs.readFileSync(path.join(root, 'operaciones', 'cloud-api.js'), 'utf8');
assert.match(portalHtml, /accept="\.xls,\.xlsx"/);
assert.match(operationsHtml, /\/barcode-utils\.js/);
assert.match(operationsHtml, /cloud-api\.js\?v=user-copy-v1/);
assert.match(portalApp, /raw:false/);
assert.match(operationsApp, /raw: false/);
assert.match(cloudApi, /catalogWithSafeFallback/);
assert.match(cloudApi, /nativeFetch\('\/products\.json'/);
assert.match(cloudApi, /cloud\.isSupervisor\(\) && !catalogRestoreAttempted/);
assert.match(cloudApi, /reemplazar_padron_productos.*payload:bundled/);

console.log('barcode-catalog: OK');
