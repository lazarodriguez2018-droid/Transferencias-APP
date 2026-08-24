// ===== MÓDULO RECEPCIÓN DE REMITOS =====
// Flujo principal por nombre/SKU, con escáner opcional y sincronización en tiempo real.

let receiptState = null;
let receiptParsedSource = null;
let receiptSourceBytes = null;
let receiptCurrentCode = '';
let receiptSearchResults = {};
let receiptRealtimeChannel = null;
let receiptRefreshTimer = null;
let receiptScanner = null;
let receiptScannerMode = 'expected';
let receiptLastScanCode = '';
let receiptLastScanTime = 0;
let receiptScanNoticeOpen = false;
let receiptListLimit = 250;

function receiptApi(path, options) { return fetch(`${serverUrl}${path}`, options); }
function receiptEncode(value) { return encodeURIComponent(String(value || '')); }
function receiptDecode(value) { return decodeURIComponent(String(value || '')); }
function receiptCanEdit() { return !!receiptState && receiptState.can_edit !== false && receiptState.estado === 'en_control'; }
function requireReceiptEditable() { if (receiptCanEdit()) return true; toast('Esta recepción está cerrada o pertenece a otro local.','w'); return false; }

function receiptLocation(value) {
  const raw=String(value||'').trim(),normalized=raw.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\b(bloqueo|almacen|sucursal|local|entrada|salida)\b/g,' ').replace(/\s+/g,' ').trim();
  return companyLocations.find(location=>{
    const name=String(location.nombre||'').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
    const warehouse=String(location.almacen||'').toLocaleLowerCase('es').trim();
    return normalized===name||normalized===warehouse||normalized.endsWith(name)||name.endsWith(normalized);
  }) || {nombre:raw,almacen:''};
}

async function analyzeReceptionFile(input) {
  const file=input.files&&input.files[0]; if(!file)return;
  const summary=document.getElementById('receipt-source-summary'); summary.textContent='Analizando todas las hojas…';
  try {
    const XLSX=await waitForXlsx(),buffer=await file.arrayBuffer(),workbook=XLSX.read(buffer,{type:'array',raw:false});
    const parsed=SucaneitorReception.parseWorkbook(workbook,XLSX,padron),origin=receiptLocation(parsed.origin),destination=receiptLocation(parsed.destination);
    parsed.origin=origin.nombre; parsed.destination=destination.nombre; parsed.original_filename=file.name;
    const profile=window.SucanCloud?.profile||{};
    if(!window.SucanCloud?.isSupervisor?.()&&destination.nombre!==profile.local_nombre) throw new Error(`Este remito llega a ${destination.nombre}. Tu cuenta pertenece a ${profile.local_nombre||'otro local'}`);
    receiptParsedSource=parsed; receiptSourceBytes=buffer.slice(0);
    summary.innerHTML=`<strong style="color:var(--green)">Remito ${esc(parsed.document_number)} listo</strong><br>${esc(parsed.origin)} → ${esc(parsed.destination)} · ${parsed.meta.sheet_count} hoja${parsed.meta.sheet_count===1?'':'s'} · ${parsed.meta.unique_products} productos · ${parsed.meta.expected_units} unidades<br><span style="color:var(--muted)">${parsed.meta.without_barcode.length} productos sin barras · ${parsed.meta.missing_catalog.length} SKU fuera del padrón</span>`;
    const nameInput=document.getElementById('input-sesion-nombre'); if(!nameInput.value.trim())nameInput.value=`Remito ${parsed.document_number} · ${parsed.origin} → ${parsed.destination}`;
    toast(`Remito ${parsed.document_number} listo para controlar`,'s');
  } catch(error) {
    receiptParsedSource=null; receiptSourceBytes=null; input.value=''; summary.innerHTML=`<span style="color:var(--red)">${esc(error.message||'No se pudo leer el remito')}</span>`; toast(error.message||'No se pudo leer el remito','e');
  }
}

async function createReceptionSession(url, usuario, requestedName) {
  if(!receiptParsedSource||!receiptSourceBytes){showSessionError('Cargá primero el remito a controlar');return;}
  try {
    const response=await fetch(`${url}/api/recepcion/crear`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nombre:requestedName||`Remito ${receiptParsedSource.document_number}`,document_number:receiptParsedSource.document_number,date:receiptParsedSource.date,origin:receiptParsedSource.origin,destination:receiptParsedSource.destination,items:receiptParsedSource.items,import_meta:receiptParsedSource.meta,original_filename:receiptParsedSource.original_filename,original_base64:repoArrayBufferToBase64(receiptSourceBytes)})});
    const data=await response.json().catch(()=>({})); if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo crear la recepción');
    await joinReception(data.reception_id,data.receipt.nombre,url,usuario,data.receipt); receiptParsedSource=null; receiptSourceBytes=null;
  } catch(error){showSessionError(error.message||'Error al crear la recepción');}
}

async function joinReception(rid, nombre, url, usuario, initialReceipt, options={}) {
  try {
    serverUrl=url; serverOnline=true; sessionId=rid; sessionNombre=nombre; usuarioNombre=usuario||'Usuario'; localStorage.setItem('sc_usuario',usuarioNombre);
    let loaded=initialReceipt;
    if(!loaded){const response=await fetchWithTimeout(`${url}/api/recepcion/state?rid=${encodeURIComponent(rid)}`,{},8000),data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo abrir la recepción');loaded=data.receipt;}
    receiptState=loaded; receiptCurrentCode=receiptState.items.find(item=>Number(item.recibido)<Number(item.esperado)&&!item.no_recibido)?.codigo||receiptState.items[0]?.codigo||'';
    await loadBarcodeAssignments(); enterReceptionApp(options); connectReceptionRealtime(); toast(`Remito ${receiptState.document_number} abierto`,'s');
  } catch(error){serverOnline=false;showSessionError(error.message||'No se pudo abrir la recepción');}
}

function enterReceptionApp(options={}) {
  if(!receiptState)return;
  document.title=`Remito ${receiptState.document_number} · Sucaneitor`;
  document.getElementById('session-screen').style.display='none'; document.getElementById('main-nav').style.display='flex'; document.getElementById('main-tabs').style.display='none'; document.getElementById('repo-tabs').style.display='none'; document.getElementById('receipt-tabs').style.display='flex';
  document.querySelectorAll('.page').forEach(page=>page.classList.remove('active'));
  const logo=document.querySelector('#main-nav .nav-logo > span'); if(logo)logo.innerHTML='Sucaneitor <span style="color:#38bdf8">Recepción</span>';
  const badge=document.getElementById('nav-almacen'); badge.textContent=`Remito ${receiptState.document_number}`; badge.title=`${receiptState.origin} → ${receiptState.destination}`;
  setSyncStatus('online'); renderReceiptAll(); const tab=options.tab||'control'; showReceiptTab(tab,{history:'none'}); updateOperationsHistory(options.history||'push','workspace',tab);
}

function showReceiptTab(name,options={}) {
  if(name!=='control')document.getElementById('receipt-search-results')?.style.setProperty('display','none');
  document.querySelectorAll('.page').forEach(page=>page.classList.remove('active')); document.querySelectorAll('.tab').forEach(tab=>tab.classList.remove('active'));
  const page=document.getElementById(`receipt-page-${name}`),tab=document.getElementById(`receipt-tab-${name}`); if(!page||!tab)return; page.classList.add('active');tab.classList.add('active');window.scrollTo({top:0,behavior:'auto'});
  if(name==='lista')renderReceiptList(); if(name==='extras')renderReceiptExtras(); if(name==='resumen')renderReceiptSummary(); if(name==='control'&&options.focus!==false)setTimeout(()=>document.getElementById('receipt-search-input')?.focus({preventScroll:true}),80);
  if(sessionId&&currentModule==='recepcion')updateOperationsHistory(options.history||'push','workspace',name);
}

function disconnectReceptionRealtime(clearState=true) {
  clearTimeout(receiptRefreshTimer); receiptRefreshTimer=null;
  if(receiptRealtimeChannel&&window.SucanCloud?.db){try{window.SucanCloud.db.removeChannel(receiptRealtimeChannel);}catch(_){} receiptRealtimeChannel=null;}
  if(clearState){receiptState=null;receiptCurrentCode='';}
}

function connectReceptionRealtime() {
  disconnectReceptionRealtime(false);
  const rid=sessionId; if(!rid)return;
  refreshReceptionState(false).then(()=>{receiptRealtimeChannel=window.SucanCloud?.watchReception?.(rid,()=>{clearTimeout(receiptRefreshTimer);receiptRefreshTimer=setTimeout(()=>refreshReceptionState(true),180);})||null;});
}

async function refreshReceptionState(render=true) {
  if(!sessionId||currentModule!=='recepcion')return;
  try{const response=await fetch(`/api/recepcion/state?rid=${encodeURIComponent(sessionId)}`),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo actualizar');receiptState=data.receipt;if(render)renderReceiptAll();setSyncStatus('online');}
  catch(error){setSyncStatus('offline');}
}

function receiptStatus(item) { return SucaneitorReception.status(item); }
function receiptStatusLabel(status) { return {pendiente:'Pendiente de verificación',parcial:'Recepción parcial',exacto:'Recepción confirmada',sobrante:'Excedente recibido',no_recibido:'No recibido'}[status]||status; }
function receiptStatusClass(status) { return status==='exacto'?'exact':status==='sobrante'?'over':status==='no_recibido'?'missing':'short'; }
function receiptQuantityText(value) { const quantity=Math.max(0,Number(value)||0);return `${quantity} ${quantity===1?'unidad':'unidades'}`; }
async function receiptWaitForDialogHistory() { for(let attempt=0;attempt<12&&history.state?.operationsOverlay==='app-dialog-overlay';attempt+=1)await new Promise(resolve=>setTimeout(resolve,25)); }

function renderReceiptAll() {
  if(!receiptState)return;
  document.body.classList.toggle('receipt-readonly',!receiptCanEdit());
  document.getElementById('receipt-access-banner')?.classList.toggle('show',!receiptCanEdit());
  document.getElementById('receipt-session-title').textContent=receiptState.nombre;
  document.getElementById('receipt-route-badge').textContent=`${receiptState.origin} → ${receiptState.destination}`;
  const summary=SucaneitorReception.summary(receiptState),kpis=`<div class="repo-kpi"><span>Unidades del remito</span><strong>${summary.unidades_esperadas}</strong></div><div class="repo-kpi"><span>Recibidas</span><strong>${summary.unidades_recibidas}</strong></div><div class="repo-kpi"><span>Sin confirmar</span><strong>${summary.unidades_faltantes}</strong></div><div class="repo-kpi"><span>Extras</span><strong>${summary.extras_unidades}</strong></div>`;
  ['control','lista','resumen'].forEach(section=>{const node=document.getElementById(`receipt-kpis-${section}`);if(node)node.innerHTML=kpis;});
  const count=document.getElementById('receipt-list-count'); if(count){count.textContent=summary.productos_pendientes;count.classList.toggle('show',summary.productos_pendientes>0);}
  const progress=document.getElementById('receipt-progress-copy'); if(progress)progress.innerHTML=`<strong>${summary.exactos} de ${summary.productos} productos con recepción confirmada</strong><br>${summary.productos_pendientes} continúan pendientes o presentan diferencias de cantidad.`;
  renderReceiptCurrent(); renderReceiptList(); renderReceiptExtras(); renderReceiptSummary(); renderReceiptConfig();
}

function renderReceiptCurrent() {
  const card=document.getElementById('receipt-current-card'); if(!card||!receiptState)return;
  const summary=SucaneitorReception.summary(receiptState);
  if(summary.productos_pendientes===0){card.innerHTML=`<div class="receipt-finished"><h2>Control de productos completado</h2><p>Todos los productos del remito fueron revisados. Podés consultar cantidades y diferencias desde la lista completa.</p><button class="btn btn-p" onclick="showReceiptTab('lista')">Revisar lista completa</button></div>`;return;}
  let item=receiptState.items.find(row=>String(row.codigo)===String(receiptCurrentCode)); if(!item)item=receiptState.items.find(row=>Number(row.recibido)<Number(row.esperado)&&!row.no_recibido)||receiptState.items[0];
  if(!item){card.innerHTML='<div class="repo-empty">El remito no contiene productos.</div>';return;} receiptCurrentCode=item.codigo;
  const status=receiptStatus(item),missing=Math.max(0,Number(item.esperado)-Number(item.recibido)),extra=Math.max(0,Number(item.recibido)-Number(item.esperado));
  const isChecked=status==='exacto';
  const actions=receiptCanEdit()?`<div class="receipt-check-actions"><button class="btn ${isChecked?'btn-g':'btn-p'}" ${isChecked?'disabled':''} onclick="receiptConfirmExpected('${receiptEncode(item.codigo)}','control')">${isChecked?'✓ Recepción confirmada':`✓ Confirmar ${receiptQuantityText(item.esperado)}`}</button><button class="btn btn-s" onclick="receiptEditQty('${receiptEncode(item.codigo)}')">Editar cantidad</button></div><div class="repo-inline" style="margin-top:9px"><button class="btn btn-s" onclick="receiptChangeQty('${receiptEncode(item.codigo)}',1,'nombre')">+1 unidad</button><button class="btn btn-s" onclick="openReceiptScanner('expected')">▣ Escanear</button></div>`:`<div class="repo-status-banner warn">Recepción en modo consulta.</div>`;
  card.innerHTML=`<span class="receipt-flag ${receiptStatusClass(status)}">${receiptStatusLabel(status)}</span><div class="repo-source-name" style="margin-top:12px">PRODUCTO DEL REMITO</div><h2 class="repo-product-name">${esc(item.nombre)}</h2><div class="repo-source-name">SKU ${esc(item.codigo)}${item.barras?` · Barras ${esc(item.barras)}`:' · Sin código de barras'}${item.descripcion_archivo&&item.descripcion_archivo!==item.nombre?`<br>En archivo: ${esc(item.descripcion_archivo)}`:''}</div><div class="repo-quantities"><div class="repo-quantity"><span>Esperado</span><strong>${item.esperado}</strong></div><div class="repo-quantity"><span>Recibido</span><strong>${item.recibido}</strong></div><div class="repo-quantity pending"><span>${extra?'Sobra':'Falta'}</span><strong>${extra||missing}</strong></div></div>${actions}${item.updated_by?`<div class="tm mt2">Último cambio: ${esc(item.updated_by)}</div>`:''}`;
}

function closeReceiptSearchResults(target='receipt-search-results') { const container=document.getElementById(target);if(container)container.style.display='none'; }
function receiptOpenItem(encodedCode) { receiptCurrentCode=receiptDecode(encodedCode); closeReceiptSearchResults(); renderReceiptCurrent(); showReceiptTab('control',{focus:false}); }
function receiptOpenNextPending() { const next=receiptState?.items.find(item=>Number(item.recibido)<Number(item.esperado)&&!item.no_recibido); receiptCurrentCode=next?.codigo||''; renderReceiptCurrent(); showReceiptTab('control'); }

async function receiptConfirmExpected(encodedCode,source='control') {
  const code=receiptDecode(encodedCode),item=receiptState?.items.find(row=>String(row.codigo)===code);if(!item)return;
  const choice=await openAppDialog({
    title:'Confirmar recepción',subtitle:item.nombre,icon:'✓',confirmText:`Confirmar ${receiptQuantityText(item.esperado)}`,cancelText:'Cancelar',secondaryText:'Modificar cantidad',secondaryValue:'modify',
    bodyHtml:`<div class="app-dialog-product"><strong>${esc(item.nombre)}</strong><span>SKU ${esc(item.codigo)}</span></div><div class="receipt-confirm-quantities"><div><span>Según remito</span><strong>${receiptQuantityText(item.esperado)}</strong></div><div><span>Registrado</span><strong>${receiptQuantityText(item.recibido)}</strong></div><div class="final"><span>Al confirmar</span><strong>${receiptQuantityText(item.esperado)}</strong></div></div><p class="app-dialog-message">Confirmá que la cantidad física recibida coincide con la indicada en el remito. Si es diferente, elegí “Modificar cantidad”.</p>`
  });
  if(choice==='modify'){await receiptWaitForDialogHistory();await receiptEditQty(encodedCode);return;}
  if(choice!==true)return;
  const saved=await receiptSetAbsolute(encodedCode,item.esperado,`confirmado_${source}`);if(!saved)return;
  toast(`✓ Recepción confirmada · ${item.nombre} · ${receiptQuantityText(item.esperado)}`,'s');
  if(source==='control'){
    const input=document.getElementById('receipt-search-input');if(input)input.value='';closeReceiptSearchResults();
    const next=receiptState.items.find(row=>Number(row.recibido)<Number(row.esperado)&&!row.no_recibido);receiptCurrentCode=next?.codigo||'';renderReceiptCurrent();
    setTimeout(()=>input?.focus({preventScroll:true}),80);
  }
}

async function receiptChangeQty(encodedCode,delta,source='manual') {
  if(!requireReceiptEditable())return false; const code=receiptDecode(encodedCode),item=receiptState.items.find(row=>String(row.codigo)===code); if(!item)return false;
  const next=Math.max(0,Number(item.recibido||0)+Number(delta||0));
  if(next>Number(item.esperado)&&delta>0){const confirmed=await appConfirm({title:'Cantidad mayor al remito',subtitle:item.nombre,tone:'warning',icon:'+',confirmText:'Agregar igualmente',message:`El remito indica ${item.esperado} unidades y el resultado será ${next}. ¿Confirmás que llegaron unidades de más?`});if(!confirmed)return false;}
  try{const response=await receiptApi('/api/recepcion/update_qty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reception_id:sessionId,codigo:code,delta,source})}),data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo guardar');const index=receiptState.items.findIndex(row=>String(row.codigo)===code);if(index>=0)receiptState.items[index]=data.item;receiptCurrentCode=code;renderReceiptAll();tactileFeedback(30);return true;}catch(error){toast(error.message||'No se pudo guardar','e');return false;}
}

async function receiptSetAbsolute(encodedCode,value,source='lista') {
  if(!requireReceiptEditable())return false; const code=receiptDecode(encodedCode),qty=Number.parseInt(value,10); if(!Number.isInteger(qty)||qty<0){toast('Cantidad inválida','e');renderReceiptList();return false;}
  const item=receiptState.items.find(row=>String(row.codigo)===code); if(qty>Number(item?.esperado||0)){const confirmed=await appConfirm({title:'Cantidad mayor al remito',subtitle:item?.nombre||code,tone:'warning',icon:'+',confirmText:'Guardar igualmente',message:`Esperado: ${item?.esperado||0} · recibido: ${qty}.`});if(!confirmed){renderReceiptList();return false;}}
  try{const response=await receiptApi('/api/recepcion/update_qty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reception_id:sessionId,codigo:code,absolute:qty,source})}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo guardar');const index=receiptState.items.findIndex(row=>String(row.codigo)===code);if(index>=0)receiptState.items[index]=data.item;receiptCurrentCode=code;renderReceiptAll();return true;}catch(error){toast(error.message,'e');return false;}
}

async function receiptEditQty(encodedCode) {
  const code=receiptDecode(encodedCode),item=receiptState.items.find(row=>String(row.codigo)===code); if(!item)return;
  const value=await appPrompt({title:'Cantidad recibida',subtitle:item.nombre,message:`El remito indica ${item.esperado} unidades.`,label:'Cantidad física recibida',value:String(item.recibido),type:'number',inputMode:'numeric',min:0,icon:'#',confirmText:'Guardar'}); if(value===false)return; await receiptSetAbsolute(encodedCode,value,'edicion');
}

async function receiptMarkNotReceived(encodedCode) {
  if(!requireReceiptEditable())return; const code=receiptDecode(encodedCode),item=receiptState.items.find(row=>String(row.codigo)===code);if(!item)return;
  const observation=await appPrompt({title:'Marcar como no recibido',subtitle:item.nombre,message:'La observación es opcional. La cantidad recibida quedará en cero.',label:'Observación',placeholder:'Opcional',multiline:true,maxLength:300,tone:'warning',icon:'!',confirmText:'Marcar no recibido'});if(observation===false)return;
  try{const response=await receiptApi('/api/recepcion/no_recibido',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reception_id:sessionId,codigo:code,value:true,observation})}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo guardar');const index=receiptState.items.findIndex(row=>String(row.codigo)===code);if(index>=0)receiptState.items[index]=data.item;receiptCurrentCode='';renderReceiptAll();receiptOpenNextPending();}catch(error){toast(error.message,'e');}
}

function renderReceiptList() {
  const container=document.getElementById('receipt-items-list'); if(!container||!receiptState)return;
  const query=SucaneitorReception.normalize(document.getElementById('receipt-list-search')?.value),filter=document.getElementById('receipt-list-filter')?.value||'all';
  let rows=receiptState.items.filter(item=>!query||SucaneitorReception.normalize(`${item.codigo} ${item.nombre} ${item.descripcion_archivo||''}`).includes(query)).filter(item=>{const status=receiptStatus(item);if(filter==='pending')return ['pendiente','parcial'].includes(status);if(filter==='exact')return status==='exacto';if(filter==='short')return Number(item.recibido)<Number(item.esperado);if(filter==='over')return status==='sobrante';if(filter==='not_received')return status==='no_recibido';return true;});
  const visible=rows.slice(0,receiptListLimit); container.innerHTML=rows.length?visible.map(item=>{const status=receiptStatus(item),className=`receipt-row-${receiptStatusClass(status)}`,isChecked=status==='exacto',actions=receiptCanEdit()?`<div class="repo-row-actions">${isChecked?'<span class="receipt-checked-mark">✓ Confirmado</span>':status==='sobrante'?'<span class="receipt-over-mark">Revisar excedente</span>':`<button class="btn btn-p" onclick="receiptConfirmExpected('${receiptEncode(item.codigo)}','lista')">✓ Confirmar ${item.esperado}</button>`}<button class="btn btn-s" onclick="receiptEditQty('${receiptEncode(item.codigo)}')">Editar cantidad</button></div>`:`<strong>${item.recibido}/${item.esperado}</strong>`;return `<article class="repo-row ${className}"><div onclick="receiptOpenItem('${receiptEncode(item.codigo)}')" style="cursor:pointer"><h3>${isChecked?'✓ ':''}${esc(item.nombre)}</h3><div class="repo-row-meta">SKU ${esc(item.codigo)} · Remito ${item.esperado} · Recibido ${item.recibido} · ${receiptStatusLabel(status)}${item.observacion?` · ${esc(item.observacion)}`:''}${item.updated_by?` · ${esc(item.updated_by)}`:''}</div></div>${actions}</article>`;}).join('')+(rows.length>visible.length?`<button class="btn btn-s btn-full" onclick="receiptListLimit+=250;renderReceiptList()">Mostrar más · quedan ${rows.length-visible.length}</button>`:''):'<div class="repo-empty">No hay productos para este filtro.</div>';
}

function receiptSearchSource() {
  const byCode=new Map(padron.map(product=>[String(product.codigo),product]));
  receiptState.items.forEach(item=>{if(!byCode.has(String(item.codigo)))byCode.set(String(item.codigo),item);}); return [...byCode.values()];
}

function searchReceiptProducts(query,mode) {
  const value=String(query||'').trim(),target=mode==='extra'?'receipt-extra-results':'receipt-search-results',container=document.getElementById(target);if(!container)return;
  if(value.length<2){container.style.display='none';container.innerHTML='';return;}
  const source=receiptSearchSource(),index=SucaneitorSearch.createSearchIndex(source),expectedCodes=new Set(receiptState.items.map(item=>String(item.codigo)));
  let results=SucaneitorSearch.rankProducts(index,value,null,30).map(row=>row.product);const compact=SucaneitorSearch.normalizeText(value);
  source.filter(product=>String(product.codigo).toLowerCase().includes(value.toLowerCase())||String(product.barras||'').includes(compact)).forEach(product=>{if(!results.some(row=>String(row.codigo)===String(product.codigo)))results.unshift(product);});
  if(mode!=='extra')results.sort((a,b)=>{const ae=expectedCodes.has(String(a.codigo)),be=expectedCodes.has(String(b.codigo));if(ae!==be)return Number(be)-Number(ae);const ai=receiptState.items.find(item=>String(item.codigo)===String(a.codigo)),bi=receiptState.items.find(item=>String(item.codigo)===String(b.codigo));return Number(Number(ai?.recibido)>=Number(ai?.esperado))-Number(Number(bi?.recibido)>=Number(bi?.esperado));});
  receiptSearchResults[target]=results.slice(0,25);container.style.display='block';const header=`<div class="receipt-results-head"><span>${results.length?`${Math.min(25,results.length)} resultados`:'Sin coincidencias'}</span><button type="button" onclick="closeReceiptSearchResults('${target}')" aria-label="Cerrar resultados">× Cerrar lista</button></div>`;container.innerHTML=header+(results.length?results.slice(0,25).map((product,indexRow)=>{const item=receiptState.items.find(row=>String(row.codigo)===String(product.codigo)),received=Number(item?.recibido)||0,expected=Number(item?.esperado)||0,label=item?(received===expected?`CONFIRMADO ${received}/${expected}`:received>expected?`EXCEDENTE ${received}/${expected}`:`PENDIENTE · RESTA ${Math.max(0,expected-received)}`):'FUERA DEL REMITO';return `<button type="button" class="repo-result" onclick="selectReceiptSearchResult('${target}',${indexRow},'${mode}')"><strong>${esc(product.nombre)}</strong><span>SKU ${esc(product.codigo)} · ${label}${product.barras?` · Barras ${esc(product.barras)}`:''}</span></button>`;}).join(''):'<div class="repo-empty">Probá con otro nombre o con el SKU.</div>');
}

async function selectReceiptSearchResult(target,index,mode) {
  const product=(receiptSearchResults[target]||[])[index];if(!product)return;closeReceiptSearchResults(target);
  const item=receiptState.items.find(row=>String(row.codigo)===String(product.codigo));if(item){receiptCurrentCode=item.codigo;renderReceiptCurrent();showReceiptTab('control',{focus:false});return;}
  await receiptPromptExtra(product);
}

async function receiptPromptExtra(product,increment=1,options={}) {
  if(!requireReceiptEditable())return;
  const value=await appPrompt({title:options.fromScanner?'Escaneo fuera del remito':'Producto fuera del remito',subtitle:product.nombre,message:options.fromScanner?'El código corresponde a un producto que no figura en el remito. Se agregará por separado; la cantidad inicial es 1.':'Se registrará como mercadería extra recibida.',label:'Cantidad recibida',value:String(increment),type:'number',inputMode:'numeric',min:1,tone:'warning',icon:'+',confirmText:'Agregar como extra'});if(value===false)return false;const qty=Number.parseInt(value,10);if(!Number.isInteger(qty)||qty<=0){toast('Cantidad inválida','e');return false;}const extra=await receiptUpdateExtra(product,qty,false);if(extra&&options.fromScanner)await receiptOfferScannedQuantity(product,true,qty);return !!extra;
}

async function receiptUpdateExtra(productOrCode,value,absolute=false) {
  if(!requireReceiptEditable())return;const code=typeof productOrCode==='object'?String(productOrCode.codigo):receiptDecode(productOrCode),product=typeof productOrCode==='object'?productOrCode:padron.find(item=>String(item.codigo)===code)||receiptState.extras.find(item=>String(item.codigo)===code);
  try{const payload={reception_id:sessionId,codigo:code,nombre:product?.nombre||code,barras:product?.barras||''};if(absolute)payload.absolute=Number(value);else payload.delta=Number(value);const response=await receiptApi('/api/recepcion/extra',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo guardar');const index=receiptState.extras.findIndex(item=>String(item.codigo)===code);if(index>=0)receiptState.extras[index]=data.extra;else receiptState.extras.push(data.extra);renderReceiptAll();toast('Producto registrado como extra','s');return data.extra;}catch(error){toast(error.message,'e');return false;}
}

async function receiptRemoveExtra(encodedCode) {
  if(!requireReceiptEditable())return;const code=receiptDecode(encodedCode),item=receiptState.extras.find(row=>String(row.codigo)===code);const confirmed=await appConfirm({title:'Quitar producto extra',subtitle:item?.nombre||code,tone:'danger',icon:'×',confirmText:'Quitar',message:'Se eliminará del control de productos fuera del remito.'});if(!confirmed)return;
  try{const response=await receiptApi('/api/recepcion/extra/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reception_id:sessionId,codigo:code})}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo quitar');receiptState.extras=receiptState.extras.filter(row=>String(row.codigo)!==code);renderReceiptAll();}catch(error){toast(error.message,'e');}
}

function renderReceiptExtras() {
  const container=document.getElementById('receipt-extras-list');if(!container||!receiptState)return;const extras=receiptState.extras.filter(item=>Number(item.cantidad)>0);container.innerHTML=extras.length?extras.map(item=>`<article class="repo-row receipt-row-over"><div><h3>${esc(item.nombre)}</h3><div class="repo-row-meta">SKU ${esc(item.codigo)} · Fuera del remito${item.updated_by?` · ${esc(item.updated_by)}`:''}</div></div>${receiptCanEdit()?`<div class="repo-row-actions"><button class="btn btn-s" onclick="receiptUpdateExtra('${receiptEncode(item.codigo)}',-1)">−</button><input class="input repo-qty-input" type="number" min="0" inputmode="numeric" value="${item.cantidad}" onchange="receiptUpdateExtra('${receiptEncode(item.codigo)}',this.value,true)"><button class="btn btn-s" onclick="receiptUpdateExtra('${receiptEncode(item.codigo)}',1)">+</button><button class="btn btn-s" onclick="receiptRemoveExtra('${receiptEncode(item.codigo)}')">×</button></div>`:`<strong>${item.cantidad}</strong>`}</article>`).join(''):'<div class="repo-empty">No se registraron productos fuera del remito.</div>';
}

async function submitReceiptBarcode(){const input=document.getElementById('receipt-barcode-input'),code=input.value.trim();if(!code)return;input.value='';await handleReceiptBarcode(code,'manual');}
async function handleReceiptBarcode(code,source='camera') {
  code=String(code||'').trim();if(!code||!receiptState)return;const result=findByBarcode(code),help=document.getElementById('receipt-camera-help');
  if(!result.matches.length){receiptScanNoticeOpen=source==='camera';if(help){help.textContent=`Código no encontrado: ${code}`;help.style.color='#ff7185';}currentUnknownBarcode=code;document.getElementById('modal-title').textContent='Código no encontrado';document.getElementById('modal-subtitle').textContent=code;document.getElementById('modal-body').innerHTML='<p class="tm">No se agregó ninguna unidad. Podés buscar el producto por nombre o asignar este código para corregir el padrón.</p>';document.getElementById('modal-actions').innerHTML='<button class="btn btn-s" onclick="closeModal()">Seguir</button><button class="btn btn-p" onclick="receiptScanNoticeOpen=false;closeReceiptScanner();openBarcodeAssignment()">Asignar código a un producto</button>';document.getElementById('modal-overlay').classList.add('show');return;}
  if(result.matches.length>1){receiptScanNoticeOpen=source==='camera';window._receiptBarcodeMatches=result.matches;window._receiptBarcodeCode=code;document.getElementById('modal-title').textContent='Código compartido';document.getElementById('modal-subtitle').textContent='Elegí el producto físico.';document.getElementById('modal-body').innerHTML=`<div style="max-height:340px;overflow:auto">${result.matches.map((product,index)=>`<button class="repo-result" onclick="selectReceiptBarcodeMatch(${index})"><strong>${esc(product.nombre)}</strong><span>SKU ${esc(product.codigo)}</span></button>`).join('')}</div>`;document.getElementById('modal-actions').innerHTML='<button class="btn btn-s" onclick="closeModal()">Cancelar</button>';document.getElementById('modal-overlay').classList.add('show');return;}
  await routeReceiptScannedProduct(result.matches[0],code,source);
}
async function selectReceiptBarcodeMatch(index){const product=(window._receiptBarcodeMatches||[])[index],code=window._receiptBarcodeCode||'';closeModal();if(product)await routeReceiptScannedProduct(product,code,'camera');}
async function routeReceiptScannedProduct(product,code,source) {
  const item=receiptState.items.find(row=>String(row.codigo)===String(product.codigo)),help=document.getElementById('receipt-camera-help');
  const fromCamera=source==='camera';if(fromCamera)receiptScanNoticeOpen=true;
  try{
    if(item){receiptCurrentCode=item.codigo;const added=await receiptChangeQty(receiptEncode(item.codigo),1,fromCamera?'scanner':source);if(help){help.textContent=added?`Recibido: ${item.nombre} · +1`:'Lectura cancelada';help.style.color=added?'#63e6be':'#ffd166';}if(added&&fromCamera)await receiptOfferScannedQuantity(item,false,1);return;}
    if(help){help.textContent=`Fuera del remito: ${product.nombre}`;help.style.color='#ffd166';}await receiptPromptExtra(product,1,{fromScanner:fromCamera});
  } finally {if(fromCamera){receiptScanNoticeOpen=false;receiptLastScanTime=Date.now();}}
}

async function receiptOfferScannedQuantity(product,isExtra,addedQuantity=1) {
  const code=String(product.codigo),current=isExtra?receiptState.extras.find(row=>String(row.codigo)===code):receiptState.items.find(row=>String(row.codigo)===code),total=Number(isExtra?current?.cantidad:current?.recibido)||0,expected=isExtra?null:Number(current?.esperado)||0;
  const edit=await appConfirm({title:`${addedQuantity} ${addedQuantity===1?'unidad agregada':'unidades agregadas'}`,subtitle:product.nombre,icon:'✓',confirmText:'Modificar cantidad',cancelText:'Seguir escaneando',message:`Se agregó ${addedQuantity===1?'1 unidad':`${addedQuantity} unidades`} ${isExtra?'al remito separado de extras':'al control del remito'}. Total actual: ${total}${expected!==null?` de ${expected}`:''}.`});
  if(!edit)return;
  if(isExtra){const value=await appPrompt({title:'Modificar cantidad extra',subtitle:product.nombre,message:'Indicá la cantidad total que llegó fuera del remito.',label:'Cantidad total',value:String(total),type:'number',inputMode:'numeric',min:0,icon:'#',confirmText:'Guardar'});if(value!==false)await receiptUpdateExtra(receiptEncode(code),value,true);}
  else await receiptEditQty(receiptEncode(code));
}
async function openReceiptScanner(mode='expected') {
  if(!requireReceiptEditable())return;receiptScannerMode=mode;const modal=document.getElementById('receipt-camera-modal'),help=document.getElementById('receipt-camera-help');document.getElementById('receipt-camera-title').textContent=mode==='extra'?'Escanear producto extra':'Escanear producto recibido';help.textContent='Cada lectura válida suma una unidad.';help.style.color='#d7e6ed';modal.classList.add('show');
  try{await loadHtml5QrcodeForRepo();receiptScanner=new Html5Qrcode('receipt-camera-reader');const width=Math.min(window.innerWidth-40,480);await receiptScanner.start({facingMode:'environment'},{fps:15,qrbox:{width:Math.max(220,Math.round(width*.82)),height:150},aspectRatio:1.333},decoded=>{if(receiptScanNoticeOpen)return;const now=Date.now();if(decoded===receiptLastScanCode&&now-receiptLastScanTime<1200)return;receiptLastScanCode=decoded;receiptLastScanTime=now;tactileFeedback(35);handleReceiptBarcode(decoded,'camera');},()=>{});}catch(error){help.textContent='No se pudo abrir la cámara. Podés escribir el código manualmente.';help.style.color='#ff7185';toast('No se pudo iniciar la cámara','e');}
}
async function closeReceiptScanner(){document.getElementById('receipt-camera-modal')?.classList.remove('show');if(receiptScanner){try{await receiptScanner.stop();}catch(_){}try{await receiptScanner.clear();}catch(_){}receiptScanner=null;}const reader=document.getElementById('receipt-camera-reader');if(reader)reader.innerHTML='';}

function renderReceiptSummary() {
  if(!receiptState)return;const summary=SucaneitorReception.summary(receiptState),status=document.getElementById('receipt-summary-status'),detail=document.getElementById('receipt-summary-detail'),participants=document.getElementById('receipt-participants');
  if(status)status.textContent=receiptState.estado==='cerrado'?(summary.tiene_diferencias?'Cerrado con diferencias':'Cerrado conforme'):(summary.productos_pendientes?'Control en curso':'Listo para cerrar');
  if(detail)detail.innerHTML=`Remito <strong>${esc(receiptState.document_number)}</strong> · ${esc(receiptState.date)}<br>${summary.exactos} productos exactos · ${summary.unidades_faltantes} unidades faltantes · ${summary.unidades_sobrantes} sobrantes · ${summary.extras_unidades} extras.`;
  if(participants)participants.innerHTML=(receiptState.participantes||[]).map(person=>`<span class="user-pill">👤 ${esc(person.nombre)}</span>`).join('');
  const close=document.getElementById('receipt-close-card');if(close)close.style.display=receiptState.estado==='en_control'&&receiptCanEdit()?'':'none';renderReceiptOrders();
}

function renderReceiptOrders() {
  const container=document.getElementById('receipt-orders-list');if(!container||!receiptState)return;const orders=receiptState.orders||[];
  container.innerHTML=orders.length?orders.map(order=>{const products=(order.pedido_productos||[]).map(item=>`${item.nombre} · ${Number(item.cantidad_recibida||0)}/${Number(item.cantidad_preparada||item.cantidad_aceptada||item.cantidad||0)}`).join('<br>');const pending=!!order.cliente_aviso_pendiente;return `<article class="receipt-order ${pending?'alert':''}"><strong>${pending?'📞 Avisar a ':''}${esc(order.cliente||'Pedido sin cliente')}</strong><span>${esc(order.telefono||'Sin teléfono')} · Estado: ${esc(order.estado)} · Coincidencia: ${esc(order.coincidencia)}<br>${products}</span>${pending?`<div class="repo-inline mt2">${order.telefono?`<button class="btn btn-g" onclick="receiptOpenWhatsapp('${escA(order.telefono)}','${escA(order.cliente||'')}')">WhatsApp</button>`:''}<button class="btn btn-p" onclick="receiptMarkCustomerNotified('${order.id}')">Marcar cliente avisado</button></div>`:''}</article>`;}).join(''):'<div class="repo-empty">Este remito no tiene pedidos de clientes vinculados.</div>';
}

function receiptOpenWhatsapp(phone,name){const digits=String(phone||'').replace(/\D/g,'');if(!digits){toast('El pedido no tiene teléfono','w');return;}const number=digits.startsWith('598')?digits:`598${digits.replace(/^0/,'')}`,text=encodeURIComponent(`Hola ${name||''}! Te avisamos que tu pedido ya llegó a nuestro local.`);window.open(`https://wa.me/${number}?text=${text}`,'_blank');}
async function receiptMarkCustomerNotified(orderId){const confirmed=await appConfirm({title:'Marcar cliente avisado',message:'Confirmá solamente después de haber contactado al cliente.',icon:'✓',confirmText:'Sí, ya fue avisado'});if(!confirmed)return;try{await window.SucanCloud.markCustomerNotified(orderId);const order=receiptState.orders.find(row=>row.id===orderId);if(order){order.cliente_aviso_pendiente=false;order.cliente_avisado_at=new Date().toISOString();}renderReceiptOrders();toast('Cliente marcado como avisado','s');}catch(error){toast(error.message||'No se pudo actualizar','e');}}

async function closeReceptionFlow() {
  if(!requireReceiptEditable())return;const summary=SucaneitorReception.summary(receiptState),message=summary.productos_pendientes?`Quedan ${summary.productos_pendientes} productos pendientes o parciales. El cierre los conservará como diferencias y no impedirá continuar.`:summary.tiene_diferencias?'El control está recorrido, pero existen faltantes, sobrantes o extras. Se guardarán en el informe final.':'Todas las cantidades coinciden con el remito.';
  const observations=await appPrompt({title:'Cerrar recepción',subtitle:`Remito ${receiptState.document_number}`,message,label:'Observaciones finales (opcional)',placeholder:'Podés dejar este campo vacío',multiline:true,maxLength:500,tone:summary.tiene_diferencias||summary.productos_pendientes?'warning':'default',icon:'✓',confirmText:'Cerrar igualmente'});if(observations===false)return;
  showOperationsLoading('Cerrando recepción y actualizando pedidos…');try{const response=await receiptApi('/api/recepcion/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reception_id:sessionId,observations})}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo cerrar');receiptState=data.receipt;renderReceiptAll();showReceiptTab('resumen');const result=data.result||{};toast(`Recepción cerrada · ${result.pedidos_completos||0} pedidos completados`,'s');}catch(error){toast(error.message||'No se pudo cerrar la recepción','e');}finally{finishOperationsBoot();}
}

function renderReceiptConfig() {const node=document.getElementById('receipt-config-session');if(!node||!receiptState)return;node.innerHTML=`<strong>${esc(receiptState.nombre)}</strong><div class="tm mt2">Remito ${esc(receiptState.document_number)} · ${esc(receiptState.date)}<br>${esc(receiptState.origin)} → ${esc(receiptState.destination)} · ${receiptState.estado==='cerrado'?'Cerrado':'En control'}</div>`;}
async function downloadReceptionOriginal(){try{const response=await fetch(`/api/recepcion/original?rid=${encodeURIComponent(sessionId)}`),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No disponible');location.href=data.url;}catch(error){toast(error.message||'No se pudo descargar','e');}}

async function downloadReceptionReport() {
  if(!receiptState)return;try{const XLSX=await waitForXlsx(),book=XLSX.utils.book_new(),summary=SucaneitorReception.summary(receiptState),add=(name,rows)=>XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
    add('Resumen',[['CONTROL DE REMITO'],['Remito',receiptState.document_number],['Fecha',receiptState.date],['Origen',receiptState.origin],['Destino',receiptState.destination],['Estado',receiptState.estado],[],['Productos',summary.productos],['Unidades esperadas',summary.unidades_esperadas],['Unidades recibidas',summary.unidades_recibidas],['Unidades faltantes',summary.unidades_faltantes],['Unidades sobrantes',summary.unidades_sobrantes],['Unidades extra',summary.extras_unidades],['Observaciones',receiptState.observaciones_cierre||'']]);
    add('Control',[['SKU','Producto','Esperado','Recibido','Diferencia','Estado','Observación','Actualizado por'],...receiptState.items.map(item=>[item.codigo,item.nombre,item.esperado,item.recibido,item.recibido-item.esperado,receiptStatusLabel(receiptStatus(item)),item.observacion||'',item.updated_by||''])]);
    add('Diferencias',[['SKU','Producto','Esperado','Recibido','Diferencia','Estado','Observación'],...SucaneitorReception.differenceRows(receiptState).map(item=>[item.codigo,item.nombre,item.esperado,item.recibido,item.diferencia,receiptStatusLabel(item.estado),item.observacion])]);
    add('Extras',[['SKU','Producto','Cantidad','Observación','Actualizado por'],...(receiptState.extras||[]).filter(item=>item.cantidad>0).map(item=>[item.codigo,item.nombre,item.cantidad,item.observacion||'',item.updated_by||''])]);
    add('Pedidos clientes',[['Pedido','Cliente','Teléfono','Estado','Aviso pendiente','SKU','Producto','Enviado','Recibido'],...(receiptState.orders||[]).flatMap(order=>(order.pedido_productos||[]).map(item=>[order.id,order.cliente||'',order.telefono||'',order.estado,order.cliente_aviso_pendiente?'Sí':'No',item.codigo,item.nombre,item.cantidad_preparada||item.cantidad_aceptada||item.cantidad||0,item.cantidad_recibida||0]))]);
    add('Auditoría',[['Fecha','Usuario','Acción','SKU','Detalle'],...(receiptState.log||[]).map(row=>[row.ts,row.usuario||'',row.accion,row.codigo||'',JSON.stringify(row.detalle||{})])]);
    XLSX.writeFile(book,`Control_Remito_${String(receiptState.document_number).replace(/[^A-Za-z0-9_-]/g,'_')}.xlsx`);toast('Informe descargado','s');
  }catch(error){toast(error.message||'No se pudo generar el informe','e');}
}

function receiptTransferRows(type) {
  return receiptState?SucaneitorReception.transferRows(receiptState,type):[];
}

async function downloadReceiptTransfer(type) {
  if(!receiptState)return;const rows=receiptTransferRows(type);
  if(!rows.length){toast(type==='extras'?'No hay productos extra para exportar':'Todavía no hay mercadería recibida para exportar','w');return;}
  try{
    toast('Generando remito para el sistema…','i');
    const buffer=await repoBuildTransfer(rows),route=`${repoSafeName(receiptState.origin)}_${repoSafeName(receiptState.destination)}`,number=repoSafeName(receiptState.document_number),name=type==='extras'?`Remito_Extras_Recibidos_${route}_${number}.xls`:`Remito_Recibido_${route}_${number}.xls`;
    repoDownloadBuffer(buffer,name,'application/vnd.ms-excel');
    toast(`${name} descargado`,'s');
  }catch(error){toast(error.message||'No se pudo generar el remito','e');}
}
