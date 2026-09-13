const fs = require('fs');
const path = require('path');
const vm = require('vm');

const operationsDir = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(operationsDir, 'app.js'), 'utf8');
const repositionSource = fs.readFileSync(path.join(operationsDir, 'reposition-app.js'), 'utf8');
const receptionSource = fs.readFileSync(path.join(operationsDir, 'reception-app.js'), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`No se pudo extraer ${name}`);
  return source.slice(start, end);
}

const context = {};
vm.createContext(context);
vm.runInContext(functionSource(appSource, 'encodeOperationsInlineValue', 'setOperationsStableHtml'), context);
vm.runInContext(functionSource(repositionSource, 'repoEncoded', 'repoDecoded'), context);
vm.runInContext(functionSource(receptionSource, 'receiptEncode', 'receiptDecode'), context);

const maliciousSku = "x')-alert(1)-('";
const encoded = context.encodeOperationsInlineValue(maliciousSku);

if (/[!'()*]/.test(encoded)) throw new Error(`Quedaron caracteres inseguros en el valor codificado: ${encoded}`);
if (decodeURIComponent(encoded) !== maliciousSku) throw new Error('La codificación segura no conserva el SKU original');
if (context.repoEncoded(maliciousSku) !== encoded) throw new Error('Reposición no usa el codificador seguro');
if (context.receiptEncode(maliciousSku) !== encoded) throw new Error('Recepción no usa el codificador seguro');
if (!appSource.includes("encodeOperationsInlineValue(options.secondaryValue || 'secondary')")) {
  throw new Error('El diálogo todavía inserta valores sin el codificador seguro');
}

console.log('OK: los SKU y valores dinámicos quedan aislados en handlers inline');
