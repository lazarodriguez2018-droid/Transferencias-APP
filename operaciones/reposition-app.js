// ===== MÓDULO REPOSICIÓN =====
// Se mantiene separado del conteo para que ambos flujos compartan padrón y sincronización
// sin mezclar estados ni archivos finales.

let repoSearchResultsByTarget = {};
let repoTemplateBytes = null;
let repoListRenderLimit = 200;
let repoUrgentTimer = null;
const repoUrgentSnoozed = new Map();
let repoCatalogIndex = null;
let repoCatalogIndexSource = null;
let repoVerificationContinuation = null;
const repoProductSearchTimers = new Map();

const REPO_NOT_FOUND_REASONS = [
  {code:'stock_insuficiente', label:'Stock insuficiente'},
  {code:'otro', label:'Otro'}
];

function repoApi(path, options) {
  return fetch(`${serverUrl}${path}`, options);
}

function repoProductFromCatalog(code) {
  if (repoCatalogIndexSource !== padron || !repoCatalogIndex) {
    repoCatalogIndexSource = padron;
    repoCatalogIndex = new Map((padron || []).map(product => [String(product.codigo || '').trim(), product]));
  }
  return repoCatalogIndex.get(String(code || '').trim()) || null;
}

function repoHydrateItemFromCatalog(item) {
  if (!item) return item;
  const product = repoProductFromCatalog(item.codigo);
  if (!product) return item;
  const barcode = String(product.barras || item.barras || '').trim();
  const brand = String(product.marca || item.marca || '').trim();
  if (barcode === String(item.barras || '').trim() && brand === String(item.marca || '').trim()) return item;
  return {...item, barras:barcode, marca:brand};
}

function repoHydrateStateFromCatalog(state) {
  if (!state) return state;
  state.items = (state.items || []).map(repoHydrateItemFromCatalog);
  state.extras = (state.extras || []).map(repoHydrateItemFromCatalog);
  return state;
}

async function waitForXlsx(timeoutMs = 8000) {
  const started = Date.now();
  while (!window.XLSX && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  if (!window.XLSX) throw new Error('No se pudo cargar el lector de Excel');
  return window.XLSX;
}

function repoArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + size, bytes.length)));
  }
  return btoa(binary);
}

function repoBase64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

async function analyzeRepositionFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const summaryEl = document.getElementById('repo-source-summary');
  summaryEl.textContent = 'Analizando el archivo…';
  try {
    const XLSX = await waitForXlsx();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', raw: false });
    repoParsedSource = SucaneitorReposition.parseWorkbook(workbook, XLSX, padron);
    repoSourceBytes = buffer.slice(0);
    repoParsedSource.original_filename = file.name;
    const meta = repoParsedSource.meta;
    summaryEl.innerHTML = `<strong style="color:var(--green)">Archivo listo</strong><br>${esc(repoParsedSource.origin)} → ${esc(repoParsedSource.destination)} · ${meta.retained_rows} productos · ${meta.retained_requested_units} unidades<br><span style="color:var(--muted)">${meta.excluded_rows} filas excluidas por la regla de conservar stock${meta.missing_padron.length ? ` · ${meta.missing_padron.length} SKU sin padrón` : ''}</span>`;
    const nameInput = document.getElementById('input-sesion-nombre');
    if (!nameInput.value.trim()) {
      nameInput.value = `Reposición ${repoParsedSource.origin} → ${repoParsedSource.destination} ${new Date().toLocaleDateString('es-UY')}`;
    }
    toast(`Archivo listo: ${meta.retained_rows} productos`, 's');
  } catch (error) {
    repoParsedSource = null;
    repoSourceBytes = null;
    input.value = '';
    summaryEl.innerHTML = `<span style="color:var(--red)">${esc(error.message || 'No se pudo leer la reposición')}</span>`;
    toast(error.message || 'No se pudo leer el archivo', 'e');
  }
}

async function createRepositionSession(url, usuario, requestedName) {
  if (!repoParsedSource || !repoSourceBytes) { showSessionError('Cargá primero el archivo de reposición'); return; }
  try {
    const response = await fetch(`${url}/api/reposicion/crear`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        nombre: requestedName || `Reposición ${repoParsedSource.origin} a ${repoParsedSource.destination}`,
        usuario,
        origin: repoParsedSource.origin,
        destination: repoParsedSource.destination,
        items: repoParsedSource.items,
        import_meta: repoParsedSource.meta,
        original_filename: repoParsedSource.original_filename,
        original_base64: repoArrayBufferToBase64(repoSourceBytes)
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo crear la reposición');
    await joinReposition(data.reposition_id, data.repo.nombre, url, usuario, data.repo);
    repoParsedSource = null;
    repoSourceBytes = null;
  } catch (error) {
    showSessionError(error.message || 'Error al crear la reposición');
  }
}

async function joinReposition(rid, nombre, url, usuario, initialRepo, options = {}) {
  try {
    serverUrl = url;
    serverOnline = true;
    sessionId = rid;
    sessionNombre = nombre;
    repoExhausted = false;
    usuarioNombre = usuario || 'Usuario';
    localStorage.setItem('sc_usuario', usuarioNombre);
    let loaded = initialRepo;
    if (!loaded) {
      const response = await fetchWithTimeout(`${url}/api/reposicion/state?rid=${encodeURIComponent(rid)}&usuario=${encodeURIComponent(usuarioNombre)}`, {}, 6000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo abrir la reposición');
      loaded = data.repo;
    }
    repoState = loaded;
    try {
      const pdata = await fetch(`${url}/api/padron`).then(response => response.json());
      if (pdata.padron && pdata.padron.length) {
        padron = pdata.padron;
        invalidateSearchIndex();
      }
    } catch (error) {}
    repoHydrateStateFromCatalog(repoState);
    await loadBarcodeAssignments();
    if (repoCanEdit()) await repoClaimNext({render:false,silent:true});
    enterRepositionApp(options);
    connectRepositionSSE();
    startRepoUrgentWatcher();
    toast(`Reposición abierta: ${repoState.origin} → ${repoState.destination}`, 's');
  } catch (error) {
    serverOnline = false;
    showSessionError(error.message || 'No se pudo abrir la reposición');
  }
}

function enterRepositionApp(options = {}) {
  if (!repoState) return;
  document.getElementById('session-screen').style.display = 'none';
  document.getElementById('main-nav').style.display = 'flex';
  document.getElementById('main-tabs').style.display = 'none';
  document.getElementById('repo-tabs').style.display = 'flex';
  document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
  const logo = document.querySelector('#main-nav .nav-logo > span');
  if (logo) logo.innerHTML = 'Sucaneitor <span style="color:var(--accent)">Reposición</span>';
  document.getElementById('nav-almacen').textContent = `${repoState.origin} → ${repoState.destination}`;
  document.getElementById('nav-almacen').title = repoState.nombre;
  setSyncStatus('online');
  repoCurrentIndex = repoFindInitialIndex();
  renderRepositionAll();
  const initialTab = options.tab || 'preparar';
  showRepoTab(initialTab,{history:'none'});
  updateOperationsHistory(options.history || 'push','workspace',initialTab);
}

function repoFindInitialIndex() {
  if (!repoState || !repoState.items.length) return 0;
  const assigned = repoState.items.findIndex(repoItemOwnedByMe);
  if (assigned >= 0) return assigned;
  const pending = repoState.items.findIndex(item => repoItemPending(item) && !item.asignado_cliente);
  return pending >= 0 ? pending : 0;
}

function repoViewerClientId() {
  return String(repoState?.viewer_client_id || window.SucanCloud?.clientId || '');
}

function repoItemPending(item) {
  return !!item && ['pendiente','parcial'].includes(SucaneitorReposition.status(item));
}

function repoItemOwnedByMe(item) {
  const clientId = repoViewerClientId();
  return !!clientId && String(item?.asignado_cliente || '') === clientId;
}

function repoItemClaimedByOther(item) {
  return !!item?.asignado_cliente && !repoItemOwnedByMe(item);
}

function repoMergeItem(item) {
  if (!repoState || !item?.codigo) return -1;
  item = repoHydrateItemFromCatalog(item);
  const index = repoState.items.findIndex(row => String(row.codigo) === String(item.codigo));
  if (index >= 0) repoState.items[index] = item;
  if (repoItemOwnedByMe(item)) repoExhausted = false;
  return index;
}

async function repoClaimProduct(code, options = {}) {
  if (!window.SucanCloud || !repoCanEdit() || !sessionId) return null;
  if (repoClaimInFlight) {
    try { await repoClaimInFlight; } catch (_) {}
    const own = repoState?.items.find(repoItemOwnedByMe);
    if (!code && own) return own;
    if (code) {
      const current = repoState?.items.find(item => String(item.codigo) === String(code));
      if (repoItemOwnedByMe(current)) return current;
    }
  }
  const claim = (async () => {
    const response = await repoApi('/api/reposicion/claim', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({reposition_id:sessionId,codigo:code || null,exclude_codigo:options.excludeCode || null})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo asignar el producto');
    if (data.viewer_client_id) repoState.viewer_client_id = data.viewer_client_id;
    if (!code) repoExhausted = !data.item;
    else if (data.item) repoExhausted = false;
    const index = repoMergeItem(data.item);
    if (index >= 0) repoCurrentIndex = index;
    if (options.render !== false) renderRepositionAll();
    return data.item || null;
  })();
  repoClaimInFlight = claim;
  try { return await claim; }
  catch (error) {
    if (!options.silent) toast(error.message || 'Ese producto fue tomado por otra persona','w');
    if (options.render !== false) renderRepositionAll();
    return null;
  } finally { if (repoClaimInFlight === claim) repoClaimInFlight = null; }
}

function repoClaimNext(options = {}) {
  return repoClaimProduct('',options);
}

async function repoEnsureClaim(item, options = {}) {
  if (!item || !repoCanEdit()) return false;
  if (repoItemOwnedByMe(item)) return true;
  const claimed = await repoClaimProduct(item.codigo,options);
  return !!claimed && repoItemOwnedByMe(claimed);
}

async function repoHeartbeat() {
  if (!window.SucanCloud || !sessionId || !repoState || document.visibilityState === 'hidden') return;
  try {
    const response = await repoApi('/api/reposicion/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:sessionId})});
    if (!response.ok) throw new Error('heartbeat');
    setSyncStatus('online');
  } catch (_) { setSyncStatus('offline'); }
}

async function repoReleaseAssignment(code = null) {
  if (!window.SucanCloud || !sessionId) return;
  try {
    await repoApi('/api/reposicion/release',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({reposition_id:sessionId,codigo:code || null}),keepalive:true
    });
  } catch (_) {}
}

async function repoRefreshState({claimIfNeeded = true} = {}) {
  if (!window.SucanCloud || !sessionId || !repoState) return;
  if (repoRefreshInFlight) { repoRefreshQueued = true; return; }
  repoRefreshInFlight = true;
  try {
    do {
      repoRefreshQueued = false;
      const currentCode = repoState.items?.[repoCurrentIndex]?.codigo;
      const response = await fetch(`/api/reposicion/state?rid=${encodeURIComponent(sessionId)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo sincronizar');
      repoState = repoHydrateStateFromCatalog(data.repo);
      let index = repoState.items.findIndex(repoItemOwnedByMe);
      if (index >= 0) repoExhausted = false;
      if (index < 0 && currentCode != null) index = repoState.items.findIndex(item => String(item.codigo) === String(currentCode));
      repoCurrentIndex = index >= 0 ? index : repoFindInitialIndex();
      if (claimIfNeeded && repoCanEdit() && !repoState.items.some(repoItemOwnedByMe) && repoState.items.some(repoItemPending)) {
        await repoClaimNext({render:false,silent:true});
      }
      renderRepositionAll();
      setSyncStatus('online');
    } while (repoRefreshQueued);
  } catch (error) {
    console.warn('No se pudo refrescar la reposición',error);
    setSyncStatus('offline');
  } finally { repoRefreshInFlight = false; }
}

function repoHandleRealtime(change) {
  if (!change || !repoState) return;
  if (change.kind === 'repository' && change.event === 'DELETE') {
    toast('Esta reposición fue eliminada. Volviendo a las sesiones disponibles.','w');
    leaveOperationsWorkspace({notify:false});
    mostrarPantallaSesion(true);
    updateOperationsHistory('replace','sessions');
    return;
  }
  if (change.kind === 'status') {
    const online = change.status === 'SUBSCRIBED';
    setSyncStatus(online ? 'online' : 'offline');
    if (online) repoRefreshState();
    return;
  }
  if (change.kind === 'item' && change.item) {
    const currentCode = repoState.items?.[repoCurrentIndex]?.codigo;
    repoMergeItem(change.item);
    const ownIndex = repoState.items.findIndex(repoItemOwnedByMe);
    if (ownIndex >= 0) repoCurrentIndex = ownIndex;
    else if (currentCode != null) {
      const kept = repoState.items.findIndex(item => String(item.codigo) === String(currentCode));
      if (kept >= 0) repoCurrentIndex = kept;
    }
    renderRepositionAll();
    if (repoCanEdit() && !repoState.items.some(repoItemOwnedByMe) && repoState.items.some(repoItemPending)) {
      repoClaimNext({silent:true});
    }
    setSyncStatus('online');
    return;
  }
  if (change.kind === 'device') {
    const clientId = String(change.row?.cliente_id || change.old?.cliente_id || '');
    repoState.participantes = (repoState.participantes || []).filter(item => String(item.cliente_id || '') !== clientId);
    if (change.event !== 'DELETE' && change.row) {
      repoState.participantes.push({
        nombre:change.row.nombre || 'Usuario',cliente_id:change.row.cliente_id,
        usuario_id:change.row.usuario_id,last_seen:change.row.last_seen,joined:change.row.last_seen
      });
    }
    renderRepoSummary();
    return;
  }
  repoRefreshState();
}

function connectRepositionSSE() {
  if (repoSSE) repoSSE.close();
  if (window.SucanCloud) {
    const channel = window.SucanCloud.watchReposition(sessionId,repoHandleRealtime);
    repoHeartbeatTimer = setInterval(repoHeartbeat,45000);
    repoFallbackTimer = setInterval(()=>repoRefreshState(),20000);
    if (!document.documentElement.dataset.repoVisibilitySync) {
      document.documentElement.dataset.repoVisibilitySync='1';
      document.addEventListener('visibilitychange',()=>{
        if (document.visibilityState === 'visible' && currentModule === 'reposicion' && sessionId) {
          repoHeartbeat(); repoRefreshState();
        }
      });
    }
    repoSSE = { close() {
      clearInterval(repoHeartbeatTimer); clearInterval(repoFallbackTimer);
      repoHeartbeatTimer=null; repoFallbackTimer=null;
      window.SucanCloud.db.removeChannel(channel);
    } };
    repoHeartbeat();
    return;
  }
  repoSSE = new EventSource(`${serverUrl}/api/reposicion/events?rid=${encodeURIComponent(sessionId)}`);
  repoSSE.addEventListener('init', event => {
    repoState = repoHydrateStateFromCatalog(JSON.parse(event.data));
    renderRepositionAll();
  });
  repoSSE.addEventListener('update', event => {
    const data = JSON.parse(event.data);
    const index = repoState.items.findIndex(item => String(item.codigo) === String(data.item.codigo));
    if (index >= 0) repoState.items[index] = repoHydrateItemFromCatalog(data.item);
    if (data.log) { repoState.log = repoState.log || []; repoState.log.unshift(data.log); }
    renderRepositionAll();
  });
  repoSSE.addEventListener('extra', event => {
    const data = JSON.parse(event.data);
    const index = repoState.extras.findIndex(item => String(item.codigo) === String(data.extra.codigo));
    const extra = repoHydrateItemFromCatalog(data.extra);
    if (index >= 0) repoState.extras[index] = extra; else repoState.extras.push(extra);
    renderRepositionAll();
  });
  repoSSE.addEventListener('extra_remove', event => {
    const data = JSON.parse(event.data);
    repoState.extras = repoState.extras.filter(item => String(item.codigo) !== String(data.codigo));
    renderRepositionAll();
  });
  repoSSE.onopen = () => setSyncStatus('online');
  repoSSE.onerror = () => setSyncStatus('offline');
}

function showRepoTab(name, options = {}) {
  if (currentModule !== 'reposicion') return;
  const page = document.getElementById(`repo-page-${name}`);
  const tab = document.getElementById(`repo-tab-${name}`);
  if (!page || !tab) return;
  if (options.force !== true && page.classList.contains('active') && tab.classList.contains('active')) {
    if (sessionId) updateOperationsHistory(options.history || 'push','workspace',name);
    return;
  }
  document.querySelectorAll('.page,.repo-page').forEach(page => page.classList.remove('active'));
  document.querySelectorAll('#repo-tabs .tab').forEach(tab => tab.classList.remove('active'));
  page.classList.add('active');
  tab.classList.add('active');
  window.scrollTo({top:0, behavior:'auto'});
  if (name === 'lista') renderRepoList();
  if (name === 'extras') renderRepoExtras();
  if (name === 'resumen') renderRepoSummary();
  if (sessionId && currentModule === 'reposicion') updateOperationsHistory(options.history || 'push','workspace',name);
}

function renderRepositionAll() {
  if (!repoState) return;
  document.body.classList.toggle('repo-readonly',!repoCanEdit());
  const accessBanner = document.getElementById('repo-access-banner');
  if (accessBanner) accessBanner.classList.toggle('show',repoState.can_edit === false && repoState.estado === 'preparando');
  document.getElementById('repo-session-title').textContent = repoState.nombre || 'Preparar mercadería';
  document.getElementById('repo-route-badge').textContent = `${repoState.origin} → ${repoState.destination}`;
  document.getElementById('repo-list-count').textContent = repoState.items.length;
  document.getElementById('nav-almacen').textContent = `${repoState.origin} → ${repoState.destination}`;
  renderRepoKpis();
  renderRepoCurrent();
  renderRepoList();
  renderRepoExtras();
  renderRepoSummary();
  const config = document.getElementById('repo-config-session');
  if (config) config.innerHTML = `<strong>${esc(repoState.nombre)}</strong><div class="tm mt2">${esc(repoState.origin)} → ${esc(repoState.destination)} · Usuario: ${esc(usuarioNombre)} · ID ${esc(sessionId)}</div>`;
  const padronStatus = document.getElementById('repo-padron-status');
  if (padronStatus) padronStatus.textContent = `${padron.length} productos disponibles en el padrón global`;
}

function renderRepoKpis() {
  const summary = SucaneitorReposition.summary(repoState);
  const html = `
    <div class="repo-kpi"><span>Productos listos</span><strong>${summary.completos + summary.excedidos}/${summary.productos}</strong></div>
    <div class="repo-kpi"><span>Unidades juntadas</span><strong>${summary.preparados}/${summary.pedidos}</strong></div>
    <div class="repo-kpi"><span>Unidades faltantes</span><strong>${summary.faltantes}</strong></div>
    <div class="repo-kpi"><span>Extras separados</span><strong>${summary.extras_unidades}</strong></div>`;
  ['preparar','lista','resumen'].forEach(name => {
    const container = document.getElementById(`repo-kpis-${name}`);
    if (container) container.innerHTML = html;
  });
}

function repoEncoded(code) { return encodeURIComponent(String(code || '')); }
function repoDecoded(code) { try { return decodeURIComponent(code); } catch (error) { return String(code || ''); } }
function repoCanEdit() { return repoState?.estado === 'preparando' && repoState?.can_edit !== false; }
function requireRepoEditable() {
  if (repoCanEdit()) return true;
  toast(repoState?.estado === 'preparando' ? 'Esta reposición se prepara desde el local de origen. Tu acceso es de consulta.' : 'Esta reposición ya fue enviada y quedó en modo consulta.','w');
  return false;
}

function renderRepoCurrent() {
  const card = document.getElementById('repo-current-card');
  if (!card || !repoState) return;
  if (!repoState.items.length || (repoCanEdit() && repoExhausted && !repoState.items.some(repoItemOwnedByMe))) {
    const pickup = SucaneitorReposition.pickupState(repoState);
    const subtitle = pickup.completed
      ? 'Recorriste todos los productos. Podés revisar cantidades, faltantes y corregir cualquier registro desde la lista completa.'
      : `Los ${pickup.remaining} productos pendientes están siendo preparados por otros usuarios. Podés revisar el avance y modificar cualquier producto disponible desde la lista.`;
    card.innerHTML = `
      <div class="repo-finished-state">
        <div class="repo-finished-icon" aria-hidden="true">✓</div>
        <span class="eyebrow">RECORRIDO FINALIZADO</span>
        <h2>No existen más productos para recoger</h2>
        <p>${esc(subtitle)}</p>
        <div class="repo-finished-actions">
          <button class="btn btn-p" onclick="repoOpenFullList()">Ver y modificar toda la lista</button>
          <button class="btn btn-s" onclick="showRepoTab('resumen')">Ver resumen</button>
        </div>
      </div>`;
    return;
  }
  repoCurrentIndex = Math.max(0, Math.min(repoCurrentIndex, repoState.items.length - 1));
  const item = repoState.items[repoCurrentIndex];
  const status = SucaneitorReposition.status(item);
  const pending = Math.max(0, Number(item.pedido) - Number(item.preparado));
  const label = {completo:'Completo',excedido:'Cantidad excedida',no_encontrado:'Marcado no encontrado',incompleto:'Cerrado incompleto',parcial:'En preparación',pendiente:'Pendiente'}[status];
  const bannerClass = status === 'completo' ? 'ok' : status === 'excedido' || status === 'parcial' || status === 'incompleto' ? 'warn' : status === 'no_encontrado' ? 'bad' : 'warn';
  const code = repoEncoded(item.codigo);
  const registeredReason = item.motivo_label || item.motivo || '';
  const reasonDetail = item.motivo_otro ? `: ${item.motivo_otro}` : '';
  const reasonHtml = registeredReason ? `<div class="app-dialog-product" style="margin-top:10px"><strong>${esc(registeredReason + reasonDetail)}</strong>${item.comentario ? `<span style="font-family:'DM Sans','Segoe UI',sans-serif">${esc(item.comentario)}</span>` : ''}</div>` : '';
  const orders = item.pedidos_asignados || [];
  const customerOrderHtml = Number(item.pedido_clientes) > 0
    ? `<div class="repo-client-extra"><span>PEDIDO ENTRE LOCALES</span><strong>Extra pedido por ${esc(repoState.destination || 'el local destino')}</strong><small>Estas ${Number(item.pedido_clientes)} unidades fueron solicitadas por ${esc(repoState.destination || 'el destino')} a ${esc(repoState.origin || 'el origen')}.</small></div>`
    : '';
  const sourceHtml = (Number(item.pedido_clientes) > 0 || Number(item.pedido_reposicion) > 0) ? `${customerOrderHtml}<div class="repo-order-coverage"><div><span>Reposición automática</span><strong>${Number(item.pedido_reposicion)||0}</strong></div><div><span>Pedido de ${esc(repoState.destination || 'destino')}</span><strong>${Number(item.pedido_clientes)||0}</strong></div><div><span>Total físico</span><strong>${Number(item.pedido)||0}</strong></div></div>${orders.length ? `<div class="repo-client-orders"><strong>Pedidos de clientes:</strong> ${orders.map(order=>`${esc(order.cliente || 'Sin nombre')} ×${Number(order.cantidad)||0}${order.urgente?' · URGENTE':''}`).join(' · ')}</div>` : ''}` : '';
  const verificationHtml = item.requiere_verificacion ? `<div class="repo-status-banner warn" style="margin-top:10px"><strong>Control final pendiente</strong><br>Hay más de una unidad registrada. Antes del envío se pedirá confirmar la cantidad física.</div>` : '';
  const controls = repoCanEdit() ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:9px">
      <button class="btn btn-p" style="min-height:58px;font-size:16px" onclick="repoFound('${code}')">✓ Encontrado</button>
      <button class="btn btn-s" style="min-height:58px" onclick="openRepoScanner('requested',true)">▣ Escanear para comprobación</button>
    </div>
    <div class="repo-fast"><button class="btn btn-s" onclick="repoChangeQty('${code}',1,'rapido')">+1</button><button class="btn btn-s" onclick="repoAddFive('${code}')">+5</button><button class="btn btn-s" onclick="repoEditQty('${code}')">Editar cantidad</button></div>
    <div class="repo-inline" style="margin-top:12px"><button class="btn btn-s" onclick="repoMark('${code}','no_encontrado')">No encontrado</button><button class="btn btn-s" onclick="repoMark('${code}','cerrado_incompleto')">Cerrar incompleto</button></div>`
    : `<div class="app-dialog-product" style="margin-top:14px"><strong>${repoState.estado === 'preparando' ? 'Seguimiento en tiempo real' : 'Preparación cerrada'}</strong><span>${repoState.estado === 'preparando' ? 'El local de origen está preparando esta mercadería. Los cambios aparecerán automáticamente.' : 'Esta mercadería ya fue marcada como enviada. El detalle queda en modo consulta.'}</span></div>`;
  card.innerHTML = `
    <div class="repo-status-banner ${bannerClass}">${repoCurrentIndex + 1} de ${repoState.items.length} · ${label}</div>
    <span class="eyebrow">PRODUCTO ACTUAL</span>
    <h2 class="repo-product-name">${esc(item.nombre)}</h2>
    <div class="repo-source-name">SKU <strong>${esc(item.codigo)}</strong>${item.barras ? ` · Barras ${esc(item.barras)}` : ' · Sin código de barras en el padrón'}${item.descripcion_archivo && item.descripcion_archivo !== item.nombre ? `<br>Archivo: ${esc(item.descripcion_archivo)}` : ''}</div>
    <div class="repo-quantities"><div class="repo-quantity"><span>Total físico</span><strong>${item.pedido}</strong></div><div class="repo-quantity"><span>Juntado</span><strong>${item.preparado}</strong></div><div class="repo-quantity pending"><span>Falta</span><strong>${pending}</strong></div></div>${sourceHtml}${reasonHtml}${verificationHtml}
    ${controls}`;
}

async function repoFound(encodedCode) {
  if (!requireRepoEditable()) return;
  const code = repoDecoded(encodedCode);
  const item = repoState.items.find(row => String(row.codigo) === code);
  if (!item) return;
  if (!await repoEnsureClaim(item)) return;
  const suggested = Math.max(0, Number(item.pedido || 0) - Number(item.preparado || 0));
  repoOpenQuantityModal(encodedCode, suggested, 'add');
}

function repoOpenQuantityModal(encodedCode, suggested, mode) {
  const code = repoDecoded(encodedCode);
  const item = repoState.items.find(row => String(row.codigo) === code);
  if (!item) return;
  window._repoQtyCode = encodedCode;
  window._repoQtyMode = mode;
  document.getElementById('modal-title').textContent = mode === 'add' ? 'Producto encontrado' : 'Editar cantidad juntada';
  document.getElementById('modal-subtitle').textContent = item.nombre;
  document.getElementById('modal-body').innerHTML = `
    <div class="assignment-confirm"><dl><dt>SKU</dt><dd>${esc(item.codigo)}</dd><dt>Solicitado</dt><dd>${item.pedido}</dd><dt>Juntado actualmente</dt><dd>${item.preparado}</dd></dl></div>
    ${mode === 'add' ? `<p class="app-dialog-message" style="margin:12px 0 0">La cantidad comienza en <strong>${Math.max(0, Number(item.pedido || 0) - Number(item.preparado || 0))}</strong>, que es lo que falta juntar. Modificala solamente si la cantidad física disponible es diferente.</p>` : ''}
    <label class="il" style="margin-top:14px">${mode === 'add' ? 'Unidades físicas que tenés ahora' : 'Cantidad total juntada'}</label>
    <div class="qty-stepper"><button class="qty-step" onclick="stepRepoModalQty(-1)">−</button><input id="repo-modal-qty" class="input" type="number" min="0" inputmode="numeric" value="${Math.max(0,Number(suggested)||0)}" style="text-align:center;font-size:20px"><button class="qty-step" onclick="stepRepoModalQty(1)">+</button></div>`;
  document.getElementById('modal-actions').innerHTML = '<button class="btn btn-s" onclick="closeModal()">Cancelar</button><button class="btn btn-p" onclick="confirmRepoModalQty()">Confirmar</button>';
  document.getElementById('modal-overlay').classList.add('show');
  setTimeout(() => document.getElementById('repo-modal-qty')?.select(),80);
}

function stepRepoModalQty(delta) {
  const input = document.getElementById('repo-modal-qty');
  if (input) input.value = Math.max(0,(Number.parseInt(input.value,10)||0)+delta);
}

function confirmRepoModalQty() {
  const code = repoDecoded(window._repoQtyCode || '');
  const item = repoState.items.find(row => String(row.codigo) === code);
  const value = Number.parseInt(document.getElementById('repo-modal-qty')?.value,10);
  if (!item || !Number.isInteger(value) || value < 0) { toast('Ingresá una cantidad válida','e'); return; }
  closeModal();
  if (window._repoQtyMode === 'add') repoChangeQty(repoEncoded(code),value,'encontrado');
  else repoSetAbsolute(repoEncoded(code),value,'manual');
}

async function repoAddFive(encodedCode) {
  if (!requireRepoEditable()) return;
  const code=repoDecoded(encodedCode),item=repoState?.items.find(row=>String(row.codigo)===code);
  if(!item)return;
  const confirmed=await appConfirm({
    title:'Agregar 5 unidades',subtitle:item.nombre,icon:'+5',tone:'warning',confirmText:'Sí, conté 5 unidades',
    message:`Se registrarán 5 unidades de una vez (${Number(item.preparado||0)} → ${Number(item.preparado||0)+5}). La aplicación pedirá una comprobación rápida antes del envío.`
  });
  if(confirmed)await repoChangeQty(encodedCode,5,'lote_rapido');
}

async function repoChangeQty(encodedCode, delta, source) {
  const change = Number.parseInt(delta,10);
  if (!Number.isInteger(change) || change === 0) return false;
  return repoUpdateQuantity(encodedCode,{delta:change},source || 'manual');
}

async function repoSetAbsolute(encodedCode, value, source) {
  const absolute = Number.parseInt(value,10);
  if (!Number.isInteger(absolute)) { toast('Cantidad inválida','e'); return false; }
  return repoUpdateQuantity(encodedCode,{absolute},source || 'manual');
}

async function repoUpdateQuantity(encodedCode, change, source) {
  if (!requireRepoEditable()) return false;
  const code = repoDecoded(encodedCode);
  let item = repoState.items.find(row => String(row.codigo) === code);
  if (!item || !await repoEnsureClaim(item)) return false;
  item = repoState.items.find(row => String(row.codigo) === code) || item;
  const qty = change.absolute == null ? Number(item.preparado || 0) + Number(change.delta || 0) : Number(change.absolute);
  if (!item || !Number.isInteger(qty) || qty < 0) { toast('Cantidad inválida', 'e'); renderRepositionAll(); return false; }
  if (qty > Number(item.pedido)) {
    const confirmed = await appConfirm({
      title: 'Cantidad mayor a la solicitada',
      subtitle: item.nombre,
      tone: 'warning', icon: '!', confirmText: 'Guardar igualmente',
      bodyHtml: `<div class="app-dialog-product"><strong>${esc(item.nombre)}</strong><span>SKU ${esc(item.codigo)}</span></div><p class="app-dialog-message">Vas a registrar <strong>${qty}</strong> unidades, aunque el archivo solicita <strong>${item.pedido}</strong>. Quedará marcado como excedido y podrás corregirlo desde la lista.</p>`
    });
    if (!confirmed) { renderRepositionAll(); return false; }
  }
  const fileLimit = Math.max(0, Number(item.stock_origen) - 1);
  if (qty > fileLimit) {
    const confirmed = await appConfirm({
      title: 'Revisar stock del local de origen',
      subtitle: 'La recomendación es conservar al menos una unidad.',
      tone: 'warning', icon: '!', confirmText: 'Continuar y registrar',
      bodyHtml: `<div class="app-dialog-product"><strong>${esc(item.nombre)}</strong><span>SKU ${esc(item.codigo)}</span></div><p class="app-dialog-message">Según el archivo, convendría preparar como máximo <strong>${fileLimit}</strong> unidades. Estás intentando registrar <strong>${qty}</strong>. El stock real puede haber cambiado.</p>`
    });
    if (!confirmed) { renderRepositionAll(); return false; }
  }
  try {
    const response = await repoApi('/api/reposicion/update_qty', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({reposition_id:sessionId,codigo:code,absolute:change.absolute == null ? null : qty,delta:change.absolute == null ? Number(change.delta || 0) : null,usuario:usuarioNombre,source})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo actualizar');
    const index = repoState.items.findIndex(row => String(row.codigo) === code);
    repoState.items[index] = repoHydrateItemFromCatalog(data.item);
    tactileFeedback(24);
    if (Number(data.item.preparado) >= Number(data.item.pedido) && source !== 'lista') {
      await repoClaimNext({excludeCode:code,render:false,silent:true});
    }
    renderRepositionAll();
    return true;
  } catch (error) { toast(error.message, 'e'); return false; }
}

function repoEditQty(encodedCode) {
  const code = repoDecoded(encodedCode);
  const item = repoState.items.find(row => String(row.codigo) === code);
  if (!item) return;
  repoOpenQuantityModal(encodedCode, item.preparado || 0, 'absolute');
}

function toggleRepoOtherReason(value) {
  const field = document.getElementById('repo-other-reason-field');
  const input = document.getElementById('repo-other-reason');
  if (!field) return;
  const show = value === 'otro';
  field.style.display = show ? 'block' : 'none';
  if (show) setTimeout(() => input?.focus(), 30);
}

function repoRequestNotFoundDetails(item) {
  const currentCode = String(item.motivo_codigo || '');
  const reasons = REPO_NOT_FOUND_REASONS.map(reason => `
    <label class="reason-option">
      <input type="radio" name="repo-not-found-reason" value="${esc(reason.code)}" ${currentCode === reason.code ? 'checked' : ''} onchange="toggleRepoOtherReason(this.value)">
      <span>${esc(reason.label)}</span>
    </label>`).join('');
  const currentComment = String(item.comentario || '');
  const currentOther = String(item.motivo_otro || '');
  return openAppDialog({
    title: 'Marcar como no encontrado',
    subtitle: 'El motivo y el comentario son opcionales.',
    tone: 'warning', icon: '?', confirmText: 'Guardar y continuar',
    bodyHtml: `
      <div class="app-dialog-product"><strong>${esc(item.nombre)}</strong><span>SKU ${esc(item.codigo)} · Solicitado ${item.pedido} · Juntado ${item.preparado || 0}</span></div>
      <div class="dialog-field"><span>Motivo (opcional)</span><div class="reason-grid">${reasons}</div></div>
      <label class="dialog-field" id="repo-other-reason-field" style="display:${currentCode === 'otro' ? 'block' : 'none'}"><span>Descripción de “Otro” (opcional)</span><input class="input" id="repo-other-reason" maxlength="200" value="${esc(currentOther)}" placeholder="Podés ampliar el motivo"></label>
      <label class="dialog-field"><span>Comentario adicional (opcional)</span><textarea class="input" id="repo-not-found-comment" maxlength="500" placeholder="Ej.: se revisó depósito, góndola y cajas cerradas" oninput="updateDialogCounter('repo-not-found-comment',500)">${esc(currentComment)}</textarea><small class="dialog-counter" id="repo-not-found-comment-counter">${currentComment.length}/500</small></label>`,
    validate: body => {
      const selected = body.querySelector('input[name="repo-not-found-reason"]:checked')?.value || '';
      const reason = REPO_NOT_FOUND_REASONS.find(entry => entry.code === selected);
      const other = String(body.querySelector('#repo-other-reason')?.value || '').trim();
      const comment = String(body.querySelector('#repo-not-found-comment')?.value || '').trim();
      const label = reason?.label || '';
      const base = selected === 'otro' ? (other ? `Otro: ${other}` : 'Otro') : label;
      const motivo = [base, comment].filter(Boolean).join(' · ');
      return {ok:true,value:{motivo_codigo:selected,motivo_label:label,motivo_otro:selected === 'otro' ? other : '',comentario:comment,motivo}};
    }
  });
}

async function repoRequestIncompleteDetails(item) {
  const comment = await appPrompt({
    title: 'Cerrar con cantidad incompleta',
    subtitle: item.nombre,
    message: `Solicitado: ${item.pedido} · Juntado: ${item.preparado || 0}. Podés explicar por qué se enviará una cantidad menor.`,
    label: 'Comentario (opcional)',
    value: item.comentario || '',
    placeholder: 'Ej.: sólo había 2 unidades disponibles',
    multiline: true, maxLength: 500,
    tone: 'warning', icon: '!', confirmText: 'Cerrar incompleto'
  });
  if (comment === null) return null;
  return {
    motivo_codigo: 'cantidad_incompleta', motivo_label: 'Cantidad incompleta',
    motivo_otro: '', comentario: comment,
    motivo: comment ? `Cantidad incompleta · ${comment}` : 'Cantidad incompleta'
  };
}

async function repoMark(encodedCode, field) {
  if (!requireRepoEditable()) return;
  const code = repoDecoded(encodedCode);
  const item = repoState.items.find(row => String(row.codigo) === code);
  if (!item) return;
  if (!await repoEnsureClaim(item)) return;
  const details = field === 'no_encontrado'
    ? await repoRequestNotFoundDetails(item)
    : await repoRequestIncompleteDetails(item);
  if (!details) return;
  try {
    const response = await repoApi('/api/reposicion/mark', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:sessionId,codigo:code,field,value:true,...details,usuario:usuarioNombre})});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo guardar');
    const index = repoState.items.findIndex(row => String(row.codigo) === code);
    repoState.items[index] = repoHydrateItemFromCatalog(data.item);
    await repoClaimNext({excludeCode:code,render:false,silent:true});
    renderRepositionAll();
  } catch (error) { toast(error.message, 'e'); }
}

async function repoSelectNext(preferPending, direction = 1) {
  if (!repoState || !repoState.items.length) return;
  if (preferPending && repoCanEdit() && window.SucanCloud) {
    const current = repoState.items[repoCurrentIndex];
    const claimed = await repoClaimNext({excludeCode:current?.codigo || null,silent:true});
    if (!claimed) toast('No quedan productos disponibles; los restantes pueden estar asignados a otras personas.','i');
    return;
  }
  repoExhausted = false;
  const length = repoState.items.length;
  for (let step = 1; step <= length; step += 1) {
    const index = (repoCurrentIndex + direction * step + length * 2) % length;
    if (!preferPending || ['pendiente','parcial'].includes(SucaneitorReposition.status(repoState.items[index]))) {
      repoCurrentIndex = index;
      renderRepoCurrent();
      window.scrollTo({top:0,behavior:'auto'});
      return;
    }
  }
  repoCurrentIndex = (repoCurrentIndex + direction + length) % length;
  renderRepoCurrent();
}

function repoOpenItem(encodedCode) {
  const code = repoDecoded(encodedCode);
  const index = repoState.items.findIndex(item => String(item.codigo) === code);
  if (index >= 0) {
    repoExhausted = false;
    repoCurrentIndex = index;
    showRepoTab('preparar');
    renderRepoCurrent();
  }
}

function repoOpenFullList() {
  const search = document.getElementById('repo-list-search');
  const filter = document.getElementById('repo-list-filter');
  if (search) search.value = '';
  if (filter) filter.value = 'all';
  showRepoTab('lista');
  renderRepoList();
}

function renderRepoList() {
  const container = document.getElementById('repo-items-list');
  if (!container || !repoState) return;
  const query = String(document.getElementById('repo-list-search')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('repo-list-filter')?.value || 'all';
  let rows = repoState.items.filter(item => !query || `${item.codigo} ${item.nombre}`.toLowerCase().includes(query));
  rows = rows.filter(item => {
    const status = SucaneitorReposition.status(item);
    if (filter === 'pending') return ['pendiente','parcial','incompleto'].includes(status);
    if (filter === 'complete') return status === 'completo';
    if (filter === 'over') return status === 'excedido';
    if (filter === 'not_found') return status === 'no_encontrado';
    return true;
  });
  const visibleRows = rows.slice(0,repoListRenderLimit);
  container.innerHTML = rows.length ? visibleRows.map(item => {
    const status = SucaneitorReposition.status(item);
    const rowClass = status === 'completo' ? 'complete' : status === 'excedido' ? 'over' : status === 'no_encontrado' ? 'not-found' : status === 'parcial' || status === 'incompleto' ? 'partial' : '';
    const code = repoEncoded(item.codigo);
    const reason = item.motivo_label || item.motivo || '';
    const source = Number(item.pedido_clientes) > 0 ? ` · Repo ${Number(item.pedido_reposicion)||0} · Clientes ${Number(item.pedido_clientes)||0}` : '';
    const actions=repoCanEdit()?`<div class="repo-row-actions"><button class="btn btn-s" onclick="repoChangeQty('${code}',-1,'lista')">−</button><input class="input repo-qty-input" type="number" min="0" inputmode="numeric" value="${item.preparado}" onchange="repoSetAbsolute('${code}',this.value,'lista')"><button class="btn btn-s" onclick="repoChangeQty('${code}',1,'lista')">+</button></div>`:`<strong>${item.preparado}/${item.pedido}</strong>`;
    return `<article class="repo-row ${rowClass}"><div onclick="repoOpenItem('${code}')" style="cursor:pointer"><h3>${esc(item.nombre)}</h3><div class="repo-row-meta">SKU ${esc(item.codigo)} · Total físico ${item.pedido}${source} · Stock archivo ${item.stock_origen} · ${esc(status.replaceAll('_',' '))}${reason ? ` · ${esc(reason)}` : ''}${item.updated_by ? ` · Último cambio: ${esc(item.updated_by)}` : ''}</div></div>${actions}</article>`;
  }).join('') + (rows.length > visibleRows.length ? `<button class="btn btn-s btn-full" onclick="repoShowMoreItems()">Mostrar ${Math.min(200,rows.length-visibleRows.length)} más · quedan ${rows.length-visibleRows.length}</button>` : '') : '<div class="repo-empty">No hay productos para este filtro.</div>';
}

function repoShowMoreItems() {
  repoListRenderLimit += 200;
  renderRepoList();
}

function searchRepoProducts(query, mode) {
  const value = String(query || '').trim();
  const target = mode === 'extra' ? 'repo-extra-results' : 'repo-search-results';
  const container = document.getElementById(target);
  if (!container) return;
  clearTimeout(repoProductSearchTimers.get(target));
  if (value.length < 2) { container.style.display = 'none'; container.innerHTML = ''; return; }
  repoProductSearchTimers.set(target, setTimeout(() => runRepoProductSearch(value, mode, target, container), 90));
}

function runRepoProductSearch(value, mode, target, container) {
  const source = padron;
  const requestedCodes = new Set((repoState.items || []).map(item => String(item.codigo)));
  let results;
  if (window.SucaneitorSearch) {
    const index = mode === 'extra' ? ensureSearchIndex() : ensureSearchIndex();
    results = SucaneitorSearch.rankProducts(index, value, null, 20).map(result => result.product);
    const compact = SucaneitorSearch.normalizeText(value);
    source.filter(product => String(product.codigo).toLowerCase().includes(value.toLowerCase()) || String(product.barras || '').includes(compact))
      .forEach(product => { if (!results.some(item => String(item.codigo) === String(product.codigo))) results.unshift(product); });
  } else {
    const simple = value.toLowerCase();
    results = source.filter(product => `${product.codigo} ${product.nombre} ${product.barras || ''}`.toLowerCase().includes(simple)).slice(0,20);
  }
  if (mode !== 'extra') {
    results.sort((a,b) => Number(requestedCodes.has(String(b.codigo))) - Number(requestedCodes.has(String(a.codigo))));
  }
  repoSearchResultsByTarget[target] = results.slice(0,20);
  container.style.display = 'block';
  container.innerHTML = results.length ? results.slice(0,20).map((product,index) => `<button type="button" class="repo-result" onclick="selectRepoSearchResult('${target}',${index},'${mode}')"><strong>${esc(product.nombre)}</strong><span>SKU ${esc(product.codigo)}${product.barras ? ` · Barras ${esc(product.barras)}` : ' · Sin barras'}${mode !== 'extra' ? (requestedCodes.has(String(product.codigo)) ? ' · PEDIDO' : ' · FUERA DEL PEDIDO') : ''}</span></button>`).join('') : '<div class="repo-empty">Sin coincidencias.</div>';
}

async function selectRepoSearchResult(target, index, mode) {
  const product = (repoSearchResultsByTarget[target] || [])[index];
  if (!product) return;
  document.getElementById(target).style.display = 'none';
  if (mode === 'extra') await repoPromptAddExtra(product);
  else if (repoState.items.some(item => String(item.codigo) === String(product.codigo))) repoOpenItem(repoEncoded(product.codigo));
  else await repoPromptAddExtra(product);
}

async function repoPromptAddExtra(product) {
  if (!requireRepoEditable()) return;
  const value = await appPrompt({
    title: 'Agregar producto extra',
    subtitle: 'Se incluirá en un remito separado.',
    message: product.nombre,
    label: 'Cantidad a enviar', value: '1', type: 'number', inputMode: 'numeric', min: 1,
    icon: '+', confirmText: 'Agregar al remito'
  });
  if (value === null) return;
  const qty = Number.parseInt(value,10);
  if (!Number.isInteger(qty) || qty <= 0) { toast('Cantidad inválida', 'e'); return; }
  await repoUpdateExtra(product, qty, true);
}

async function repoUpdateExtra(productOrCode, value, absolute = false) {
  if (!requireRepoEditable()) return;
  const code = typeof productOrCode === 'object' ? String(productOrCode.codigo) : repoDecoded(productOrCode);
  const product = typeof productOrCode === 'object' ? productOrCode : padron.find(item => String(item.codigo) === code) || repoState.extras.find(item => String(item.codigo) === code);
  try {
    const payload = {reposition_id:sessionId,codigo:code,nombre:product?.nombre || code,barras:product?.barras || '',usuario:usuarioNombre};
    if (absolute) payload.absolute = Number.parseInt(value,10); else payload.delta = Number.parseInt(value,10);
    const response = await repoApi('/api/reposicion/extra', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo guardar el extra');
    const index = repoState.extras.findIndex(item => String(item.codigo) === code);
    const extra = repoHydrateItemFromCatalog(data.extra);
    if (index >= 0) repoState.extras[index] = extra; else repoState.extras.push(extra);
    renderRepositionAll();
    toast('Extra actualizado en su remito separado', 's');
  } catch (error) { toast(error.message, 'e'); }
}

async function repoRemoveExtra(encodedCode) {
  if (!requireRepoEditable()) return;
  const code = repoDecoded(encodedCode);
  const item = repoState.extras.find(row => String(row.codigo) === code);
  const confirmed = await appConfirm({
    title: 'Quitar producto extra',
    subtitle: item?.nombre || `SKU ${code}`,
    message: 'El producto se eliminará únicamente del remito separado de extras.',
    icon: '×', tone: 'danger', confirmText: 'Sí, quitar producto'
  });
  if (!confirmed) return;
  try {
    const response = await repoApi('/api/reposicion/extra/remove', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:sessionId,codigo:code,usuario:usuarioNombre})});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo quitar');
    repoState.extras = repoState.extras.filter(item => String(item.codigo) !== code);
    renderRepositionAll();
  } catch (error) { toast(error.message, 'e'); }
}

function renderRepoExtras() {
  const container = document.getElementById('repo-extras-list');
  if (!container || !repoState) return;
  const extras = repoState.extras.filter(item => Number(item.cantidad) > 0);
  container.innerHTML = extras.length ? extras.map(item => {
    const code = repoEncoded(item.codigo);
    const actions=repoCanEdit()?`<div class="repo-row-actions"><button class="btn btn-s" onclick="repoUpdateExtra('${code}',-1)">−</button><input class="input repo-qty-input" type="number" min="0" inputmode="numeric" value="${item.cantidad}" onchange="repoUpdateExtra('${code}',this.value,true)"><button class="btn btn-s" onclick="repoUpdateExtra('${code}',1)">+</button><button class="btn btn-d" onclick="repoRemoveExtra('${code}')">×</button></div>`:`<strong>${item.cantidad}</strong>`;
    return `<article class="repo-row"><div><h3>${esc(item.nombre)}</h3><div class="repo-row-meta">SKU ${esc(item.codigo)} · Remito independiente</div></div>${actions}</article>`;
  }).join('') : '<div class="repo-empty">Todavía no agregaste productos fuera de la reposición.</div>';
}

function renderRepoSummary() {
  if (!repoState) return;
  const summary = SucaneitorReposition.summary(repoState);
  const status = document.getElementById('repo-summary-status');
  const detail = document.getElementById('repo-summary-detail');
  if (status) status.textContent = summary.faltantes ? `Quedan ${summary.faltantes} unidades` : 'Reposición completa';
  if (detail) {
    const verificationCount=(repoState.items||[]).filter(item=>item.requiere_verificacion).length;
    detail.textContent = `${summary.completos} productos completos, ${summary.parciales} parciales, ${summary.pendientes} pendientes, ${summary.excedidos} excedidos y ${summary.no_encontrados} no encontrados.${verificationCount?` ${verificationCount} producto${verificationCount===1?'':'s'} con cantidad múltiple requiere${verificationCount===1?'':'n'} control final.`:''}`;
  }
  const participants = document.getElementById('repo-participants');
  if (participants) participants.innerHTML = (repoState.participantes || []).map(item => `<span class="user-pill">${esc(item.nombre)}</span>`).join('');
  const missing = SucaneitorReposition.missingRows(repoState);
  const list = document.getElementById('repo-missing-list');
  if (list) list.innerHTML = missing.length ? missing.map(item => {
    const reason = item.motivo_label || item.motivo || '';
    const other = item.motivo_otro ? `: ${item.motivo_otro}` : '';
    return `<article class="repo-row not-found"><div><h3>${esc(item.nombre)}</h3><div class="repo-row-meta">SKU ${esc(item.codigo)} · Pedido ${item.pedido} · Juntado ${item.preparado}${reason ? ` · ${esc(reason + other)}` : ''}${item.comentario ? `<br>Comentario: ${esc(item.comentario)}` : ''}</div></div><strong style="color:var(--red)">Faltan ${item.faltante}</strong></article>`;
  }).join('') : '<div class="repo-empty">No hay faltantes.</div>';
}

function submitRepoBarcode() {
  if (!requireRepoEditable()) return;
  const input = document.getElementById('repo-barcode-input');
  const code = input.value.trim();
  if (!code) return;
  input.value = '';
  handleRepoBarcode(code, 'manual');
}

async function handleRepoBarcode(code, source = 'camera') {
  code = String(code || '').trim();
  if (!code || !repoState) return;
  const result = findByBarcode(code);
  const help = document.getElementById('repo-camera-help');
  if (!result.matches.length) {
    if (help) { help.textContent = `No encontrado: ${code}`; help.style.color = '#ff7185'; }
    currentUnknownBarcode = code;
    document.getElementById('modal-title').textContent = 'Código no encontrado';
    document.getElementById('modal-subtitle').textContent = code;
    document.getElementById('modal-body').innerHTML = '<p class="tm">No se agregó ninguna unidad. Podés seguir o registrar este código para corregir el padrón después.</p>';
    document.getElementById('modal-actions').innerHTML = '<button class="btn btn-s" onclick="closeModal()">Seguir</button><button class="btn btn-p" onclick="closeRepoScanner();openBarcodeAssignment()">Asignar código a un producto</button>';
    document.getElementById('modal-overlay').classList.add('show');
    return;
  }
  if (result.matches.length > 1) {
    window._repoBarcodeMatches = result.matches;
    window._repoBarcodeCode = code;
    document.getElementById('modal-title').textContent = 'Código compartido por varios productos';
    document.getElementById('modal-subtitle').textContent = 'Elegí el SKU que tenés físicamente. No se sumó nada todavía.';
    document.getElementById('modal-body').innerHTML = `<div style="max-height:340px;overflow:auto">${result.matches.map((product,index) => `<button class="repo-result" onclick="selectRepoBarcodeMatch(${index})"><strong>${esc(product.nombre)}</strong><span>SKU ${esc(product.codigo)}</span></button>`).join('')}</div>`;
    document.getElementById('modal-actions').innerHTML = '<button class="btn btn-s" onclick="closeModal()">Cancelar</button>';
    document.getElementById('modal-overlay').classList.add('show');
    return;
  }
  await routeRepoScannedProduct(result.matches[0], code, source);
}

async function selectRepoBarcodeMatch(index) {
  const product = (window._repoBarcodeMatches || [])[index];
  const code = window._repoBarcodeCode || '';
  closeModal();
  if (product) await routeRepoScannedProduct(product, code, 'camera');
}

async function routeRepoScannedProduct(product, code, source) {
  const requested = repoState.items.find(item => String(item.codigo) === String(product.codigo));
  const current = repoState.items[repoCurrentIndex];
  const help = document.getElementById('repo-camera-help');
  if (repoScannerMode === 'extra') {
    showRepoScanDecision(product,'extra');
    return;
  }
  if (requested && current && String(requested.codigo) === String(current.codigo)) {
    const added = await repoChangeQty(repoEncoded(requested.codigo), 1, 'scanner');
    if (help) { help.textContent = added ? `Correcto: ${requested.nombre} · +1` : 'Lectura cancelada'; help.style.color = added ? '#63e6be' : '#ffd166'; }
    return;
  }
  if (requested) {
    if (help) { help.textContent = `No corresponde al producto mostrado: ${product.nombre}`; help.style.color = '#ff7185'; }
    showRepoScanDecision(product,'requested');
    return;
  }
  if (help) { help.textContent = `Producto fuera de la solicitud: ${product.nombre}`; help.style.color = '#ffd166'; }
  showRepoScanDecision(product,'extra');
}

function showRepoScanDecision(product, mode) {
  window._repoScannedDecisionProduct = product;
  window._repoScannedDecisionMode = mode;
  const isRequested = mode === 'requested';
  document.getElementById('modal-title').textContent = isRequested ? 'Es otro producto solicitado' : 'Producto fuera de la reposición';
  document.getElementById('modal-subtitle').textContent = isRequested
    ? 'No corresponde al producto que está en pantalla. No se agregó ninguna unidad.'
    : 'Este producto se puede enviar, pero irá en un remito separado.';
  document.getElementById('modal-body').innerHTML = `<div class="assignment-confirm"><strong>${esc(product.nombre)}</strong><dl><dt>SKU</dt><dd>${esc(product.codigo)}</dd><dt>Código de barras</dt><dd>${esc(product.barras || '—')}</dd></dl></div>`;
  document.getElementById('modal-actions').innerHTML = `<button class="btn btn-s" onclick="closeModal()">No agregar</button><button class="btn btn-p" onclick="confirmRepoScanDecision()">${isRequested ? 'Agregar +1 a ese producto' : 'Agregar +1 como extra'}</button>`;
  document.getElementById('modal-overlay').classList.add('show');
}

async function confirmRepoScanDecision() {
  const product = window._repoScannedDecisionProduct;
  const mode = window._repoScannedDecisionMode;
  closeModal();
  if (!product) return;
  if (mode === 'requested') await repoChangeQty(repoEncoded(product.codigo),1,'scanner_otro_producto');
  else await repoUpdateExtra(product,1,false);
}

async function loadHtml5QrcodeForRepo() {
  if (window.Html5Qrcode) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'html5-qrcode.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar el escáner'));
    document.head.appendChild(script);
  });
}

async function openRepoScanner(mode = 'requested', verifyCurrent = false) {
  if (!requireRepoEditable()) return;
  repoScannerMode = mode === 'extra' ? 'extra' : 'requested';
  const modal = document.getElementById('repo-camera-modal');
  document.getElementById('repo-camera-title').textContent = verifyCurrent && repoState?.items?.[repoCurrentIndex]
    ? `Comprobar: ${repoState.items[repoCurrentIndex].nombre}`
    : repoScannerMode === 'extra' ? 'Escanear producto extra' : 'Escanear producto';
  const help = document.getElementById('repo-camera-help');
  help.textContent = verifyCurrent ? 'El código debe coincidir con el producto mostrado.' : 'Cada lectura válida suma una unidad.';
  help.style.color = '#d7e6ed';
  modal.classList.add('show');
  try {
    await loadHtml5QrcodeForRepo();
    repoScanner = new Html5Qrcode('repo-camera-reader');
    const width = Math.min(window.innerWidth - 40, 480);
    await repoScanner.start({facingMode:'environment'}, {fps:15,qrbox:{width:Math.max(220,Math.round(width*.82)),height:150},aspectRatio:1.333}, decodedText => {
      const now = Date.now();
      if (decodedText === repoLastScanCode && now - repoLastScanTime < 1200) return;
      repoLastScanCode = decodedText;
      repoLastScanTime = now;
      tactileFeedback(35);
      handleRepoBarcode(decodedText, 'camera');
    }, () => {});
  } catch (error) {
    help.textContent = 'No se pudo abrir la cámara. Podés escribir el código manualmente.';
    help.style.color = '#ff7185';
    toast('No se pudo iniciar la cámara', 'e');
  }
}

async function closeRepoScanner() {
  document.getElementById('repo-camera-modal')?.classList.remove('show');
  if (repoScanner) {
    try { await repoScanner.stop(); } catch (error) {}
    try { await repoScanner.clear(); } catch (error) {}
    repoScanner = null;
  }
  const reader = document.getElementById('repo-camera-reader');
  if (reader) reader.innerHTML = '';
}

function repoSafeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80) || 'Reposicion';
}

async function repoLoadTemplate() {
  if (repoTemplateBytes) return repoTemplateBytes.slice(0);
  const response = await fetch('Plantilla%20Importacion%20Transaccion%20Stock.xls');
  if (!response.ok) throw new Error('No se encontró la plantilla de importación');
  repoTemplateBytes = await response.arrayBuffer();
  return repoTemplateBytes.slice(0);
}

async function repoBuildTransfer(rows) {
  const XLSX = await waitForXlsx();
  const template = await repoLoadTemplate();
  return SucaneitorRepositionExport.buildTransfer(template,XLSX,rows);
}

async function repoBuildMissing() {
  const XLSX = await waitForXlsx();
  return SucaneitorRepositionExport.buildMissing(repoState,XLSX,SucaneitorReposition);
}

async function repoBuildSummary() {
  const XLSX = await waitForXlsx();
  return SucaneitorRepositionExport.buildSummary(repoState,XLSX,SucaneitorReposition);
}

async function repoGenerateExports() {
  const route = `${repoSafeName(repoState.origin)}_${repoSafeName(repoState.destination)}`;
  return [
    {type:'main',name:`Remito_Reposicion_${route}.xls`,mime:'application/vnd.ms-excel',buffer:await repoBuildTransfer(SucaneitorReposition.mainTransferRows(repoState))},
    {type:'orders',name:`Remito_Pedidos_${route}.xls`,mime:'application/vnd.ms-excel',buffer:await repoBuildTransfer(SucaneitorReposition.orderTransferRows(repoState))},
    {type:'extras',name:`Remito_Extras_${route}.xls`,mime:'application/vnd.ms-excel',buffer:await repoBuildTransfer(SucaneitorReposition.extraTransferRows(repoState))},
    {type:'missing',name:`Faltantes_${route}.xlsx`,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await repoBuildMissing()},
    {type:'summary',name:`Resumen_Reposicion_${route}.xlsx`,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await repoBuildSummary()}
  ];
}

function repoDownloadBuffer(buffer, name, mime) {
  const blob = new Blob([buffer],{type:mime});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href=url; anchor.download=name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}

async function repoLogExport(file) {
  try { await repoApi('/api/reposicion/export_log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:sessionId,usuario:usuarioNombre,tipo:file.type,nombre:file.name})}); } catch (error) {}
}

async function downloadRepoExport(type) {
  if (!repoState) return;
  const stats = SucaneitorReposition.summary(repoState);
  if (stats.faltantes > 0) {
    const confirmed = await appConfirm({
      title: 'La reposición todavía tiene faltantes',
      subtitle: `${stats.faltantes} unidades pendientes en ${stats.productos_faltantes} productos.`,
      message: 'El remito incluirá únicamente las cantidades que ya fueron juntadas. El archivo de faltantes conservará los motivos y comentarios registrados.',
      icon: '!', tone: 'warning', confirmText: 'Generar igualmente'
    });
    if (!confirmed) return;
  }
  try {
    toast('Generando archivos…','i');
    const files = await repoGenerateExports();
    if (type === 'package') {
      const response = await repoApi('/api/reposicion/export_package',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:sessionId,usuario:usuarioNombre,filename:`Reposicion_${repoSafeName(repoState.origin)}_${repoSafeName(repoState.destination)}.zip`,files:files.map(file => ({name:file.name,base64:repoArrayBufferToBase64(file.buffer)}))})});
      if (!response.ok) { const data=await response.json().catch(()=>({})); throw new Error(data.error || 'No se pudo generar el paquete'); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const anchor=document.createElement('a'); anchor.href=url; anchor.download=`Reposicion_${repoSafeName(repoState.origin)}_${repoSafeName(repoState.destination)}.zip`; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('Paquete completo descargado','s');
      return;
    }
    const file = files.find(item => item.type === type);
    if (!file) return;
    repoDownloadBuffer(file.buffer,file.name,file.mime);
    await repoLogExport(file);
    toast(`${file.name} descargado`,'s');
  } catch (error) { toast(error.message || 'No se pudo generar el archivo','e'); }
}

async function downloadRepoOriginal() {
  if (!sessionId) return;
  try {
    if (window.SucanCloud) await window.SucanCloud.loadOriginal(sessionId);
    else if (serverUrl) window.location.href = `${serverUrl}/api/reposicion/original?rid=${encodeURIComponent(sessionId)}`;
  } catch (error) { toast(error.message || 'Archivo original no disponible','e'); }
}

function startRepoUrgentWatcher() {
  stopRepoUrgentWatcher();
  if (!window.SucanCloud || !repoState || !repoCanEdit()) return;
  checkRepoUrgentOrders();
  repoUrgentTimer = setInterval(checkRepoUrgentOrders, 20000);
}

function stopRepoUrgentWatcher() {
  if (repoUrgentTimer) clearInterval(repoUrgentTimer);
  repoUrgentTimer = null;
}

async function checkRepoUrgentOrders() {
  if (!window.SucanCloud || !repoState || !repoCanEdit()) return;
  try {
    const orders = await window.SucanCloud.checkUrgentOrders(repoState);
    for (const order of orders) {
      if ((repoUrgentSnoozed.get(order.id) || 0) > Date.now()) continue;
      if (!window.SucanCloud.isSupervisor()) {
        repoUrgentSnoozed.set(order.id, Date.now() + 5 * 60 * 1000);
        toast(`Pedido urgente pendiente de supervisor${order.cliente ? ': ' + order.cliente : ''}`,'w');
        continue;
      }
      const products=(order.pedido_productos || []).map(item=>`${esc(item.nombre)} ×${Number(item.cantidad_aceptada == null ? item.cantidad : item.cantidad_aceptada) || 0}`).join('<br>');
      const confirmed=await appConfirm({
        title:'Pedido urgente recibido',subtitle:`${repoState.origin} → ${repoState.destination}`,
        icon:'!',tone:'warning',confirmText:'Agregar a la reposición actual',
        bodyHtml:`<div class="app-dialog-product"><strong>${esc(order.cliente || 'Cliente sin nombre')}</strong><span>${esc(order.telefono || 'Sin teléfono')}</span></div><p class="app-dialog-message">Este pedido fue aceptado después de iniciar la preparación.</p><div class="app-dialog-product">${products}</div>`
      });
      if (confirmed) {
        repoState=repoHydrateStateFromCatalog(await window.SucanCloud.addUrgentOrder(sessionId,order.id));
        renderRepositionAll();
        toast('Pedido urgente agregado a la reposición actual','s');
      } else repoUrgentSnoozed.set(order.id, Date.now() + 5 * 60 * 1000);
    }
  } catch (error) { console.warn('No se pudieron revisar pedidos urgentes',error); }
}

function repoVerificationItems() {
  return (repoState?.items||[]).filter(item=>item.requiere_verificacion&&Number(item.preparado)>0);
}

function openRepoQuantityVerification(continuation) {
  if(typeof continuation==='function')repoVerificationContinuation=continuation;
  const pending=repoVerificationItems();
  if(!pending.length){const next=repoVerificationContinuation;repoVerificationContinuation=null;closeModal();if(next)setTimeout(next,30);return;}
  const item=pending[0],code=repoEncoded(item.codigo);
  window._repoVerificationCode=code;
  document.getElementById('modal-title').textContent='Control final de cantidades';
  document.getElementById('modal-subtitle').textContent=`${pending.length} ${pending.length===1?'producto pendiente':'productos pendientes'}`;
  document.getElementById('modal-body').innerHTML=`
    <div class="app-dialog-product"><strong>${esc(item.nombre)}</strong><span>SKU ${esc(item.codigo)}</span></div>
    <p class="app-dialog-message">Hay más de una unidad registrada. Mirá la mercadería separada y confirmá cuántas unidades físicas viajarán.</p>
    <div class="receipt-confirm-quantities"><div><span>Solicitado</span><strong>${item.pedido}</strong></div><div><span>Registrado</span><strong>${item.preparado}</strong></div><div class="final"><span>A confirmar</span><strong id="repo-verification-preview">${item.preparado}</strong></div></div>
    <label class="il" for="repo-verification-qty">Cantidad física comprobada</label>
    <div class="qty-stepper"><button class="qty-step" onclick="stepRepoVerification(-1)">−</button><input id="repo-verification-qty" class="input" type="number" min="0" inputmode="numeric" value="${item.preparado}" oninput="updateRepoVerificationPreview()" style="text-align:center;font-size:20px"><button class="qty-step" onclick="stepRepoVerification(1)">+</button></div>`;
  document.getElementById('modal-actions').innerHTML='<button class="btn btn-s" onclick="closeModal()">Revisar después</button><button class="btn btn-p" onclick="confirmRepoQuantityVerification()">Confirmar y continuar</button>';
  document.getElementById('modal-overlay').classList.add('show');
  setTimeout(()=>document.getElementById('repo-verification-qty')?.select(),60);
}

function updateRepoVerificationPreview(){const input=document.getElementById('repo-verification-qty'),preview=document.getElementById('repo-verification-preview');if(preview)preview.textContent=String(Math.max(0,Number.parseInt(input?.value,10)||0));}
function stepRepoVerification(delta){const input=document.getElementById('repo-verification-qty');if(!input)return;input.value=String(Math.max(0,(Number.parseInt(input.value,10)||0)+delta));updateRepoVerificationPreview();}

async function confirmRepoQuantityVerification() {
  const code=repoDecoded(window._repoVerificationCode||''),quantity=Number.parseInt(document.getElementById('repo-verification-qty')?.value,10);
  if(!code||!Number.isInteger(quantity)||quantity<0){toast('Ingresá una cantidad válida','e');return;}
  const button=document.querySelector('#modal-actions .btn-p');if(button){button.disabled=true;button.textContent='Guardando…';}
  try{
    const response=await repoApi('/api/reposicion/verify_qty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:sessionId,codigo:code,cantidad:quantity})}),data=await response.json().catch(()=>({}));
    if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo confirmar la cantidad');
    const index=repoState.items.findIndex(row=>String(row.codigo)===code);if(index>=0)repoState.items[index]=repoHydrateItemFromCatalog(data.item);
    renderRepositionAll();tactileFeedback(24);
    if(repoVerificationItems().length)openRepoQuantityVerification();else{const next=repoVerificationContinuation;repoVerificationContinuation=null;closeModal();toast('Control final de cantidades completado','s');if(next)setTimeout(next,40);}
  }catch(error){toast(error.message||'No se pudo confirmar la cantidad','e');if(button){button.disabled=false;button.textContent='Confirmar y continuar';}}
}
