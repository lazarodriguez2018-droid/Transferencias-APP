const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const Search = require(path.join(root, 'operaciones', 'search-engine.js'));
const products = require(path.join(root, 'products.json'));
const receipt = fs.readFileSync(path.join(root, 'operaciones', 'reception-app.js'), 'utf8');
const repo = fs.readFileSync(path.join(root, 'operaciones', 'reposition-app.js'), 'utf8');
const guest = fs.readFileSync(path.join(root, 'operaciones', 'invitado.js'), 'utf8');
const inventory = fs.readFileSync(path.join(root, 'operaciones', 'app.js'), 'utf8');
const orders = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const started = performance.now();
const index = Search.createSearchIndex(products);
const indexedAt = performance.now();
const queries = ['dog chow adulto', 'bio cachorro mediano', '12549078', 'royal canin', 'alimento gato', 'pipeta perro'];
for (const query of queries) {
  const results = Search.rankProducts(index, query, null, 30);
  assert(Array.isArray(results), `La búsqueda debe responder para: ${query}`);
}
const completed = performance.now();

assert.match(receipt, /receiptSearchIndexCache/);
assert.match(receipt, /receiptProductSearchTimers/);
assert.doesNotMatch(receipt, /const source=receiptSearchSource\(\),index=SucaneitorSearch\.createSearchIndex/,
  'Recepción no debe reconstruir el índice con cada tecla');
assert.match(repo, /repoProductSearchTimers/);
assert.match(guest, /guestSearchTimer/);
assert.match(inventory, /searchContextCache/);
assert.match(inventory, /barcodeAssignmentSearchTimer/);
assert.match(orders, /productSearchTextCache=new WeakMap/);

const rankingMs = completed - indexedAt;
assert(rankingMs < 350, `Las seis búsquedas tardaron ${rankingMs.toFixed(1)} ms`);
console.log(`search-performance: OK (índice ${Math.round(indexedAt-started)} ms; seis búsquedas ${rankingMs.toFixed(1)} ms)`);
