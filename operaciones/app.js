// ===== ESTADO =====
let padron = [];
let sessionId = '';
let sessionNombre = '';
let usuarioNombre = '';
let countItems = {};   // {codigo: {codigo, nombre, qty, tipos}}
let actionLog = [];    // [{ts, tipo, codigo, nombre, qty}] — para el live log
let balanceData = null;
let almacen = '';
let searchType = 'barras';
let totalScans = 0;
let barcodeAssignments = [];
let effectiveBarcodeAssignments = [];
let currentUnknownBarcode = '';
let currentAssignmentProduct = null;
let currentAssignmentPhoto = '';
let compensationSuggestions = [];
let currentModule = '';
let repoState = null;
let repoSSE = null;
let repoHeartbeatTimer = null;
let repoFallbackTimer = null;
let repoClaimInFlight = null;
let repoRefreshInFlight = false;
let repoRefreshQueued = false;
let repoCurrentIndex = 0;
let repoExhausted = false;
let repoParsedSource = null;
let repoSourceBytes = null;
let repoScanner = null;
let repoScannerMode = 'requested';
let repoLastScanCode = '';
let repoLastScanTime = 0;
let appDialogResolver = null;
let appDialogValidator = null;
let appDialogLastFocus = null;
let availableSessions = [];
let sessionLoadSequence = 0;
let companyLocations = [];
let sessionDirectoryTimer = null;
let sessionLoadInFlight = null;
let sessionLoadModule = '';
let catalogRefreshTimer = null;
let suppressOperationsOverlayHistory = false;
let operationsBootHideTimer = null;

function showOperationsLoading(message = 'Cargando...') {
  const boot = document.getElementById('operations-boot');
  const text = document.getElementById('operations-boot-text');
  if (!boot) return;
  clearTimeout(operationsBootHideTimer);
  operationsBootHideTimer = null;
  if (text) text.textContent = message;
  boot.style.display = 'flex';
  requestAnimationFrame(() => boot.classList.remove('hidden'));
}

function finishOperationsBoot() {
  const boot = document.getElementById('operations-boot');
  if (!boot) return;
  clearTimeout(operationsBootHideTimer);
  boot.classList.add('hidden');
  operationsBootHideTimer = setTimeout(() => {
    boot.style.display = 'none';
    operationsBootHideTimer = null;
  }, 180);
}

function showOperationsBootError(message) {
  const text = document.getElementById('operations-boot-text');
  if (text) text.textContent = message;
}

// Red
let serverUrl = '';
let serverSSE = null;
let serverOnline = false;
let clientCountTimer = null;

// Cámara
let scannerStream = null;
let barcodeDetector = null;
let scanActive = false;
let lastScanCode = '';
let lastScanTime = 0;
let scanTriggerArmed = false;
let scanTriggerTimer = null;

// Debounce búsqueda
let searchTimer = null;
let searchIndex = [];
let indexedPadron = null;
let currentSearchResults = [];
const IS_IOS_DEVICE = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  new URLSearchParams(location.search).get('device') === 'ios';

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  applySavedTheme();
  const initialParams = new URLSearchParams(location.search);
  const requestedModule = initialParams.get('module');
  const requestedSession = initialParams.get('session');
  const requestedTab = initialParams.get('tab');
  if (!['inventario','reposicion','recepcion'].includes(requestedModule)) {
    location.replace('/');
    return;
  }
  currentModule = requestedModule;
  if (window.SucanCloud) {
    try {
      await window.SucanCloud.ready;
      usuarioNombre = window.SucanCloud.displayName;
      const userInput = document.getElementById('input-usuario');
      if (userInput) userInput.value = usuarioNombre;
      almacen = window.SucanCloud.profile?.almacen || '';
      serverUrl = location.origin;
      serverOnline = true;
      const [pdata,locationsData] = await Promise.all([
        fetch('/api/padron').then(response => response.json()),
        fetch('/api/locales').then(response => response.json())
      ]);
      padron = pdata.padron || [];
      companyLocations = locationsData.locales || [];
      invalidateSearchIndex();
      const barcodeProducts = padron.filter(product => clean(product.barras)).length;
      setPadronStatus(`${pdata.restored ? '✅ Padrón central restaurado' : pdata.fallback ? '⚠️ Padrón de respaldo activo' : '✅ Padrón central'}: ${padron.length} productos · ${barcodeProducts} con barras`);
      populateLocationControls();
      if (!window.SucanCloud.isSupervisor()) {
        ['inventory-padron-upload','repo-padron-upload','receipt-padron-upload'].forEach(id => { const card=document.getElementById(id); if(card) card.style.display='none'; });
      }
      window.SucanCloud.watchCatalog(scheduleCatalogRefresh);
      window.SucanCloud.watchSessionDirectory(scheduleSessionDirectoryRefresh);
    } catch (error) {
      console.error(error);
      showOperationsBootError('No pudimos sincronizar tu cuenta. Volvé al inicio e intentá nuevamente.');
      return;
    }
  } else {
    loadPadronFromBuiltin();
  }

  const inp = document.getElementById('search-input');
  inp.addEventListener('keydown', onSearchKeydown);
  inp.addEventListener('input',   onSearchInput);
  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('resize', positionSearchResults);
  if (!IS_IOS_DEVICE) window.visualViewport?.addEventListener('resize', positionSearchResults);
  document.documentElement.classList.toggle('ios-device', IS_IOS_DEVICE);
  window.addEventListener('popstate', handleOperationsPopState);
  setupOperationsOverlayHistory();

  const savedSearchType = localStorage.getItem('sc_search_type');
  const initialSearchType = ['barras', 'nombre', 'codigo'].includes(savedSearchType)
    ? savedSearchType
    : (window.matchMedia?.('(pointer: coarse)').matches ? 'nombre' : 'barras');
  setST(initialSearchType);

  selectModule(requestedModule,{showSessions:!requestedSession});
  if (requestedSession) {
    await unirseASesion(requestedSession,'',{history:'replace',tab:requestedTab || undefined});
    if (!sessionId) mostrarPantallaSesion(true);
  }
  finishOperationsBoot();
});

function populateLocationControls() {
  const profile = window.SucanCloud?.profile || {};
  const isSupervisor = !!window.SucanCloud?.isSupervisor?.();
  const createSelect = document.getElementById('session-create-location');
  if (createSelect) {
    const previous = createSelect.value;
    createSelect.innerHTML = '<option value="">Seleccionar local…</option>' + companyLocations.map(location =>
      `<option value="${esc(location.nombre)}">${esc(location.nombre)}${location.almacen ? ` (${esc(location.almacen)})` : ''}</option>`
    ).join('');
    createSelect.value = companyLocations.some(location => location.nombre === previous) ? previous : (isSupervisor ? '' : profile.local_nombre || '');
  }
  const warehouseSelect = document.getElementById('almacen-select');
  if (warehouseSelect) {
    const visibleLocations = isSupervisor ? companyLocations : companyLocations.filter(location => location.nombre === profile.local_nombre || location.almacen === profile.almacen);
    warehouseSelect.innerHTML = '<option value="">Seleccionar local…</option>' + visibleLocations.map(location =>
      `<option value="${esc(location.almacen || location.nombre)}">${esc(location.almacen || '—')} - ${esc(location.nombre)}</option>`
    ).join('');
    warehouseSelect.disabled = !isSupervisor;
    warehouseSelect.value = almacen || profile.almacen || '';
  }
}

function scheduleSessionDirectoryRefresh() {
  clearTimeout(sessionDirectoryTimer);
  sessionDirectoryTimer = setTimeout(() => {
    if (document.getElementById('session-screen')?.style.display !== 'none') cargarSesionesDisponibles({silent:true});
  }, 900);
}

function scheduleCatalogRefresh() {
  clearTimeout(catalogRefreshTimer);
  catalogRefreshTimer = setTimeout(async () => {
    try {
      const data = await fetch('/api/padron').then(response => response.json());
      if (data.padron?.length) {
        padron = data.padron;
        invalidateSearchIndex();
        setPadronStatus(`✅ Padrón central: ${padron.length} productos`);
        await loadBarcodeAssignments();
        renderSearchContext();
        toast('📋 Padrón central actualizado en todos los módulos', 's');
      }
    } catch (error) { console.warn('No se pudo refrescar el padrón central', error); }
  }, 350);
}

function selectModule(moduleName, options = {}) {
  currentModule = ['reposicion','recepcion'].includes(moduleName) ? moduleName : 'inventario';
  document.title = currentModule === 'recepcion' ? 'Sucaneitor · Control de remitos' : currentModule === 'reposicion' ? 'Sucaneitor · Reposición' : 'Sucaneitor · Inventario';
  localStorage.setItem('sc_module', currentModule);
  if (options.showSessions !== false) {
    mostrarPantallaSesion(true);
    updateOperationsHistory('replace','sessions');
  }
}

function operationsUrl(stage, tabName, sid) {
  const url = new URL(location.href);
  url.searchParams.set('module', currentModule);
  if (stage === 'workspace' && sid) {
    url.searchParams.set('session', sid);
    if (tabName) url.searchParams.set('tab', tabName);
  } else {
    url.searchParams.delete('session');
    url.searchParams.delete('tab');
  }
  return url.pathname + '?' + url.searchParams.toString();
}

function updateOperationsHistory(mode, stage, tabName, sid = sessionId) {
  if (mode === 'none') return;
  const state = {sucaneitorModule:currentModule,stage,tab:tabName || '',sessionId:sid || '',sessionName:sessionNombre || ''};
  const url = operationsUrl(stage,tabName,sid);
  if (mode === 'replace') history.replaceState(state,'',url);
  else if (JSON.stringify(history.state) !== JSON.stringify(state)) history.pushState(state,'',url);
}

function activeOperationsTab() {
  if (currentModule === 'reposicion') {
    return document.querySelector('#repo-tabs .tab.active')?.id?.replace('repo-tab-','') || '';
  }
  if (currentModule === 'recepcion') return document.querySelector('#receipt-tabs .tab.active')?.id?.replace('receipt-tab-','') || '';
  return document.querySelector('#main-tabs .tab.active')?.id?.replace('tab-','') || '';
}

function operationsRouteIsCurrent(state) {
  if (state.stage === 'sessions') {
    return !sessionId && document.getElementById('session-screen')?.style.display !== 'none';
  }
  if (state.stage !== 'workspace' || !state.sessionId || sessionId !== state.sessionId) return false;
  return !state.tab || activeOperationsTab() === state.tab;
}

function leaveOperationsWorkspace({notify = true} = {}) {
  if (scanActive) stopScanner();
  if (typeof stopRepoUrgentWatcher === 'function') stopRepoUrgentWatcher();
  if (currentModule === 'reposicion' && sessionId && typeof repoReleaseAssignment === 'function') repoReleaseAssignment();
  if (repoSSE) { repoSSE.close(); repoSSE = null; }
  if (serverSSE) { serverSSE.close(); serverSSE = null; }
  clearTimeout(clientCountTimer); clientCountTimer = null;
  closeRepoScanner();
  if (typeof closeReceiptScanner === 'function') closeReceiptScanner();
  if (typeof disconnectReceptionRealtime === 'function') disconnectReceptionRealtime();
  if (notify && currentModule === 'inventario' && serverOnline && sessionId) {
    fetch(`${serverUrl}/api/sesion/salir`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId})}).catch(()=>{});
  }
  sessionId = ''; sessionNombre = ''; repoState = null; repoExhausted = false;
  serverOnline = true;
  document.getElementById('main-nav').style.display = 'none';
  document.getElementById('main-tabs').style.display = 'none';
  document.getElementById('repo-tabs').style.display = 'none';
  document.getElementById('receipt-tabs').style.display = 'none';
}

async function handleOperationsPopState(event) {
  const state = event.state;
  if (!state || state.sucaneitorModule !== currentModule) return;
  const routeAlreadyCurrent = operationsRouteIsCurrent(state);
  const overlays = ['modal-overlay','app-dialog-overlay','repo-camera-modal','receipt-camera-modal'];
  const visibleOverlay = overlays.map(id => document.getElementById(id)).find(element => element?.classList.contains('show'));
  if (visibleOverlay && state.operationsOverlay !== visibleOverlay.id) {
    suppressOperationsOverlayHistory = true;
    if (visibleOverlay.id === 'app-dialog-overlay') resolveAppDialog(false);
    else if (visibleOverlay.id === 'repo-camera-modal' && typeof closeRepoScanner === 'function') closeRepoScanner();
    else if (visibleOverlay.id === 'receipt-camera-modal' && typeof closeReceiptScanner === 'function') closeReceiptScanner();
    else closeModal();
    requestAnimationFrame(() => { suppressOperationsOverlayHistory = false; });
  }
  if (state.operationsOverlay) {
    const overlay = document.getElementById(state.operationsOverlay);
    if (overlay && !overlay.classList.contains('show')) {
      suppressOperationsOverlayHistory = true;
      overlay.classList.add('show');
      requestAnimationFrame(() => { suppressOperationsOverlayHistory = false; });
    }
  }
  if (routeAlreadyCurrent) return;
  if (state.stage === 'sessions') {
    leaveOperationsWorkspace();
    mostrarPantallaSesion(true);
    return;
  }
  if (state.stage === 'workspace' && state.sessionId) {
    if (sessionId !== state.sessionId) await unirseASesion(state.sessionId,state.sessionName || '',{history:'none',tab:state.tab});
    else if (currentModule === 'reposicion') showRepoTab(state.tab || 'preparar',{history:'none'});
    else if (currentModule === 'recepcion') showReceiptTab(state.tab || 'control',{history:'none'});
    else showTab(state.tab || 'conteo',{history:'none'});
  }
}

function setupOperationsOverlayHistory() {
  ['modal-overlay','app-dialog-overlay','repo-camera-modal','receipt-camera-modal'].forEach(id => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.dataset.historyVisible = overlay.classList.contains('show') ? '1' : '0';
    new MutationObserver(() => {
      const visible = overlay.classList.contains('show');
      const wasVisible = overlay.dataset.historyVisible === '1';
      overlay.dataset.historyVisible = visible ? '1' : '0';
      if (visible === wasVisible || suppressOperationsOverlayHistory) return;
      if (visible && history.state?.operationsOverlay !== id) {
        history.pushState({...history.state,operationsOverlay:id},'',location.href);
      } else if (!visible && history.state?.operationsOverlay === id) {
        history.back();
      }
    }).observe(overlay,{attributes:true,attributeFilter:['class']});
  });
}

function backToModules() {
  if (typeof stopRepoUrgentWatcher === 'function') stopRepoUrgentWatcher();
  if (currentModule === 'reposicion' && sessionId && typeof repoReleaseAssignment === 'function') repoReleaseAssignment();
  if (repoSSE) { repoSSE.close(); repoSSE = null; }
  if (serverSSE) { serverSSE.close(); serverSSE = null; }
  closeRepoScanner();
  if (typeof closeReceiptScanner === 'function') closeReceiptScanner();
  if (typeof disconnectReceptionRealtime === 'function') disconnectReceptionRealtime();
  currentModule = '';
  sessionId = ''; sessionNombre = ''; repoState = null;
  document.getElementById('session-screen').style.display = 'none';
  document.getElementById('main-nav').style.display = 'none';
  document.getElementById('main-tabs').style.display = 'none';
  document.getElementById('repo-tabs').style.display = 'none';
  document.getElementById('receipt-tabs').style.display = 'none';
  document.querySelectorAll('.page,.repo-page').forEach(page => page.classList.remove('active'));
  location.href = '/';
}

function mostrarPantallaSesion(loadSessions = true) {
  if (!currentModule) {
    location.replace('/');
    return;
  }
  document.getElementById('session-screen').style.display = 'flex';
  document.getElementById('main-nav').style.display = 'none';
  document.getElementById('main-tabs').style.display = 'none';
  document.getElementById('repo-tabs').style.display = 'none';
  document.getElementById('receipt-tabs').style.display = 'none';

  const isRepo = currentModule === 'reposicion';
  const isReceipt = currentModule === 'recepcion';
  document.getElementById('session-module-name').textContent = isRepo ? 'Reposición' : isReceipt ? 'Recepción' : 'Inventario';
  document.getElementById('session-module-subtitle').textContent = isRepo ? 'Preparación colaborativa y generación de remitos' : isReceipt ? 'Control colaborativo de mercadería recibida' : 'Sistema de conteo colaborativo';
  document.getElementById('repo-file-fields').style.display = isRepo ? 'block' : 'none';
  document.getElementById('receipt-file-fields').style.display = isReceipt ? 'block' : 'none';
  document.getElementById('create-session-title').textContent = isRepo ? 'Crear reposición nueva' : isReceipt ? 'Crear control de remito' : 'Crear sesión nueva';
  const sessionInput = document.getElementById('input-sesion-nombre');
  sessionInput.placeholder = isRepo || isReceipt ? 'Nombre opcional (se completa desde el archivo)' : 'Ej: Inventario PDE marzo';
  const profile = window.SucanCloud?.profile || {};
  const displayName = window.SucanCloud?.displayName || localStorage.getItem('sc_usuario') || 'Usuario';
  const localName = profile.local_nombre || '';
  const warehouse = profile.almacen || '';
  const isSupervisor = !!window.SucanCloud?.isSupervisor?.();
  document.getElementById('input-usuario').value = displayName;
  document.getElementById('session-user-context').textContent = displayName;
  document.getElementById('session-scope-label').textContent = isSupervisor
    ? 'Acceso administrativo: podés ver las sesiones de toda la empresa.'
    : localName
      ? `Mostrando solamente sesiones vinculadas a ${localName}${warehouse ? ` (${warehouse})` : ''}.`
      : 'Mostrando las sesiones disponibles para tu cuenta.';
  const locationFilter = document.getElementById('session-location-filter');
  locationFilter.style.display = isSupervisor ? 'block' : 'none';
  if (!isSupervisor) locationFilter.value = '';
  const createLocationWrap = document.getElementById('session-create-location-wrap');
  if (createLocationWrap) createLocationWrap.style.display = isSupervisor && !isRepo && !isReceipt ? 'block' : 'none';
  populateLocationControls();
  document.getElementById('session-search').value = '';
  document.getElementById('available-sessions-title').textContent = isRepo ? 'Reposiciones disponibles' : isReceipt ? 'Controles de remitos disponibles' : 'Inventarios disponibles';
  document.querySelector('#session-create-panel summary').lastChild.textContent = isRepo ? ' Crear una reposición nueva' : isReceipt ? ' Crear un control de remito' : ' Crear un inventario nuevo';

  if (loadSessions) cargarSesionesDisponibles();
}

function entrarApp(options = {}) {
  if (currentModule === 'reposicion') {
    enterRepositionApp();
    return;
  }
  if (currentModule === 'recepcion') { enterReceptionApp(options); return; }
  document.getElementById('session-screen').style.display = 'none';
  document.getElementById('main-nav').style.display = 'flex';
  document.getElementById('main-tabs').style.display = 'flex';
  const badge = document.getElementById('nav-almacen');
  if (sessionNombre) badge.title = 'Sesión: ' + sessionNombre;

  // Si es app Android: mostrar botón de escáner nativo, ocultar botón WebView
  if (window.AndroidBridge && window.AndroidBridge.isAndroidApp()) {
    const nativeBtn = document.getElementById('android-scanner-btn');
    const webBtn = document.getElementById('start-scan-btn');
    if (nativeBtn) nativeBtn.style.display = 'block';
    if (webBtn) webBtn.style.display = 'none';
  }

  const initialTab = options.tab || 'conteo';
  showTab(initialTab,{history:'none'});
  updateOperationsHistory(options.history || 'push','workspace',initialTab);
  renderSearchContext();
  focusSearchInput();
  // En modo red, el estado viene del servidor. No pisar con localStorage viejo.
  if (!serverOnline) loadLocalState();
  updateSessionCard();
  if (serverOnline) loadBarcodeAssignments();
}

function normalizeSessionSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .trim();
}

function sessionLocations(session) {
  return [session.local_nombre, session.almacen, session.origin, session.destination]
    .map(value => String(value || '').trim())
    .filter(Boolean);
}

function populateSessionLocationFilter(sessions) {
  const filter = document.getElementById('session-location-filter');
  if (!filter || !window.SucanCloud?.isSupervisor?.()) return;
  const previous = filter.value;
  const labels = [...new Set(sessions.flatMap(sessionLocations))]
    .sort((left, right) => left.localeCompare(right, 'es', {sensitivity:'base'}));
  filter.innerHTML = '<option value="">Toda la empresa</option>' + labels
    .map(label => `<option value="${esc(label)}">${esc(label)}</option>`)
    .join('');
  filter.value = labels.includes(previous) ? previous : '';
}

function renderAvailableSessions() {
  const items = document.getElementById('sesiones-items');
  const count = document.getElementById('session-results-count');
  if (!items || !count) return;
  const queryTerms = normalizeSessionSearch(document.getElementById('session-search')?.value).split(/\s+/).filter(Boolean);
  const selectedLocation = normalizeSessionSearch(document.getElementById('session-location-filter')?.value);
  const profileLocation = normalizeSessionSearch(window.SucanCloud?.profile?.local_nombre || window.SucanCloud?.profile?.almacen);

  const visible = availableSessions.filter(session => {
    const participants = [...(session.usuarios || []), ...(session.participantes || [])]
      .map(person => person.nombre || '').join(' ');
    const locations = sessionLocations(session);
    const haystack = normalizeSessionSearch([
      session.nombre, session.id, session.estado, participants, ...locations
    ].join(' '));
    const matchesSearch = queryTerms.every(term => haystack.includes(term));
    const matchesLocation = !selectedLocation || locations.some(value => normalizeSessionSearch(value) === selectedLocation);
    return matchesSearch && matchesLocation;
  }).sort((left, right) => {
    const leftLocal = sessionLocations(left).some(value => normalizeSessionSearch(value) === profileLocation) ? 1 : 0;
    const rightLocal = sessionLocations(right).some(value => normalizeSessionSearch(value) === profileLocation) ? 1 : 0;
    if (leftLocal !== rightLocal) return rightLocal - leftLocal;
    return new Date(right.updated_at || right.creada_fecha || 0) - new Date(left.updated_at || left.creada_fecha || 0);
  });

  count.textContent = !availableSessions.length
    ? 'No hay sesiones activas disponibles.'
    : visible.length === availableSessions.length
      ? `${visible.length} ${visible.length === 1 ? 'sesión disponible' : 'sesiones disponibles'}`
      : `${visible.length} de ${availableSessions.length} sesiones`;

  if (!visible.length) {
    items.innerHTML = `<div class="session-empty">${availableSessions.length
      ? 'No hay resultados con esos filtros. Probá otro nombre, local, almacén o usuario.'
      : `Todavía no hay ${currentModule === 'reposicion' ? 'reposiciones' : currentModule === 'recepcion' ? 'controles de remitos' : 'inventarios'} disponibles para tu cuenta.`}</div>`;
    return;
  }

  items.innerHTML = '';
  visible.forEach(session => {
    const summary = session.summary || {};
    const participants = session.usuarios || session.participantes || [];
    const entry = document.createElement('div');
    entry.className = 'session-entry';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sesion-item';
    const route = currentModule === 'reposicion' || currentModule === 'recepcion'
      ? `<span class="session-route-pill">${esc(session.origin || '—')} → ${esc(session.destination || '—')}</span>`
      : session.local_nombre || session.almacen
        ? `<span class="session-route-pill">${esc(session.local_nombre || session.almacen)}${session.local_nombre && session.almacen ? ` · ${esc(session.almacen)}` : ''}</span>`
        : '';
    const details = currentModule === 'reposicion'
      ? `${session.estado === 'enviado' ? 'Enviada' : 'En preparación'} · ${summary.productos || 0} productos · ${summary.unidades_preparadas || 0}/${summary.unidades_pedidas || 0} unidades${session.remito_pendiente ? ' · remito pendiente' : ''}`
      : currentModule === 'recepcion'
        ? `Remito ${esc(session.document_number || '—')} · ${session.estado === 'cerrado' ? 'Cerrado' : 'En control'} · ${summary.productos || 0} productos · ${summary.unidades_recibidas || 0}/${summary.unidades_esperadas || 0} unidades${session.linked_orders ? ` · ${session.linked_orders} pedido${session.linked_orders === 1 ? '' : 's'} de cliente` : ''}`
      : `${session.productos || 0} productos · ${session.unidades || 0} unidades`;
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px;line-height:1.35">${esc(session.nombre)}</div>
        ${route}
        <div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.45">${details}</div>
        ${participants.length ? `<div style="margin-top:6px">${participants.slice(0, 4).map(person => `<span class="user-pill">👤 ${esc(person.nombre)}</span>`).join('')}${participants.length > 4 ? `<span class="user-pill">+${participants.length - 4}</span>` : ''}</div>` : ''}
      </div>
      <span class="sesion-badge">${(currentModule === 'reposicion' && (session.estado === 'enviado' || session.can_edit === false)) || (currentModule === 'recepcion' && (session.estado === 'cerrado' || session.can_edit === false)) ? 'Consultar →' : 'Entrar →'}</span>`;
    row.onclick = () => unirseASesion(session.id, session.nombre);
    entry.appendChild(row);
    if (currentModule === 'reposicion' && session.can_delete) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'session-delete';
      remove.setAttribute('aria-label', `Eliminar reposición ${session.nombre}`);
      remove.innerHTML = '<span aria-hidden="true">×</span><small>Eliminar</small>';
      remove.onclick = event => {
        event.stopPropagation();
        eliminarReposicionDisponible(encodeURIComponent(String(session.id)));
      };
      entry.appendChild(remove);
    }
    if (currentModule === 'recepcion' && session.can_delete) {
      const remove=document.createElement('button'); remove.type='button'; remove.className='session-delete'; remove.setAttribute('aria-label',`Eliminar recepción ${session.nombre}`); remove.innerHTML='<span aria-hidden="true">×</span><small>Eliminar</small>';
      remove.onclick=event=>{event.stopPropagation();eliminarRecepcionDisponible(encodeURIComponent(String(session.id)));}; entry.appendChild(remove);
    }
    items.appendChild(entry);
  });
}

async function eliminarRecepcionDisponible(encodedId) {
  if(currentModule!=='recepcion')return;
  const id=decodeURIComponent(String(encodedId||'')),session=availableSessions.find(item=>String(item.id)===id);
  if(!session?.can_delete){toast('Solamente el local destino o un administrador puede eliminar una recepción abierta.','w');return;}
  const confirmed=await appConfirm({title:'Eliminar control de remito',subtitle:`Remito ${session.document_number||'—'} · ${session.origin||'—'} → ${session.destination||'—'}`,tone:'danger',icon:'×',confirmText:'Eliminar definitivamente',message:'Se borrarán las cantidades controladas, participantes y archivo original. Los pedidos vinculados continuarán En viaje. Esta acción no se puede deshacer.'});
  if(!confirmed)return; showOperationsLoading('Eliminando recepción...');
  try{const response=await fetch('/api/recepcion/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reception_id:id})}),data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo eliminar');availableSessions=availableSessions.filter(item=>String(item.id)!==id);populateSessionLocationFilter(availableSessions);renderAvailableSessions();toast('Recepción eliminada correctamente','s');}
  catch(error){toast(error.message||'No se pudo eliminar la recepción','e');}finally{finishOperationsBoot();}
}

async function eliminarReposicionDisponible(encodedId) {
  if (currentModule !== 'reposicion') return;
  const id = decodeURIComponent(String(encodedId || ''));
  const session = availableSessions.find(item => String(item.id) === id);
  if (!session?.can_delete) {
    toast('Solamente el local de origen o un administrador puede eliminar una reposición en preparación.','w');
    return;
  }
  const confirmed = await appConfirm({
    title: 'Eliminar reposición',
    subtitle: `${session.origin || '—'} → ${session.destination || '—'}`,
    tone: 'danger', icon: '×', confirmText: 'Eliminar definitivamente',
    bodyHtml: `<div class="app-dialog-product"><strong>${esc(session.nombre)}</strong><span>${session.summary?.productos || 0} productos · ${session.summary?.unidades_preparadas || 0}/${session.summary?.unidades_pedidas || 0} unidades juntadas</span></div><p class="app-dialog-message">Se borrarán la preparación, sus cantidades, participantes y archivos. Los pedidos aceptados vinculados volverán a quedar disponibles para otra reposición. Esta acción no se puede deshacer.</p>`
  });
  if (!confirmed) return;
  showOperationsLoading('Eliminando reposición...');
  try {
    const response = await fetch('/api/reposicion/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reposition_id:id})});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo eliminar la reposición');
    availableSessions = availableSessions.filter(item => String(item.id) !== id);
    populateSessionLocationFilter(availableSessions);
    renderAvailableSessions();
    toast('Reposición eliminada correctamente','s');
  } catch (error) {
    toast(error.message || 'No se pudo eliminar la reposición','e');
  } finally {
    finishOperationsBoot();
  }
}

async function cargarSesionesDisponibles(options = {}) {
  const silent = !!options.silent;
  const requestedModule = currentModule;
  if (sessionLoadInFlight && sessionLoadModule === requestedModule) return sessionLoadInFlight;
  const requestSequence = ++sessionLoadSequence;
  const items = document.getElementById('sesiones-items');
  const count = document.getElementById('session-results-count');
  if (!silent) {
    items.innerHTML = '<div class="session-empty">Buscando sesiones disponibles…</div>';
    count.textContent = 'Actualizando…';
  }
  const requestPromise = (async () => {
    try {
      const endpoint = requestedModule === 'reposicion' ? '/api/reposiciones' : requestedModule === 'recepcion' ? '/api/recepciones' : '/api/sesiones';
      const res = await fetchWithTimeout(`${location.origin}${endpoint}`, {}, 15000);
      if (!res.ok) throw new Error('No se pudo consultar las sesiones');
      const sesiones = await res.json();
      if (requestSequence !== sessionLoadSequence || currentModule !== requestedModule) return;
      availableSessions = Array.isArray(sesiones) ? sesiones : [];
      populateSessionLocationFilter(availableSessions);
      renderAvailableSessions();
    } catch(e) {
      if (requestSequence !== sessionLoadSequence || currentModule !== requestedModule || silent) return;
      availableSessions = [];
      count.textContent = 'No se pudieron cargar las sesiones.';
      items.innerHTML = '<div class="session-empty">No pudimos consultar Sucaneitor. Revisá tu conexión a internet y tocá “Actualizar”.</div>';
    }
  })();
  sessionLoadInFlight = requestPromise;
  sessionLoadModule = requestedModule;
  try {
    await requestPromise;
  } finally {
    if (sessionLoadInFlight === requestPromise) {
      sessionLoadInFlight = null;
      sessionLoadModule = '';
    }
  }
}

async function unirseASesion(sid, nombre, options = {}) {
  showOperationsLoading(currentModule === 'reposicion' ? 'Abriendo reposición...' : currentModule === 'recepcion' ? 'Abriendo recepción...' : 'Abriendo inventario...');
  try {
    await unirseASesionInternal(sid, nombre, options);
  } finally {
    finishOperationsBoot();
  }
}

async function unirseASesionInternal(sid, nombre, options = {}) {
  const url = location.origin;
  const usuario = document.getElementById('input-usuario').value.trim() || 'Usuario';

  if (currentModule === 'reposicion') {
    await joinReposition(sid, nombre, url, usuario, null, options);
    return;
  }
  if (currentModule === 'recepcion') { await joinReception(sid,nombre,url,usuario,null,options); return; }
  try {
    const res = await fetch(`${url}/api/sesion/crear`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: sid, nombre_sesion: nombre, nombre_usuario: usuario})
    });
    const data = await res.json();
    if (!data.ok) { showSessionError(data.error || 'Error'); return; }

    usuarioNombre = usuario;
    localStorage.setItem('sc_usuario', usuario);

    sessionId = data.session_id;
    sessionNombre = data.nombre;
    await connectToServer(url, sessionId);
    entrarApp(options);
    toast(`✅ Unido a "${data.nombre}"`, 's');
  } catch(e) {
    showSessionError('Error al conectar: ' + e.message);
  }
}

async function crearSesion() {
  showOperationsLoading(currentModule === 'reposicion' ? 'Creando reposición...' : currentModule === 'recepcion' ? 'Creando control de remito...' : 'Creando inventario...');
  try {
    await crearSesionInternal();
  } finally {
    finishOperationsBoot();
  }
}

async function crearSesionInternal() {
  const url = location.origin;
  const usuario = document.getElementById('input-usuario').value.trim() || 'Usuario';
  const nombreSesion = document.getElementById('input-sesion-nombre').value.trim();
  if (currentModule === 'reposicion') {
    await createRepositionSession(url, usuario, nombreSesion);
    return;
  }
  if (currentModule === 'recepcion') { await createReceptionSession(url,usuario,nombreSesion); return; }
  if (!nombreSesion) { showSessionError('Ingresá un nombre para la sesión'); return; }
  const selectedLocation = document.getElementById('session-create-location')?.value || '';
  if (window.SucanCloud?.isSupervisor?.() && !selectedLocation) { showSessionError('Seleccioná el local del inventario'); return; }

  try {
    const res = await fetch(`${url}/api/sesion/crear`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({nombre_sesion: nombreSesion, nombre_usuario: usuario, local_nombre:selectedLocation})
    });
    const data = await res.json();
    if (!data.ok) { showSessionError(data.error || 'Error'); return; }

    usuarioNombre = usuario;
    localStorage.setItem('sc_usuario', usuario);

    sessionId = data.session_id;
    sessionNombre = data.nombre;
    await connectToServer(url, sessionId);
    entrarApp();
    toast(`✅ Sesión "${data.nombre}" creada`, 's');
  } catch(e) {
    showSessionError('Error: ' + e.message);
  }
}

function showSessionError(msg) {
  const el = document.getElementById('session-error');
  el.textContent = '❌ ' + msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 4000);
}

// ===== PADRÓN =====
function loadPadronFromBuiltin() {
  if (typeof PADRON_DATA !== 'undefined' && PADRON_DATA.length > 0) {
    padron = PADRON_DATA;
    invalidateSearchIndex();
    setPadronStatus(`✅ Padrón: ${padron.length} productos`);
  } else {
    setPadronStatus('⚠️ Cargue el padrón manualmente');
  }
}
function setPadronStatus(msg) {
  const el = document.getElementById('padron-status');
  if (el) el.textContent = msg;
  const repoEl = document.getElementById('repo-padron-status');
  if (repoEl) repoEl.textContent = msg;
  const receiptEl = document.getElementById('receipt-padron-status');
  if (receiptEl) receiptEl.textContent = msg;
}

async function loadPadron(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  toast('Procesando padrón...', 'i');
  try {
    if (!window.SucaneitorBarcode) throw new Error('No se pudo iniciar el validador del padrón');
    const { read, utils } = XLSX;
    const data = await file.arrayBuffer();
    const wb = read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    const parsed = window.SucaneitorBarcode.parseCatalogRows(rows);
    if (!parsed.ok) throw new Error(parsed.error);
    const stats = parsed.stats;
    const confirmed = await appConfirm({
      title: 'Comprobar y reemplazar padrón',
      icon: '📋',
      confirmText: 'Reemplazar padrón',
      message: `${file.name}\n\nProductos: ${stats.products}\nCon código de barras: ${stats.barcodeProducts}\nSin código de barras: ${stats.withoutBarcode}${stats.duplicateBarcodes ? `\nCódigos compartidos por variantes: ${stats.duplicateBarcodes}` : ''}\n\nEl cambio se sincronizará con Inventario, Reposición y Recepción.`
    });
    if (!confirmed) {
      toast('Carga cancelada. El padrón anterior no cambió.', 'i');
      return;
    }
    padron = parsed.products;
    invalidateSearchIndex();
    setPadronStatus(`✅ Padrón: ${padron.length} productos · ${stats.barcodeProducts} con barras`);
    toast(`✅ Padrón validado: ${padron.length} productos`, 's');
    saveLocal();
    // Guardar el padrón central para que todos los dispositivos lo compartan.
    if (serverUrl && serverOnline) {
      try {
        const up = await fetch(`${serverUrl}/api/padron`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ padron })
        });
        if (!up.ok) {
          const err = await up.text();
          throw new Error(err || 'No se pudo guardar el padrón');
        }
        const ans = await up.json().catch(() => ({}));
        toast(`☁️ Padrón global sincronizado (${ans.total || padron.length} productos · ${stats.barcodeProducts} con barras)`, 's');
        await loadBarcodeAssignments();
      } catch (e) {
        console.warn('No se pudo sincronizar el padrón central:', e);
        toast('⚠️ No se pudo actualizar el padrón central. Revisá tu conexión a internet.', 'e');
      }
    } else {
      toast('⚠️ No hay conexión con Sucaneitor. El padrón central no se actualizó.', 'e');
    }
  } catch (e) {
    toast('❌ Error al leer el padrón', 'e');
    console.error(e);
  }
}

// ===== NORMALIZACIÓN DE CÓDIGOS (fix principal) =====
// El padrón puede tener códigos con puntos decimales porque Excel los leyó como número:
// EAN-13 "7790085000178" -> se guardó como float -> padron tiene "7790085000178" ok
// o a veces ".5411388910006" (perdió un dígito)
// El escáner USB/cámara manda el código limpio como string.
// Estrategia: normalizar AMBOS (padron y scanned) antes de comparar.

function normCode(code) {
  if (window.SucaneitorBarcode) return window.SucaneitorBarcode.normalizeBarcode(code);
  return String(code || '').trim().replace(/\s/g, '').toUpperCase();
}

// Generar variantes de un código para búsqueda flexible
function codeVariants(code) {
  if (window.SucaneitorBarcode) return window.SucaneitorBarcode.barcodeVariants(code);
  const s = normCode(code);
  const variants = new Set([s]);
  // Sin ceros iniciales
  variants.add(s.replace(/^0+/, '') || s);
  // Con cero inicial (si el escáner mandó sin él)
  variants.add('0' + s);
  // Sin punto decimal inicial
  if (s.startsWith('.')) variants.add(s.slice(1));
  // Número entero (por si vino como float)
  const n = parseFloat(s);
  if (!isNaN(n)) {
    variants.add(String(Math.round(n)));
    variants.add(n.toString());
  }
  return variants;
}

// Buscar producto por código de barras (matching inteligente)
function findByBarcode(scannedCode) {
  const scVariants = codeVariants(scannedCode);
  const scNorm = normCode(scannedCode);

  // Las asignaciones provisionales son globales y tienen prioridad. Vinculan
  // el barras nuevo al SKU existente; nunca reemplazan el código de producto.
  const provisional = [];
  for (const assignment of effectiveBarcodeAssignments) {
    const av = codeVariants(assignment.barcode);
    if ([...scVariants].some(v => av.has(v))) {
      const product = padron.find(p => String(p.codigo) === String(assignment.product_code));
      if (product) provisional.push(product);
    }
  }
  if (provisional.length) return { matches: provisional, type: 'provisional' };

  const byBarras = [];
  const byCodigo = [];
  const byBarrasPrefix = []; // barras del padrón tiene sufijo de color/variante (ej: "8010690092898BL")
  const partial  = [];

  for (const p of padron) {
    // 1. Buscar en Código de Barras (campo 'barras') — prioridad máxima
    if (p.barras) {
      const bNorm = normCode(p.barras);
      const bv = codeVariants(p.barras);
      let hit = false;
      for (const sv of scVariants) { if (bv.has(sv)) { hit = true; break; } }
      if (hit) { byBarras.push(p); continue; }

      // 1b. El padrón guarda el barras con sufijo de letras (color/variante)
      //     pero el escáner manda solo la parte numérica. Ej: padrón "8010690092898BL", escáner "8010690092898"
      if (bNorm.length > scNorm.length && bNorm.startsWith(scNorm) && /^[A-Za-z]+$/.test(bNorm.slice(scNorm.length))) {
        byBarrasPrefix.push(p); continue;
      }
      // 1c. Al revés: el escáner puede mandar el código base que está en el padrón sin sufijo
      for (const sv of scVariants) {
        if (sv.length > 0 && bNorm.length > sv.length && bNorm.startsWith(sv) && /^[A-Za-z]+$/.test(bNorm.slice(sv.length))) {
          byBarrasPrefix.push(p); break;
        }
      }
      if (byBarrasPrefix.length && byBarrasPrefix[byBarrasPrefix.length-1] === p) continue;
    }

    // 2. Parcial en barras como último recurso
    if (p.barras && p.barras.length >= 6) {
      const bv = codeVariants(p.barras);
      for (const sv of scVariants) {
        for (const pv of bv) {
          if (sv.includes(pv) || pv.includes(sv)) { partial.push(p); break; }
        }
        if (partial.length && partial[partial.length-1] === p) break;
      }
    }
  }

  if (byBarras.length > 0)       return { matches: byBarras,       type: 'barras' };
  if (byBarrasPrefix.length > 0) return { matches: byBarrasPrefix, type: 'barras' };
  if (byCodigo.length > 0)       return { matches: byCodigo,       type: 'codigo' };
  if (partial.length  > 0)       return { matches: partial,        type: 'partial' };
  return { matches: [], type: 'none' };
}

// ===== TIPO DE BÚSQUEDA =====
function setST(type) {
  searchType = type;
  localStorage.setItem('sc_search_type', type);
  ['barras', 'nombre', 'codigo'].forEach(t => {
    document.getElementById(`st-${t}`).classList.toggle('active', t === type);
  });
  const inp = document.getElementById('search-input');
  const card = document.getElementById('search-card');
  if (card) card.dataset.searchType = type;
  inp.className = type === 'barras' ? 'input barcode' : 'input';
  inp.placeholder = type === 'barras' ? 'Escanear código de barras...'
                  : type === 'nombre' ? 'Ej: bio cach med, royal pup 15...'
                  : 'Buscar por código interno...';
  inp.inputMode = type === 'nombre' ? 'search' : 'text';
  inp.value = '';
  hideResults();
  renderSearchContext();
  focusSearchInput();
}

// ===== MANEJO DEL INPUT =====
function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    hideResults();
    return;
  }
  if (e.key === 'ArrowDown' && currentSearchResults.length) {
    e.preventDefault();
    document.querySelector('#results-list .ri-select')?.focus();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (!val) return;
    if (searchType === 'barras') {
      processBarcodeInput(val);
      e.target.value = '';
    } else {
      doSearch();
    }
  }
}

function onSearchInput(e) {
  if (searchType === 'barras') return; // esperar Enter del escáner
  clearTimeout(searchTimer);
  const val = e.target.value.trim();
  if (val.length < 2) { hideResults(); return; }
  searchTimer = setTimeout(doSearch, 90);
}

function doSearch() {
  const val = document.getElementById('search-input').value.trim();
  if (!val) return;

  if (searchType === 'barras') {
    processBarcodeInput(val);
    document.getElementById('search-input').value = '';
    return;
  }

  if (!window.SucaneitorSearch) {
    const q = val.toLowerCase();
    const fallback = padron
      .filter(p => searchType === 'nombre'
        ? String(p.nombre || '').toLowerCase().includes(q)
        : String(p.codigo || '').toLowerCase().includes(q))
      .slice(0, 32)
      .map(product => ({ product, reasons: [] }));
    showResults(fallback);
    return;
  }

  const index = ensureSearchIndex();
  const context = buildSearchContext();
  const results = searchType === 'nombre'
    ? SucaneitorSearch.rankProducts(index, val, context, 32)
    : SucaneitorSearch.searchByCode(index, val, 32);

  renderSearchContext(context);
  showResults(results);
}

// ===== PROCESAR CÓDIGO DE BARRAS =====
async function processBarcodeInput(code, options = {}) {
  // Sin debounce — cada escaneo cuenta. El escáner USB ya evita duplicados.

  const { matches, type } = findByBarcode(code);

  if (matches.length === 0) {
    if (options.camera) showUnknownScan(code);
    else toast(`❌ Código no encontrado: ${code}`, 'e');
    return { status: 'unknown', code };
  }
  if (matches.length === 1) {
    const scannedItem = { ...matches[0], barras: code };
    await addItem(scannedItem, 1, 'scanner');
    toast(`✅ +1 · ${matches[0].nombre.substring(0, 45)}`, 's');
    if (options.camera) showSuccessfulScan(matches[0], code, type);
    return { status: 'success', product: matches[0], type };
  } else {
    showMultiMatchModal(matches, code, 1, 'scanner');
    window._matchCameraBarcode = options.camera ? code : '';
    return { status: 'multiple', matches, type };
  }
}

// ===== MOSTRAR RESULTADOS =====
function showResults(results) {
  const container = document.getElementById('search-results');
  const list = document.getElementById('results-list');
  const title = document.getElementById('results-title');

  currentSearchResults = results;
  title.textContent = results.length === 1 ? '1 resultado' : `${results.length} resultados`;
  list.innerHTML = '';

  if (results.length === 0) {
    list.innerHTML = `<div class="search-empty"><span>🔎</span><strong>Sin coincidencias</strong><small>Probá con partes del nombre, por ejemplo “bio cach med”.</small></div>`;
    container.style.display = 'block';
    positionSearchResults();
    return;
  }

  results.forEach((result, index) => {
    const item = result.product || result;
    const countedQty = Number(countItems[item.codigo]?.qty || 0);
    const div = document.createElement('div');
    div.className = 'ri';
    const contextBadge = result.reasons?.length
      ? `<span class="ri-context">★ ${esc(result.reasons[0])}</span>`
      : '';
    div.innerHTML = `
      <button type="button" class="ri-select" aria-label="Elegir ${esc(item.nombre)}">
        <span class="ri-name">${esc(item.nombre)}</span>
        <span class="ri-meta">
          <span class="ri-code">${esc(item.codigo)}</span>
          ${item.marca ? `<span class="ri-marca">${esc(item.marca)}</span>` : ''}
          ${countedQty ? `<span class="ri-count">Contado: ${countedQty}</span>` : ''}
          ${contextBadge}
        </span>
      </button>
      <button type="button" class="ri-quick" aria-label="Agregar una unidad de ${esc(item.nombre)}">+1</button>`;
    div.querySelector('.ri-select').onclick = () => {
      showQtyModal(item, searchType === 'nombre' ? 'nombre' : 'codigo');
    };
    const quickButton = div.querySelector('.ri-quick');
    quickButton.onpointerdown = event => event.preventDefault();
    quickButton.onclick = () => quickAddSearchResult(index);
    list.appendChild(div);
  });
  container.style.display = 'block';
  list.scrollTop = 0;
  positionSearchResults();
}

function hideResults() {
  document.getElementById('search-results').style.display = 'none';
  currentSearchResults = [];
}

function quickAddSearchResult(index) {
  const result = currentSearchResults[index];
  const item = result?.product || result;
  if (!item) return;
  addItem(item, 1, searchType === 'nombre' ? 'nombre' : 'codigo');
  tactileFeedback(18);
  toast(`✅ +1 · ${item.nombre.substring(0, 45)}`, 's');
  hideResults();
  const input = document.getElementById('search-input');
  input.value = '';
  focusSearchInput();
}

function invalidateSearchIndex() {
  searchIndex = [];
  indexedPadron = null;
}

function ensureSearchIndex() {
  if (!window.SucaneitorSearch) return [];
  if (indexedPadron !== padron || searchIndex.length !== padron.length) {
    searchIndex = SucaneitorSearch.createSearchIndex(padron);
    indexedPadron = padron;
  }
  return searchIndex;
}

function buildSearchContext() {
  if (!window.SucaneitorSearch) return null;
  return SucaneitorSearch.createContext(ensureSearchIndex(), {
    sessionName: sessionNombre,
    countItems,
    actionLog,
    balanceData: balanceData || []
  });
}

function renderSearchContext(context) {
  const el = document.getElementById('search-context');
  if (!el) return;
  if (searchType !== 'nombre') {
    el.innerHTML = searchType === 'barras'
      ? '<span>⚡</span> El lector agrega 1 unidad al presionar Enter.'
      : '<span>🔢</span> Podés escribir una parte del código.';
    return;
  }

  const activeContext = context || buildSearchContext();
  if (activeContext?.label) {
    el.innerHTML = `<span>🎯</span> Prioridad actual: <strong>${esc(activeContext.label)}</strong>`;
  } else if (sessionNombre) {
    el.innerHTML = `<span>🎯</span> Priorizando la sesión <strong>${esc(sessionNombre)}</strong>`;
  } else {
    el.innerHTML = '<span>✨</span> Acepta palabras parciales y en cualquier orden.';
  }
}

function positionSearchResults() {
  const container = document.getElementById('search-results');
  const card = document.getElementById('search-card');
  if (IS_IOS_DEVICE || !container || !card || container.style.display === 'none' || window.innerWidth > 700) return;
  const bottom = Math.max(0, card.getBoundingClientRect().bottom + 6);
  document.documentElement.style.setProperty('--search-results-top', `${Math.round(bottom)}px`);
}

function focusSearchInput() {
  const input = document.getElementById('search-input');
  if (!input) return;
  // Safari iOS desplaza la página al enfocar por código. Solo conservamos el
  // foco si el usuario ya estaba escribiendo; en los demás casos decide él.
  if (IS_IOS_DEVICE && document.activeElement !== input) return;
  try { input.focus({ preventScroll: true }); }
  catch (e) { input.focus(); }
}

// ===== MODALES =====
function showQtyModal(item, tipo) {
  window._pendingItem = item;
  document.getElementById('modal-title').textContent = 'Agregar Cantidad';
  document.getElementById('modal-subtitle').textContent = item.nombre;
  document.getElementById('modal-body').innerHTML = `
    <div class="qty-editor">
      <label class="il" for="qty-input">Cantidad</label>
      <div class="qty-stepper">
        <button type="button" class="qty-step" onclick="stepPendingQty(-1)" aria-label="Restar uno">−</button>
        <input type="number" class="input" id="qty-input" value="1" min="1" max="9999"
               inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="Cantidad a agregar">
        <button type="button" class="qty-step" onclick="stepPendingQty(1)" aria-label="Sumar uno">+</button>
      </div>
    </div>
    <div class="qty-presets" aria-label="Cantidades rápidas">
      ${[1,2,3,5,10,20,50].map(n=>`<button type="button" class="btn btn-s" onclick="setPendingQty(${n})">${n}</button>`).join('')}
    </div>`;
  document.getElementById('modal-actions').innerHTML = `
    <button class="btn btn-s" onclick="closeModal()">Cancelar</button>
    <button class="btn btn-p" id="confirm-qty-btn" onclick="confirmQty('${tipo}')">✅ Agregar</button>`;
  document.getElementById('modal-overlay').classList.add('show');
  setTimeout(() => { document.getElementById('qty-input')?.select(); }, 80);
}

function setPendingQty(value) {
  const input = document.getElementById('qty-input');
  if (!input) return;
  input.value = Math.min(9999, Math.max(1, Number(value) || 1));
  input.select();
}

function stepPendingQty(delta) {
  const input = document.getElementById('qty-input');
  if (!input) return;
  setPendingQty((parseInt(input.value) || 1) + delta);
}

function confirmQty(tipo) {
  const qty = Math.max(1, parseInt(document.getElementById('qty-input')?.value) || 1);
  const item = window._pendingItem;
  if (!item) { closeModal(); return; }
  addItem(item, qty, tipo);
  tactileFeedback(24);
  toast(`✅ +${qty} · ${item.nombre.substring(0, 40)}`, 's');
  closeModal();
  hideResults();
  document.getElementById('search-input').value = '';
  focusSearchInput();
}

function tactileFeedback(duration) {
  try { navigator.vibrate?.(duration); } catch (e) {}
}

function showMultiMatchModal(matches, code, qty, tipo) {
  document.getElementById('modal-title').textContent = 'Múltiples coincidencias';
  document.getElementById('modal-subtitle').textContent = `Código escaneado: ${code}`;
  window._matchItems = matches;
  window._matchTipo = tipo;

  let html = '<div style="max-height:320px;overflow-y:auto">';
  matches.slice(0, 25).forEach((item, idx) => {
    html += `<div class="match-item" onclick="selectMatch(${idx})">
      <div style="flex:1">
        <div style="font-family:'JetBrains Mono';font-size:11px;color:var(--accent)">${esc(item.codigo)}</div>
        <div style="font-size:13px;margin-top:2px">${esc(item.nombre)}</div>
        ${item.marca ? `<span class="chip">${esc(item.marca)}</span>` : ''}
      </div>
    </div>`;
  });
  html += '</div>';
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-actions').innerHTML = `<button class="btn btn-s btn-sm" onclick="closeModal()">Cancelar</button>`;
  document.getElementById('modal-overlay').classList.add('show');
}

async function selectMatch(idx) {
  const item = window._matchItems[idx];
  const tipo = window._matchTipo || 'scanner';
  const cameraCode = window._matchCameraBarcode || '';
  window._matchCameraBarcode = '';
  closeModal();
  if (tipo === 'scanner') {
    await addItem({ ...item, barras: cameraCode || item.barras || '' }, 1, 'scanner');
    toast(`✅ +1 · ${item.nombre.substring(0, 45)}`, 's');
    if (cameraCode) {
      showSuccessfulScan(item, cameraCode, 'multiple');
      resumeCameraScanning(1500);
    }
  } else {
    showQtyModal(item, tipo);
  }
}

function closeModal() {
  const wasBarcodeAssignment = !!document.getElementById('assignment-search');
  document.getElementById('modal-overlay').classList.remove('show');
  if (currentModule === 'recepcion' && typeof receiptScanNoticeOpen !== 'undefined') receiptScanNoticeOpen = false;
  if (window._matchCameraBarcode) {
    window._matchCameraBarcode = '';
    resumeCameraScanning(200);
  } else if (wasBarcodeAssignment && currentUnknownBarcode) {
    resumeCameraScanning(200);
  }
}

// ===== DIÁLOGOS CORPORATIVOS =====
// Reemplazan confirm(), prompt() y alert() para conservar el mismo diseño,
// accesibilidad y comportamiento táctil en PC, tablet, Android y iPhone.
function appDialogMessageHtml(message) {
  return `<p class="app-dialog-message">${esc(String(message || '')).replace(/\n/g, '<br>')}</p>`;
}

function openAppDialog(options = {}) {
  if (appDialogResolver) resolveAppDialog(false);
  const overlay = document.getElementById('app-dialog-overlay');
  const dialog = document.getElementById('app-dialog');
  const title = document.getElementById('app-dialog-title');
  const subtitle = document.getElementById('app-dialog-subtitle');
  const icon = document.getElementById('app-dialog-icon');
  const body = document.getElementById('app-dialog-body');
  const actions = document.getElementById('app-dialog-actions');
  const error = document.getElementById('app-dialog-error');
  const tone = ['danger', 'warning'].includes(options.tone) ? options.tone : 'default';
  const confirmClass = options.confirmClass || (tone === 'danger' ? 'btn-d' : 'btn-p');

  dialog.classList.remove('tone-danger', 'tone-warning');
  if (tone !== 'default') dialog.classList.add(`tone-${tone}`);
  title.textContent = options.title || 'Confirmar acción';
  subtitle.textContent = options.subtitle || '';
  subtitle.style.display = options.subtitle ? '' : 'none';
  icon.textContent = options.icon || (tone === 'danger' ? '!' : tone === 'warning' ? '!' : '✓');
  body.innerHTML = options.bodyHtml || appDialogMessageHtml(options.message || '');
  error.textContent = '';
  error.style.display = 'none';
  actions.innerHTML = `
    <button class="btn btn-s" type="button" onclick="resolveAppDialog(false)">${esc(options.cancelText || 'Cancelar')}</button>
    <button class="btn ${esc(confirmClass)}" id="app-dialog-confirm" type="button" onclick="resolveAppDialog(true)">${esc(options.confirmText || 'Confirmar')}</button>`;
  appDialogValidator = typeof options.validate === 'function' ? options.validate : null;
  appDialogLastFocus = document.activeElement;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');

  return new Promise(resolve => {
    appDialogResolver = resolve;
    setTimeout(() => {
      const focusTarget = options.focusSelector ? body.querySelector(options.focusSelector) : null;
      (focusTarget || document.getElementById('app-dialog-confirm'))?.focus();
      if (options.selectOnFocus && focusTarget?.select) focusTarget.select();
    }, 60);
  });
}

async function resolveAppDialog(confirmed) {
  if (!appDialogResolver) return;
  const body = document.getElementById('app-dialog-body');
  const error = document.getElementById('app-dialog-error');
  let value = null;
  if (confirmed && appDialogValidator) {
    try {
      const result = await appDialogValidator(body);
      if (result && result.ok === false) {
        error.textContent = result.error || 'Revisá los datos ingresados.';
        error.style.display = 'block';
        result.focusSelector && body.querySelector(result.focusSelector)?.focus();
        return;
      }
      value = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
    } catch (validationError) {
      error.textContent = validationError?.message || 'Revisá los datos ingresados.';
      error.style.display = 'block';
      return;
    }
  } else if (confirmed) {
    value = true;
  }

  const resolver = appDialogResolver;
  appDialogResolver = null;
  appDialogValidator = null;
  const overlay = document.getElementById('app-dialog-overlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  const focus = appDialogLastFocus;
  appDialogLastFocus = null;
  if (focus?.isConnected && focus.focus) setTimeout(() => focus.focus(), 20);
  resolver(value);
}

async function appConfirm(options = {}) {
  return (await openAppDialog(options)) === true;
}

async function appPrompt(options = {}) {
  const inputId = 'app-dialog-input';
  const maxLength = Math.max(1, Number(options.maxLength) || 300);
  const inputHtml = options.multiline
    ? `<textarea class="input" id="${inputId}" maxlength="${maxLength}" placeholder="${esc(options.placeholder || '')}" oninput="updateDialogCounter('${inputId}',${maxLength})">${esc(options.value || '')}</textarea><small class="dialog-counter" id="${inputId}-counter">${String(options.value || '').length}/${maxLength}</small>`
    : `<input class="input" id="${inputId}" type="${esc(options.type || 'text')}" inputmode="${esc(options.inputMode || 'text')}" min="${esc(options.min ?? '')}" maxlength="${maxLength}" value="${esc(options.value ?? '')}" placeholder="${esc(options.placeholder || '')}">`;
  return openAppDialog({
    ...options,
    bodyHtml: `${options.message ? appDialogMessageHtml(options.message) : ''}<label class="dialog-field"><span>${esc(options.label || 'Detalle')}</span>${inputHtml}</label>`,
    focusSelector: `#${inputId}`,
    selectOnFocus: !options.multiline,
    validate: body => {
      const input = body.querySelector(`#${inputId}`);
      const value = String(input?.value || '').trim();
      if (options.required && !value) return {ok:false,error:options.requiredMessage || 'Este dato es obligatorio.',focusSelector:`#${inputId}`};
      return {ok:true,value};
    }
  });
}

function updateDialogCounter(id, maxLength) {
  const input = document.getElementById(id);
  const counter = document.getElementById(`${id}-counter`);
  if (input && counter) counter.textContent = `${input.value.length}/${maxLength}`;
}

function onGlobalKey(e) {
  const appDialog = document.getElementById('app-dialog-overlay');
  if (appDialog?.classList.contains('show')) {
    if (e.key === 'Escape') { e.preventDefault(); resolveAppDialog(false); return; }
    if (e.key === 'Enter' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault(); document.getElementById('app-dialog-confirm')?.click();
    }
    return;
  }
  const mo = document.getElementById('modal-overlay');
  if (!mo.classList.contains('show')) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key === 'Enter') {
    const btn = mo.querySelector('#confirm-qty-btn');
    if (btn && document.activeElement?.id === 'qty-input') btn.click();
  }
}

// ===== AGREGAR ÍTEM =====
async function addItem(item, qty, tipo) {
  if (serverOnline) {
    // Modo red: enviar al servidor
    try {
      const res = await fetch(`${serverUrl}/api/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo: item.codigo, barras: item.barras||'', nombre: item.nombre, qty, tipo, session_id: sessionId })
      });
      if (!res.ok) throw new Error('Server error');
      // El servidor hará broadcast y actualizará todos los clientes via SSE
      return;
    } catch (e) {
      toast('⚠️ Error de red, guardando local', 'e');
    }
  }

  // Modo local
  const key = item.codigo;
  if (countItems[key]) {
    countItems[key].qty += qty;
    countItems[key].tipos = countItems[key].tipos || {};
    countItems[key].tipos[tipo] = (countItems[key].tipos[tipo] || 0) + qty;
  } else {
    countItems[key] = { codigo: item.codigo, barras: item.barras||'', nombre: item.nombre, qty, tipos: { [tipo]: qty } };
  }
  if (tipo === 'scanner') totalScans++;

  // Si el último log es el mismo producto (dentro de 30s), acumular en vez de duplicar
  const last = actionLog[0];
  const now30 = Date.now();
  if (last && last.codigo === item.codigo && last.tipo === tipo &&
      now30 - (last._ts || 0) < 30000) {
    last.qty += qty;
    last.ts = timeStr();
    last._ts = now30;
  } else {
    const entry = { ts: timeStr(), _ts: now30, tipo, codigo: item.codigo, barras: item.barras||'', nombre: item.nombre, qty };
    actionLog.unshift(entry);
    if (actionLog.length > 200) actionLog.pop();
  }

  renderLiveLog();
  renderCountTable();
  updateStats();
  renderSearchContext();
  saveLocal();
}

async function removeItem(codigo) {
  if (serverOnline) {
    try {
      await fetch(`${serverUrl}/api/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, session_id: sessionId })
      });
      return;
    } catch (e) {}
  }
  delete countItems[codigo];
  renderCountTable();
  updateStats();
  renderSearchContext();
  saveLocal();
}

async function updateQty(codigo, delta) {
  if (serverOnline) {
    try {
      await fetch(`${serverUrl}/api/update_qty`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, delta, session_id: sessionId })
      });
      return;
    } catch (e) {}
  }
  if (!countItems[codigo]) return;
  countItems[codigo].qty = Math.max(0, countItems[codigo].qty + delta);
  if (countItems[codigo].qty === 0) delete countItems[codigo];
  renderCountTable();
  updateStats();
  renderSearchContext();
  saveLocal();
}

async function clearAll() {
  if (Object.keys(countItems).length === 0 && actionLog.length === 0) return;
  const confirmed = await appConfirm({
    title: 'Borrar conteo actual',
    subtitle: 'Esta acción afecta a la sesión de inventario abierta.',
    message: 'Se eliminarán todos los productos contados y el historial de lecturas de esta sesión.',
    icon: '×', tone: 'danger', confirmText: 'Sí, borrar conteo'
  });
  if (!confirmed) return;
  if (serverOnline) {
    try { await fetch(`${serverUrl}/api/clear`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({session_id: sessionId}) }); return; }
    catch (e) {}
  }
  countItems = {}; actionLog = []; totalScans = 0;
  renderLiveLog(); renderCountTable(); updateStats(); saveLocal();
  renderSearchContext();
  toast('🗑️ Conteo borrado', 'i');
}

// ===== RENDER LIVE LOG =====

// ===== VERIFICAR SI PRODUCTO ESTÁ EN BALANCE =====
function checkBalance(codigo) {
  if (!balanceData || !balanceData.length) return null; // sin balance cargado
  const found = balanceData.find(b => b.codigo === codigo);
  return found ? true : false;
}

function balanceBadge(codigo) {
  const result = checkBalance(codigo);
  if (result === null) return ''; // sin balance
  if (result) return '<span style="font-size:10px;color:var(--green);font-weight:600">✓ en balance</span>';
  return '<span style="font-size:10px;color:var(--yellow);font-weight:600">⚠ no está en balance</span>';
}
function renderLiveLog() {
  const container = document.getElementById('live-log');
  const countEl = document.getElementById('log-count');
  if (!actionLog.length) {
    container.innerHTML = '<div class="empty"><div class="icon">📭</div><p>Empezá a escanear...</p></div>';
    countEl.textContent = '0 registros';
    return;
  }
  countEl.textContent = `${actionLog.length} registro(s)`;
  container.innerHTML = actionLog.map((entry) => {
    const tipoLabel = entry.tipo === 'scanner' ? '🔲 escáner' : entry.tipo === 'nombre' ? '🔤 nombre' : entry.tipo === 'ia' ? '🤖 IA' : '🔢 código';
    const tipoClass = entry.tipo === 'ia' ? 'nombre' : entry.tipo; // 'ia' usa estilo de nombre
    const imgKey = entry.barras || entry.codigo;
    const cachedImg = imgCache[imgKey];
    const imgHtml = cachedImg
      ? `<img class="log-img" src="${cachedImg}" data-key="${esc(imgKey)}" style="display:block">`
      : `<img class="log-img" src="" data-key="${esc(imgKey)}" style="display:none">`;
    return `<div class="log-item">
      <span class="log-qty">+${entry.qty}</span>
      <div class="log-thumb">${imgHtml}</div>
      <div class="log-info">
        <div class="log-name">${esc(entry.nombre)}</div>
        <div class="log-code">${esc(entry.barras ? entry.barras + ' · ' + entry.codigo : entry.codigo)} ${balanceBadge(entry.codigo)}</div>
      </div>
      <span class="log-tipo ${tipoClass}">${tipoLabel}</span>
      <span class="log-time">${entry.ts}</span>
    </div>`;
  }).join('');

  // Cargar imágenes faltantes en background
  actionLog.forEach(entry => {
    const key = entry.barras || entry.codigo;
    if (!(key in imgCache)) {
      loadLogImage(key, entry.barras, entry.nombre, entry.codigo);
    }
  });
}

// ===== RENDER COUNT TABLE =====
function renderCountTable() {
  const tbody = document.getElementById('count-tbody');
  const badge = document.getElementById('lista-cnt');
  const items = Object.values(countItems);

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty"><div class="icon">📭</div><p>No hay productos contados</p></div></td></tr>`;
    badge.className = 'tab-cnt';
    return;
  }

  badge.textContent = items.length;
  badge.className = 'tab-cnt show';

  tbody.innerHTML = items.map(item => {
    const tipos = item.tipos || {};
    const chips = Object.entries(tipos)
      .filter(([,q]) => q > 0)
      .map(([t, q]) => `<span class="chip ${t[0]}">${t === 'scanner' ? '🔲' : t === 'nombre' ? '🔤' : '🔢'} ${q}</span>`)
      .join('');
    return `<tr>
      <td style="font-family:'JetBrains Mono';font-size:11px;color:var(--accent)">${esc(item.codigo)}</td>
      <td><div style="font-size:13px">${esc(item.nombre)}</div><div>${chips} ${balanceBadge(item.codigo)}</div></td>
      <td></td>
      <td><div class="qctrl">
        <button class="qbtn" onclick="updateQty('${escA(item.codigo)}',-1)">−</button>
        <span class="qbadge">${item.qty}</span>
        <button class="qbtn" onclick="updateQty('${escA(item.codigo)}',1)">+</button>
      </div></td>
      <td><button class="btn btn-d btn-sm" onclick="removeItem('${escA(item.codigo)}')">✕</button></td>
    </tr>`;
  }).join('');
}

// ===== STATS =====
function updateStats() {
  const items = Object.values(countItems);
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  document.getElementById('s-items').textContent = items.length;
  document.getElementById('s-units').textContent = totalQty;
  document.getElementById('s-scans').textContent = totalScans;
  const dashboardValues = { 'd-items': items.length, 'd-units': totalQty, 'd-scans': totalScans };
  Object.entries(dashboardValues).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
}

// ===== BALANCE / REPORTE =====
async function loadBalance(input) {
  const file = input.files[0];
  if (!file) return;
  toast('Procesando balance...', 'i');
  try {
    const { read, utils } = XLSX;
    const data = await file.arrayBuffer();
    const wb = read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = utils.sheet_to_json(ws, { header: 1, defval: '' });

    let almacenDet = '', fechaDet = '';
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const txt = rows[i].join(' ');
      if (txt.includes('Almacenes:')) almacenDet = txt.split('Almacenes:')[1]?.trim() || '';
      if (txt.includes('Balance al:')) fechaDet = txt.split('Balance al:')[1]?.trim() || '';
    }

    // Auto-detectar almacén
    const almMap = { MDO: 'Maldonado', PDE: 'Punta del Este', CEN: 'Central', CDA: 'Canelones', CDE: 'Ciudad de la Costa' };
    for (const [k, v] of Object.entries(almMap)) {
      if (almacenDet.toUpperCase().includes(k) || almacenDet.includes(v)) {
        if (!almacen) setAlmacen(k);
        break;
      }
    }

    let headerRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].some(c => /código|codigo/i.test(String(c)))) { headerRow = i; break; }
    }
    let ci = 1, ni = 2, si = 6;
    if (headerRow >= 0) {
      rows[headerRow].forEach((c, i) => {
        const s = String(c).toLowerCase();
        if (/^código$|^codigo$/.test(s)) ci = i;
        else if (s.includes('nombre')) ni = i;
        else if (s.includes('stock')) si = i;
      });
    }

    balanceData = []; window.balanceMeta = null;
    for (let i = (headerRow >= 0 ? headerRow + 1 : 9); i < rows.length; i++) {
      const r = rows[i];
      const codigo = clean(r[ci]);
      const nombre = clean(r[ni]);
      if (codigo && nombre) {
        balanceData.push({ codigo, nombre, stockActual: parseFloat(r[si]) || 0 });
      }
    }

    document.getElementById('bal-status').style.display = 'block';
    document.getElementById('no-bal-msg').style.display = 'none';
    document.getElementById('bal-fname').textContent = `📄 ${file.name}`;
    // Metadata simple para mostrar y sincronizar entre dispositivos.
    window.balanceMeta = { almacen: almacenDet, fecha: fechaDet, nombre: file.name };
    document.getElementById('bal-info').textContent = `${balanceData.length} productos · ${almacenDet || '?'} · ${fechaDet || ''}`;
    toast(`✅ Balance: ${balanceData.length} productos`, 's');
    refreshReport();
    saveLocal();
    // Guardar el balance web vinculado a la sesión.
    if (serverUrl && serverOnline && sessionId) {
      try {
        const metaGuardar = { almacen: almacenDet, fecha: fechaDet, nombre: file.name };
        const up = await fetch(`${serverUrl}/api/balance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, balance: balanceData, meta: metaGuardar })
        });
        if (!up.ok) {
          const err = await up.text();
          throw new Error(err || 'No se pudo guardar el balance');
        }
        const ans = await up.json().catch(() => ({}));
        toast(`☁️ Balance sincronizado a esta sesión (${ans.total || balanceData.length})`, 's');
      } catch (e) {
        console.warn('No se pudo sincronizar el balance:', e);
        toast('⚠️ No se pudo guardar el balance en la web. Revisá tu conexión a internet.', 'e');
      }
    } else {
      toast('⚠️ Entrá a un inventario antes de cargar el balance.', 'e');
    }
  } catch (e) {
    toast('❌ Error al leer el balance', 'e');
    console.error(e);
  }
}

async function clearBalance() {
  balanceData = null;
  compensationSuggestions = [];
  document.getElementById('bal-status').style.display = 'none';
  document.getElementById('reporte-area').style.display = 'none';
  document.getElementById('no-bal-msg').style.display = 'block';
  document.getElementById('bal-file').value = '';
  const diffs = document.getElementById('d-diffs');
  if (diffs) diffs.textContent = '—';
  try { localStorage.removeItem(localBalanceKey()); } catch (e) {}
  if (serverOnline && serverUrl && sessionId) {
    try {
      await fetch(`${serverUrl}/api/balance`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({session_id: sessionId, balance: [], meta: {}})
      });
    } catch (e) { toast('No se pudo quitar el balance compartido', 'e'); }
  }
}

function normalizeAnalysisText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/([0-9]),([0-9])/g, '$1.$2').replace(/[^a-z0-9.]+/g, ' ').trim();
}

function canonicalToken(token) {
  const aliases = {
    dog:'perro', dogs:'perro', perros:'perro', canine:'perro', canino:'perro', canina:'perro', cat:'gato', cats:'gato', gatos:'gato', feline:'gato', felino:'gato', felina:'gato',
    puppy:'cachorro', puppies:'cachorro', cachorros:'cachorro', junior:'cachorro', baby:'cachorro', kitten:'cachorro', kittens:'cachorro', cachorra:'cachorro',
    adult:'adulto', adults:'adulto', adultos:'adulto', adulta:'adulto', mature:'adulto', maduro:'adulto', madura:'adulto', ageing:'senior', aging:'senior',
    small:'pequeno', mini:'pequeno', toy:'pequeno', chico:'pequeno', chica:'pequeno', pequena:'pequeno', s:'pequeno', xs:'pequeno',
    medium:'mediano', medio:'mediano', media:'mediano', mediana:'mediano', m:'mediano',
    large:'grande', maxi:'grande', giant:'grande', gigante:'grande', l:'grande', xl:'grande', xxl:'grande',
    neutered:'castrado', sterilised:'castrado', sterilized:'castrado',
    blue:'azul', red:'rojo', green:'verde', pink:'rosado', grey:'gris', gray:'gris',
    black:'negro', white:'blanco', brown:'marron', yellow:'amarillo', orange:'naranja'
  };
  return aliases[token] || token;
}

function extractMeasures(text) {
  const normalized = normalizeAnalysisText(text);
  const measures = [];
  const rx = /(\d+(?:\.\d+)?)\s*(kg|kilos?|grs?|gramos?|g|ml|litros?|lts?|lt|l|cm|mm)\b/g;
  let match;
  while ((match = rx.exec(normalized))) {
    let value = parseFloat(match[1]);
    let unit = match[2];
    if (/^kg|^kilo/.test(unit)) { value *= 1000; unit = 'g'; }
    else if (/^gr|^gram|^g$/.test(unit)) unit = 'g';
    else if (/^lit|^lt|^l$/.test(unit)) { value *= 1000; unit = 'ml'; }
    else if (unit === 'mm') { value /= 10; unit = 'cm'; }
    measures.push(`${Math.round(value * 100) / 100}${unit}`);
  }
  return [...new Set(measures)].sort();
}

function productAnalysisProfile(item) {
  const text = normalizeAnalysisText(item.nombre);
  const tokens = text.split(/\s+/).filter(Boolean).map(canonicalToken);
  const tokenSet = new Set(tokens);
  const pick = groups => groups.find(value => tokenSet.has(value)) || '';
  const colors = ['azul','rojo','verde','rosado','rosa','gris','negro','blanco','marron','amarillo','naranja','violeta','celeste','beige'].filter(v => tokenSet.has(v));
  const proteins = ['pollo','salmon','cerdo','cordero','pavo','pato','conejo','atun','trucha','carne','vacuno','venado','fish','chicken','lamb','pork','duck','rabbit','turkey'].filter(v => tokenSet.has(v)).map(canonicalToken);
  const categories = ['alimento','racion','snack','stick','cama','colchon','manta','collar','correa','arnes','juguete','pelota','mordedor','comedero','bebedero','shampoo','acondicionador','pipeta','antiparasitario','arena','higiene','cepillo','peine','transportadora','ropa','bozal','pañal','panal'];
  const category = pick(categories);
  const species = pick(['perro','gato']);
  const stage = pick(['cachorro','adulto','senior']);
  const size = pick(['pequeno','mediano','grande']);
  const measures = extractMeasures(item.nombre);
  const variable = new Set([
    'perro','gato','cachorro','adulto','senior','pequeno','mediano','grande','raza','porte',
    'kg','g','gr','gramos','ml','l','lt','litros','cm','mm','sale','discontinuado','un','unidad',
    ...colors, ...proteins
  ]);
  const core = new Set(tokens.filter(t => !variable.has(t) && !/^\d+(?:\.\d+)?$/.test(t) && t.length > 1));
  const explicitBrand = normalizeAnalysisText(item.marca || item.fabricante || '').split(' ')[0];
  const generic = new Set(['alimento','racion','snack','stick','cama','collar','correa','arnes','juguete','pelota','mordedor','shampoo','perro','gato']);
  const inferredBrand = tokens.find(t => t.length > 2 && !generic.has(t) && !/^\d/.test(t)) || '';
  return { text, tokens, core, category, species, stage, size, colors, proteins, measures, brand: explicitBrand || inferredBrand };
}

function setSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach(value => { if (b.has(value)) intersection++; });
  return intersection / (a.size + b.size - intersection);
}

function compareCompensationPair(shortage, surplus) {
  const a = shortage.profile;
  const b = surplus.profile;
  if (a.species && b.species && a.species !== b.species) return null;
  // Presentaciones diferentes no se compensan: 3 kg nunca se sugiere contra 15 kg.
  if (a.measures.length && b.measures.length && a.measures.join('|') !== b.measures.join('|')) return null;
  if (a.category && b.category && a.category !== b.category) return null;

  const similarity = setSimilarity(a.core, b.core);
  const sameBrand = a.brand && b.brand && a.brand === b.brand;
  const sameCategory = a.category && b.category && a.category === b.category;
  if (similarity < .25 && !sameBrand) return null;

  let score = 22 + similarity * 42;
  if (sameBrand) score += 15;
  else if (a.brand && b.brand) score -= 12;
  if (sameCategory) score += 8;
  if (a.species && b.species && a.species === b.species) score += 6;
  if (a.measures.length && b.measures.length) score += 12;
  else if (a.measures.length !== b.measures.length) score -= 8;
  if (Math.abs(shortage.diff) === surplus.diff) score += 7;

  const differences = [];
  if (a.stage !== b.stage && (a.stage || b.stage)) differences.push(`edad: ${a.stage || '?'} / ${b.stage || '?'}`);
  if (a.size !== b.size && (a.size || b.size)) differences.push(`porte: ${a.size || '?'} / ${b.size || '?'}`);
  if (a.colors.join() !== b.colors.join() && (a.colors.length || b.colors.length)) differences.push(`color: ${a.colors.join(', ') || '?'} / ${b.colors.join(', ') || '?'}`);
  if (a.proteins.join() !== b.proteins.join() && (a.proteins.length || b.proteins.length)) differences.push(`variedad: ${a.proteins.join(', ') || '?'} / ${b.proteins.join(', ') || '?'}`);
  const differenceCount = differences.length;
  if (!differenceCount) {
    differences.push('variante o código muy similar');
    score += 8;
  } else if (differenceCount === 1) {
    score += 6;
  } else {
    // Dos o más variantes distintas deben revisarse con más cautela, aunque
    // coincidan marca, especie, peso y cantidades.
    score -= 20 * (differenceCount - 1);
  }
  score = Math.max(0, Math.min(99, Math.round(score)));
  if (score < 56) return null;
  return { score, reasons: differences, differenceCount };
}

function buildDifferenceRows() {
  const rows = [];
  const seen = new Set();
  (balanceData || []).forEach(item => {
    const code = String(item.codigo);
    const count = countItems[code]?.qty || 0;
    rows.push({ ...item, codigo: code, count, diff: count - item.stockActual });
    seen.add(code);
  });
  Object.values(countItems).forEach(item => {
    const code = String(item.codigo);
    if (!seen.has(code)) rows.push({ codigo: code, nombre: item.nombre, stockActual: 0, count: item.qty, diff: item.qty, outsideBalance: true });
  });
  return rows;
}

function findCompensations(rows) {
  const shortages = rows.filter(r => r.diff < 0).map(r => ({ ...r, profile: productAnalysisProfile(r), remaining: Math.abs(r.diff) }));
  const surpluses = rows.filter(r => r.diff > 0).map(r => ({ ...r, profile: productAnalysisProfile(r), remaining: r.diff }));
  const candidates = [];
  shortages.forEach(shortage => surpluses.forEach(surplus => {
    const comparison = compareCompensationPair(shortage, surplus);
    if (comparison) candidates.push({ shortage, surplus, ...comparison });
  }));
  candidates.sort((a, b) => b.score - a.score);
  const suggestions = [];
  for (const candidate of candidates) {
    if (!candidate.shortage.remaining || !candidate.surplus.remaining) continue;
    const quantity = Math.min(candidate.shortage.remaining, candidate.surplus.remaining);
    candidate.shortage.remaining -= quantity;
    candidate.surplus.remaining -= quantity;
    suggestions.push({
      shortage: candidate.shortage,
      surplus: candidate.surplus,
      quantity,
      score: candidate.score,
      reasons: candidate.reasons,
      confidence: candidate.score >= 86 && candidate.differenceCount <= 1 ? 'high' : candidate.score >= 70 ? 'medium' : 'low'
    });
  }
  return suggestions;
}

function renderCompensations() {
  const container = document.getElementById('compensation-list');
  if (!container) return;
  if (!compensationSuggestions.length) {
    container.innerHTML = '<div class="empty" style="padding:24px"><div class="icon">✓</div><p>No encontramos compensaciones suficientemente similares.</p></div>';
    return;
  }
  const confidenceLabel = { high: 'Confianza alta', medium: 'Confianza media', low: 'Revisar' };
  container.innerHTML = compensationSuggestions.map(item => `
    <div class="comp-card">
      <div class="comp-product"><strong>${esc(item.shortage.nombre)}</strong><span>${esc(item.shortage.codigo)}</span><div class="comp-diff negative">Faltan ${Math.abs(item.shortage.diff)}</div></div>
      <div class="comp-arrow">⇄</div>
      <div class="comp-product"><strong>${esc(item.surplus.nombre)}</strong><span>${esc(item.surplus.codigo)}</span><div class="comp-diff positive">Sobran ${item.surplus.diff}</div></div>
      <div class="comp-confidence confidence-${item.confidence}"><strong>${confidenceLabel[item.confidence]}</strong><span>${item.score}% · compensa ${item.quantity}<br>${esc(item.reasons.join(' · '))}</span></div>
    </div>`).join('');
}

function refreshReport() {
  if (!balanceData) return;
  const alm = almacen || 'Sin almacén';
  const rows = buildDifferenceRows();

  document.getElementById('reporte-area').style.display = 'block';
  document.getElementById('no-bal-msg').style.display = 'none';
  document.getElementById('alm-info').innerHTML = `Almacén: <b>${esc(alm)}</b>`;

  let ok = 0;
  let differences = 0;
  document.getElementById('report-rows').innerHTML = rows.map(item => {
    if (item.diff === 0) ok++; else differences++;
    const state = item.diff > 0 ? 'Sobrante' : item.diff < 0 ? 'Faltante' : 'Correcto';
    const stateClass = item.diff > 0 ? 'dpos' : item.diff < 0 ? 'dneg' : '';
    return `<div class="rrow">
      <div style="font-family:'JetBrains Mono';font-size:10px;color:var(--muted)">${esc(item.codigo)}</div>
      <div style="font-size:12px">${esc(item.nombre)}${item.outsideBalance ? '<br><small style="color:var(--yellow)">No figura en el balance cargado</small>' : ''}</div>
      <div style="text-align:center">${item.stockActual}</div>
      <div style="text-align:center">${item.count}</div>
      <div class="${stateClass}" style="text-align:center">${item.diff === 0 ? '—' : (item.diff > 0 ? '+' : '') + item.diff}</div>
      <div class="${stateClass}">${state}</div>
    </div>`;
  }).join('');

  compensationSuggestions = findCompensations(rows);
  renderCompensations();
  document.getElementById('r-total').textContent = rows.length;
  document.getElementById('r-ok').textContent = ok;
  document.getElementById('r-diff').textContent = differences;
  document.getElementById('r-compensations').textContent = compensationSuggestions.length;
  const dashboardDiffs = document.getElementById('d-diffs');
  if (dashboardDiffs) dashboardDiffs.textContent = differences;
}

// ===== GENERAR EXCEL =====
async function generateReport() {
  if (!balanceData) { toast('❌ Cargá el balance primero', 'e'); return; }
  if (!window.XLSX) { toast('El generador de Excel todavía se está cargando', 'e'); return; }
  toast('📊 Generando Excel...', 'i');

  const { utils, write } = XLSX;
  const alm = almacen || 'XXX';
  const now = new Date();
  const fecha = now.toLocaleDateString('es-UY');

  const wb = utils.book_new();

  // ===== HOJA: Código | Nombre | Stock Actual | Conteo =====
  const headers = ['Código', 'Nombre Mercadería', 'Stock Actual', 'Conteo'];
  const rows = [headers];

  balanceData.forEach(item => {
    const ci = countItems[item.codigo];
    const conteoTotal = ci ? ci.qty : 0;
    const stockActual = item.stockActual || 0;

    rows.push([
      item.codigo,
      item.nombre,
      stockActual,
      conteoTotal
    ]);
  });

  const ws = utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:46},{wch:13},{wch:10}];

  // Encabezado en negrita
  for (let c = 0; c <= 3; c++) {
    const cell = ws[utils.encode_cell({r:0, c})];
    if (cell) cell.s = {font:{bold:true}};
  }

  utils.book_append_sheet(wb, ws, 'Inventario');

  const out = write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Balance_${alm}_${fecha.replace(/\//g,'-')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  toast('✅ Excel descargado', 's');
}

function exportAnalysisReport() {
  if (!balanceData) { toast('Cargá el balance desde Dashboard', 'e'); return; }
  if (!window.XLSX) { toast('El generador de Excel todavía se está cargando', 'e'); return; }
  refreshReport();
  const details = [['Código','Producto','Stock sistema','Conteo real','Diferencia','Estado']];
  buildDifferenceRows().forEach(item => details.push([
    item.codigo, item.nombre, item.stockActual, item.count, item.diff,
    item.diff > 0 ? 'Sobrante' : item.diff < 0 ? 'Faltante' : 'Correcto'
  ]));
  const compensations = [['Confianza','Puntaje','Cantidad compensable','SKU faltante','Producto faltante','Diferencia faltante','SKU sobrante','Producto sobrante','Diferencia sobrante','Motivo']];
  compensationSuggestions.forEach(item => compensations.push([
    item.confidence === 'high' ? 'Alta' : item.confidence === 'medium' ? 'Media' : 'Revisar',
    item.score, item.quantity, item.shortage.codigo, item.shortage.nombre, item.shortage.diff,
    item.surplus.codigo, item.surplus.nombre, item.surplus.diff, item.reasons.join(' · ')
  ]));
  const wb = XLSX.utils.book_new();
  const detailSheet = XLSX.utils.aoa_to_sheet(details);
  detailSheet['!cols'] = [{wch:16},{wch:55},{wch:14},{wch:12},{wch:12},{wch:14}];
  const compensationSheet = XLSX.utils.aoa_to_sheet(compensations);
  compensationSheet['!cols'] = [{wch:14},{wch:10},{wch:20},{wch:16},{wch:55},{wch:16},{wch:16},{wch:55},{wch:16},{wch:40}];
  XLSX.utils.book_append_sheet(wb, detailSheet, 'Diferencias');
  XLSX.utils.book_append_sheet(wb, compensationSheet, 'Compensaciones sugeridas');
  const out = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  downloadBlob(new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), `Analisis_Inventario_${almacen || 'SIN-ALMACEN'}_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast('Análisis descargado', 's');
}


// ===== EXPORTAR CONTEO =====
function exportConteo() {
  if (!window.XLSX) { toast('El generador de Excel todavía se está cargando', 'e'); return; }
  const { utils, write } = XLSX;
  const wb = utils.book_new();
  const rows = [['Código','Nombre','Total','Escáner','Por Nombre','Por Código']];
  Object.values(countItems).forEach(i => rows.push([
    i.codigo, i.nombre, i.qty,
    i.tipos?.scanner||0, i.tipos?.nombre||0, i.tipos?.codigo||0
  ]));
  const ws = utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:20},{wch:40},{wch:10},{wch:10},{wch:12},{wch:12}];
  utils.book_append_sheet(wb, ws, 'Conteo');
  const out = write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Conteo_${new Date().toLocaleDateString('es-UY').replace(/\//g,'-')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== ALMACEN =====
async function setAlmacen(val) {
  almacen = val;
  document.getElementById('almacen-select').value = val;
  document.getElementById('nav-almacen').textContent = val || 'Sin almacén';
  if (sessionNombre) document.getElementById('nav-almacen').title = 'Sesión: ' + sessionNombre;
  if (serverOnline) {
    try { await fetch(`${serverUrl}/api/set_almacen`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({almacen: val, session_id: sessionId}) }); }
    catch (e) {}
  }
  saveLocal();
}

// ===== SINCRONIZACIÓN WEB =====
async function connectToServer(url, sid) {
  url = (url || location.origin).replace(/\/$/, '');
  if (sid) sessionId = sid;

  // Comprobar la sesión alojada y cargar su estado compartido.
  try {
    const stateUrl = sessionId ? `${url}/api/state?sid=${sessionId}` : `${url}/api/state`;
    const res = await fetchWithTimeout(stateUrl, {}, 3000);
    if (!res.ok) throw new Error('not ok');
    const state = await res.json();

    serverUrl = url;
    serverOnline = true;

    // Cargar estado del servidor
    countItems = state.countItems || {};
    almacen = state.almacen || '';
    totalScans = state.totalScans || 0;
    actionLog = state.log || [];
    updateSessionBadge(state.usuarios || []);
    if (state.almacen) setAlmacen(state.almacen);

    renderLiveLog(); renderCountTable(); updateStats();

    // Bajar el padrón central (tiene prioridad sobre el incorporado).
    try {
      const resPadron = await fetch(`${url}/api/padron`);
      if (resPadron.ok) {
        const pdata = await resPadron.json();
        if (pdata.padron && pdata.padron.length > 0) {
          padron = pdata.padron;
          invalidateSearchIndex();
          setPadronStatus(`✅ Padrón central: ${padron.length} productos`);
        }
      }
    } catch (e) { console.warn('No se pudo actualizar el padrón central:', e); }

    // Bajar el balance compartido de la sesión.
    if (sessionId) {
      balanceData = null;
      try {
        const resBal = await fetch(`${url}/api/balance?session_id=${sessionId}`);
        if (resBal.ok) {
          const bdata = await resBal.json();
          if (bdata.balance && bdata.balance.length > 0) {
            balanceData = bdata.balance;
            window.balanceMeta = bdata.meta || null;
            const meta = bdata.meta || {};
            document.getElementById('bal-info').textContent =
              `${balanceData.length} productos${meta.almacen ? ' · ' + meta.almacen : ''}${meta.fecha ? ' · ' + meta.fecha : ''} (web)`;
            document.getElementById('bal-status').style.display = 'block';
            document.getElementById('no-bal-msg').style.display = 'none';
            if (meta.nombre) document.getElementById('bal-fname').textContent = `📄 ${meta.nombre}`;
            refreshReport();
            saveLocal();
          } else {
            document.getElementById('bal-status').style.display = 'none';
            document.getElementById('reporte-area').style.display = 'none';
            document.getElementById('no-bal-msg').style.display = 'block';
          }
        }
      } catch (e) { console.warn('No se pudo actualizar el balance compartido:', e); }
    }

    await loadBarcodeAssignments();

    // Conectar SSE
    connectSSE();

    const offlineCard = document.getElementById('net-offline');
    const onlineCard = document.getElementById('net-online');
    const urlDisplay = document.getElementById('net-url-display');
    if (offlineCard) offlineCard.style.display = 'none';
    if (onlineCard) onlineCard.style.display = 'block';
    if (urlDisplay) urlDisplay.textContent = url;
    setSyncStatus('online');
    toast('✅ Sincronización web activa', 's');
    updateClientCount();
  } catch (e) {
    toast('❌ No se pudo sincronizar. Revisá tu conexión a internet.', 'e');
    console.error(e);
  }
}

function connectSSE() {
  if (serverSSE) serverSSE.close();
  if (window.SucanCloud) {
    let refreshing = false;
    const refresh = async (payload) => {
      if (refreshing) return;
      refreshing = true;
      try {
        const state = await fetch(`/api/state?sid=${encodeURIComponent(sessionId)}`).then(response => response.json());
        countItems = state.countItems || {};
        almacen = state.almacen || '';
        totalScans = state.totalScans || 0;
        actionLog = state.log || [];
        renderLiveLog(); renderCountTable(); updateStats(); renderSearchContext();
        updateSessionBadge(state.usuarios || []);
        if (payload?.table === 'op_inventario_balances') {
          const balanceResponse = await fetch(`/api/balance?session_id=${encodeURIComponent(sessionId)}`);
          const balanceJson = await balanceResponse.json();
          balanceData = balanceJson.balance?.length ? balanceJson.balance : null;
          window.balanceMeta = balanceJson.meta || null;
          if (balanceData) refreshReport();
        }
        setSyncStatus('online');
      } finally { refreshing = false; }
    };
    const channel = window.SucanCloud.watchInventory(sessionId, refresh);
    serverSSE = { close() { window.SucanCloud.db.removeChannel(channel); } };
    return;
  }
  serverSSE = new EventSource(`${serverUrl}/events${sessionId ? '?sid=' + sessionId : ''}`);

  serverSSE.addEventListener('init', (e) => {
    const state = JSON.parse(e.data);
    countItems = state.countItems || {};
    almacen = state.almacen || '';
    totalScans = state.totalScans || 0;
    actionLog = state.log || [];
    if (almacen) setAlmacen(almacen);
    if (state.session_id) sessionId = state.session_id;
    if (state.session_nombre) {
      sessionNombre = state.session_nombre;
      updateSessionBadge(state.usuarios || []);
    }
    renderLiveLog(); renderCountTable(); updateStats();
    renderSearchContext();
  });

  serverSSE.addEventListener('add', (e) => {
    const { item, log } = JSON.parse(e.data);
    countItems[item.codigo] = item;
    if (log) { actionLog.unshift(log); if (actionLog.length > 100) actionLog.pop(); }
    if (log?.tipo === 'scanner') totalScans++;
    renderLiveLog(); renderCountTable(); updateStats();
    renderSearchContext();
  });

  serverSSE.addEventListener('remove', (e) => {
    const { codigo } = JSON.parse(e.data);
    delete countItems[codigo];
    renderCountTable(); updateStats();
    renderSearchContext();
  });

  serverSSE.addEventListener('update', (e) => {
    const { item } = JSON.parse(e.data);
    countItems[item.codigo] = item;
    renderCountTable(); updateStats();
    renderSearchContext();
  });

  serverSSE.addEventListener('clear', () => {
    countItems = {}; actionLog = []; totalScans = 0;
    renderLiveLog(); renderCountTable(); updateStats();
    renderSearchContext();
    toast('🗑️ Conteo borrado', 'i');
  });

  serverSSE.addEventListener('almacen', (e) => {
    const { almacen: a } = JSON.parse(e.data);
    almacen = a;
    document.getElementById('almacen-select').value = a;
    document.getElementById('nav-almacen').textContent = a || 'Sin almacén';
  });

  // Padrón global: cuando alguien sube uno nuevo, todos los dispositivos lo reciben.
  serverSSE.addEventListener('padron', (e) => {
    const d = JSON.parse(e.data);
    if (d.padron && d.padron.length) {
      padron = d.padron;
      invalidateSearchIndex();
      setPadronStatus(`✅ Padrón central: ${padron.length} productos`);
      toast('📋 Padrón central actualizado', 's');
      loadBarcodeAssignments();
    }
  });

  serverSSE.addEventListener('barcode_assignments', (e) => {
    const data = JSON.parse(e.data);
    if (data.effective) effectiveBarcodeAssignments = data.effective;
    loadBarcodeAssignments();
  });

  // Balance por sesión: solo se envía a los usuarios conectados a esta sesión.
  serverSSE.addEventListener('balance', (e) => {
    const d = JSON.parse(e.data);
    balanceData = d.balance?.length ? d.balance : null;
    window.balanceMeta = d.meta || null;
    if (balanceData && balanceData.length) {
      const meta = window.balanceMeta || {};
      document.getElementById('bal-status').style.display = 'block';
      document.getElementById('no-bal-msg').style.display = 'none';
      document.getElementById('bal-fname').textContent = meta.nombre ? `📄 ${meta.nombre}` : '📄 Balance de Stock';
      document.getElementById('bal-info').textContent = `${balanceData.length} productos${meta.almacen ? ' · ' + meta.almacen : ''}${meta.fecha ? ' · ' + meta.fecha : ''} (web)`;
      refreshReport();
      saveLocal();
      toast('📊 Balance actualizado en esta sesión', 's');
    } else {
      document.getElementById('bal-status').style.display = 'none';
      document.getElementById('reporte-area').style.display = 'none';
      document.getElementById('no-bal-msg').style.display = 'block';
      const diffs = document.getElementById('d-diffs');
      if (diffs) diffs.textContent = '—';
    }
  });

  serverSSE.onopen = () => { setSyncStatus('online'); };

  serverSSE.addEventListener('usuario_join', (e) => {
    const d = JSON.parse(e.data);
    updateSessionBadge(d.usuarios || []);
    toast(`👤 ${d.usuario} se unió a la sesión`, 'i');
  });

  serverSSE.addEventListener('usuario_leave', (e) => {
    const d = JSON.parse(e.data);
    updateSessionBadge(d.usuarios || []);
  });
  serverSSE.onerror = () => {
    setSyncStatus('offline');
    // Reintentar en 5s
    setTimeout(() => { if (serverOnline) connectSSE(); }, 5000);
  };
}

function disconnectServer() {
  serverOnline = false;
  clearTimeout(clientCountTimer); clientCountTimer = null;
  if (serverSSE) { serverSSE.close(); serverSSE = null; }
  serverUrl = '';
  const offlineCard = document.getElementById('net-offline');
  const onlineCard = document.getElementById('net-online');
  if (offlineCard) offlineCard.style.display = 'block';
  if (onlineCard) onlineCard.style.display = 'none';
  setSyncStatus('offline');
  toast('Sincronización pausada', 'i');
}

async function updateClientCount() {
  if (!serverOnline) return;
  try {
    const res = await fetch(`${serverUrl}/api/clients?sid=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    const el = document.getElementById('net-clients');
    if (el) el.textContent = `${data.connected} participante(s) en la sesión`;
  } catch (e) {}
  clearTimeout(clientCountTimer);
  if (serverOnline && sessionId) clientCountTimer = setTimeout(updateClientCount, 15000);
}

function setSyncStatus(status) {
  const dot = document.getElementById('sync-dot');
  dot.className = `sync-dot ${status}`;
}

// ===== CÁMARA =====
let html5QrScanner = null;

function setScannerTriggerReady(label = '▣ Escanear ahora') {
  clearTimeout(scanTriggerTimer);
  scanTriggerTimer = null;
  scanTriggerArmed = false;
  const button = document.getElementById('trigger-scan-btn');
  if (!button) return;
  button.disabled = !scanActive;
  button.classList.remove('armed');
  button.textContent = label;
}

function consumeScannerTrigger() {
  if (!scanTriggerArmed) return false;
  clearTimeout(scanTriggerTimer);
  scanTriggerTimer = null;
  scanTriggerArmed = false;
  const button = document.getElementById('trigger-scan-btn');
  if (button) {
    button.disabled = true;
    button.classList.remove('armed');
    button.textContent = 'Lectura recibida';
  }
  return true;
}

function triggerCameraScan() {
  if (!scanActive) {
    startScanner();
    return;
  }
  if (scanPaused) {
    toast('Terminá la comprobación actual antes de escanear otro producto', 'i');
    return;
  }
  clearTimeout(scanTriggerTimer);
  scanTriggerArmed = true;
  const button = document.getElementById('trigger-scan-btn');
  if (button) {
    button.disabled = false;
    button.classList.add('armed');
    button.textContent = 'Buscando código…';
  }
  resetScannerResult('Buscando código…');
  if (navigator.vibrate) navigator.vibrate(35);
  if (barcodeDetector) scanFrame();
  scanTriggerTimer = setTimeout(() => {
    if (!scanTriggerArmed) return;
    setScannerTriggerReady();
    resetScannerResult('No se detectó ningún código · probá otra vez');
  }, 4000);
}

function scannerResultElement() { return document.getElementById('scanner-result'); }

function captureScannerFrame() {
  try {
    const video = document.querySelector('#html5qr-container video') || document.getElementById('scanner-video');
    if (!video || !video.videoWidth || !video.videoHeight) return '';
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .76);
  } catch (e) {
    return '';
  }
}

function resetScannerResult(message = 'Esperando una lectura') {
  const card = scannerResultElement();
  if (!card) return;
  card.className = 'scanner-result waiting';
  document.getElementById('scanner-result-state').textContent = message;
  document.getElementById('scanner-result-name').textContent = 'El producto aparecerá aquí';
  document.getElementById('scanner-result-meta').textContent = '—';
  document.getElementById('scanner-result-count').textContent = '';
  document.getElementById('unknown-scan-actions').style.display = 'none';
}

function showSuccessfulScan(product, code, matchType) {
  currentUnknownBarcode = '';
  const card = scannerResultElement();
  card.className = 'scanner-result success';
  document.getElementById('scanner-result-state').textContent = matchType === 'provisional' ? 'Código provisional reconocido' : 'Producto encontrado';
  document.getElementById('scanner-result-name').textContent = product.nombre;
  document.getElementById('scanner-result-meta').textContent = `SKU ${product.codigo} · Barras ${code}`;
  document.getElementById('scanner-result-count').textContent = '+1 agregado al conteo';
  document.getElementById('unknown-scan-actions').style.display = 'none';
  if (window.innerWidth <= 700) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showUnknownScan(code) {
  currentUnknownBarcode = code;
  currentAssignmentProduct = null;
  currentAssignmentPhoto = captureScannerFrame();
  const card = scannerResultElement();
  card.className = 'scanner-result unknown';
  document.getElementById('scanner-result-state').textContent = 'Código no encontrado';
  document.getElementById('scanner-result-name').textContent = 'Este código no figura en el padrón';
  document.getElementById('scanner-result-meta').textContent = code;
  document.getElementById('scanner-result-count').textContent = 'No se sumó ninguna unidad';
  document.getElementById('unknown-scan-actions').style.display = 'flex';
  if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
  if (window.innerWidth <= 700) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resumeCameraScanning(delay = 0) {
  setTimeout(() => {
    scanPaused = false;
    if (scanActive) setScannerTriggerReady();
  }, delay);
}

async function handleCameraBarcode(code) {
  if (!code || scanPaused) return;
  scanPaused = true;
  lastScanCode = code;
  lastScanTime = Date.now();
  currentAssignmentPhoto = captureScannerFrame();
  if (navigator.vibrate) navigator.vibrate(70);
  const last = document.getElementById('last-scan');
  if (last) last.style.display = 'block';
  const lastCode = document.getElementById('last-scan-code');
  if (lastCode) lastCode.textContent = code;
  const result = await processBarcodeInput(code, { camera: true });
  if (result?.status === 'success') resumeCameraScanning(700);
}

// Puentes compatibles con envoltorios Android que devuelven el resultado nativo.
window.onBarcodeScanned = code => handleCameraBarcode(String(code || ''));
window.onBarcodeResult = code => handleCameraBarcode(String(code || ''));

function ignoreUnknownBarcode() {
  currentUnknownBarcode = '';
  currentAssignmentProduct = null;
  currentAssignmentPhoto = '';
  resetScannerResult('Listo para el siguiente producto');
  resumeCameraScanning(150);
}

function openBarcodeAssignment() {
  if (!currentUnknownBarcode) return;
  if (!serverOnline || !serverUrl) {
    toast('La asignación necesita conexión a internet para compartirse', 'e');
    return;
  }
  currentAssignmentProduct = null;
  document.getElementById('modal-title').textContent = 'Asignar código de barras';
  document.getElementById('modal-subtitle').textContent = 'Buscá el producto correcto y verificá los datos antes de confirmar.';
  document.getElementById('modal-body').innerHTML = `
    <div class="assignment-confirm" style="margin-top:0">
      <dl style="margin-top:0"><dt>Código leído</dt><dd>${esc(currentUnknownBarcode)}</dd></dl>
    </div>
    <label class="il" style="margin-top:14px">Buscar en el padrón por nombre o SKU</label>
    <input class="input" id="assignment-search" type="search" inputmode="search" autocomplete="off"
      placeholder="Ej: bio cachorro mediano" oninput="searchBarcodeAssignmentProducts(this.value)">
    <div id="assignment-search-results" class="assign-search-results" style="display:none"></div>
    <div id="assignment-selected"></div>
    <div style="margin-top:14px">
      <label class="il">Foto comprobante del producto</label>
      <input id="assignment-photo-input" type="file" accept="image/*" capture="environment" style="display:none" onchange="onAssignmentPhotoChange(this)">
      <button class="btn btn-s btn-full" type="button" onclick="document.getElementById('assignment-photo-input').click()">${currentAssignmentPhoto ? 'Cambiar foto' : 'Tomar foto del producto'}</button>
      <div id="assignment-photo-preview">${currentAssignmentPhoto ? `<img class="photo-preview" src="${currentAssignmentPhoto}" alt="Foto comprobante">` : '<div class="tm" style="text-align:center;padding:12px">La foto es obligatoria para confirmar.</div>'}</div>
    </div>
    <label style="display:flex;align-items:flex-start;gap:10px;margin-top:14px;font-size:12px;line-height:1.45;cursor:pointer">
      <input type="checkbox" id="assignment-verified" onchange="updateAssignmentConfirmState()" style="width:20px;height:20px;flex:0 0 20px">
      <span>Verifiqué físicamente que el código escaneado corresponde al producto seleccionado.</span>
    </label>`;
  document.getElementById('modal-actions').innerHTML = `
    <button class="btn btn-s" onclick="cancelBarcodeAssignment()">Cancelar</button>
    <button class="btn btn-p" id="confirm-barcode-assignment" onclick="confirmBarcodeAssignment()" disabled>Confirmar asignación</button>`;
  document.getElementById('modal-overlay').classList.add('show');
  setTimeout(() => document.getElementById('assignment-search')?.focus(), 100);
}

function cancelBarcodeAssignment() {
  document.getElementById('modal-overlay').classList.remove('show');
  resumeCameraScanning(200);
}

function searchBarcodeAssignmentProducts(query) {
  const container = document.getElementById('assignment-search-results');
  const value = String(query || '').trim();
  if (value.length < 2) { container.style.display = 'none'; container.innerHTML = ''; return; }
  const index = ensureSearchIndex();
  const results = window.SucaneitorSearch
    ? SucaneitorSearch.rankProducts(index, value, buildSearchContext(), 16)
    : padron.filter(p => normalizeAnalysisText(p.nombre).includes(normalizeAnalysisText(value))).slice(0, 16).map(product => ({ product }));
  window._barcodeAssignmentResults = results.map(r => r.product || r);
  container.style.display = 'block';
  container.innerHTML = window._barcodeAssignmentResults.length
    ? window._barcodeAssignmentResults.map((product, index) => `<button class="assign-result" type="button" onclick="selectBarcodeAssignmentProduct(${index})"><strong>${esc(product.nombre)}</strong><span>SKU ${esc(product.codigo)} · ${product.barras ? 'Barras actual ' + esc(product.barras) : 'Sin código de barras'}</span></button>`).join('')
    : '<div class="empty" style="padding:18px"><p>Sin coincidencias.</p></div>';
}

function selectBarcodeAssignmentProduct(index) {
  const product = (window._barcodeAssignmentResults || [])[index];
  if (!product) return;
  currentAssignmentProduct = product;
  const selected = document.getElementById('assignment-selected');
  selected.innerHTML = `<div class="assignment-confirm">
    <strong>${esc(product.nombre)}</strong>
    <dl><dt>Código interno</dt><dd>${esc(product.codigo)}</dd><dt>Barras actual</dt><dd>${product.barras ? esc(product.barras) : 'Sin código asignado'}</dd><dt>Barras nuevo</dt><dd>${esc(currentUnknownBarcode)}</dd></dl>
  </div>`;
  document.getElementById('assignment-search-results').style.display = 'none';
  document.getElementById('assignment-search').value = product.nombre;
  updateAssignmentConfirmState();
}

async function compressAssignmentPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .78);
}

async function onAssignmentPhotoChange(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    currentAssignmentPhoto = await compressAssignmentPhoto(file);
    document.getElementById('assignment-photo-preview').innerHTML = `<img class="photo-preview" src="${currentAssignmentPhoto}" alt="Foto comprobante">`;
    updateAssignmentConfirmState();
  } catch (e) {
    toast('No se pudo procesar la foto', 'e');
  }
}

function updateAssignmentConfirmState() {
  const button = document.getElementById('confirm-barcode-assignment');
  const verified = document.getElementById('assignment-verified')?.checked;
  if (button) button.disabled = !(currentAssignmentProduct && currentAssignmentPhoto && verified);
}

async function confirmBarcodeAssignment() {
  const button = document.getElementById('confirm-barcode-assignment');
  if (!currentAssignmentProduct || !currentUnknownBarcode || !currentAssignmentPhoto || !document.getElementById('assignment-verified')?.checked) return;
  button.disabled = true;
  button.textContent = 'Guardando…';
  const scannedCode = currentUnknownBarcode;
  const product = currentAssignmentProduct;
  try {
    const response = await fetch(`${serverUrl}/api/barcode_assignments`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        barcode: scannedCode,
        product_code: product.codigo,
        user: usuarioNombre || 'Usuario',
        session_id: sessionId,
        session_name: sessionNombre,
        photo_data: currentAssignmentPhoto
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const conflict = data.conflict ? `: ${data.conflict.codigo} · ${data.conflict.nombre}` : '';
      throw new Error((data.error || 'No se pudo guardar') + conflict);
    }
    document.getElementById('modal-overlay').classList.remove('show');
    effectiveBarcodeAssignments = data.effective || effectiveBarcodeAssignments;
    if (currentModule === 'reposicion' && typeof routeRepoScannedProduct === 'function') {
      await routeRepoScannedProduct({...product, barras: scannedCode}, scannedCode, 'asignacion');
      toast('Código asignado globalmente y producto comprobado', 's');
    } else if (currentModule === 'recepcion' && typeof routeReceiptScannedProduct === 'function') {
      await routeReceiptScannedProduct({...product,barras:scannedCode},scannedCode,'asignacion');
      toast('Código asignado globalmente y producto recibido', 's');
    } else {
      await addItem({ ...product, barras: scannedCode }, 1, 'scanner');
      showSuccessfulScan(product, scannedCode, 'provisional');
      document.getElementById('scanner-result-state').textContent = 'Código asignado y producto contado';
      toast('Código asignado globalmente · +1 al conteo', 's');
    }
    currentUnknownBarcode = '';
    currentAssignmentProduct = null;
    currentAssignmentPhoto = '';
    await loadBarcodeAssignments();
    if (currentModule !== 'reposicion' && currentModule !== 'recepcion') resumeCameraScanning(1700);
  } catch (e) {
    button.disabled = false;
    button.textContent = 'Confirmar asignación';
    toast(e.message, 'e');
  }
}

const BARCODE_STATUS_LABELS = {
  pending: 'Pendiente', incorporated: 'Ya incorporado', conflict: 'Conflicto',
  product_missing: 'Producto no encontrado', superseded: 'Reemplazado', discarded: 'Descartado'
};

async function loadBarcodeAssignments() {
  if (!serverOnline || !serverUrl) return;
  try {
    const response = await fetch(`${serverUrl}/api/barcode_assignments`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Error');
    barcodeAssignments = data.assignments || [];
    effectiveBarcodeAssignments = data.effective || [];
    renderBarcodeAssignments();
  } catch (e) {
    console.warn('No se pudieron cargar las asignaciones de barras:', e);
  }
}

function renderBarcodeAssignments() {
  const counts = barcodeAssignments.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const values = {
    'ba-pending': counts.pending || 0,
    'ba-incorporated': counts.incorporated || 0,
    'ba-review': (counts.conflict || 0) + (counts.product_missing || 0)
  };
  Object.entries(values).forEach(([id, value]) => { const el = document.getElementById(id); if (el) el.textContent = value; });
  const container = document.getElementById('barcode-assignment-list');
  if (!container) return;
  if (!barcodeAssignments.length) {
    container.innerHTML = '<div class="empty"><div class="icon">▤</div><p>Todavía no hay asignaciones.</p></div>';
    return;
  }
  container.innerHTML = barcodeAssignments.slice(0, 150).map(item => {
    const photo = item.photo_url || (item.photo_file ? `${serverUrl}/api/barcode_photo/${encodeURIComponent(item.photo_file)}` : '');
    const canDiscard = ['pending', 'conflict', 'product_missing'].includes(item.status);
    return `<article class="assignment-item">
      <div class="assignment-main"><strong>${esc(item.barcode)}</strong><code>SKU ${esc(item.product_code)}</code></div>
      <div class="assignment-product"><strong>${esc(item.product_name)}</strong><span>Anterior: ${esc(item.official_barcode || 'sin código')} · ${esc(item.user)} · ${esc(item.created_at?.replace('T',' ') || '')}</span></div>
      <div class="assignment-side">${photo ? `<a href="${photo}" target="_blank" aria-label="Abrir foto"><img class="assignment-photo" src="${photo}" alt="Comprobante"></a>` : ''}<span class="status-pill status-${esc(item.status)}">${BARCODE_STATUS_LABELS[item.status] || esc(item.status)}</span>${canDiscard ? `<button class="btn btn-s btn-sm" onclick="discardBarcodeAssignment('${escA(item.id)}')">Descartar</button>` : ''}</div>
    </article>`;
  }).join('');
}

async function discardBarcodeAssignment(id) {
  const confirmed = await appConfirm({
    title: 'Descartar asignación',
    subtitle: 'El código dejará de reconocerse de forma provisional.',
    message: 'El registro seguirá disponible en el historial como descartado, pero ya no se usará para identificar el producto.',
    icon: '×', tone: 'warning', confirmText: 'Descartar asignación'
  });
  if (!confirmed) return;
  try {
    const response = await fetch(`${serverUrl}/api/barcode_assignments/${encodeURIComponent(id)}/discard`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo descartar');
    effectiveBarcodeAssignments = data.effective || [];
    await loadBarcodeAssignments();
    toast('Asignación descartada', 'i');
  } catch (e) { toast(e.message, 'e'); }
}

async function downloadBarcodePackage() {
  if (!barcodeAssignments.length) { toast('No hay asignaciones para exportar', 'e'); return; }
  if (!window.XLSX || !window.JSZip) { toast('El generador de reportes todavía se está cargando', 'e'); return; }
  try {
    toast('Preparando reporte y fotos…', 'i');
    const rows = [['Estado','Código de barras nuevo','Código interno SKU','Producto','Código de barras actual','Usuario','Sesión','Fecha y hora','Foto']];
    barcodeAssignments.forEach((item,index) => rows.push([
      BARCODE_STATUS_LABELS[item.status] || item.status,item.barcode,item.product_code,item.product_name,
      item.official_barcode || '',item.user || '',item.session_name || '',item.created_at || '',
      item.photo_url ? `fotos/${String(index + 1).padStart(3,'0')}_${String(item.product_code || 'SKU').replace(/[^a-z0-9_-]+/gi,'_')}.jpg` : ''
    ]));
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [{wch:22},{wch:24},{wch:18},{wch:55},{wch:24},{wch:18},{wch:24},{wch:22},{wch:48}];
    XLSX.utils.book_append_sheet(workbook,sheet,'Códigos de barras');
    const zip = new JSZip();
    zip.file('Reporte_Codigos_Barras.xlsx',XLSX.write(workbook,{bookType:'xlsx',type:'array'}));
    for (let index=0; index<barcodeAssignments.length; index+=1) {
      const item=barcodeAssignments[index];
      if (!item.photo_url) continue;
      try {
        const response=await fetch(item.photo_url);
        if (!response.ok) continue;
        const contentType=response.headers.get('content-type') || '';
        const extension=contentType.includes('png')?'png':contentType.includes('webp')?'webp':'jpg';
        const name=`${String(index + 1).padStart(3,'0')}_${String(item.product_code || 'SKU').replace(/[^a-z0-9_-]+/gi,'_')}.${extension}`;
        zip.file(`fotos/${name}`,await response.blob());
      } catch (_) { /* El reporte igualmente se genera si una foto dejó de estar disponible. */ }
    }
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
    downloadBlob(blob,`Codigos_Barras_${new Date().toISOString().slice(0,10)}.zip`);
    toast('Reporte y fotos descargados', 's');
  } catch (error) { toast(error.message || 'No se pudo generar el paquete', 'e'); }
}

function exportBarcodeAssignmentsExcel() {
  if (!barcodeAssignments.length) { toast('No hay asignaciones para exportar', 'e'); return; }
  if (!window.XLSX) { toast('El generador de Excel todavía se está cargando', 'e'); return; }
  const labels = BARCODE_STATUS_LABELS;
  const rows = [['Estado','Código de barras nuevo','Código interno SKU','Producto','Código de barras actual','Usuario','Sesión','Fecha y hora','Foto']];
  barcodeAssignments.forEach(item => rows.push([
    labels[item.status] || item.status, item.barcode, item.product_code, item.product_name,
    item.official_barcode || '', item.user || '', item.session_name || '', item.created_at || '', item.photo_file || ''
  ]));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:22},{wch:24},{wch:18},{wch:55},{wch:24},{wch:18},{wch:24},{wch:22},{wch:35}];
  XLSX.utils.book_append_sheet(wb, ws, 'Códigos de barras');
  const out = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  downloadBlob(new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), `Codigos_Barras_${new Date().toISOString().slice(0,10)}.xlsx`);
}

async function startScanner() {
  if (scanActive) return;
  if (window.AndroidBridge && window.AndroidBridge.isAndroidApp()) {
    window.AndroidBridge.startNativeScanner();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    scannerStream = stream;
    const video = document.getElementById('scanner-video');

    // Fix Android: asignar stream y forzar play
    video.srcObject = stream;
    video.setAttribute('playsinline', true);
    video.setAttribute('muted', true);
    video.muted = true;
    await video.play().catch(() => {});

    video.style.display = 'block';
    document.getElementById('scan-placeholder').style.display = 'none';
    document.getElementById('scan-overlay').style.display = 'block';
    document.getElementById('start-scan-btn').style.display = 'none';
    document.getElementById('stop-scan-btn').style.display = '';
    document.getElementById('flash-btn').style.display = '';
    document.getElementById('trigger-scan-btn').style.display = '';
    scanActive = true;
    scanPaused = false;
    setScannerTriggerReady();
    resetScannerResult('Cámara activa · tocá “Escanear ahora”');

    if ('BarcodeDetector' in window) {
      // Android Chrome — API nativa
      barcodeDetector = new BarcodeDetector({
        formats: ['ean_13','ean_8','code_128','code_39','qr_code','upc_a','upc_e','itf','codabar']
      });
      toast('✅ Cámara lista — usá el botón Escanear ahora', 'i');
    } else {
      // iOS / Firefox — cargar html5-qrcode
      toast('⏳ Cargando escáner para iOS...', 'i');
      // Detener stream nativo, html5-qrcode maneja el suyo
      stream.getTracks().forEach(t => t.stop());
      scannerStream = null;
      video.style.display = 'none';
      document.getElementById('scan-overlay').style.display = 'none';

      await new Promise((resolve) => {
        if (window.Html5Qrcode) { resolve(); return; }
        // Intentar múltiples CDNs
        const cdns = [
          'html5-qrcode.min.js',
          'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
          'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js'
        ];
        let tried = 0;
        const tryNext = () => {
          if (tried >= cdns.length) { resolve(); return; }
          const s = document.createElement('script');
          s.src = cdns[tried++];
          s.onload = resolve;
          s.onerror = tryNext;
          document.head.appendChild(s);
        };
        tryNext();
      });

      if (!window.Html5Qrcode) {
        toast('⚠️ Escáner no disponible — usá Conteo por barras o escribí el código', 'w');
        document.getElementById('scan-placeholder').style.display = 'block';
        document.getElementById('start-scan-btn').style.display = '';
        document.getElementById('trigger-scan-btn').style.display = 'none';
        document.getElementById('stop-scan-btn').style.display = 'none';
        scanActive = false;
        return;
      }

      let qrDiv = document.getElementById('html5qr-container');
      if (!qrDiv) {
        qrDiv = document.createElement('div');
        qrDiv.id = 'html5qr-container';
        qrDiv.style.cssText = 'width:100%;border-radius:10px;overflow:hidden';
        video.parentNode.insertBefore(qrDiv, video);
      }
      qrDiv.style.display = 'block';

      html5QrScanner = new Html5Qrcode('html5qr-container');
      await html5QrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        (code) => {
          if (scanPaused || !consumeScannerTrigger()) return;
          if (navigator.vibrate) navigator.vibrate(80);
          document.getElementById('last-scan').style.display = 'block';
          document.getElementById('last-scan-code').textContent = code;
          handleCameraBarcode(code);
        },
        () => {}
      );
      // html5-qrcode crea su propio <video>. En Safari/iPhone debe quedar
      // visible y en reproducción dentro del escenario del escáner.
      const qrVideo = qrDiv.querySelector('video');
      if (qrVideo) {
        qrVideo.setAttribute('playsinline', 'true');
        qrVideo.setAttribute('webkit-playsinline', 'true');
        qrVideo.muted = true;
        qrVideo.style.setProperty('display', 'block', 'important');
        qrVideo.style.setProperty('width', '100%', 'important');
        qrVideo.style.setProperty('height', '100%', 'important');
        qrVideo.style.setProperty('object-fit', 'cover', 'important');
        await qrVideo.play().catch(() => {});
      }
      toast('✅ Cámara lista — usá el botón Escanear ahora', 'i');
    }
  } catch(e) {
    toast('❌ No se pudo acceder a la cámara: ' + e.message, 'e');
    scanActive = false;
    document.getElementById('trigger-scan-btn').style.display = 'none';
    document.getElementById('start-scan-btn').style.display = '';
    document.getElementById('stop-scan-btn').style.display = 'none';
  }
}

// ===== FLASH =====
let flashOn = false;
async function toggleFlash() {
  if (!scannerStream) { toast('Activá la cámara primero', 'w'); return; }
  try {
    const track = scannerStream.getVideoTracks()[0];
    const caps = track.getCapabilities();
    if (!caps.torch) { toast('⚠️ Flash no disponible en este dispositivo', 'w'); return; }
    flashOn = !flashOn;
    await track.applyConstraints({ advanced: [{ torch: flashOn }] });
    const btn = document.getElementById('flash-btn');
    if (btn) {
      btn.textContent = flashOn ? '🔦 ON' : '🔦 Flash';
      btn.style.background = flashOn ? 'var(--yellow)' : '';
      btn.style.color = flashOn ? '#000' : '';
    }
  } catch(e) { toast('⚠️ Flash no disponible', 'w'); }
}

function stopScanner() {
  scanActive = false;
  scanPaused = false;
  scanTriggerArmed = false;
  clearTimeout(scanTriggerTimer);
  scanTriggerTimer = null;
  flashOn = false;
  const fb = document.getElementById('flash-btn');
  if (fb) { fb.style.display = 'none'; fb.textContent = '🔦 Flash'; fb.style.background = ''; fb.style.color = ''; }
  if (html5QrScanner) {
    html5QrScanner.stop().catch(()=>{});
    html5QrScanner = null;
    const qrDiv = document.getElementById('html5qr-container');
    if (qrDiv) qrDiv.style.display = 'none';
  }
  if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
  const video = document.getElementById('scanner-video');
  video.style.display = 'none'; video.srcObject = null;
  document.getElementById('scan-placeholder').style.display = 'block';
  document.getElementById('scan-overlay').style.display = 'none';
  document.getElementById('start-scan-btn').style.display = '';
  document.getElementById('trigger-scan-btn').style.display = 'none';
  document.getElementById('stop-scan-btn').style.display = 'none';
  resetScannerResult('Escáner detenido');
}

let scanPaused = false;
async function scanFrame() {
  if (!scanActive || !barcodeDetector || scanPaused || !scanTriggerArmed) return;
  const video = document.getElementById('scanner-video');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    try {
      const codes = await barcodeDetector.detect(video);
      if (codes.length > 0) {
        const code = codes[0].rawValue;
        if (!consumeScannerTrigger()) return;
        lastScanCode = code;
        lastScanTime = Date.now();
        // Feedback visual verde
        const overlay = document.getElementById('scan-overlay');
        if (overlay) overlay.style.borderColor = '#10B981';
        await handleCameraBarcode(code);
        setTimeout(() => { if (overlay) overlay.style.borderColor = ''; }, 650);
        return;
      }
    } catch (e) {}
  }
  if (scanActive && scanTriggerArmed) setTimeout(scanFrame, 200);
}

// ===== TABS =====
function showTab(name, options = {}) {
  if (name !== 'scanner' && scanActive) stopScanner();
  const page = document.getElementById(`page-${name}`);
  const tab = document.getElementById(`tab-${name}`);
  if (!page || !tab) return;
  if (options.force !== true && page.classList.contains('active') && tab.classList.contains('active')) {
    if (sessionId && currentModule === 'inventario') updateOperationsHistory(options.history || 'push','workspace',name);
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  page.classList.add('active');
  tab.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'auto' });

  if (name === 'conteo') focusSearchInput();
  if (name === 'lista') { renderCountTable(); updateStats(); }
  if (name === 'dashboard') { updateStats(); loadBarcodeAssignments(); if (balanceData) refreshReport(); }
  if (name === 'analisis' && balanceData) refreshReport();
  if (name === 'scanner') resetScannerResult();
  if (sessionId && currentModule === 'inventario') updateOperationsHistory(options.history || 'push','workspace',name);
}

// ===== TOAST =====
let toastTimer;
let toastClearTimer;
let toastSequence = 0;
function toast(msg, type = 'i') {
  const t = document.getElementById('toast');
  if (!t) return;
  const sequence = ++toastSequence;
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  clearTimeout(toastClearTimer);
  toastTimer = setTimeout(() => {
    if (sequence !== toastSequence) return;
    t.classList.remove('show');
    toastClearTimer = setTimeout(() => {
      if (sequence === toastSequence) t.textContent = '';
    }, 350);
  }, 2600);
}

// ===== PERSISTENCIA LOCAL =====
function localStateKey() {
  return sessionId ? `sc_v2_${sessionId}` : 'sc_v2_offline';
}
function localBalanceKey() {
  return sessionId ? `sc_balance_${sessionId}` : 'sc_balance_offline';
}

function saveLocal() {
  try {
    localStorage.setItem(localStateKey(), JSON.stringify({
      countItems, almacen, totalScans,
      actionLog: actionLog.slice(0, 50)
    }));
    // Guardar balance por separado y por sesión para no mezclar balances viejos.
    if (balanceData && balanceData.length) {
      localStorage.setItem(localBalanceKey(), JSON.stringify({
        data: balanceData,
        meta: window.balanceMeta || null
      }));
    }
  } catch (e) {}
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(localStateKey());
    if (raw) {
      const d = JSON.parse(raw);
      if (d.countItems) countItems = d.countItems;
      if (d.almacen) setAlmacen(d.almacen);
      if (d.totalScans) totalScans = d.totalScans;
      if (d.actionLog) actionLog = d.actionLog;
      renderLiveLog(); renderCountTable(); updateStats();
    }
  } catch (e) {}
  // Cargar balance guardado localmente solo como respaldo offline / caché de esa sesión.
  try {
    const rawBal = localStorage.getItem(localBalanceKey());
    if (rawBal) {
      const b = JSON.parse(rawBal);
      if (b.data && b.data.length) {
        balanceData = b.data;
        window.balanceMeta = b.meta || null;
        const meta = b.meta || {};
        document.getElementById('bal-status').style.display = 'block';
        document.getElementById('no-bal-msg').style.display = 'none';
        document.getElementById('bal-fname').textContent = meta.nombre ? `📄 ${meta.nombre}` : '📄 Balance de Stock';
        document.getElementById('bal-info').textContent =
          `${balanceData.length} productos${meta.almacen ? ' · ' + meta.almacen : ''}${meta.fecha ? ' · ' + meta.fecha : ''} (guardado)`;
        refreshReport();
      }
    }
  } catch (e) {}
}


async function diagnosticoServidor() {
  if (!serverUrl) { toast('❌ No hay conexión con Sucaneitor', 'e'); return; }
  try {
    const p = await fetch(`${serverUrl}/api/padron`).then(r=>r.json());
    let msg = `Sucaneitor: padrón ${p.total || 0}`;
    if (sessionId) {
      const b = await fetch(`${serverUrl}/api/balance?session_id=${sessionId}`).then(r=>r.json());
      msg += ` · balance ${b.balance ? b.balance.length : 0}`;
    }
    toast(msg, 'i');
    console.log('[diagnosticoServidor]', {padron:p, sessionId, balance: sessionId ? await fetch(`${serverUrl}/api/balance?session_id=${sessionId}`).then(r=>r.json()) : null});
  } catch(e) {
    toast('❌ No pude consultar Sucaneitor', 'e');
    console.error(e);
  }
}
window.diagnosticoServidor = diagnosticoServidor;

// ===== UTILS =====
function applySavedTheme() {
  const theme = 'dark';
  localStorage.setItem('sc_theme', theme);
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = '#0f0f13';
}

function toggleTheme() {
  applySavedTheme();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  if (typeof AbortController === 'undefined') return fetch(url, options || {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 4000);
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clean(v) {
  const s = String(v ?? '').trim();
  return (s.toLowerCase() === 'nan' || s === 'undefined' || s === 'null') ? '' : s;
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escA(s) { return String(s||'').replace(/'/g,"\\'").replace(/"/g,'\\"'); }
function timeStr() {
  return new Date().toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Cargar SheetJS
(function() {
  const s = document.createElement('script');
  s.src = 'xlsx.full.min.js';
  s.onerror = () => {
    const fallback = document.createElement('script');
    fallback.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    document.head.appendChild(fallback);
  };
  document.head.appendChild(s);
})();

// ===== FOTOS DE PRODUCTO =====
const imgCache = {};         // key -> url | null | 'pending'
const imgPollTimers = {};

function updateImgInDOM(key, url) {
  if (!url) return;
  // Base64 se carga directo; URLs externas pasan por el proxy del servidor
  const proxyUrl = (!serverOnline || url.startsWith('data:'))
    ? url
    : `${serverUrl}/api/img_proxy?url=${encodeURIComponent(url)}`;
  document.querySelectorAll(`.log-img[data-key="${CSS.escape(key)}"]`).forEach(el => {
    el.src = proxyUrl;
    el.style.display = 'block';
    el.onerror = () => { el.style.display = 'none'; };
  });
}

async function fetchProductImage(barras, nombre, codigo) {
  if (!serverOnline) return null;

  const key = barras || codigo;
  if (!key) return null;
  if (imgCache[key] && imgCache[key] !== 'pending') { updateImgInDOM(key, imgCache[key]); return imgCache[key]; }
  if (imgCache[key] === 'pending') return null;

  imgCache[key] = 'pending';

  const q = encodeURIComponent(nombre);
  const b = encodeURIComponent(barras || '');

  try {
    const res = await fetch(`${serverUrl}/api/imagen?q=${q}&barras=${b}`);
    const data = await res.json();
    if (data.url) {
      imgCache[key] = data.url;
      updateImgInDOM(key, data.url);
      return data.url;
    }
    // Servidor está buscando en background → poll rápido
    if (data.pending) pollForImage(key, q, b);
  } catch(e) { imgCache[key] = null; }
  return null;
}

function pollForImage(key, q, b, attempts = 0) {
  if (attempts > 12) { imgCache[key] = null; return; }
  clearTimeout(imgPollTimers[key]);
  // Poll cada 1s los primeros 5 intentos, luego cada 2s
  const delay = attempts < 5 ? 1000 : 2000;
  imgPollTimers[key] = setTimeout(async () => {
    if (!serverOnline) return;
    try {
      const res = await fetch(`${serverUrl}/api/imagen_ready?q=${q}&barras=${b}`);
      const data = await res.json();
      if (data.ready) {
        imgCache[key] = data.url || null;
        if (data.url) updateImgInDOM(key, data.url);
      } else {
        pollForImage(key, q, b, attempts + 1);
      }
    } catch(e) { pollForImage(key, q, b, attempts + 1); }
  }, delay);
}

async function loadLogImage(key, barras, nombre, codigo) {
  fetchProductImage(barras, nombre, codigo);
}

// ===== SESIONES UI =====
function updateSessionBadge(usuarios) {
  const badge = document.getElementById('nav-almacen');
  if (sessionNombre) {
    badge.title = `Sesión: ${sessionNombre} | Usuarios: ${usuarios.map(u=>u.nombre).join(', ')}`;
  }
  // Actualizar indicador de usuarios en el nav
  let userEl = document.getElementById('nav-users');
  if (!userEl) {
    userEl = document.createElement('span');
    userEl.id = 'nav-users';
    userEl.style.cssText = 'font-size:12px;color:var(--muted);margin-right:6px';
    document.getElementById('nav-almacen').parentNode.insertBefore(userEl, document.getElementById('nav-almacen'));
  }
  userEl.textContent = usuarios.length > 1 ? `👥 ${usuarios.length}` : '';
}



async function cambiarSesion() {
  const confirmed = await appConfirm({
    title: 'Salir de la sesión',
    subtitle: sessionNombre || 'Sesión actual',
    message: currentModule === 'reposicion' || currentModule === 'recepcion'
      ? 'Los avances ya sincronizados quedarán guardados. Volverás a la pantalla de acceso.'
      : 'El conteo guardado no se elimina. Volverás a la pantalla de acceso.',
    icon: '←', confirmText: 'Salir de la sesión'
  });
  if (confirmed) {
    leaveOperationsWorkspace();
    mostrarPantallaSesion();
    updateOperationsHistory('push','sessions');
  }
}

function updateSessionCard() {
  const card = document.getElementById('sesion-activa-card');
  const info = document.getElementById('sesion-activa-info');
  if (!card) return;
  if (sessionNombre) {
    card.style.display = 'block';
    info.innerHTML = `
      <div style="font-weight:700;font-size:15px;color:var(--accent2)">${esc(sessionNombre)}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">Usuario: ${esc(usuarioNombre)}</div>
      <div style="font-size:12px;color:var(--muted)">ID: ${esc(sessionId)}</div>
    `;
  } else {
    card.style.display = 'none';
  }
}

// ===== MÓDULO IA - OPENAI VISION =====
// La clave se configura y permanece únicamente en el servidor.

let iaCameraStream = null;
let iaActive = false;
let iaHistory = [];
let currentIaClave = '';

// Construir contexto del padrón para identificación visual
// Solo manda ~400 productos para no exceder el quota gratuito
function buildPadronContext(hintText) {
  let lista = padron;

  // Si hay texto visible en la imagen (pista), filtrar productos relevantes primero
  if (hintText && hintText.length > 2) {
    const q = hintText.toLowerCase();
    const relevantes = padron.filter(p =>
      p.nombre.toLowerCase().includes(q) || (p.marca || '').toLowerCase().includes(q)
    );
    // Si encontramos coincidencias, usarlas primero
    if (relevantes.length > 0) {
      // Primeros 200 relevantes + 100 random para contexto
      const random = padron.filter(p => !relevantes.includes(p))
        .sort(() => Math.random() - 0.5).slice(0, 50);
      lista = [...relevantes.slice(0, 100), ...random.slice(0, 50)];
    } else {
      lista = padron.slice(0, 400);
    }
  } else {
    // Sin pista: mandar 400 productos aleatorios para no exceder quota
    lista = padron.slice(0, 400);
  }

  return lista.map(p =>
    `${p.codigo}|${p.barras || ''}|${p.nombre}|${p.marca || ''}`
  ).join('\n');
}

async function iaStartCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    iaCameraStream = stream;
    const video = document.getElementById('ia-video');
    video.srcObject = stream;
    video.style.display = 'block';
    document.getElementById('ia-placeholder').style.display = 'none';
    document.getElementById('ia-start-btn').style.display = 'none';
    document.getElementById('ia-stop-btn').style.display = '';
    document.getElementById('ia-identify-btn').style.display = '';
    document.getElementById('ia-status').textContent = '✅ Cámara activa — apuntá al producto y tocá Identificar';
    iaActive = true;
  } catch(e) {
    toast('❌ No se pudo acceder a la cámara', 'e');
    document.getElementById('ia-status').textContent = '❌ Error: ' + e.message;
  }
}

function iaStopCamera() {
  iaActive = false;
  if (iaCameraStream) {
    iaCameraStream.getTracks().forEach(t => t.stop());
    iaCameraStream = null;
  }
  const video = document.getElementById('ia-video');
  video.style.display = 'none';
  video.srcObject = null;
  document.getElementById('ia-placeholder').style.display = 'block';
  document.getElementById('ia-start-btn').style.display = '';
  document.getElementById('ia-stop-btn').style.display = 'none';
  document.getElementById('ia-identify-btn').style.display = 'none';
  document.getElementById('ia-status').textContent = 'Activá la cámara para empezar';
}

async function iaIdentify() {
  if (!iaActive || !iaCameraStream) {
    toast('❌ Activá la cámara primero', 'e');
    return;
  }

  // Capturar frame del video
  const video = document.getElementById('ia-video');
  const canvas = document.getElementById('ia-canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  const imageBase64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

  // UI: mostrar que está procesando
  const overlay = document.getElementById('ia-overlay');
  const btn = document.getElementById('ia-identify-btn');
  const status = document.getElementById('ia-status');
  overlay.style.display = 'block';
  btn.disabled = true;
  btn.textContent = '⏳ Analizando...';
  status.textContent = '🤖 Enviando a Sucaneitor...';

  try {
    // Prompt con contexto del padrón
    status.textContent = '🤖 Analizando imagen...';

    // Usar el servidor para la identificación visual
    // El servidor filtra el padrón inteligentemente antes de mandarlo
    const useServer = serverOnline && serverUrl;
    let result;

    if (useServer) {
      // El servidor hace la llamada — mejor filtrado, sin límite de tokens en el browser
      const resp = await fetch(`${serverUrl}/api/ia_identificar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageBase64,
          hint: ''
        })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Error del servicio');
      result = data.result;
      status.textContent = `🤖 Analizando... (${data.productos_analizados} productos comparados)`;
    } else {
      // Sin servidor: no disponible
      throw new Error('Necesitás conexión a internet para usar esta función.');
    }

    // result ya está asignado arriba

    // Guardar imagen capturada para mostrar
    const capturedImg = canvas.toDataURL('image/jpeg', 0.6);
    currentIaClave = result.clave_historial || '';
    showIaResult(result, capturedImg);

    // Agregar al historial
    iaHistory.unshift({ result, img: capturedImg, ts: timeStr() });
    if (iaHistory.length > 20) iaHistory.pop();
    renderIaHistory();

    status.textContent = result.encontrado
      ? `✅ Producto identificado (${result.producto?.confianza || '?'}% confianza)`
      : '❓ No se pudo identificar el producto';

  } catch(e) {
    console.error(e);
    status.textContent = '❌ Error: ' + e.message;
    toast('❌ Error al identificar: ' + e.message, 'e');
    document.getElementById('ia-result-area').innerHTML = `
      <div style="color:var(--red);font-size:13px;padding:10px">
        ❌ ${e.message}
        ${e.message.includes('API') ? '<br><br>Verificá que la API key sea válida.' : ''}
      </div>`;
  } finally {
    overlay.style.display = 'none';
    btn.disabled = false;
    btn.textContent = '🤖 Identificar Producto';
  }
}

function showIaResult(result, capturedImg) {
  const area = document.getElementById('ia-result-area');

  if (!result.encontrado) {
    area.innerHTML = `
      <div style="text-align:center;padding:20px">
        <div style="font-size:36px;margin-bottom:10px">🤷</div>
        <div style="color:var(--text);font-weight:600">No identificado</div>
        <div style="color:var(--muted);font-size:12px;margin-top:6px">${esc(result.razon || '')}</div>
      </div>
      ${capturedImg ? `<img src="${capturedImg}" style="width:100%;border-radius:8px;margin-top:10px;opacity:0.6">` : ''}`;
    return;
  }

  const p = result.producto;
  const confianzaColor = p.confianza >= 85 ? 'var(--green)' : p.confianza >= 60 ? 'var(--yellow)' : 'var(--red)';

  let altsHtml = '';
  if (result.alternativas?.length) {
    altsHtml = `
      <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
        <div class="tm mb2">Otras posibilidades:</div>
        ${result.alternativas.map(a => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer"
            onclick="iaConfirmarAlternativa('${esc(a.codigo)}')">
            <span style="background:var(--surface2);border-radius:20px;padding:2px 8px;
              font-size:11px;color:var(--muted)">${a.confianza}%</span>
            <span style="font-size:12px;color:var(--text)">${esc(a.nombre)}</span>
          </div>`).join('')}
      </div>`;
  }

  area.innerHTML = `
    ${capturedImg ? `<img src="${capturedImg}" style="width:100%;border-radius:8px;margin-bottom:12px;max-height:160px;object-fit:cover">` : ''}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="background:${confianzaColor};color:#000;font-weight:700;font-size:13px;
        border-radius:20px;padding:3px 12px">${p.confianza}%</div>
      <div style="font-size:11px;color:var(--muted)">confianza</div>
    </div>
    <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px">${esc(p.nombre)}</div>
    <div style="font-family:'JetBrains Mono';font-size:11px;color:var(--accent);margin-bottom:6px">${esc(p.codigo)}</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px;font-style:italic">${esc(p.razon || '')}</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-p btn-full" onclick="iaConfirmar('${esc(p.codigo)}', '${esc(p.barras || '')}', '${esc(p.nombre)}', '${currentIaClave||''}')">
        ✅ Agregar al conteo
      </button>
      <button class="btn btn-s btn-sm" onclick="iaRechazar()">✕</button>
    </div>
    ${altsHtml}`;
}

function iaConfirmar(codigo, barras, nombre, claveHistorial) {
  const producto = padron.find(p => p.codigo === codigo) ||
    { codigo, barras, nombre };
  showQtyModal(producto, 'ia');
  document.getElementById('ia-result-area').innerHTML = `
    <div class="empty"><div class="icon">✅</div><p>Agregado al conteo</p></div>`;
  // Guardar en historial si tenemos la clave
  if (claveHistorial && serverOnline && serverUrl) {
    fetch(`${serverUrl}/api/ia_confirmar`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({clave: claveHistorial, codigo, nombre, barras: barras||''})
    }).catch(()=>{});
  }
}

function iaConfirmarAlternativa(codigo) {
  const producto = padron.find(p => p.codigo === codigo);
  if (!producto) { toast('❌ Producto no encontrado', 'e'); return; }
  showQtyModal(producto, 'ia');
  // Guardar alternativa elegida como correcta en el historial
  if (currentIaClave && serverOnline && serverUrl) {
    fetch(`${serverUrl}/api/ia_confirmar`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        clave: currentIaClave,
        codigo: producto.codigo,
        nombre: producto.nombre,
        barras: producto.barras||''
      })
    }).catch(()=>{});
  }
}

function iaRechazar() {
  document.getElementById('ia-result-area').innerHTML = `
    <div class="empty"><div class="icon">🤖</div><p>El resultado de la IA aparecerá aquí</p></div>`;
}

function renderIaHistory() {
  const container = document.getElementById('ia-history');
  if (!iaHistory.length) {
    container.innerHTML = '<div class="empty" style="padding:20px"><p>Sin identificaciones aún</p></div>';
    return;
  }
  container.innerHTML = iaHistory.map((entry, i) => {
    const p = entry.result?.producto;
    const found = entry.result?.encontrado;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 13px;
        border-bottom:1px solid var(--border)">
        <img src="${entry.img}" style="width:44px;height:44px;object-fit:cover;
          border-radius:6px;flex-shrink:0">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;${found ? 'color:var(--text)' : 'color:var(--muted)'};
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${found ? esc(p.nombre) : '❓ No identificado'}
          </div>
          ${found ? `<div style="font-size:10px;color:var(--muted)">${p.confianza}% · ${entry.ts}</div>` : ''}
        </div>
        ${found ? `<button class="btn btn-p btn-sm" onclick="iaConfirmar('${esc(p.codigo)}','${esc(p.barras||'')}','${esc(p.nombre)}')">+</button>` : ''}
      </div>`;
  }).join('');
}

function iaClearHistory() {
  iaHistory = [];
  renderIaHistory();
}
