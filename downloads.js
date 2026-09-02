(function (root) {
  'use strict';

  const BUCKET = 'op-archivos-compartidos';
  const SHARE_SECONDS = 7 * 24 * 60 * 60;
  const MAX_SHARE_BYTES = 50 * 1024 * 1024;
  let getClient = () => root.SucanCloud?.db;
  let activeDialog = null;
  const nativeFetch = root.fetch?.bind(root);

  function cleanName(value) {
    return String(value || '').normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_')
      .replace(/^[. ]+|[. ]+$/g, '').trim();
  }

  function splitName(filename) {
    const clean = cleanName(filename) || 'Archivo';
    const match = clean.match(/(\.[a-z0-9]{1,10})$/i);
    return {base: match ? clean.slice(0, -match[0].length) : clean, extension: match?.[0] || ''};
  }

  function fileName(base, extension) {
    let name = cleanName(base);
    if (extension && name.toLowerCase().endsWith(extension.toLowerCase())) name = name.slice(0, -extension.length);
    name = name.replace(/[. ]+$/g, '');
    if (!name) throw new Error('Ingresá un nombre para el archivo.');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    // Leaves room for multibyte characters and the fixed extension on common filesystems.
    return Array.from(name).slice(0, 80).join('') + extension;
  }

  function canPickLocation() {
    return root.isSecureContext && typeof root.showSaveFilePicker === 'function';
  }

  function fallbackDownload(blob, filename) {
    const url = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    root.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Mobile browsers may consume the URL after the click handler has completed.
    root.setTimeout(() => root.URL.revokeObjectURL(url), 60000);
    return {status: 'started', filename};
  }

  async function saveFile(blob, filename) {
    if (canPickLocation()) {
      let handle;
      try {
        // Must be the first asynchronous operation in the user's click handler.
        handle = await root.showSaveFilePicker({suggestedName: filename});
      } catch (error) {
        if (error.name === 'AbortError') return {status: 'cancelled'};
        if (!['SecurityError', 'NotAllowedError', 'NotSupportedError', 'TypeError'].includes(error.name)) throw error;
        return fallbackDownload(blob, filename);
      }
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => {});
        throw error;
      }
      return {status: 'saved', filename: handle.name || filename};
    }
    return fallbackDownload(blob, filename);
  }

  async function createSharedFile(blob, filename) {
    if (blob.size > MAX_SHARE_BYTES) throw new Error('El archivo supera los 50 MB permitidos para compartir. Podés descargarlo en tu dispositivo.');
    const client = getClient();
    if (!client) throw new Error('Iniciá sesión en la aplicación para crear un enlace.');
    const {data, error} = await client.auth.getUser();
    if (error || !data?.user?.id) throw new Error('Tu sesión venció. Volvé a iniciar sesión para compartir.');
    const extension = splitName(filename).extension.toLowerCase();
    const path = `${data.user.id}/${root.crypto.randomUUID()}/archivo${extension}`;
    const storage = client.storage.from(BUCKET);
    // Storage's multipart uploader uses Blob.type rather than options.contentType.
    // Normalize the transport MIME without modifying a single file byte.
    const uploadBlob = new Blob([blob], {type: 'application/octet-stream'});
    const {error: uploadError} = await storage.upload(path, uploadBlob, {
      contentType: 'application/octet-stream', upsert: false, cacheControl: '0'
    });
    if (uploadError) {
      if (/bucket.*not found/i.test(uploadError.message || '')) throw new Error('Compartir todavía no está habilitado en el servidor. Podés descargar el archivo mientras se activa.');
      throw new Error('No se pudo subir el archivo para compartir. Revisá tu conexión y los permisos de tu cuenta.');
    }
    try {
      const {data: signed, error: signError} = await storage.createSignedUrl(path, SHARE_SECONDS, {download: filename});
      if (signError || !signed?.signedUrl) throw new Error('No se pudo crear el enlace. Intentá nuevamente.');
      const url = new URL(signed.signedUrl);
      if (url.protocol !== 'https:') throw new Error('El servidor no devolvió un enlace seguro.');
      return {url: url.href, expiresAt: Date.now() + SHARE_SECONDS * 1000};
    } catch (error) {
      // Only remove this new upload if signing failed; never remove source documents.
      await storage.remove([path]).catch(() => {});
      throw error;
    }
  }

  function beginClipboardWrite(linkPromise) {
    // Promise-valued ClipboardItem preserves Safari's user activation during upload.
    if (root.navigator?.clipboard?.write && root.ClipboardItem) {
      try {
        const textData = linkPromise.then(link => new Blob([link.url], {type: 'text/plain'}));
        // Some browsers reject clipboard permission before they consume the promise.
        textData.catch(() => {});
        return root.navigator.clipboard.write([new root.ClipboardItem({
          'text/plain': textData
        })]).then(() => true, () => false);
      } catch (_) { /* Try writeText or show the explicit copy action below. */ }
    }
    return linkPromise.then(link => root.navigator?.clipboard?.writeText?.(link.url))
      .then(result => Boolean(root.navigator?.clipboard?.writeText), () => false);
  }

  function configure(options = {}) {
    if (options.getClient) getClient = options.getClient;
  }

  async function openRemote(url, filename) {
    const response = await nativeFetch(url);
    if (!response.ok) throw new Error('No se pudo recuperar el archivo. Intentá nuevamente.');
    return open({blob: await response.blob(), filename});
  }

  function open({blob, filename, onAction} = {}) {
    if (!(blob instanceof Blob)) throw new Error('El archivo no está listo para descargar.');
    if (activeDialog) { activeDialog.querySelector('input')?.focus(); return; }
    const {base, extension} = splitName(filename);
    const previousFocus = root.document.activeElement;
    const previousOverflow = root.document.documentElement.style.overflow;
    const dialog = root.document.createElement('dialog');
    dialog.className = 'sucan-download-dialog';
    dialog.setAttribute('aria-labelledby', 'sucan-download-title');
    dialog.setAttribute('aria-describedby', 'sucan-download-description');
    // Only static markup; filenames, URLs and errors are always assigned as text/value.
    dialog.innerHTML = `
      <header class="sucan-download-head"><div><span class="sucan-download-eyebrow">ARCHIVO LISTO</span><h2 id="sucan-download-title">Descargar o compartir</h2></div><button type="button" data-action="close" class="sucan-download-close" aria-label="Cerrar ventana">×</button></header>
      <p id="sucan-download-description">Elegí el nombre del archivo. Su contenido y formato no cambian.</p>
      <label for="sucan-download-name">Nombre del archivo</label>
      <div class="sucan-download-name"><input id="sucan-download-name" maxlength="80" autocomplete="off" spellcheck="false"><span data-field="extension"></span></div>
      <p class="sucan-download-meta" data-field="preview"></p>
      <div class="sucan-download-note"><strong>Al compartir</strong><span>Se sube una copia y se copia un enlace válido por 7 días. Cualquier persona con el enlace podrá descargarla sin iniciar sesión. Compartilo solo con personas autorizadas.</span></div>
      <p class="sucan-download-meta" data-field="location"></p>
      <div class="sucan-download-link" data-field="link-box" hidden><label for="sucan-download-link">Enlace de descarga</label><input id="sucan-download-link" readonly><button type="button" data-action="copy">Copiar enlace</button><p data-field="expiry"></p></div>
      <p class="sucan-download-status" data-field="status" role="status" aria-live="polite" aria-atomic="true"></p>
      <footer class="sucan-download-actions"><button type="button" data-action="share">Compartir</button><button type="button" data-action="download" class="sucan-download-primary">Descargar</button></footer>`;
    const field = name => dialog.querySelector(`[data-field="${name}"]`);
    const button = name => dialog.querySelector(`[data-action="${name}"]`);
    const input = dialog.querySelector('#sucan-download-name');
    const linkInput = dialog.querySelector('#sucan-download-link');
    let busy = false;
    const links = new Map();
    const announce = (text, error = false) => { field('status').textContent = text; field('status').classList.toggle('is-error', error); };
    const updatePreview = () => {
      try { field('preview').textContent = `${fileName(input.value, extension)} · ${Math.max(1, Math.ceil(blob.size / 1024)).toLocaleString('es-UY')} KB`; }
      catch (_) { field('preview').textContent = 'Ingresá un nombre para continuar.'; }
      field('link-box').hidden = true;
      announce('');
    };
    const setBusy = value => {
      busy = value;
      input.disabled = value;
      for (const action of ['share', 'download', 'close', 'copy']) button(action).disabled = value;
      dialog.setAttribute('aria-busy', String(value));
    };
    const record = (action, name) => {
      Promise.resolve().then(() => onAction?.({action, filename: name})).catch(error => root.console.warn('No se pudo registrar la exportación', error));
    };
    const close = () => { if (!busy) dialog.close(); };
    input.value = base;
    field('extension').textContent = extension || 'Archivo';
    field('location').textContent = canPickLocation()
      ? 'Al descargar se abrirá el explorador para elegir dónde guardar el archivo.'
      : 'Se usará la descarga habitual del navegador. La carpeta depende del dispositivo; en iPhone/iPad podés elegir Guardar en Archivos desde la vista del archivo.';
    updatePreview();
    input.addEventListener('input', updatePreview);
    button('close').addEventListener('click', close);
    // Do not let Escape/Enter operate a module's underlying quantity/detail modal.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      activeDialog = null;
      root.document.documentElement.style.overflow = previousOverflow;
      dialog.remove(); previousFocus?.focus?.();
    });
    button('download').addEventListener('click', async () => {
      try {
        const name = fileName(input.value, extension);
        setBusy(true);
        const result = await saveFile(blob, name);
        if (result.status === 'cancelled') { announce('Descarga cancelada. No se guardó ningún archivo.'); return; }
        announce(result.status === 'saved' ? `Archivo guardado: ${result.filename}` : `Descarga iniciada: ${name}. Revisá las descargas de tu navegador.`);
        record('download', result.filename);
      } catch (error) { announce(error.message || 'No se pudo guardar el archivo. Intentá nuevamente.', true); }
      finally { setBusy(false); }
    });
    button('share').addEventListener('click', async () => {
      try {
        const name = fileName(input.value, extension);
        setBusy(true);
        announce('Preparando enlace seguro…');
        const existing = links.get(name);
        const linkPromise = existing && existing.expiresAt > Date.now() + 60000 ? Promise.resolve(existing) : createSharedFile(blob, name);
        const copiedPromise = beginClipboardWrite(linkPromise);
        const link = await linkPromise;
        links.set(name, link);
        linkInput.value = link.url;
        field('link-box').hidden = false;
        field('expiry').textContent = `Vence: ${new Date(link.expiresAt).toLocaleString('es-UY')}. Al abrirlo, el navegador iniciará la descarga.`;
        const copied = await copiedPromise;
        announce(copied ? 'Enlace copiado. Ya podés pegarlo y compartirlo.' : 'Enlace creado. El navegador no permitió copiarlo automáticamente: pulsá “Copiar enlace” o copialo del campo.');
        record('share', name);
      } catch (error) { announce(error.message || 'No se pudo crear el enlace. Podés descargar el archivo.', true); }
      finally { setBusy(false); }
    });
    button('copy').addEventListener('click', async () => {
      try {
        if (!root.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
        await root.navigator.clipboard.writeText(linkInput.value);
        announce('Enlace copiado. Ya podés pegarlo y compartirlo.');
      } catch (_) {
        linkInput.focus(); linkInput.select();
        announce('Seleccionamos el enlace. Mantené pulsado y elegí Copiar, o usá Ctrl+C / ⌘C.');
      }
    });
    root.document.body.appendChild(dialog);
    activeDialog = dialog;
    root.document.documentElement.style.overflow = 'hidden';
    dialog.showModal();
    input.focus(); input.select();
    return dialog;
  }

  root.SucanDownloads = {configure, open, openRemote};
  if (typeof module !== 'undefined' && module.exports) module.exports = {
    configure, open, openRemote, cleanName, splitName, fileName, saveFile, createSharedFile, beginClipboardWrite,
    BUCKET, SHARE_SECONDS, MAX_SHARE_BYTES
  };
})(typeof window !== 'undefined' ? window : globalThis);
