const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const repo = fs.readFileSync(path.join(root, 'reposition-app.js'), 'utf8');
const reception = fs.readFileSync(path.join(root, 'reception-app.js'), 'utf8');
const guest = fs.readFileSync(path.join(root, 'invitado.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const executable = `${app}\n${repo}\n${reception}`.replace(/\/\/[^\n]*/g, '');

assert.strictEqual(/\b(?:alert|confirm|prompt)\s*\(/.test(executable), false, 'No deben quedar cuadros nativos del navegador');
assert(html.includes('id="app-dialog-overlay"'), 'Falta el diálogo corporativo');
assert(app.includes('function appConfirm('), 'Falta confirmación corporativa');
assert(app.includes('function appPrompt('), 'Falta formulario corporativo');
assert(app.includes('options.secondaryText'), 'El diálogo corporativo debe admitir una acción secundaria');
assert(repo.includes('REPO_NOT_FOUND_REASONS'), 'Falta catálogo de motivos');
assert(repo.includes("{code:'stock_insuficiente', label:'Stock insuficiente'}"), 'Falta Stock insuficiente');
assert(repo.includes("{code:'otro', label:'Otro'}"), 'Falta la opción Otro');
assert.strictEqual((repo.match(/\{code:/g) || []).length, 2, 'Debe haber exactamente dos motivos');
assert(repo.includes('repo-not-found-comment'), 'Falta el comentario de no encontrado');
assert.strictEqual(repo.includes('Seleccioná un motivo antes de continuar.'), false, 'El motivo no debe ser obligatorio');
assert(html.includes('repo-decision-found') && html.includes('repo-decision-missing') && html.includes('repo-decision-scan'), 'Faltan las tres decisiones principales de reposición');
assert(guest.includes('guest-decision-found') && guest.includes('guest-decision-missing') && guest.includes('guest-decision-scan'), 'El acceso QR debe conservar las tres decisiones principales');
assert.strictEqual(html.includes("downloadRepoExport('missing')"), false, 'Faltantes XLSX ya no debe mostrarse en Resumen');
assert.strictEqual(html.includes("downloadRepoExport('summary')"), false, 'Resumen XLSX ya no debe mostrarse en Resumen');
const exportSection = repo.slice(repo.indexOf('async function repoGenerateExports'), repo.indexOf('function repoDownloadBuffer'));
assert.strictEqual(exportSection.includes("type:'missing'"), false, 'El ZIP no debe incluir Faltantes XLSX');
assert.strictEqual(exportSection.includes("type:'summary'"), false, 'El ZIP no debe incluir Resumen XLSX');

console.log('ui-dialogs: OK');
