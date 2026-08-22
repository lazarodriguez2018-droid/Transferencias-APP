'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('function normalizeAnalysisText');
const end = source.indexOf('function buildDifferenceRows');
assert(start >= 0 && end > start, 'No se encontró el motor de análisis en app.js');

const context = vm.createContext({ console });
vm.runInContext(
  source.slice(start, end) +
  '\nthis.analysis = { productAnalysisProfile, compareCompensationPair };',
  context
);

const { productAnalysisProfile, compareCompensationPair } = context.analysis;

function row(nombre, diff) {
  const base = { nombre, marca: 'BIOFRESH', diff };
  return { ...base, profile: productAnalysisProfile(base) };
}

function compare(shortageName, surplusName, shortageDiff = -1, surplusDiff = 1) {
  return compareCompensationPair(row(shortageName, shortageDiff), row(surplusName, surplusDiff));
}

// La presentación es una barrera estricta.
assert.strictEqual(compare(
  'BIOFRESH PERRO ADULTO MEDIANO 3 KG',
  'BIOFRESH PERRO ADULTO MEDIANO 15 KG'
), null);

// Una única variante plausible puede ser de confianza alta.
const oneVariant = compare(
  'BIOFRESH PERRO ADULTO RAZA PEQUEÑA 10 KG',
  'BIOFRESH PERRO ADULTO RAZA MEDIANA 10 KG'
);
assert(oneVariant && oneVariant.differenceCount === 1);
assert(oneVariant.score >= 86);

// Dos cambios simultáneos deben bajar de confianza alta.
const twoVariants = compare(
  'BIOFRESH GATO CACHORRO SALMON 7.5 KG',
  'BIOFRESH GATO ADULTO POLLO 7.5 KG'
);
assert(twoVariants && twoVariants.differenceCount === 2);
assert(twoVariants.score < 86);

// También se analizan accesorios con el mismo tamaño y distinto color.
const accessory = compareCompensationPair(
  { ...row('JUGUETE PEPITO HUESO DIAMANTE VERDE S', -1), profile: productAnalysisProfile({nombre:'JUGUETE PEPITO HUESO DIAMANTE VERDE S', marca:'PEPITO'}) },
  { ...row('JUGUETE PEPITO HUESO DIAMANTE VIOLETA S', 1), profile: productAnalysisProfile({nombre:'JUGUETE PEPITO HUESO DIAMANTE VIOLETA S', marca:'PEPITO'}) }
);
assert(accessory && accessory.reasons.some(reason => reason.startsWith('color:')));

console.log(`OK: peso estricto; 1 variante ${oneVariant.score}%; 2 variantes ${twoVariants.score}%; accesorios ${accessory.score}%`);
