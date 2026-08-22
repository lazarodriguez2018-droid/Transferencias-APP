'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Search = require('../search-engine.js');

const root = path.resolve(__dirname, '..');
const products = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'padron_global.json'), 'utf8')).padron;
const sessions = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'sesiones.json'), 'utf8'));
const index = Search.createSearchIndex(products);

function names(query, context, limit = 10) {
  return Search.rankProducts(index, query, context || null, limit).map(result => result.product.nombre);
}

function codes(query, context, limit = 10) {
  return Search.rankProducts(index, query, context || null, limit).map(result => result.product.codigo);
}

function contextFor(sessionId) {
  const session = sessions[sessionId];
  return Search.createContext(index, {
    sessionName: session.nombre,
    countItems: session.state.countItems,
    actionLog: session.state.log
  });
}

// Abreviaturas, palabras parciales, acentos, orden libre y pequeños errores.
assert(codes('bio cach med', null, 5).includes('113352'));
assert.strictEqual(codes('biofres cach med 15', null, 1)[0], '113352');
assert.strictEqual(codes('15 med cach bio', null, 1)[0], '113352');
assert(names('roy can pup 15').every(name => /ROYAL CANIN/i.test(name)));
assert.strictEqual(codes('sach pro per ad poll', null, 1)[0], '12341823');
assert.strictEqual(codes('neo aren reen', null, 1)[0], '1306');
assert.strictEqual(codes('chap big paw black', null, 1)[0], 'GL02BIGBLACK');
assert.strictEqual(codes('frost sens peq 2.5', null, 1)[0], 'IFRFR025');
assert(names('monge gat tonn azul', null, 3).some(name => /MONGE.*GATO.*TONNO/i.test(name)));

// Inglés, español, géneros, plurales y presentaciones mixtas del padrón.
assert(names('royal canin perro pequeno adulto 3', null, 5).some(name => /ROYAL CANIN PERRO MINI ADULT.*3 KG/i.test(name)));
assert(names('royal canin perro mediano cachorro 15', null, 5).some(name => /MEDIUM PUPPY 15 KG/i.test(name)));
assert(names('royal canin gato gatito 1.5', null, 5).some(name => /GATO KITTEN.*1\.5 KG/i.test(name)));
assert(names('monge pato adulto 12', null, 5).some(name => /MONGE PERRO.*ADULT DUCK 12 KG/i.test(name)));
assert(names('gato castrado atun', null, 6).some(name => /STERILISED.*TUNA|ESTERILISED.*TUNA/i.test(name)));
assert(names('piel sensible pro plan', null, 5).every(name => /SENSITIVE SKIN/i.test(name)));
assert(names('sin cereales gato', null, 5).every(name => /GRAIN FREE/i.test(name)));
assert(names('bola de pelo hills gato', null, 5).every(name => /HAIRBALL/i.test(name)));
assert.strictEqual(names('pechera azul oscuro mediano dingo', null, 1)[0], 'DINGO Harness Design Dark Blue M');
assert.strictEqual(names('arnes turquesa mediano dingo', null, 1)[0], 'DINGO Padded Harness Turquoise M');
assert(names('juguete pelota amarillo', null, 3).some(name => /BALL TOY.*YELLOW/i.test(name)));

// Cada aparición de estos términos ingleses debe poder recuperarse usando su
// equivalente habitual en español, no solamente los ejemplos de arriba.
const translationCases = [
  ['adult', 'adulto'], ['puppy', 'cachorro'], ['kitten', 'gatito'],
  ['dog', 'perro'], ['dogs', 'perro'], ['cat', 'gato'], ['cats', 'gato'],
  ['small', 'pequeno'], ['medium', 'mediano'], ['large', 'grande'],
  ['black', 'negro'], ['white', 'blanco'], ['red', 'rojo'], ['blue', 'azul'],
  ['green', 'verde'], ['orange', 'naranja'], ['pink', 'rosa'],
  ['yellow', 'amarillo'], ['purple', 'violeta'], ['brown', 'marron'],
  ['gray', 'gris'], ['grey', 'gris'], ['turquoise', 'turquesa'], ['dark', 'oscuro'],
  ['chicken', 'pollo'], ['lamb', 'cordero'], ['turkey', 'pavo'], ['duck', 'pato'],
  ['pork', 'cerdo'], ['fish', 'pescado'], ['tuna', 'atun'], ['tonno', 'atun'],
  ['rabbit', 'conejo'], ['rice', 'arroz'], ['food', 'alimento'],
  ['toy', 'juguete'], ['ball', 'pelota'], ['bone', 'hueso'], ['bowl', 'comedero'],
  ['bed', 'cama'], ['leash', 'correa'], ['harness', 'arnes'], ['brush', 'cepillo'],
  ['pads', 'panales'], ['carrier', 'transportadora'], ['scratcher', 'rascador'],
  ['litter', 'arena'], ['rubber', 'goma'], ['mesh', 'malla'],
  ['aluminum', 'aluminio'], ['reflective', 'reflectivo'],
  ['waterproof', 'impermeable'], ['soft', 'suave'], ['slow', 'lento'],
  ['training', 'entrenamiento'], ['indoor', 'interior'], ['outdoor', 'exterior'],
  ['skin', 'piel'], ['sterilised', 'castrado'], ['sterilized', 'castrado'],
  ['neutered', 'castrado'], ['weight', 'peso'], ['sensitive', 'sensible'],
  ['digestive', 'digestivo'], ['urinary', 'urinario'], ['kidney', 'rinon'],
  ['liver', 'higado'], ['joint', 'articulaciones'], ['mobility', 'movilidad'],
  ['calming', 'calma'], ['hypoallergenic', 'hipoalergenico'],
  ['wipes', 'toallitas'], ['bottle', 'botella'], ['dispenser', 'dispensador'],
  ['scoop', 'pala'], ['house', 'casa'], ['sweater', 'buzo'], ['muzzle', 'bozal'],
  ['flea', 'pulga'], ['recipe', 'receta']
];

let translatedProductChecks = 0;
for (const [english, spanish] of translationCases) {
  const affected = index.filter(entry => entry.nameTokens.includes(english));
  assert(affected.length > 0, `Caso sin productos en el padrón: ${english}`);
  for (const entry of affected) {
    assert(Search.matchesEntry(entry, spanish), `No traduce ${spanish} -> ${english}: ${entry.product.nombre}`);
    translatedProductChecks++;
  }
}

for (const [english, spanish] of [
  ['grain', 'sin cereales'],
  ['hairball', 'bola de pelo'],
  ['navy', 'azul marino']
]) {
  const affected = index.filter(entry => entry.nameTokens.includes(english));
  assert(affected.length > 0, `Frase sin productos en el padrón: ${english}`);
  for (const entry of affected) {
    assert(Search.matchesEntry(entry, spanish), `No traduce frase ${spanish} -> ${english}: ${entry.product.nombre}`);
    translatedProductChecks++;
  }
}

// El contexto de la sesión cambia el orden, sin inventar coincidencias.
const proPlanContext = contextFor('proplan170426');
assert.strictEqual(proPlanContext.label, 'PRO PLAN · Raciones');
assert(names('cachorro mediana 3', proPlanContext, 2).every(name => /^PRO PLAN/i.test(name)));

const biofreshContext = contextFor('biofresh170826');
assert.strictEqual(biofreshContext.label, 'BIOFRESH · Raciones');
assert(names('cach med', biofreshContext, 3).every(name => /^BIOFRESH/i.test(name)));

const wetContext = contextFor('stockhumedos');
assert.strictEqual(wetContext.label, 'Húmedos');
assert(names('adulto perro', wetContext, 5).every(name => /SACHET|LATA|PATE|PATÉ|POUCH/i.test(name)));

const tagContext = contextFor('stockchapitas220426');
assert.strictEqual(tagContext.label, 'Chapitas');
assert(names('black', tagContext, 8).every(name => /CHAPITA/i.test(name)));
assert(names('bio cach med', tagContext, 3).every(name => /BIOFRESH/i.test(name)));

// Código interno: exactos primero y parciales después.
assert.strictEqual(Search.searchByCode(index, '113352', 1)[0].product.codigo, '113352');

// Todo el padrón se indexa y cada producto acepta una consulta abreviada creada
// a partir de su propio nombre. Además, una muestra distribuida verifica el
// orden real dentro de los primeros diez resultados.
let foundInTop10 = 0;
let rankedSamples = 0;
for (let productIndex = 0; productIndex < products.length; productIndex++) {
  const product = products[productIndex];
  const terms = Search.tokenize(product.nombre)
    .filter(term => term.length >= 2 && term !== 'obsequio')
    .slice(0, 4)
    .map(term => term.length >= 4 ? term.slice(0, 3) : term);
  if (!terms.length) continue;
  const query = terms.join(' ');
  assert(Search.matchesEntry(index[productIndex], query), `No recuperable: ${product.codigo}: ${query}`);
  if (productIndex % 23 !== 0) continue;
  rankedSamples++;
  const result = Search.rankProducts(index, query, null, 10);
  assert(result.length > 0, `Sin resultados para ${product.codigo}: ${terms.join(' ')}`);
  if (result.some(item => item.product.codigo === product.codigo)) foundInTop10++;
}

const top10Coverage = foundInTop10 / rankedSamples;
assert(top10Coverage >= 0.70, `Cobertura top-10 insuficiente: ${(top10Coverage * 100).toFixed(1)}%`);

console.log(`OK: ${products.length} productos indexados; ${translatedProductChecks} traducciones verificadas; ${rankedSamples} rankings; cobertura top-10 ${(top10Coverage * 100).toFixed(1)}%`);
