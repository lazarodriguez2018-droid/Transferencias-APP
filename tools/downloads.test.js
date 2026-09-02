const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'downloads.js'), 'utf8');

function setup() {
  const calls = [];
  class Element {
    constructor(tag) { this.tag = tag; this.events = {}; this.nodes = new Map(); this.value = ''; this.hidden = false; this.classList = {toggle() {}}; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, callback) { this.events[type] = callback; }
    querySelector(selector) {
      if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(selector));
      return this.nodes.get(selector);
    }
    appendChild(node) { calls.push(['append', node.tag]); }
    click() { if (this.disabled) return; calls.push(['click', this.tag, this.download]); return this.events.click?.(); }
    remove() { calls.push(['remove', this.tag]); }
    focus() { calls.push(['focus', this.tag]); }
    select() { calls.push(['select', this.tag]); }
    showModal() { calls.push(['showModal']); }
    close() { this.events.close?.(); }
  }
  const document = {documentElement: {style: {overflow: 'auto'}}, body: new Element('body'), activeElement: new Element('opener'), createElement: tag => new Element(tag)};
  const storage = {
    async upload(...args) { assert.equal(args[1].type, 'application/octet-stream'); calls.push(['upload', ...args]); return {}; },
    async createSignedUrl(...args) { calls.push(['sign', ...args]); return {data: {signedUrl: 'https://example.test/storage/v1/object/sign/file?token=test&download=remito.xls'}}; },
    async remove(paths) { calls.push(['cleanup', paths]); return {}; }
  };
  const client = {
    auth: {async getUser() { return {data: {user: {id: 'owner-id'}}}; }},
    storage: {from(bucket) { calls.push(['bucket', bucket]); return storage; }}
  };
  const window = {
    document, isSecureContext: true, navigator: {clipboard: {async writeText(text) { calls.push(['clipboard', text]); }}},
    URL: {createObjectURL: () => 'blob:local-only', revokeObjectURL: value => calls.push(['revoke', value])},
    setTimeout(callback, ms) { calls.push(['timer', ms]); }, crypto: {randomUUID: () => 'unique-id'}, console,
    fetch: async () => ({ok: true, blob: async () => new Blob(['original'])}),
    SucanCloud: {db: client}
  };
  const context = {window, module: {exports: {}}, Blob, URL, console};
  vm.runInNewContext(source, context);
  return {api: context.module.exports, window, calls, storage, client};
}

async function main() {
  let test = setup();
  const {api} = test;
  assert.equal(api.fileName('Remito de José', '.xls'), 'Remito de José.xls');
  assert.equal(api.fileName('remito.XLS', '.xls'), 'remito.xls');
  assert.equal(api.fileName('../CON', '.xlsx'), '_CON.xlsx');
  assert.equal(api.fileName('CON', '.xlsx'), '_CON.xlsx');
  assert.equal(api.fileName('a/b:c*?', '.zip'), 'a_b_c__.zip');
  assert.equal(api.fileName('a\r\nb\u202e', '.csv'), 'a__b_.csv');
  assert.throws(() => api.fileName(' . ', '.xls'), /nombre/);
  assert.equal(api.fileName('a'.repeat(100), '.xls').length, 84);
  assert.equal(api.splitName('Original.XLSX').extension, '.XLSX');

  const blob = new Blob(['archivo de prueba']);
  let saved = await api.saveFile(blob, 'Prueba.xls');
  assert.equal(saved.status, 'started');
  assert(test.calls.some(call => call[0] === 'click' && call[2] === 'Prueba.xls'));
  assert(test.calls.some(call => call[0] === 'timer' && call[1] === 60000));
  test = setup();
  test.window.showSaveFilePicker = options => {
    test.calls.push(['picker', options.suggestedName]);
    return Promise.resolve({name: 'Nombre elegido.xls', createWritable: async () => ({
      write: async content => test.calls.push(['write', content]), close: async () => test.calls.push(['closed'])
    })});
  };
  const pending = test.api.saveFile(blob, 'Prueba.xls');
  assert.equal(test.calls[0][0], 'picker', 'Picker must run immediately in the click, before any await');
  saved = await pending;
  assert.equal(saved.filename, 'Nombre elegido.xls');
  assert.equal(saved.status, 'saved');
  assert(test.calls.some(call => call[0] === 'closed'));
  test.window.showSaveFilePicker = async () => { throw Object.assign(new Error('cancel'), {name: 'AbortError'}); };
  assert.equal((await test.api.saveFile(blob, 'Prueba.xls')).status, 'cancelled');
  assert(!test.calls.some(call => call[0] === 'click'));
  test.window.showSaveFilePicker = async () => { throw Object.assign(new Error('denied'), {name: 'SecurityError'}); };
  assert.equal((await test.api.saveFile(blob, 'Prueba.xls')).status, 'started');

  test = setup();
  const link = await test.api.createSharedFile(blob, 'Remito José.xls');
  assert(link.url.startsWith('https://'));
  const sign = test.calls.find(call => call[0] === 'sign');
  assert.equal(sign[1], 'owner-id/unique-id/archivo.xls');
  assert.equal(sign[2], 604800);
  assert.equal(sign[3].download, 'Remito José.xls');
  const upload = test.calls.find(call => call[0] === 'upload');
  assert.equal(await upload[2].text(), await blob.text());
  assert.equal(upload[2].type, 'application/octet-stream');
  assert.equal(upload[3].upsert, false);
  assert.equal(upload[3].contentType, 'application/octet-stream');
  assert(link.expiresAt > Date.now() + 604700000);
  for (const mime of ['text/csv;charset=utf-8', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip']) {
    const typedFile = new Blob([new Uint8Array([0, 1, 127, 255])], {type: mime});
    await test.api.createSharedFile(typedFile, 'typed-file.xls');
    const sent = test.calls.filter(call => call[0] === 'upload').at(-1)[2];
    assert.equal(sent.type, 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await sent.arrayBuffer()), new Uint8Array(await typedFile.arrayBuffer()));
  }
  await assert.rejects(test.api.createSharedFile({size: 52428801}, 'Grande.zip'), /50 MB/);
  test.storage.createSignedUrl = async () => ({error: new Error('no signing')});
  await assert.rejects(test.api.createSharedFile(blob, 'file.xls'), /crear el enlace/);
  assert(test.calls.some(call => call[0] === 'cleanup'));
  test.storage.upload = async () => ({error: new Error('Bucket not found')});
  await assert.rejects(test.api.createSharedFile(blob, 'file.xls'), /no está disponible/);
  test.client.auth.getUser = async () => ({data: {user: null}});
  await assert.rejects(test.api.createSharedFile(blob, 'file.xls'), /sesión venció/);

  // Modal: no file is written or uploaded before the user's explicit action.
  test = setup();
  const recorded = [];
  const dialog = test.api.open({blob, filename: 'Remito.xls', onAction: action => recorded.push(action)});
  assert.equal(test.window.document.documentElement.style.overflow, 'hidden');
  let stopped = false;
  dialog.events.keydown({stopPropagation() { stopped = true; }});
  assert(stopped, 'Keyboard actions must not reach underlying dialogs');
  const input = dialog.querySelector('#sucan-download-name');
  const button = action => dialog.querySelector(`[data-action="${action}"]`);
  const field = name => dialog.querySelector(`[data-field="${name}"]`);
  assert.equal(input.value, 'Remito');
  assert(!test.calls.some(call => ['upload', 'click'].includes(call[0])));
  input.value = 'Corregido';
  await button('download').click();
  assert.match(field('status').textContent, /Descarga iniciada: Corregido.xls/);
  assert(!test.calls.some(call => call[0] === 'upload'), 'Local download must not upload');
  await button('share').click();
  assert.match(field('status').textContent, /Enlace copiado/);
  assert.equal(field('link-box').hidden, false);
  assert.equal(recorded.at(-1).action, 'share');
  assert.equal(recorded.at(-1).filename, 'Corregido.xls');
  await button('share').click();
  assert.equal(test.calls.filter(call => call[0] === 'upload').length, 1, 'Repeated sharing reuses the link');
  input.value = 'Otro'; input.events.input();
  assert.equal(field('link-box').hidden, true);
  await button('share').click();
  assert.equal(test.calls.filter(call => call[0] === 'upload').length, 2, 'A new name gets its own link');
  test.window.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  await button('share').click();
  assert.match(field('status').textContent, /Tocá “Copiar enlace”/);
  assert.doesNotMatch(field('status').textContent, /Enlace copiado/);
  await button('copy').click();
  assert.match(field('status').textContent, /Copiá el enlace seleccionado/);
  assert.doesNotMatch(field('status').textContent, /Enlace copiado/);
  input.value = '...';
  await button('download').click();
  assert.match(field('status').textContent, /Ingresá un nombre/);
  assert.equal(button('download').disabled, false);
  button('close').click();
  assert.equal(test.window.document.documentElement.style.overflow, 'auto');
  assert(test.calls.some(call => call[0] === 'focus' && call[1] === 'opener'));

  test = setup();
  test.window.ClipboardItem = class { constructor(data) { this.data = data; } };
  test.window.navigator.clipboard.write = items => {
    test.calls.push(['clipboard-start']);
    return items[0].data['text/plain'].then(async value => { assert.equal(await value.text(), 'https://test/link'); });
  };
  let resolveLink;
  const futureLink = new Promise(resolve => { resolveLink = resolve; });
  const copied = test.api.beginClipboardWrite(futureLink);
  assert.equal(test.calls[0][0], 'clipboard-start', 'Safari copy starts while the click is active');
  resolveLink({url: 'https://test/link'});
  assert.equal(await copied, true);

  // Guard all existing export entry points against bypassing the common dialog.
  for (const file of ['app.js', 'operaciones/app.js', 'operaciones/reposition-app.js', 'operaciones/reception-app.js']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(code, /\.download\s*=|XLSX\.writeFile\(/, file);
    assert.match(code, /SucanDownloads|repoDownloadBuffer/, file);
  }
  for (const file of ['index.html', 'operaciones/index.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert(html.indexOf('downloads.js') < html.indexOf('<script src="app.js'));
    assert.match(html, /downloads\.css/);
  }
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902170000_archivos_compartidos.sql'), 'utf8');
  assert.match(migration, /false, 52428800/);
  assert.match(migration, /owner_id = auth.uid\(\)::text/);
  assert.match(migration, /approved = true/);
  assert.doesNotMatch(migration, /for (?:all|update) to authenticated/i);
  console.log('downloads: OK — naming, save picker, cancellation, fallback, secure sharing, copy, modal and all export routes');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
