// ═══════════════════════════════════════════
//  SUPABASE CONFIG
// ═══════════════════════════════════════════
const SUPABASE_URL = 'https://akqqpodyijzjdoibkint.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ClVgs8WdyAu0McGi0eAaEQ_MovUmDCC';
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
let currentUser   = null;   // auth user
let currentPerfil = null;   // perfil row
let localesCache  = [];
let transportesCache = [];
let selectedProductTemp = null;
let newOrderProducts    = [];
let fotoBase64 = null;
let despachoTab = 'pendientes';
let currentChatOrderId = null;
let currentSugId = null;
let productsCache = [];
let agendaCache = [];
let clienteDesdePedido = false;

var IDLE_TIMEOUT_MS = window.IDLE_TIMEOUT_MS || (60 * 60 * 1000); // 1 hora
var IDLE_WARNING_MS = window.IDLE_WARNING_MS || (5 * 60 * 1000); // aviso 5 min antes
var IDLE_CHECK_INTERVAL_MS = window.IDLE_CHECK_INTERVAL_MS || (30 * 1000);
let idleIntervalId = null;
let idleWarned = false;
let activityListenersBound = false;
let lastActivityWriteMs = 0;
let realtimeChannels = [];

function normalizeExtraProduct(row){
return {
id: row?.id || null,
codigo: row?.codigo ?? row?.cod ?? row?.sku ?? '',
nombre: row?.nombre ?? row?.producto ?? row?.descripcion ?? '',
marca: row?.marca ?? row?.categoria ?? row?.unidad ?? row?.descripcion ?? ''
};
}

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════
function el(id){ return document.getElementById(id); }
// ═══════════════════════════════════════════
//  SPINNER
// ═══════════════════════════════════════════
function showSpinner(){
let s=el('global-spinner');
if(!s){
s=document.createElement('div');
s.id='global-spinner';
s.innerHTML='<div class="spinner-box"><div class="spinner-icon">📦</div><div class="spinner-ring"></div><div class="spinner-txt">Cargando...</div></div>';
document.body.appendChild(s);
}
s.style.display='flex';
}
function hideSpinner(){ const s=el('global-spinner'); if(s) s.style.display='none'; }
async function withSpinner(fn){ showSpinner(); try{ await fn(); }finally{ hideSpinner(); } }

function safeSet(id, val){ const e=el(id); if(e) e.textContent=val; }
function escHtml(v){
return String(v??'').replace(/[&<>"']/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
}
function escJsStr(v){
return String(v??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r?\n/g,' ');
}

function notify(msg, type='info'){
const icons={success:'✅',error:'❌',info:'ℹ️'};
const e=document.createElement('div');
e.className='notification '+type;
const icon=document.createElement('span');
icon.textContent=icons[type]||icons.info;
const txt=document.createElement('span');
txt.textContent=String(msg||'');
e.appendChild(icon);
e.appendChild(txt);
document.body.appendChild(e);
setTimeout(()=>e.remove(), 4000);
}

function showPage(id){
['auth-page','pending-page','app-page'].forEach(pid=>{
const e=el(pid); if(e){e.style.display='none';e.classList.remove('active');}
});
const t=el(id); if(!t) return;
t.style.display='flex'; t.classList.add('active');
}

function fmtDate(iso){
if(!iso) return '–';
return new Date(iso).toLocaleDateString('es-UY',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function fmtDateTime(iso){
if(!iso) return '–';
return new Date(iso).toLocaleString('es-UY',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}


function getActivityStorageKey(userId){
return 'last_activity_' + String(userId || 'anon');
}

function getLastActivityMs(userId){
const raw = localStorage.getItem(getActivityStorageKey(userId));
const n = parseInt(raw || '0', 10);
return Number.isFinite(n) ? n : 0;
}

function setLastActivityMs(userId, ms){
if(!userId) return;
localStorage.setItem(getActivityStorageKey(userId), String(ms || Date.now()));
}

function clearLastActivityMs(userId){
if(!userId) return;
localStorage.removeItem(getActivityStorageKey(userId));
}

function recordActivity(force=false){
if(!currentUser?.id) return;
if(isExpiredByInactivity(currentUser.id)){
forceIdleLogout();
return;
}
const now = Date.now();
if(!force && now - lastActivityWriteMs < 15000) return;
lastActivityWriteMs = now;
setLastActivityMs(currentUser.id, now);
idleWarned = false;
}

function stopIdleWatcher(){
if(idleIntervalId){ clearInterval(idleIntervalId); idleIntervalId = null; }
idleWarned = false;
}

async function forceIdleLogout(){
stopIdleWatcher();
teardownRealtime();
try{ await db.auth.signOut(); }catch(_e){}
clearLastActivityMs(currentUser?.id);
currentUser=null;
currentPerfil=null;
clearAuthMessages();
showPage('auth-page');
checkEmpresaClave();
notify('Sesión cerrada por inactividad (más de 1 hora).','info');
}

function bindActivityListeners(){
if(activityListenersBound) return;
activityListenersBound = true;
['click','keydown','touchstart','scroll','mousemove'].forEach(evt=>{
window.addEventListener(evt, ()=>recordActivity(false), {passive:true});
});
document.addEventListener('visibilitychange', ()=>{
if(document.visibilityState!=='visible') return;
if(currentUser?.id && isExpiredByInactivity(currentUser.id)){
forceIdleLogout();
return;
}
recordActivity(true);
});
}

function startIdleWatcher(){
if(!currentUser?.id) return;
bindActivityListeners();
recordActivity(true);
if(idleIntervalId) clearInterval(idleIntervalId);
idleIntervalId = setInterval(async ()=>{
if(!currentUser?.id) return;
const last = getLastActivityMs(currentUser.id);
if(!last) return;
const now = Date.now();
const idleMs = now - last;
const remainingMs = IDLE_TIMEOUT_MS - idleMs;
if(remainingMs <= 0){
await forceIdleLogout();
return;
}
if(remainingMs <= IDLE_WARNING_MS && !idleWarned){
idleWarned = true;
const mins = Math.max(1, Math.ceil(remainingMs / 60000));
notify('⚠️ Tu sesión se cerrará en '+mins+' min por inactividad.','info');
}
}, IDLE_CHECK_INTERVAL_MS);
}

function isExpiredByInactivity(userId){
const last = getLastActivityMs(userId);
if(!last) return false;
return (Date.now() - last) > IDLE_TIMEOUT_MS;
}

// ═══════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════
function switchAuthTab(tab){
clearAuthMessages();
document.querySelectorAll('.auth-tab').forEach((t,i)=>
t.classList.toggle('active',(tab==='login'&&i===0)||(tab==='register'&&i===1)));
el('login-form').style.display    = tab==='login'    ?'block':'none';
el('register-form').style.display = tab==='register' ?'block':'none';
}

function onTipoCuentaChange(){
const tipo=el('reg-tipo-cuenta')?.value||'local';
const grp=el('reg-local')?.closest('.form-group');
if(!grp) return;
if(tipo==='personal'){
grp.style.opacity='0.7';
} else {
grp.style.opacity='1';
}
}

function clearMessage(id){
const e=el(id);
if(!e) return;
e.textContent='';
e.classList.remove('show');
}

function clearAuthMessages(){
['login-error','reg-error','reg-success'].forEach(clearMessage);
}

function showErr(id,msg){ const e=el(id); e.textContent=msg; e.classList.add('show'); setTimeout(()=>e.classList.remove('show'),6000); }
function showSuc(id,msg){ const e=el(id); e.textContent=msg; e.classList.add('show'); }

async function populateRegisterLocales(){
const {data}=await db.from('locales').select('*').order('nombre');
localesCache = data||[];
const sel=el('reg-local');
sel.innerHTML='<option value="">Seleccionar local...</option>'+
localesCache.map(l=>'<option value="'+l.nombre+'|'+l.almacen+'">'+l.nombre+' ('+l.almacen+')</option>').join('');
}

async function doLogin(){
clearAuthMessages();
const email=el('login-email').value.trim();
const pass =el('login-password').value;
if(!email||!pass) return showErr('login-error','Completá email y contraseña.');
showSpinner();
const {data,error}=await db.auth.signInWithPassword({email,password:pass});
hideSpinner();
if(error) return showErr('login-error', error.message==='Invalid login credentials'?'Email o contraseña incorrectos.':error.message);
await afterLogin(data.user);
}

let regData={}, verifyCode='';

async function doRegisterStep1(){
const nombre   = el('reg-nombre').value.trim();
const apellido = el('reg-apellido').value.trim();
const localVal = el('reg-local').value;
const tipoCuenta = el('reg-tipo-cuenta')?.value || 'local';
const email    = el('reg-email').value.trim();
const pass     = el('reg-pass').value;
const pass2    = el('reg-pass2').value;
if(!nombre||!apellido||!email||!pass) return showErr('reg-error','Completá todos los campos.');
if(tipoCuenta==='local' && !localVal) return showErr('reg-error','Seleccioná un local para cuentas tipo local.');
if(pass!==pass2)   return showErr('reg-error','Las contraseñas no coinciden.');
if(pass.length<6)  return showErr('reg-error','Mínimo 6 caracteres.');
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('reg-error','Email inválido.');
let localNombre='General', almacen='SUP';
if(localVal){
  const parts=localVal.split('|');
  localNombre=parts[0]||'General';
  almacen=parts[1]||'SUP';
}
regData={nombre,apellido,localNombre,almacen,email,pass,tipoCuenta};
// Sign up with Supabase — sends verification email automatically
const {error}=await db.auth.signUp({email,password:pass,options:{emailRedirectTo:window.location.href}});
if(error) return showErr('reg-error',error.message);
el('reg-email-display').textContent=email;
el('reg-step1').style.display='none';
el('reg-step2').style.display='block';
showSuc('reg-success','¡Código enviado a '+email+'! Revisá tu bandeja de entrada.');
}

function backToStep1(){
el('reg-step1').style.display='block';
el('reg-step2').style.display='none';
}

async function doRegisterStep2(){
const token=el('reg-code').value.trim();
if(!token||token.length<6) return showErr('reg-error','Ingresá el código de 6 dígitos.');
showSpinner();
try{
// Verify OTP
const {data,error}=await db.auth.verifyOtp({email:regData.email,token,type:'signup'});
if(error) return showErr('reg-error','Código incorrecto o expirado. '+error.message);
// Seguridad: evitar auto-admin por conteos afectados por RLS.
const isFirst=false;
// Create perfil
const {error:pe}=await db.from('perfiles').insert({
id:data.user.id, nombre:regData.nombre, apellido:regData.apellido,
local_nombre:regData.localNombre, almacen:regData.almacen,
role:regData.tipoCuenta==='personal'?'admin':'empleado', approved:false
});
if(pe) return showErr('reg-error','Error al crear perfil: '+pe.message);
el('reg-step2').style.display='none';
el('reg-step1').style.display='block';
el('reg-code').value='';
showRegisterSuccess(isFirst
?'¡Cuenta creada! Sos el primer administrador. Ya podés iniciar sesión.'
:'¡Cuenta creada con éxito! Un administrador debe aprobarla antes de que puedas ingresar.');
} finally {
hideSpinner();
}
}

function showRegisterSuccess(msg){
el('register-success-msg').textContent=msg;
el('register-success-overlay').style.display='flex';
}
function closeRegisterSuccess(){
el('register-success-overlay').style.display='none';
switchAuthTab('login');
}

async function doLogout(){
await db.auth.signOut();
stopIdleWatcher();
teardownRealtime();
clearLastActivityMs(currentUser?.id);
currentUser=null; currentPerfil=null;
sessionStorage.removeItem('empresa_validada');
sessionStorage.removeItem('empresa_nombre');
// Reset UI completamente para evitar que persistan opciones de admin
const adminNav = el('admin-nav');
if(adminNav) adminNav.style.display='none';
document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
clearAuthMessages();
showPage('auth-page');
checkEmpresaClave();
}

async function afterLogin(user){
currentUser=user;
try{
const {data:perfil,error}=await db.from('perfiles').select('*').eq('id',user.id).single();
if(error) throw error;
if(!perfil){ showErr('login-error','No se encontró tu perfil. Contactá al administrador.'); return; }
currentPerfil=perfil;
if(!perfil.approved){ showPage('pending-page'); return; }
setLastActivityMs(user.id, Date.now());
await loadApp();
startIdleWatcher();
}catch(err){
console.error('Error durante login:', err);
await db.auth.signOut();
currentUser=null;
currentPerfil=null;
showErr('login-error','No se pudo iniciar sesión. Reintentá en unos segundos.');
showPage('auth-page');
}
}

async function checkSession(){
const {data:{session}}=await db.auth.getSession();
if(!session){
currentUser=null;
currentPerfil=null;
clearAuthMessages();
showPage('auth-page');
return;
}
if(isExpiredByInactivity(session.user.id)){
await forceIdleLogout();
return;
}
if(!getLastActivityMs(session.user.id)) setLastActivityMs(session.user.id, Date.now());
// Hay sesión — ir directo a la app sin pasar por auth
await afterLogin(session.user);
}

// ═══════════════════════════════════════════
//  APP LOAD
// ═══════════════════════════════════════════
async function loadApp(){
showSpinner();
try{
showPage('app-page');
// Siempre resetear nav antes de aplicar rol
el('admin-nav').style.display='none';
const isAdmin = currentPerfil.role==='admin';
safeSet('sidebar-name', currentPerfil.nombre_display||(currentPerfil.nombre+' '+currentPerfil.apellido));
safeSet('sidebar-role', roleLabel(currentPerfil.role));
// Avatar: foto o iniciales
const avatarEl = el('sidebar-avatar');
if(currentPerfil.foto_url){
avatarEl.style.backgroundImage='url('+currentPerfil.foto_url+')';
avatarEl.style.backgroundSize='cover';
avatarEl.style.backgroundPosition='center';
avatarEl.textContent='';
} else {
avatarEl.style.backgroundImage='';
avatarEl.textContent = currentPerfil.nombre[0]+currentPerfil.apellido[0];
}
safeSet('sidebar-local-badge', currentPerfil.local_nombre+' ('+currentPerfil.almacen+')');
if(isAdmin) el('admin-nav').style.display='block';
// Load caches
const [{data:locs},{data:trans}]=await Promise.all([
db.from('locales').select('*').order('nombre'),
db.from('transportes').select('*').order('nombre'),
]);
localesCache     = locs||[];
transportesCache = trans||[];
navigateTo('misPedidos');
setupRealtime();
} finally {
hideSpinner();
}
}

function setupRealtime(){
teardownRealtime();
// Listen for new notifications for current user
const notifsChannel = db.channel('notifs-'+currentPerfil.id)
.on('postgres_changes',{event:'INSERT',schema:'public',table:'notificaciones',filter:'usuario_id=eq.'+currentPerfil.id},
payload=>{
updateNotifBadge();
const n=payload.new;
notify('🔔 '+n.titulo,'info');
})
.subscribe();
// Listen for pedido changes in my locals
const pedidosChannel = db.channel('pedidos-changes-'+currentPerfil.id)
.on('postgres_changes',{event:'UPDATE',schema:'public',table:'pedidos'},
()=>{ refreshView(); updateBadges(); })
.on('postgres_changes',{event:'INSERT',schema:'public',table:'pedidos'},
()=>{ refreshView(); updateBadges(); })
.subscribe();
realtimeChannels=[notifsChannel,pedidosChannel];
}

function teardownRealtime(){
if(!realtimeChannels.length) return;
realtimeChannels.forEach(ch=>{ try{ db.removeChannel(ch); }catch(_e){} });
realtimeChannels=[];
}

async function updateBadges(){
if(!currentPerfil) return;
const local   = currentPerfil.local_nombre;
const isAdmin = currentPerfil.role==='admin';
const countOrZero = async (q)=>{
const {count,error}=await q;
if(error){ console.error('Badge query error:', error.message); return 0; }
return count||0;
};

// Badges siempre filtran por local propio (empleados Y supervisores)
const qMis  = db.from('pedidos').select('id',{count:'exact',head:true}).not('estado','in','("completo","incompleto","denegado")').eq('destino_local',local);
// Para enviar: incluir pedidos de escala donde este local es la escala
const escalasDe = Object.entries(ESCALAS).filter(([d,e])=>e.escala===local).map(([d])=>d);
let qPara = db.from('pedidos').select('id',{count:'exact',head:true}).in('estado',['pendiente','aceptado','listo','transito_escala','en_escala','listo_escala']);
if(escalasDe.length>0){
// Soy local de escala O soy origen
qPara = qPara.or('origen_local.eq.'+local+',destino_local.in.('+escalasDe.map(d=>'"'+d+'"').join(',')+')');
} else {
qPara = qPara.eq('origen_local',local);
}

const [mp,pe,no]=await Promise.all([
countOrZero(qMis),
countOrZero(qPara),
countOrZero(db.from('notificaciones').select('id',{count:'exact',head:true}).eq('usuario_id',currentPerfil.id).eq('leida',false)),
]);

el('badge-misPedidos').textContent=mp; el('badge-misPedidos').style.display=mp>0?'flex':'none';
el('badge-paraEnviar').textContent=pe; el('badge-paraEnviar').style.display=pe>0?'flex':'none';
updateNotifBadgeCount(no);

if(currentPerfil.role==='admin'){
const [pu,su]=await Promise.all([
countOrZero(db.from('perfiles').select('id',{count:'exact',head:true}).eq('approved',false)),
countOrZero(db.from('sugerencias').select('id',{count:'exact',head:true}).eq('leida',false)),
]);
el('badge-usuarios').textContent=pu; el('badge-usuarios').style.display=pu>0?'flex':'none';
el('badge-sugerencias').textContent=su; el('badge-sugerencias').style.display=su>0?'flex':'none';
}

// Dashboard stats
let listosCount=0, completadosCount=0;
if(isAdmin){
[listosCount,completadosCount]=await Promise.all([
countOrZero(db.from('pedidos').select('id',{count:'exact',head:true}).eq('origen_local',local).eq('estado','listo')),
countOrZero(db.from('pedidos').select('id',{count:'exact',head:true}).or('origen_local.eq.'+local+',destino_local.eq.'+local).in('estado',['completo','incompleto'])),
]);
}
safeSet('stat-pendientes', pe);
safeSet('stat-activos', mp);
safeSet('stat-listos', listosCount);
safeSet('stat-completados', completadosCount);

// Mis consultas badge
const mr=await countOrZero(db.from('sugerencias').select('id',{count:'exact',head:true}).eq('usuario_id',currentPerfil.id).eq('respuesta_leida',false).not('respuesta','is',null));
el('badge-misConsultas').textContent=mr; el('badge-misConsultas').style.display=mr>0?'flex':'none';
}

// ═══════════════════════════════════════════
//  CONFIRM MODAL — reemplaza confirm() nativo
// ═══════════════════════════════════════════
function showConfirm(msg, onConfirm, opts={}){
const title   = opts.title   || '¿Confirmar?';
const btnLabel= opts.btnLabel|| 'Confirmar';
const btnClass= opts.btnClass|| 'btn-danger';
el('modal-accion-title').textContent = title;
el('modal-accion-body').innerHTML =
'<div style="font-size:14px;color:var(--text2);line-height:1.6;padding:4px 0">'+msg+'</div>';
el('modal-accion-footer').innerHTML =
'<button class="btn btn-ghost btn-sm" onclick="closeModal(\'modal-accion\')">Cancelar</button>'+
'<button class="btn '+btnClass+' btn-sm" id="confirm-ok-btn">'+btnLabel+'</button>';
openModal('modal-accion');
setTimeout(()=>{
const btn = el('confirm-ok-btn');
if(btn) btn.onclick = ()=>{ closeModal('modal-accion'); onConfirm(); };
}, 50);
}

// ═══════════════════════════════════════════
//  LÓGICA DE ESCALA
// ═══════════════════════════════════════════
const ESCALAS = {
'Maldonado': { escala: 'Punta del Este', almacen: 'PDE' }
// Agregar más locales con escala acá si es necesario
};

function tieneEscala(destino_local) {
return !!ESCALAS[destino_local];
}

function getEscala(destino_local) {
return ESCALAS[destino_local] || null;
}

// Estados que pertenecen a la fase de escala
const ESTADOS_ESCALA = ['transito_escala','en_escala','listo_escala'];
// Estados que pertenecen a la fase final (destino real)
const ESTADOS_FINAL  = ['transito','llegado','completo','incompleto'];

// ═══════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════
function navigateTo(view){
document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
document.querySelectorAll('[id^="view-"]').forEach(v=>v.style.display='none');
const ve=el('view-'+view); if(ve) ve.style.display='block';
const ni=el('nav-'+view); if(ni) ni.classList.add('active');
const titles={
dashboard:'Dashboard',misPedidos:'Pedidos de mi local',paraEnviar:'Pedidos a despachar',
historial:'Historial',misConsultas:'Mis Consultas',chats:'Chats',agenda:'Agenda',
perfil:'Mi Perfil',usuarios:'Usuarios',sugerencias:'Sugerencias',config:'Configuración'
};
safeSet('mobile-title', titles[view]||view);
el('fab-btn').style.display=['misPedidos','paraEnviar','historial','dashboard'].includes(view)?'flex':'none';
updateBadges();

const _rm={dashboard:renderDashboard,misPedidos:renderMisPedidos,paraEnviar:renderParaEnviar,
historial:renderHistorial,misConsultas:renderMisConsultas,chats:renderChats,agenda:renderAgendaClientes,
perfil:renderPerfil,usuarios:renderUsuarios,sugerencias:renderSugerencias,config:renderConfig};
if(_rm[view]) withSpinner(()=>_rm[view]());
closeSidebar();
}

// ═══════════════════════════════════════════
//  PEDIDOS — helpers
// ═══════════════════════════════════════════
function estadoInfo(estado){
const m={
pendiente:        ['⏳','Pendiente','badge-pending'],
aceptado:         ['✅','Aceptado','badge-accepted'],
denegado:         ['❌','Denegado','badge-denied'],
listo:            ['📦','Listo para enviar','badge-ready'],
transito_escala:  ['🚚','En viaje a escala','badge-transit'],
en_escala:        ['📍','En depósito escala','badge-arrived'],
listo_escala:     ['📦','Listo para enviar a destino','badge-ready'],
transito:         ['🚚','En viaje al destino','badge-transit'],
llegado:          ['📍','Llegó a sucursal','badge-arrived'],
completo:         ['✅','Completo','badge-complete'],
incompleto:       ['⚠️','Incompleto','badge-incomplete'],
};
return m[estado]||['❓',estado,'badge-pending'];
}

function roleLabel(role){
return (role==='admin' || role==='supervisor_general') ? 'Supervisor' : 'Local';
}

async function fetchPedidos(filters={}){
let q=db.from('pedidos').select('*, pedido_productos(*)').order('created_at',{ascending:false});
if(filters.destinoLocal) q=q.eq('destino_local',filters.destinoLocal);
if(filters.origenLocal)  q=q.eq('origen_local',filters.origenLocal);
if(filters.estado)       q=q.eq('estado',filters.estado);
if(filters.notEstados)   q=q.not('estado','in','('+filters.notEstados.map(s=>'"'+s+'"').join(',')+')');
if(filters.inEstados)    q=q.in('estado',filters.inEstados);
const {data,error}=await q;
if(error){ console.error(error); return []; }
return data||[];
}

function orderCard(o){
const [icon,label,cls]=estadoInfo(o.estado);
const prods=o.pedido_productos||[];
const pn=prods.slice(0,2).map(p=>escHtml((p.nombre||'').substring(0,28))).join(', ')+(prods.length>2?' +'+(prods.length-2)+' más':'');
const fecha=fmtDate(o.created_at);
const urgente=o.urgente?' <span class="priority-badge">🔴 URGENTE</span>':'';
const viejo=o._viejo?' <span class="priority-badge" style="color:#f7971e">⏰ +24hs</span>':'';
const isMio=o.destino_local===currentPerfil.local_nombre;
const isAdmin=currentPerfil.role==='admin';
const rol=isMio
?'<span style="font-size:10px;font-weight:700;color:var(--text3)">YO PEDÍ</span>'
:'<span style="font-size:10px;font-weight:700;color:var(--accent4)">ME PIDIERON</span>';
return '<div class="order-card" onclick="openDetalle(\''+o.id+'\')">'+
'<div class="order-top"><div>'+
'<div class="order-id">'+rol+'  #'+o.id.slice(-8,-2).toUpperCase()+urgente+viejo+'</div>'+
'<div class="order-title">'+escHtml(o.cliente||'Sin cliente')+(o.telefono?' · 📞 '+escHtml(o.telefono):'')+'</div>'+
(tieneEscala(o.destino_local)?'<div class="order-route">📤 '+escHtml(o.origen_local)+' → 🔄 '+escHtml(getEscala(o.destino_local).escala)+' → 📥 '+escHtml(o.destino_local)+(o.transporte?' · 🚛 '+escHtml(o.transporte):'')+'</div>':'<div class="order-route">📤 '+escHtml(o.origen_local)+' ('+escHtml(o.origen_almacen)+') → 📥 '+escHtml(o.destino_local)+' ('+escHtml(o.destino_almacen)+')'+(o.transporte?' · 🚛 '+escHtml(o.transporte):'')+'</div>')+
'</div><span class="badge '+cls+'">'+icon+' '+label+'</span></div>'+
'<div class="order-meta"><span class="order-date">📅 '+fecha+'</span><span class="order-products">🏷️ '+pn+'</span></div>'+
'</div>';
}

async function renderList(elId, pedidos, emptyIcon, emptyMsg){
const e=el(elId);
if(!pedidos.length){
e.innerHTML='<div class="empty-state"><div class="icon">'+emptyIcon+'</div><p>'+emptyMsg+'</p></div>';
return;
}
// Sort: pending old ones first with warning
e.innerHTML=pedidos.map(o=>orderCard(o)).join('');
}

// ═══════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════
async function renderDashboard(){
safeSet('dash-subtitle','Resumen de '+currentPerfil.local_nombre+' ('+currentPerfil.almacen+')');
await updateBadges();
const local=currentPerfil.local_nombre;
const {data}=await db.from('pedidos').select('*,pedido_productos(*)')
.or('origen_local.eq.'+local+',destino_local.eq.'+local)
.order('updated_at',{ascending:false}).limit(6);
const e=el('dash-recent');
e.innerHTML=(data&&data.length)?data.map(o=>orderCard(o)).join('')
:'<div class="empty-state"><div class="icon">📦</div><p>No hay actividad reciente</p></div>';
}

// ═══════════════════════════════════════════
//  MIS PEDIDOS (yo soy destino)
// ═══════════════════════════════════════════
async function renderMisPedidos(){
const isAdmin = currentPerfil.role==='admin';
const local   = currentPerfil.local_nombre;

// Populate filtro origen
const selOrigen = el('filter-mis-origen');
const cvOrigen  = selOrigen.value;
selOrigen.innerHTML='<option value="">Todos los orígenes</option>'+
localesCache.map(l=>'<option value="'+l.nombre+'"'+(cvOrigen===l.nombre?' selected':'')+'>'+l.nombre+'</option>').join('');

// Filtro destino — visible para admins
const selDestino = el('filter-mis-destino');
const selCreador = el('filter-mis-creador');
if(isAdmin){
selDestino.style.display='';
const cvDest=selDestino.value;
selDestino.innerHTML='<option value="">Todos los destinos</option>'+
localesCache.map(l=>'<option value="'+l.nombre+'"'+(cvDest===l.nombre?' selected':'')+'>'+l.nombre+'</option>').join('');
} else {
selDestino.style.display='none';
if(selCreador) selCreador.style.display='none';
}
if(isAdmin && selCreador){
selCreador.style.display='';
const cvC=selCreador.value;
const {data:creadores}=await db.from('perfiles').select('id,nombre,apellido,local_nombre').eq('approved',true).order('nombre');
selCreador.innerHTML='<option value="">Realizado por: todos</option>'+(creadores||[]).map(c=>{
const lbl=(c.nombre||'')+' '+(c.apellido||'')+' · '+(c.local_nombre||'');
return '<option value="'+c.id+'"'+(cvC===c.id?' selected':'')+'>'+escHtml(lbl)+'</option>';
}).join('');
}

let q=db.from('pedidos').select('*,pedido_productos(*)')
.not('estado','in','("completo","incompleto","denegado")');

// Empleado: solo sus pedidos (es destino). Admin: puede ver todos pero con filtros
if(!isAdmin) q=q.eq('destino_local',local);

const estado  = el('filter-mis-estado').value;
const origen  = selOrigen.value;
const destino = isAdmin ? selDestino.value : '';
const creador = isAdmin && selCreador ? selCreador.value : '';
if(estado)  q=q.eq('estado',estado);
if(origen)  q=q.eq('origen_local',origen);
if(destino) q=q.eq('destino_local',destino);
if(creador) q=q.eq('creado_por',creador);

q=q.order('created_at',{ascending:true});

// Filtros de fecha
const misDesde=el('filter-mis-desde')?.value;
const misHasta=el('filter-mis-hasta')?.value;
if(misDesde) q=q.gte('created_at',misDesde+'T00:00:00');
if(misHasta) q=q.lte('created_at',misHasta+'T23:59:59');

const {data}=await q;
const list=data||[];
// Actualizar subtítulo según rol
safeSet('mis-pedidos-subtitle', isAdmin
?'Todos los pedidos solicitados — usá los filtros para buscar'
:'Pedidos que tu local solicitó. Seguí el estado acá.');
const ahora=Date.now();
list.forEach(o=>{
if(['pendiente','aceptado'].includes(o.estado)){
o._viejo=(ahora-new Date(o.created_at).getTime())/3600000>24;
}
});
renderList('list-misPedidos',list,'📤',isAdmin?'No hay pedidos activos':'No tenés pedidos activos');
}

// ═══════════════════════════════════════════
//  PARA ENVIAR (yo soy origen)
// ═══════════════════════════════════════════
async function switchDespachoTab(tab){
despachoTab=tab;
el('tab-pendientes').classList.toggle('active',tab==='pendientes');
el('tab-completados').classList.toggle('active',tab==='completados');
el('filter-env-estado').style.display=tab==='pendientes'?'block':'none';
await renderParaEnviar();
}

async function renderParaEnviar(){
const isAdmin = currentPerfil.role==='admin';
const local   = currentPerfil.local_nombre;

// Filtros de local — visibles para admins
const selOrigen  = el('filter-para-origen');
const selDestino = el('filter-para-destino');
const selCreador = el('filter-para-creador');
if(isAdmin){
selOrigen.style.display='';
selDestino.style.display='';
const cvO=selOrigen.value, cvD=selDestino.value;
selOrigen.innerHTML='<option value="">Todos los orígenes</option>'+
localesCache.map(l=>'<option value="'+l.nombre+'"'+(cvO===l.nombre?' selected':'')+'>'+l.nombre+'</option>').join('');
selDestino.innerHTML='<option value="">Todos los destinos</option>'+
localesCache.map(l=>'<option value="'+l.nombre+'"'+(cvD===l.nombre?' selected':'')+'>'+l.nombre+'</option>').join('');
} else {
selOrigen.style.display='none';
selDestino.style.display='none';
if(selCreador) selCreador.style.display='none';
}
if(isAdmin && selCreador){
selCreador.style.display='';
const cvC=selCreador.value;
const {data:creadores}=await db.from('perfiles').select('id,nombre,apellido,local_nombre').eq('approved',true).order('nombre');
selCreador.innerHTML='<option value="">Realizado por: todos</option>'+(creadores||[]).map(c=>{
const lbl=(c.nombre||'')+' '+(c.apellido||'')+' · '+(c.local_nombre||'');
return '<option value="'+c.id+'"'+(cvC===c.id?' selected':'')+'>'+escHtml(lbl)+'</option>';
}).join('');
}

// Locales para los cuales soy escala
const soyEscalaDe = Object.entries(ESCALAS).filter(([d,e])=>e.escala===local).map(([d])=>d);

let q=db.from('pedidos').select('*,pedido_productos(*)');
if(!isAdmin){
if(soyEscalaDe.length>0){
// Veo mis pedidos propios + los pedidos donde soy escala
q=q.or('origen_local.eq.'+local+',destino_local.in.('+soyEscalaDe.map(d=>'"'+d+'"').join(',')+')');
} else {
q=q.eq('origen_local',local);
}
} else {
if(selOrigen.value)  q=q.eq('origen_local',selOrigen.value);
if(selDestino.value) q=q.eq('destino_local',selDestino.value);
if(selCreador?.value) q=q.eq('creado_por',selCreador.value);
}

if(despachoTab==='pendientes'){
q=q.in('estado',['pendiente','aceptado','listo','transito_escala','en_escala','listo_escala']);
const estado=el('filter-env-estado').value;
if(estado) q=q.eq('estado',estado);
q=q.order('created_at',{ascending:true});
} else {
q=q.in('estado',['transito','completo','incompleto','denegado']);
q=q.order('updated_at',{ascending:false});
}

// Filtro por fecha (date pickers)
const desde=el('filter-desde')?.value;
const hasta=el('filter-hasta')?.value;
if(desde) q=q.gte('created_at',desde+'T00:00:00');
if(hasta) q=q.lte('created_at',hasta+'T23:59:59');

const {data}=await q;
const list=data||[];
list.forEach(o=>{
if(['pendiente','aceptado'].includes(o.estado))
o._viejo=(Date.now()-new Date(o.created_at).getTime())/3600000>24;
});
renderList('list-paraEnviar',list,despachoTab==='pendientes'?'📭':'✅',
despachoTab==='pendientes'?'No hay pedidos pendientes':'No hay pedidos completados aún');
}

// ═══════════════════════════════════════════
//  HISTORIAL
// ═══════════════════════════════════════════
async function renderHistorial(){
const local=currentPerfil.local_nombre;
const tipo=el('filter-hist-tipo').value;
const estado=el('filter-hist-estado').value;
let q=db.from('pedidos').select('*,pedido_productos(*)').in('estado',['completo','incompleto','denegado']).order('updated_at',{ascending:false});
if(tipo==='misPedidos')  q=q.eq('destino_local',local);
else if(tipo==='despachados') q=q.eq('origen_local',local);
else q=q.or('origen_local.eq.'+local+',destino_local.eq.'+local);
if(estado) q=q.eq('estado',estado);
const desde=el('filter-hist-desde')?.value;
const hasta=el('filter-hist-hasta')?.value;
if(desde) q=q.gte('updated_at',desde+'T00:00:00');
if(hasta) q=q.lte('updated_at',hasta+'T23:59:59');
const {data}=await q;
renderList('list-historial', data||[], '📋','No hay historial');
}

// ═══════════════════════════════════════════
//  DETALLE
// ═══════════════════════════════════════════
async function openDetalle(orderId){
const {data:o}=await db.from('pedidos').select('*,pedido_productos(*)').eq('id',orderId).single();
if(!o) return;
const [icon,label,cls]=estadoInfo(o.estado);
const isOrigen  = o.origen_local===currentPerfil.local_nombre;
const isDestino = o.destino_local===currentPerfil.local_nombre;
el('modal-detalle-title').textContent='Pedido #'+o.id.slice(-8,-2).toUpperCase();

const prods=(o.pedido_productos||[]).map(p=>
'<div class="product-item"><div class="p-info"><div class="p-name">'+escHtml(p.nombre)+'</div><div class="p-code">'+escHtml(p.codigo)+'</div></div><div class="p-qty">x'+p.cantidad+'</div></div>'
).join('');

// Determinar si el pedido tiene escala
const escalaInfo = tieneEscala(o.destino_local) ? getEscala(o.destino_local) : null;

let stateOrder, steps;
if(escalaInfo){
stateOrder=['pendiente','aceptado','listo','transito_escala','en_escala','listo_escala','transito','llegado','completo'];
steps=[
['pendiente','⏳','Pedido creado'],
['aceptado','✅','Aceptado por el local origen'],
['listo','📦','Listo — en camino a '+escalaInfo.escala],
['transito_escala','🚚','En viaje a '+escalaInfo.escala],
['en_escala','📍',escalaInfo.escala+' confirma recepción'],
['listo_escala','📦',escalaInfo.escala+' despacha a '+o.destino_local],
['transito','🚚','En viaje a '+o.destino_local],
['llegado','📍','Llegó a '+o.destino_local],
['completo','✅','Completado'],
];
} else {
stateOrder=['pendiente','aceptado','listo','transito','llegado','completo'];
steps=[
['pendiente','⏳','Pedido creado'],
['aceptado','✅','Aceptado por el local origen'],
['listo','📦','Listo para enviar'],
['transito','🚚','En viaje'],
['llegado','📍','Llegó a sucursal'],
['completo','✅','Completado'],
];
}
const ci=stateOrder.indexOf(o.estado);
let timeline='';
if(o.estado==='denegado'){
timeline='<div style="color:var(--accent2);font-size:13px;padding:6px 0">❌ Pedido denegado<br><span style="color:var(--text2)">Motivo: '+escHtml(o.motivo_denegacion||'No especificado')+'</span></div>';
} else {
timeline=steps.map((s,i)=>{
const idx=stateOrder.indexOf(s[0]);
const done=idx<ci;
const cur=s[0]===o.estado||(o.estado==='incompleto'&&s[0]==='completo');
const isLast=i===steps.length-1;
return '<div class="timeline-item"><div class="timeline-line">'+
'<div class="timeline-dot '+(done?'done':'')+(cur?' current':'')+'"></div>'+
(!isLast?'<div class="timeline-connector"></div>':'')+
'</div><div class="timeline-content"><div class="timeline-title" style="color:'+(cur?'var(--accent)':(done?'var(--accent3)':'var(--text3)'))+'">'+s[1]+' '+s[2]+'</div></div></div>';
}).join('');
}

let extra='';
if(o.transporte) extra+='<div class="detail-row"><span class="label">Transporte:</span><span class="value">🚛 '+escHtml(o.transporte)+'</span></div>';
if(o.tracking)   extra+='<div class="detail-row"><span class="label">Tracking:</span><span class="value" style="font-family:\'DM Mono\',monospace">'+escHtml(o.tracking)+'</span></div>';
if(o.remito)     extra+='<div class="detail-row"><span class="label">N° Remito:</span><span class="value" style="font-family:\'DM Mono\',monospace">'+escHtml(o.remito)+'</span></div>';
if(o.foto_url)   extra+='<br><img src="'+encodeURI(o.foto_url)+'" class="photo-preview" alt="Foto">';
if(o.estado==='incompleto'&&o.faltantes) extra+='<div class="detail-row"><span class="label">Faltantes:</span><span class="value" style="color:var(--accent2)">'+escHtml(o.faltantes)+'</span></div>';
if(o.notas) extra+='<div class="detail-row"><span class="label">Notas:</span><span class="value">'+escHtml(o.notas)+'</span></div>';
if(o.faltantes_escala) extra+='<div class="detail-row"><span class="label">Faltó en escala:</span><span class="value" style="color:#a855f7">'+escHtml(o.faltantes_escala)+'</span></div>';

const canOrigen  = isOrigen  || currentPerfil.role==='admin';
const canDestino = isDestino || currentPerfil.role==='admin';
const esEscala   = escalaInfo !== null;
const isEscalaLocal = escalaInfo && currentPerfil.local_nombre === escalaInfo.escala;
const canEscala  = isEscalaLocal || currentPerfil.role==='admin';
let actions='';

if(esEscala){
// ── FLUJO CON ESCALA ──
if(canOrigen && o.estado==='pendiente'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'aceptar\',\''+o.id+'\')">✅ Aceptar pedido</button><button class="btn btn-danger btn-sm" onclick="accion(\'denegar\',\''+o.id+'\')">❌ Denegar pedido</button></div>';
} else if(canOrigen && o.estado==='aceptado'){
actions='<div class="actions-bar"><button class="btn btn-primary btn-sm" onclick="accion(\'listo\',\''+o.id+'\')">📦 Marcar listo para enviar a '+escalaInfo.escala+'</button></div>';
} else if(canOrigen && o.estado==='listo'){
actions='<div class="actions-bar"><button class="btn btn-primary btn-sm" onclick="accion(\'transito_escala\',\''+o.id+'\')">🚚 Marcar en viaje hacia '+escalaInfo.escala+'</button></div>';
} else if(canEscala && o.estado==='transito_escala'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'en_escala_completo\',\''+o.id+'\')">✅ Llegó completo a '+escalaInfo.escala+'</button><button class="btn btn-warning btn-sm" onclick="accion(\'en_escala_incompleto\',\''+o.id+'\')">⚠️ Llegó incompleto a '+escalaInfo.escala+'</button></div>';
} else if(canEscala && o.estado==='en_escala'){
actions='<div class="actions-bar"><button class="btn btn-primary btn-sm" onclick="accion(\'listo_escala\',\''+o.id+'\')">📦 Marcar listo para enviar a '+o.destino_local+'</button></div>';
} else if(canEscala && o.estado==='listo_escala'){
actions='<div class="actions-bar"><button class="btn btn-primary btn-sm" onclick="accion(\'transito\',\''+o.id+'\')">🚚 Marcar en viaje hacia '+o.destino_local+'</button></div>';
} else if(canDestino && o.estado==='transito'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'llegado\',\''+o.id+'\')">📍 Confirmar llegada a '+o.destino_local+'</button></div>';
} else if(canDestino && o.estado==='llegado'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'completo\',\''+o.id+'\')">✅ Llegó completo</button><button class="btn btn-warning btn-sm" onclick="accion(\'incompleto\',\''+o.id+'\')">⚠️ Llegó incompleto</button></div>';
}
} else {
// ── FLUJO NORMAL ──
if(canOrigen && o.estado==='pendiente'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'aceptar\',\''+o.id+'\')">✅ Aceptar pedido</button><button class="btn btn-danger btn-sm" onclick="accion(\'denegar\',\''+o.id+'\')">❌ Denegar pedido</button></div>';
} else if(canOrigen && o.estado==='aceptado'){
actions='<div class="actions-bar"><button class="btn btn-primary btn-sm" onclick="accion(\'listo\',\''+o.id+'\')">📦 Marcar listo para enviar</button></div>';
} else if(canOrigen && o.estado==='listo'){
actions='<div class="actions-bar"><button class="btn btn-primary btn-sm" onclick="accion(\'transito\',\''+o.id+'\')">🚚 Marcar en viaje</button></div>';
} else if(canDestino && o.estado==='transito'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'llegado\',\''+o.id+'\')">📍 Confirmar llegada a sucursal</button></div>';
} else if(canDestino && o.estado==='llegado'){
actions='<div class="actions-bar"><button class="btn btn-success btn-sm" onclick="accion(\'completo\',\''+o.id+'\')">✅ Llegó completo</button><button class="btn btn-warning btn-sm" onclick="accion(\'incompleto\',\''+o.id+'\')">⚠️ Llegó incompleto</button></div>';
}
}

el('modal-detalle-body').innerHTML=
'<div class="detail-section"><h4>Estado</h4><span class="badge '+cls+'" style="font-size:13px;padding:5px 12px">'+icon+' '+label+'</span>'+(o.urgente?' <span class="priority-badge">🔴 URGENTE</span>':'')+' </div>'+
'<div class="detail-section"><h4>Ruta</h4><div class="route-box"><div class="route-local"><div class="rl-label">SALE DE</div><div class="rl-name">'+escHtml(o.origen_local)+'</div><div class="rl-code">'+escHtml(o.origen_almacen)+'</div></div><div class="arrow">→</div><div class="route-local"><div class="rl-label">LLEGA A</div><div class="rl-name">'+escHtml(o.destino_local)+'</div><div class="rl-code">'+escHtml(o.destino_almacen)+'</div></div></div></div>'+
'<div class="detail-section"><h4>Cliente</h4><div class="detail-row"><span class="label">Nombre:</span><span class="value">'+escHtml(o.cliente||'–')+'</span></div><div class="detail-row"><span class="label">Teléfono:</span><span class="value">'+escHtml(o.telefono||'–')+'</span></div></div>'+
'<div class="detail-section"><h4>Info</h4><div class="detail-row"><span class="label">Creado:</span><span class="value">'+fmtDateTime(o.created_at)+'</span></div><div class="detail-row"><span class="label">Actualizado:</span><span class="value">'+fmtDateTime(o.updated_at)+'</span></div>'+extra+'</div>'+
'<div class="detail-section"><h4>Productos ('+(o.pedido_productos||[]).length+')</h4><div class="product-items">'+prods+'</div></div>'+
'<div class="detail-section"><h4>Seguimiento</h4><div class="timeline">'+timeline+'</div></div>'+
actions+
'<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">'+
'<button class="btn btn-ghost btn-sm" onclick="openChat(\''+o.id+'\')">💬 Chat del pedido</button>'+
(o.telefono?'<button class="btn btn-success btn-sm" onclick="abrirWhatsApp(\''+escJsStr(o.telefono)+'\',\''+escJsStr(o.cliente||'')+'\')" style="background:#25d366;border-color:#25d366;color:#fff">💬 WhatsApp cliente</button>':'')+
'<button class="btn btn-ghost btn-sm" onclick="generarEtiqueta(\''+o.id+'\')">🖨️ Etiqueta de envío</button>'+
(currentPerfil.role==='admin'?
'<button class="btn btn-warning btn-sm" onclick="retrocederEstado(\''+o.id+'\')">↩️ Retroceder estado</button>'+
'<button class="btn btn-danger btn-sm" onclick="eliminarPedido(\''+o.id+'\')">🗑️ Eliminar pedido</button>':'')+
'</div>';
openModal('modal-detalle');
}

// ═══════════════════════════════════════════
//  ACCIONES
// ═══════════════════════════════════════════
function accion(tipo, orderId){
const labels={aceptar:'Aceptar el pedido',transito:'Marcar en viaje',transito_escala:'Marcar en viaje a escala',en_escala_completo:'Llegó completo a escala',en_escala_incompleto:'Llegó incompleto a escala',listo_escala:'Listo para enviar a destino',llegado:'Confirmar llegada final',completo:'Marcar como completo'};
if(tipo==='denegar'){
el('modal-accion-title').textContent='❌ Denegar pedido';
el('modal-accion-body').innerHTML='<div class="warning-box">⚠️ Esta acción es <strong>irreversible</strong>.</div><div class="form-group" style="margin-top:14px"><label class="form-label">Motivo (obligatorio)</label><textarea class="form-input" id="motivo-den" rows="3" placeholder="Ej: Sin stock..."></textarea></div>';
el('modal-accion-footer').innerHTML='<button class="btn btn-ghost btn-sm" onclick="closeModal(\'modal-accion\')">Cancelar</button><button class="btn btn-danger btn-sm" onclick="confirmarAccion(\'denegar\',\''+orderId+'\')">Confirmar denegación</button>';
openModal('modal-accion'); return;
}
if(tipo==='listo'){
fotoBase64=null;
el('modal-accion-title').textContent='📦 Listo para enviar';
el('modal-accion-body').innerHTML='<div class="warning-box">⚠️ Esta acción es <strong>irreversible</strong>.</div>'+
'<div class="form-group" style="margin-top:14px"><label class="form-label">Método de transporte (obligatorio)</label>'+
'<select class="form-input" id="accion-transporte"><option value="">Seleccionar...</option>'+
transportesCache.map(t=>'<option value="'+t.nombre+'">'+t.nombre+'</option>').join('')+
'<option value="__otro__">Otro (especificar)...</option></select></div>'+
'<div class="form-group" id="transporte-otro-wrap" style="display:none"><label class="form-label">Especificar</label><input class="form-input" id="transporte-otro-input" type="text" placeholder="Ej: FedEx..."></div>'+
'<div class="form-group"><label class="form-label">N° Remito (opcional)</label><input class="form-input" id="num-remito" type="text" placeholder="Ej: 000123" style="font-family:\'DM Mono\',monospace"></div>'+
'<div class="form-group"><label class="form-label">N° Tracking (opcional)</label><input class="form-input" id="num-tracking" type="text" placeholder="Ej: 1Z999AA10123456784" style="font-family:\'DM Mono\',monospace"></div>'+
'<div class="form-group"><label class="form-label">Foto del paquete (opcional)</label><div class="photo-upload" onclick="el(\'foto-input\').click()">📷 Agregar foto<input type="file" id="foto-input" accept="image/*" style="display:none" onchange="previewFoto(event)"></div><img id="foto-preview" class="photo-preview" style="display:none" alt="Preview"></div>';
setTimeout(()=>{ const s=el('accion-transporte'); if(s) s.onchange=function(){el('transporte-otro-wrap').style.display=this.value==='**otro**'?'block':'none';}; },100);
el('modal-accion-footer').innerHTML='<button class="btn btn-ghost btn-sm" onclick="closeModal(\'modal-accion\')">Cancelar</button><button class="btn btn-primary btn-sm" onclick="confirmarAccion(\'listo\',\''+orderId+'\')">Confirmar</button>';
openModal('modal-accion'); return;
}
if(tipo==='incompleto' || tipo==='en_escala_incompleto'){
const label = tipo==='en_escala_incompleto' ? 'Llegó incompleto a escala' : 'Llegó incompleto';
el('modal-accion-title').textContent='⚠️ '+label;
el('modal-accion-body').innerHTML='<div class="warning-box">⚠️ Esta acción es <strong>irreversible</strong>.</div><div class="form-group" style="margin-top:14px"><label class="form-label">¿Qué faltó? (obligatorio)</label><textarea class="form-input" id="faltantes-det" rows="3" placeholder="Ej: Faltó 1 unidad de..."></textarea></div>';
el('modal-accion-footer').innerHTML='<button class="btn btn-ghost btn-sm" onclick="closeModal(\'modal-accion\')">Cancelar</button><button class="btn btn-warning btn-sm" onclick="confirmarAccion(\''+tipo+'\',\''+orderId+'\')">Confirmar</button>';
openModal('modal-accion'); return;
}
el('modal-accion-title').textContent=labels[tipo]||'Confirmar';
el('modal-accion-body').innerHTML='<div class="warning-box">⚠️ Esta acción es <strong>irreversible</strong>. ¿Confirmar?</div>';
el('modal-accion-footer').innerHTML='<button class="btn btn-ghost btn-sm" onclick="closeModal(\'modal-accion\')">Cancelar</button><button class="btn btn-primary btn-sm" onclick="confirmarAccion(\''+tipo+'\',\''+orderId+'\')">Sí, confirmar</button>';
openModal('modal-accion');
}

function previewFoto(e){
const f=e.target.files[0]; if(!f) return;
const r=new FileReader();
r.onload=ev=>{fotoBase64=ev.target.result; const p=el('foto-preview'); p.src=fotoBase64; p.style.display='block';};
r.readAsDataURL(f);
}

async function confirmarAccion(tipo, orderId){
const sm={
aceptar:'aceptado', transito:'transito', transito_escala:'transito_escala',
en_escala_completo:'en_escala', listo_escala:'listo_escala',
llegado:'llegado', completo:'completo'
};
const updates={updated_at:new Date().toISOString()};
if(tipo==='denegar'){
const m=el('motivo-den')&&el('motivo-den').value.trim();
if(!m) return notify('Ingresá el motivo','error');
updates.estado='denegado'; updates.motivo_denegacion=m;
} else if(tipo==='listo'){
let transp=el('accion-transporte')&&el('accion-transporte').value;
if(transp==='**otro**') transp=el('transporte-otro-input')&&el('transporte-otro-input').value.trim();
if(!transp) return notify('Seleccioná el transporte','error');
updates.estado='listo'; updates.transporte=transp;
updates.remito=(el('num-remito')&&el('num-remito').value.trim())||null;
updates.tracking=(el('num-tracking')&&el('num-tracking').value.trim())||null;
if(fotoBase64) updates.foto_url=fotoBase64;
fotoBase64=null;
} else if(tipo==='incompleto'){
const f=el('faltantes-det')&&el('faltantes-det').value.trim();
if(!f) return notify('Indicá qué faltó','error');
updates.estado='incompleto'; updates.faltantes=f;
} else if(tipo==='en_escala_incompleto'){
const f=el('faltantes-det')&&el('faltantes-det').value.trim();
if(!f) return notify('Indicá qué faltó','error');
// Llegó incompleto a la escala pero igual sigue el proceso
updates.estado='en_escala';
updates.faltantes_escala=f;
} else {
updates.estado=sm[tipo]||tipo;
}

const {error}=await db.from('pedidos').update(updates).eq('id',orderId);
if(error) return notify('Error al actualizar: '+error.message,'error');

// Historial
await db.from('pedido_historial').insert({pedido_id:orderId,estado:updates.estado,usuario_id:currentPerfil.id});

// Notificar a los otros participantes
await notificarCambioEstado(orderId, updates.estado);

closeModal('modal-accion'); closeModal('modal-detalle');
notify('Estado actualizado correctamente','success');
await updateBadges(); refreshView();
}

async function notificarCambioEstado(orderId, estado){
const {data:o}=await db.from('pedidos').select('origen_local,destino_local,cliente,id').eq('id',orderId).single();
if(!o) return;
const {data:users}=await db.from('perfiles').select('id,local_nombre,role').eq('approved',true);
if(!users) return;
const labels={aceptado:'✅ Pedido aceptado',denegado:'❌ Pedido denegado',listo:'📦 Listo para enviar',transito_escala:'🚚 En viaje a escala',en_escala:'📍 Llegó a escala',listo_escala:'📦 Sale de escala al destino',transito:'🚚 En viaje al destino final',llegado:'📍 Llegó a sucursal destino',completo:'✅ Pedido completado',incompleto:'⚠️ Pedido incompleto'};
const titulo=labels[estado]||estado;
const cuerpo='#'+orderId.slice(-8,-2).toUpperCase()+' · '+o.origen_local+' → '+o.destino_local+(o.cliente?' · '+o.cliente:'');
// Solo notificar a usuarios de los locales origen y destino (no a todos los admins)
// Incluir local de escala si aplica
const escalaLocal = getEscala(o.destino_local)?.escala || null;
const destinatarios=users.filter(u=>
u.id!==currentPerfil.id &&
(u.local_nombre===o.origen_local || u.local_nombre===o.destino_local || (escalaLocal && u.local_nombre===escalaLocal))
);
if(destinatarios.length){
await db.from('notificaciones').insert(destinatarios.map(u=>({usuario_id:u.id,titulo,cuerpo,pedido_id:orderId})));
}
}

function refreshView(){
const active=Array.from(document.querySelectorAll('[id^="view-"]')).find(e=>e.style.display!=='none');
if(!active) return;
const v=active.id.replace('view-','');
if(v==='dashboard')   renderDashboard();
if(v==='misPedidos')  renderMisPedidos();
if(v==='paraEnviar')  renderParaEnviar();
if(v==='historial')   renderHistorial();
if(v==='agenda')      renderAgendaClientes();
}

// ═══════════════════════════════════════════
//  AGENDA DE CLIENTES
// ═══════════════════════════════════════════
async function renderAgendaClientes(){
const q=(el('agenda-search')?.value||'').trim();
let query=db.from('clientes_agenda').select('*').order('created_at',{ascending:false}).limit(400);
if(q){
const qEsc=q.replace(/,/g,' ');
query=query.or('nombre.ilike.%'+qEsc+'%,telefono.ilike.%'+qEsc+'%,direccion.ilike.%'+qEsc+'%');
}
const {data,error}=await query;
const tbody=el('agenda-body');
if(!tbody) return;
if(error){
tbody.innerHTML='<tr><td colspan="4" style="color:var(--danger)">No se pudo cargar agenda: '+escHtml(error.message)+'</td></tr>';
return;
}
agendaCache=data||[];
if(!agendaCache.length){
tbody.innerHTML='<tr><td colspan="4" style="color:var(--text3)">Sin clientes en agenda</td></tr>';
return;
}
tbody.innerHTML=agendaCache.map(c=>'<tr>'+
'<td>'+escHtml(c.nombre||'')+'</td>'+
'<td>'+escHtml(c.telefono||'')+'</td>'+
'<td>'+escHtml(c.direccion||'')+'</td>'+
'<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editarClienteAgenda(\''+c.id+'\')">✏️</button> '+
'<button class="btn btn-danger btn-sm" onclick="eliminarClienteAgenda(\''+c.id+'\')">🗑️</button></td>'+
'</tr>').join('');
}

function abrirModalNuevoClienteAgenda(desdePedido=false){
clienteDesdePedido=!!desdePedido;
el('cliente-agenda-id').value='';
el('cliente-agenda-nombre').value=el('new-cliente')?.value||'';
el('cliente-agenda-telefono').value=el('new-telefono')?.value||'';
el('cliente-agenda-direccion').value='';
safeSet('modal-cliente-title','➕ Nuevo cliente');
openModal('modal-cliente-agenda');
}

function editarClienteAgenda(id){
const c=agendaCache.find(x=>x.id===id);
if(!c) return;
clienteDesdePedido=false;
el('cliente-agenda-id').value=c.id;
el('cliente-agenda-nombre').value=c.nombre||'';
el('cliente-agenda-telefono').value=c.telefono||'';
el('cliente-agenda-direccion').value=c.direccion||'';
safeSet('modal-cliente-title','✏️ Editar cliente');
openModal('modal-cliente-agenda');
}

async function guardarClienteAgenda(){
const id=el('cliente-agenda-id').value||null;
const nombre=el('cliente-agenda-nombre').value.trim();
const telefono=el('cliente-agenda-telefono').value.trim();
const direccion=el('cliente-agenda-direccion').value.trim();
if(!nombre||!telefono) return notify('Completá nombre y teléfono','error');
const payload={nombre,telefono,direccion:direccion||null};
const req=id
?db.from('clientes_agenda').update(payload).eq('id',id).select().single()
:db.from('clientes_agenda').insert(payload).select().single();
const {data,error}=await req;
if(error) return notify('No se pudo guardar cliente: '+error.message,'error');
closeModal('modal-cliente-agenda');
notify(id?'Cliente actualizado':'Cliente agregado','success');
if(clienteDesdePedido){
seleccionarClienteAgendaPedido(data);
clienteDesdePedido=false;
}
if(el('view-agenda')?.style.display!=='none') await renderAgendaClientes();
}

async function eliminarClienteAgenda(id){
if(!confirm('¿Eliminar este cliente de la agenda?')) return;
const {error}=await db.from('clientes_agenda').delete().eq('id',id);
if(error) return notify('No se pudo eliminar: '+error.message,'error');
notify('Cliente eliminado','info');
await renderAgendaClientes();
}

let _agendaPedidoTimeout=null;
function buscarClienteAgendaPedido(){
const q=el('cliente-search-input').value.trim();
const res=el('cliente-search-results');
if(q.length<2){ res.classList.remove('show'); return; }
clearTimeout(_agendaPedidoTimeout);
_agendaPedidoTimeout=setTimeout(async()=>{
const qEsc=q.replace(/,/g,' ');
const {data,error}=await db.from('clientes_agenda').select('*')
.or('nombre.ilike.%'+qEsc+'%,telefono.ilike.%'+qEsc+'%')
.order('nombre').limit(20);
if(error) return;
if(!data||!data.length){
res.innerHTML='<div class="product-result"><div class="p-name" style="color:var(--text2)">Sin clientes para "'+escHtml(q)+'"</div></div>';
res.classList.add('show');
return;
}
window._agenda_sr=data;
res.innerHTML=data.map((c,i)=>'<div class="product-result" onclick="selClienteAgenda('+i+')">'+
'<div class="p-name">'+escHtml(c.nombre||'')+'</div>'+
'<div class="p-code">'+escHtml(c.telefono||'')+(c.direccion?' · '+escHtml(c.direccion):'')+'</div>'+
'</div>').join('');
res.classList.add('show');
},250);
}

function selClienteAgenda(idx){
const c=window._agenda_sr&&window._agenda_sr[idx];
if(!c) return;
seleccionarClienteAgendaPedido(c);
}

function seleccionarClienteAgendaPedido(c){
el('new-cliente').value=c.nombre||'';
el('new-telefono').value=c.telefono||'';
el('cliente-search-input').value=(c.nombre||'')+(c.telefono?' · '+c.telefono:'');
el('cliente-search-results').classList.remove('show');
}

// ═══════════════════════════════════════════
//  NUEVO PEDIDO
// ═══════════════════════════════════════════
async function openNuevoPedido(){
newOrderProducts=[]; fotoBase64=null; selectedProductTemp=null;
el('new-cliente').value=''; el('new-telefono').value='';
el('cliente-search-input').value='';
el('cliente-search-results').classList.remove('show');
el('new-notas').value=''; el('new-urgente').checked=false;
el('product-search-input').value=''; el('product-qty').value='1';
renderSelectedProducts();
const opts=localesCache.map(l=>'<option value="'+l.nombre+'|'+l.almacen+'">'+l.nombre+' ('+l.almacen+')</option>').join('');
el('new-origen').innerHTML=opts; el('new-destino').innerHTML=opts;
// Default destino = mi local, origen = primer local distinto
const dest=el('new-destino');
for(let i=0;i<dest.options.length;i++){ if(dest.options[i].value.startsWith(currentPerfil.local_nombre+'|')){dest.selectedIndex=i;break;} }
const orig=el('new-origen');
for(let i=0;i<orig.options.length;i++){ if(!orig.options[i].value.startsWith(currentPerfil.local_nombre+'|')){orig.selectedIndex=i;break;} }
updateRoutePreview();
// Load products if not cached
if(!productsCache.length){
const [baseRes,extraRes]=await Promise.all([
db.from('productos').select('codigo,nombre,marca').order('nombre').limit(6000),
db.from('padron_extra').select('*').order('nombre').limit(6000)
]);
const base=baseRes.data||[];
const extra=extraRes.error?[]:(extraRes.data||[]).map(normalizeExtraProduct);
productsCache=[...base,...extra];
}
openModal('modal-nuevo-pedido');
}

function updateRoutePreview(){
const ov=el('new-origen').value, dv=el('new-destino').value;
const oNom=ov?ov.split('|')[0]:'–';
const dNom=dv?dv.split('|')[0]:'–';
safeSet('rp-origen', oNom);
safeSet('rp-destino', dNom);
// Mostrar aviso de escala si el destino tiene escala
const escalaBox=el('escala-aviso');
if(escalaBox){
const esc=dv?getEscala(dNom):null;
if(esc){
escalaBox.style.display='block';
escalaBox.innerHTML='🔄 <strong>Escala automática:</strong> La mercadería pasará primero por <strong>'+esc.escala+'</strong> antes de llegar a <strong>'+dNom+'</strong>.';
} else {
escalaBox.style.display='none';
}
}
}

let _searchTimeout=null;
function searchProducts(){
const q=el('product-search-input').value.trim().toLowerCase();
const res=el('product-search-results');
if(q.length<2){res.classList.remove('show');return;}
// Debounce 300ms para no spamear queries
clearTimeout(_searchTimeout);
_searchTimeout=setTimeout(async()=>{
// Buscar en padrón principal + padrón extra
const [baseRes,extraRes]=await Promise.all([
db.from('productos').select('codigo,nombre,marca').or('nombre.ilike.%'+q+'%,codigo.ilike.%'+q+'%').order('nombre').limit(30),
db.from('padron_extra').select('*').ilike('nombre','%'+q+'%').order('nombre').limit(30)
]);
const base=baseRes.data||[];
const extra=extraRes.error?[]:(extraRes.data||[]).map(normalizeExtraProduct);
const merged=[...base,...extra];
const map=new Map();
merged.forEach(p=>{
const k=(p.codigo||'')+'|'+(p.nombre||'');
if(!map.has(k)) map.set(k,p);
});
const results=Array.from(map.values()).slice(0,30);
if(!results||!results.length){
res.innerHTML='<div class="product-result"><div class="p-name" style="color:var(--text2)">Sin resultados para "'+escHtml(q)+'"</div></div>';
res.classList.add('show'); return;
}
window._sr=results;
res.innerHTML=results.map((p,i)=>'<div class="product-result" onclick="selProd('+i+')"><div class="p-name">'+escHtml(p.nombre)+'</div><div class="p-code">'+escHtml(p.codigo)+(p.marca?' · '+escHtml(p.marca):'')+'</div></div>').join('');
res.classList.add('show');
},300);
}

function selProd(idx){
const p=window._sr&&window._sr[idx]; if(!p) return;
selectedProductTemp=p;
el('product-search-input').value=p.nombre;
el('product-search-results').classList.remove('show');
el('product-qty').focus();
}

function addSelectedProduct(){
if(!selectedProductTemp) return notify('Seleccioná un producto','error');
const qty=parseInt(el('product-qty').value)||1;
if(qty<1) return notify('Cantidad inválida','error');
const ex=newOrderProducts.find(p=>p.codigo===selectedProductTemp.codigo);
if(ex) ex.cantidad+=qty; else newOrderProducts.push(Object.assign({},selectedProductTemp,{cantidad:qty}));
selectedProductTemp=null;
el('product-search-input').value=''; el('product-qty').value='1';
renderSelectedProducts();
}

function removeProduct(idx){newOrderProducts.splice(idx,1);renderSelectedProducts();}

function renderSelectedProducts(){
const e=el('selected-products');
e.innerHTML=newOrderProducts.length
?newOrderProducts.map((p,i)=>'<div class="product-item"><div class="p-info"><div class="p-name">'+p.nombre+'</div><div class="p-code">'+p.codigo+'</div></div><div class="p-qty">x'+p.cantidad+'</div><div class="remove-btn" onclick="removeProduct('+i+')">✕</div></div>').join(''):'';
}

async function crearPedido(){
if(!newOrderProducts.length) return notify('Agregá al menos un producto','error');
const ov=el('new-origen').value, dv=el('new-destino').value;
if(!ov||!dv) return notify('Seleccioná origen y destino','error');
if(ov===dv) return notify('Origen y destino no pueden ser iguales','error');
const [oNom,oAlm]=ov.split('|'), [dNom,dAlm]=dv.split('|');
const {data:pedido,error}=await db.from('pedidos').insert({
origen_local:oNom,origen_almacen:oAlm,destino_local:dNom,destino_almacen:dAlm,
cliente:el('new-cliente').value.trim()||null,
telefono:el('new-telefono').value.trim()||null,
urgente:el('new-urgente').checked,
notas:el('new-notas').value.trim()||null,
estado:'pendiente',creado_por:currentPerfil.id
}).select().single();
if(error) return notify('Error al crear pedido: '+error.message,'error');
// Insert products
await db.from('pedido_productos').insert(newOrderProducts.map(p=>({pedido_id:pedido.id,codigo:p.codigo,nombre:p.nombre,marca:p.marca,cantidad:p.cantidad})));
await db.from('pedido_historial').insert({pedido_id:pedido.id,estado:'pendiente',usuario_id:currentPerfil.id});
// Notify origen local users
const {data:users}=await db.from('perfiles').select('id,local_nombre,role').eq('approved',true);
// Notificar origen + escala si aplica
const escalaCrear = getEscala(dNom);
const dest=users?.filter(u=>u.id!==currentPerfil.id&&(u.local_nombre===oNom||(escalaCrear&&u.local_nombre===escalaCrear.escala)))||[];
if(dest.length) await db.from('notificaciones').insert(dest.map(u=>({usuario_id:u.id,titulo:'📦 Nuevo pedido de '+dNom,cuerpo:'#'+pedido.id.slice(-8,-2).toUpperCase()+(pedido.cliente?' · '+pedido.cliente:''),pedido_id:pedido.id})));
closeModal('modal-nuevo-pedido');
notify('¡Pedido creado exitosamente!','success');
await updateBadges(); navigateTo('misPedidos');
}

// ═══════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════
async function openChat(orderId){
currentChatOrderId=orderId;
el('chat-title').textContent='💬 Chat — Pedido #'+orderId.slice(-8,-2).toUpperCase();
await renderChatMessages();
openModal('modal-chat');
// Realtime chat
db.channel('chat-'+orderId)
.on('postgres_changes',{event:'INSERT',schema:'public',table:'chat_mensajes',filter:'pedido_id=eq.'+orderId},
()=>renderChatMessages()).subscribe();
}

async function renderChatMessages(){
const {data:msgs}=await db.from('chat_mensajes').select('*').eq('pedido_id',currentChatOrderId).order('created_at');
const e=el('chat-messages');
if(!msgs||!msgs.length){e.innerHTML='<div style="text-align:center;color:var(--text3);font-size:13px;padding:20px">No hay mensajes aún</div>';return;}
e.innerHTML=msgs.map(m=>{
const isOwn=m.usuario_id===currentPerfil.id;
const initials=(m.usuario_nombre||'').split(' ').map(w=>w[0]||'').join('').slice(0,2);
const hora=new Date(m.created_at).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'});
return '<div class="chat-msg '+(isOwn?'own':'other')+'">'+
'<div class="chat-avatar" style="background:'+(isOwn?'var(--accent)':'var(--surface3)')+'">'+escHtml(initials)+'</div>'+
'<div><div class="chat-bubble">'+escHtml(m.texto)+'</div><div class="chat-meta" style="text-align:'+(isOwn?'right':'left')+'">'+escHtml(m.usuario_nombre)+' · '+hora+'</div></div></div>';
}).join('');
e.scrollTop=e.scrollHeight;
}

async function sendChatMsg(){
const inp=el('chat-input');
const txt=inp.value.trim(); if(!txt) return;
await db.from('chat_mensajes').insert({pedido_id:currentChatOrderId,usuario_id:currentPerfil.id,usuario_nombre:currentPerfil.nombre+' '+currentPerfil.apellido,local_nombre:currentPerfil.local_nombre,texto:txt});
inp.value=''; await renderChatMessages();
}

// ═══════════════════════════════════════════
//  NOTIFICACIONES
// ═══════════════════════════════════════════
function updateNotifBadgeCount(count){
document.querySelectorAll('.notif-count,.notif-count-desktop,[id^="notif-count"]').forEach(e=>{
e.textContent=count; e.style.display=count>0?'flex':'none';
});
}
async function updateNotifBadge(){
const {count}=await db.from('notificaciones').select('*',{count:'exact',head:true}).eq('usuario_id',currentPerfil.id).eq('leida',false);
updateNotifBadgeCount(count||0);
}

function toggleNotifPanel(){
const panel=el('notif-panel'), overlay=el('notif-overlay');
if(panel.style.display!=='none'){cerrarNotifPanel();}
else{panel.style.display='block';overlay.style.display='block';renderNotifPanel();}
}
function cerrarNotifPanel(){
el('notif-panel').style.display='none'; el('notif-overlay').style.display='none';
}
async function renderNotifPanel(){
const {data:notifs}=await db.from('notificaciones').select('*').eq('usuario_id',currentPerfil.id).order('created_at',{ascending:false}).limit(30);
const listEl=el('notif-list');
if(!notifs||!notifs.length){listEl.innerHTML='<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">Sin notificaciones</div>';return;}
listEl.innerHTML=notifs.map(n=>{
const time=fmtDateTime(n.created_at);
return '<div class="notif-item '+(n.leida?'':'unread')+'" onclick="clickNotif(\''+n.id+'\',\''+(n.pedido_id||'')+'\')">'+
'<div class="n-title">'+escHtml(n.titulo)+'</div>'+
(n.cuerpo?'<div class="n-body">'+escHtml(n.cuerpo)+'</div>':'')+
'<div class="n-time">'+time+'</div></div>';
}).join('');
}
async function clickNotif(notifId, orderId){
await db.from('notificaciones').update({leida:true}).eq('id',notifId);
await updateNotifBadge();
cerrarNotifPanel();
if(orderId&&orderId!=='null'&&orderId!=='') openDetalle(orderId);
}
async function marcarTodasLeidas(){
await db.from('notificaciones').update({leida:true}).eq('usuario_id',currentPerfil.id);
await updateNotifBadge(); await renderNotifPanel();
}

async function limpiarNotificacionesViejas(){
const {error}=await db.from('notificaciones').delete().eq('usuario_id',currentPerfil.id).eq('leida',true);
if(error) return notify('No se pudieron limpiar notificaciones: '+error.message,'error');
notify('Notificaciones leídas eliminadas','info');
await renderNotifPanel();
await updateNotifBadge();
}

// ═══════════════════════════════════════════
//  MIS CONSULTAS
// ═══════════════════════════════════════════
async function renderMisConsultas(){
const {data:sugs}=await db.from('sugerencias').select('*').eq('usuario_id',currentPerfil.id).order('created_at',{ascending:false});
// Mark responses as read
await db.from('sugerencias').update({respuesta_leida:true}).eq('usuario_id',currentPerfil.id).not('respuesta','is',null);
const e=el('list-misConsultas');
if(!sugs||!sugs.length){
e.innerHTML='<div class="empty-state"><div class="icon">💬</div><p>No enviaste ninguna consulta aún.</p></div>'; return;
}
e.innerHTML=sugs.map(s=>{
const fecha=fmtDate(s.created_at);
const badge=s.respuesta?'<span class="badge badge-accepted" style="font-size:11px">✅ Respondida</span>':'<span class="badge badge-pending" style="font-size:11px">⏳ Pendiente</span>';
return '<div class="consulta-card">'+
'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'+badge+'<span class="c-meta" style="margin-bottom:0">'+fecha+'</span></div>'+
'<div class="c-asunto">'+escHtml(s.asunto)+'</div>'+
'<div class="c-texto" style="margin-top:6px">'+escHtml(s.texto)+'</div>'+
(s.respuesta?'<div class="consulta-respuesta"><div class="r-label">💬 Respuesta del administrador:</div>'+escHtml(s.respuesta)+'</div>':'<div class="consulta-pendiente">El administrador aún no respondió.</div>')+
'</div>';
}).join('');
await updateBadges();
}

async function limpiarConsultasRespondidas(){
const {error}=await db.from('sugerencias').delete().eq('usuario_id',currentPerfil.id).not('respuesta','is',null);
if(error) return notify('No se pudieron limpiar consultas: '+error.message,'error');
notify('Consultas respondidas eliminadas','info');
await renderMisConsultas();
}

async function enviarSugerencia(){
const asunto=el('sug-asunto').value.trim(), texto=el('sug-texto').value.trim();
if(!asunto||!texto) return notify('Completá asunto y mensaje','error');
const {error}=await db.from('sugerencias').insert({usuario_id:currentPerfil.id,usuario_nombre:currentPerfil.nombre+' '+currentPerfil.apellido,local_nombre:currentPerfil.local_nombre,email:currentUser.email,asunto,texto});
if(error) return notify('Error: '+error.message,'error');
// Notificar admins
const {data:admins}=await db.from('perfiles').select('id').eq('role','admin').eq('approved',true);
if(admins&&admins.length) await db.from('notificaciones').insert(admins.map(a=>({usuario_id:a.id,titulo:'💡 Nueva consulta de '+currentPerfil.local_nombre,cuerpo:asunto})));
el('sug-asunto').value=''; el('sug-texto').value='';
closeModal('modal-sugerencia');
notify('¡Consulta enviada!','success');
await updateBadges();
}

// ═══════════════════════════════════════════
//  ADMIN — SUGERENCIAS
// ═══════════════════════════════════════════
async function renderSugerencias(){
const {data:sugs}=await db.from('sugerencias').select('*').order('created_at',{ascending:false});
await db.from('sugerencias').update({leida:true}).eq('leida',false);
const e=el('list-sugerencias');
if(!sugs||!sugs.length){e.innerHTML='<div class="empty-state"><div class="icon">💡</div><p>No hay sugerencias aún</p></div>';return;}
e.innerHTML=sugs.map(s=>'<div class="suggestion-item">'+
'<div class="s-meta">'+escHtml(s.usuario_nombre)+' · '+escHtml(s.local_nombre)+' · '+fmtDate(s.created_at)+'</div>'+
'<div style="font-weight:600;margin-bottom:4px">'+escHtml(s.asunto)+'</div>'+
'<div class="s-text">'+escHtml(s.texto)+'</div>'+
(s.respuesta?'<div class="suggestion-reply">💬 Tu respuesta: '+escHtml(s.respuesta)+'</div>':'')+
'<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="abrirRespuestaSug(\''+s.id+'\')">'+
(s.respuesta?'✏️ Editar respuesta':'💬 Responder')+'</button></div></div>').join('');
await updateBadges();
}

async function abrirRespuestaSug(sugId){
currentSugId=sugId;
const {data:sug}=await db.from('sugerencias').select('*').eq('id',sugId).single();
if(!sug) return;
el('modal-resp-sug-body').innerHTML=
'<div class="suggestion-item" style="margin-bottom:14px"><div class="s-meta">'+escHtml(sug.usuario_nombre)+' · '+escHtml(sug.asunto)+'</div><div class="s-text">'+escHtml(sug.texto)+'</div></div>'+
'<div class="form-group"><label class="form-label">Tu respuesta</label><textarea class="form-input" id="resp-texto" rows="3" placeholder="Escribí tu respuesta...">'+escHtml(sug.respuesta||'')+'</textarea></div>';
openModal('modal-resp-sug');
}

async function responderSugerencia(){
const txt=el('resp-texto')&&el('resp-texto').value.trim();
if(!txt) return notify('Escribí una respuesta','error');
const {data:sug}=await db.from('sugerencias').select('usuario_id').eq('id',currentSugId).single();
await db.from('sugerencias').update({respuesta:txt,respuesta_leida:false,updated_at:new Date().toISOString()}).eq('id',currentSugId);
if(sug) await db.from('notificaciones').insert({usuario_id:sug.usuario_id,titulo:'💬 El admin respondió tu consulta',cuerpo:txt.substring(0,80)});
closeModal('modal-resp-sug');
await renderSugerencias();
notify('Respuesta guardada','success');
}

// ═══════════════════════════════════════════
//  ADMIN — USUARIOS
// ═══════════════════════════════════════════
async function renderUsuarios(){
const {data:users}=await db.from('perfiles').select('*').order('created_at');
const {data:authUsers}=await db.from('perfiles').select('id,nombre,apellido,local_nombre,almacen,role,approved,created_at');
// Get emails from auth (we'll just use what we have in perfiles)
const pending=users?.filter(u=>!u.approved)||[];
const pe=el('users-pending-list');
pe.innerHTML=pending.length
?pending.map(u=>'<div style="display:flex;align-items:center;gap:12px;padding:11px;background:var(--surface2);border-radius:var(--radius-sm);margin-bottom:8px;flex-wrap:wrap">'+
'<div style="flex:1"><div style="font-size:14px;font-weight:600">'+u.nombre+' '+u.apellido+'</div>'+
'<div style="font-size:12px;color:var(--text2)">'+u.local_nombre+' ('+u.almacen+')</div></div>'+
'<div style="display:flex;gap:8px"><button class="btn btn-success btn-sm" onclick="aprobarUser(\''+u.id+'\')">✅ Aprobar</button>'+
'<button class="btn btn-danger btn-sm" onclick="rechazarUser(\''+u.id+'\')">❌ Rechazar</button></div></div>').join('')
:'<p style="color:var(--text2);font-size:14px">No hay usuarios pendientes ✅</p>';
el('users-all-body').innerHTML=(users||[]).map(u=>
'<tr><td>'+u.nombre+' '+u.apellido+'</td>'+
'<td>'+u.local_nombre+' ('+u.almacen+')</td>'+
'<td><span class="badge '+(u.role==='admin'?'badge-admin':'badge-empleado')+'">'+roleLabel(u.role)+'</span></td>'+
'<td><span class="badge '+(u.approved?'badge-complete':'badge-pending')+'">'+(u.approved?'Activo':'Pendiente')+'</span></td>'+
'<td style="display:flex;gap:6px;flex-wrap:wrap">'+
(u.id!==currentPerfil.id
?(u.role!=='admin'?'<button class="btn btn-ghost btn-sm" onclick="setAdmin(\''+u.id+'\',true)">↑ Supervisor</button>':'')
+(u.role==='admin'?'<button class="btn btn-ghost btn-sm" onclick="setAdmin(\''+u.id+'\',false)">↓ Local</button>':'')
:'<span style="font-size:12px;color:var(--text3)">Tú</span>')+
'</td></tr>').join('');
await updateBadges();
}

async function aprobarUser(uid){
await db.from('perfiles').update({approved:true}).eq('id',uid);
await db.from('notificaciones').insert({usuario_id:uid,titulo:'✅ Tu cuenta fue aprobada',cuerpo:'Ya podés ingresar a TransferApp.'});
await renderUsuarios(); notify('Usuario aprobado','success');
}
async function rechazarUser(uid){
showConfirm('¿Eliminar este usuario permanentemente?', async()=>{
await db.from('perfiles').delete().eq('id',uid);
await renderUsuarios(); notify('Usuario eliminado','info');
}, {title:'Eliminar usuario', btnLabel:'Sí, eliminar'});
}
async function setAdmin(uid,makeAdmin){
await db.from('perfiles').update({role:makeAdmin?'admin':'empleado'}).eq('id',uid);
await renderUsuarios(); notify('Rol actualizado','success');
}

// ═══════════════════════════════════════════
//  ADMIN — CONFIG
// ═══════════════════════════════════════════
async function renderConfig(){
await Promise.all([renderAdminLocales(),renderTransportes(),renderAdminProducts(),renderPadronExtra()]);
}

async function renderAdminLocales(){
const {data}=await db.from('locales').select('*').order('nombre');
localesCache=data||[];
el('locales-body').innerHTML=localesCache.map((l)=>{
const esc=getEscala(l.nombre);
return '<tr>'+
'<td style="font-weight:600">'+l.nombre+'</td>'+
'<td style="font-family:\'DM Mono\',monospace">'+l.almacen+'</td>'+
'<td style="font-size:12px;color:var(--text2)">'+(l.email||'<span style="color:var(--text3)">–</span>')+'</td>'+
'<td style="font-size:12px;color:var(--text2)">'+(l.telefono||'<span style="color:var(--text3)">–</span>')+'</td>'+
'<td style="font-size:12px;color:var(--text2);max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(l.direccion||'<span style="color:var(--text3)">–</span>')+'</td>'+
'<td>'+(esc?'<span style="color:#a855f7;font-size:11px">🔄 '+esc.escala+'</span>':'<span style="color:var(--text3);font-size:11px">Directo</span>')+'</td>'+
'<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editarLocal(\''+l.id+'\')">✏️</button> '+
'<button class="btn btn-danger btn-sm" onclick="eliminarLocal(\''+l.id+'\')">🗑️</button></td></tr>';
}).join('');
}
async function agregarLocal(){
const n=el('new-local-nombre').value.trim(), a=el('new-local-almacen').value.trim().toUpperCase();
const em=el('new-local-email').value.trim();
const tel=el('new-local-tel')?.value.trim()||'';
const dir=el('new-local-dir')?.value.trim()||'';
if(!n||!a) return notify('Completá nombre y código','error');
const {error}=await db.from('locales').insert({nombre:n,almacen:a,email:em||null,telefono:tel||null,direccion:dir||null});
if(error) return notify(error.message,'error');
el('new-local-nombre').value=''; el('new-local-almacen').value='';
el('new-local-email').value='';
if(el('new-local-tel')) el('new-local-tel').value='';
if(el('new-local-dir')) el('new-local-dir').value='';
await renderAdminLocales(); notify('Local agregado','success');
}
async function editarLocal(id){
const l=localesCache.find(x=>x.id===id); if(!l) return;
el('edit-local-id').value=id;
el('edit-local-nombre').value=l.nombre;
el('edit-local-almacen').value=l.almacen;
el('edit-local-email').value=l.email||'';
el('edit-local-tel').value=l.telefono||'';
el('edit-local-dir').value=l.direccion||'';
openModal('modal-editar-local');
}

async function guardarLocal(){
const id=el('edit-local-id').value;
const n=el('edit-local-nombre').value.trim();
const a=el('edit-local-almacen').value.trim().toUpperCase();
const em=el('edit-local-email').value.trim();
const tel=el('edit-local-tel').value.trim();
const dir=el('edit-local-dir').value.trim();
if(!n||!a) return notify('Completá nombre y código','error');
const {error}=await db.from('locales').update({nombre:n,almacen:a,email:em||null,telefono:tel||null,direccion:dir||null}).eq('id',id);
if(error) return notify('Error al guardar: '+error.message,'error');
closeModal('modal-editar-local');
await renderAdminLocales();
notify('Local actualizado','success');
}
async function eliminarLocal(id){
showConfirm('¿Eliminar este local? Los pedidos existentes no se verán afectados.', async()=>{
await db.from('locales').delete().eq('id',id);
await renderAdminLocales(); notify('Local eliminado','info');
}, {title:'Eliminar local', btnLabel:'Sí, eliminar'});
}

async function renderTransportes(){
const {data}=await db.from('transportes').select('*').order('nombre');
transportesCache=data||[];
el('transportes-tags').innerHTML=transportesCache.map(t=>
'<div class="config-tag">'+t.nombre+'<span class="remove" onclick="eliminarTransporte(\''+t.id+'\')">✕</span></div>').join('');
}
async function agregarTransporte(){
const v=el('new-transporte-input').value.trim(); if(!v) return notify('Escribí el nombre','error');
const {error}=await db.from('transportes').insert({nombre:v});
if(error) return notify(error.message,'error');
el('new-transporte-input').value='';
const {data}=await db.from('transportes').select('*').order('nombre');
transportesCache=data||[];
await renderTransportes(); notify('Transporte agregado','success');
}
async function eliminarTransporte(id){
await db.from('transportes').delete().eq('id',id);
const {data}=await db.from('transportes').select('*').order('nombre');
transportesCache=data||[];
await renderTransportes(); notify('Eliminado','info');
}

async function renderAdminProducts(){
const [baseCountRes,extraCountRes]=await Promise.all([
db.from('productos').select('*',{count:'exact',head:true}),
db.from('padron_extra').select('*',{count:'exact',head:true})
]);
const baseCount=baseCountRes.count||0;
const extraCount=extraCountRes.error?0:(extraCountRes.count||0);
safeSet('products-count', baseCount);
safeSet('products-extra-count', extraCount);
safeSet('products-total-count', baseCount+extraCount);
const q=(el('admin-search-prod')&&el('admin-search-prod').value.trim())||'';
let qBase=db.from('productos').select('codigo,nombre,marca').order('nombre').limit(100);
let qExtra=db.from('padron_extra').select('*').order('nombre').limit(100);
if(q){
qBase=qBase.or('nombre.ilike.%'+q+'%,codigo.ilike.%'+q+'%');
qExtra=qExtra.ilike('nombre','%'+q+'%');
}
const [baseRes,extraRes]=await Promise.all([qBase,qExtra]);
const base=(baseRes.data||[]).map(p=>Object.assign({},p,{_fuente:'Principal'}));
const extra=(extraRes.error?[]:(extraRes.data||[]).map(normalizeExtraProduct)).map(p=>Object.assign({},p,{_fuente:'Extra'}));
const merged=[...base,...extra].sort((a,b)=>String(a.nombre||'').localeCompare(String(b.nombre||''))).slice(0,100);
el('admin-products-body').innerHTML=(merged||[]).map(p=>
'<tr><td style="font-family:\'DM Mono\',monospace;font-size:11px">'+p.codigo+'</td>'+
'<td style="font-size:13px">'+p.nombre+'</td>'+
'<td style="font-size:12px;color:var(--text2)">'+(p.marca||'–')+'</td>'+
'<td style="font-size:12px;color:var(--text3)">'+p._fuente+'</td></tr>').join('');
}

async function renderPadronExtra(){
const q=(el('admin-search-extra')&&el('admin-search-extra').value.trim())||'';
let query=db.from('padron_extra').select('*').order('nombre').limit(200);
if(q) query=query.ilike('nombre','%'+q+'%');
const {data,error}=await query;
if(error){
el('extra-products-body').innerHTML='<tr><td colspan="5" style="color:var(--text3);font-size:12px">No se pudo cargar padrón extra</td></tr>';
return;
}
el('extra-products-body').innerHTML=(data||[]).map(normalizeExtraProduct).map(p=>
'<tr>'+
'<td style="font-family:\'DM Mono\',monospace;font-size:11px">'+(p.codigo||'–')+'</td>'+
'<td style="font-size:13px">'+p.nombre+'</td>'+
'<td style="font-size:12px;color:var(--text2)">'+(p.marca||'–')+'</td>'+
'<td style="font-size:11px;color:var(--text3)">Extra</td>'+
'<td><button class="btn btn-danger btn-sm" onclick="eliminarPadronExtra(\''+p.id+'\')">🗑️</button></td>'+
'</tr>').join('') || '<tr><td colspan="5" style="color:var(--text3);font-size:12px">Sin productos extra cargados</td></tr>';
}

async function agregarPadronExtra(){
const codigo=el('new-extra-codigo').value.trim();
const nombre=el('new-extra-nombre').value.trim();
const marca=el('new-extra-marca').value.trim();
if(!nombre) return notify('Ingresá al menos el nombre del producto extra','error');
let {error}=await db.from('padron_extra').insert({codigo:codigo||null,nombre,marca:marca||null});
if(error && /column .*codigo|column .*marca/i.test(error.message||'')){
({error}=await db.from('padron_extra').insert({nombre}));
}
if(error) return notify('No se pudo agregar: '+error.message,'error');
el('new-extra-codigo').value='';
el('new-extra-nombre').value='';
el('new-extra-marca').value='';
productsCache=[];
await Promise.all([renderPadronExtra(),renderAdminProducts()]);
notify('Producto agregado al padrón extra','success');
}

async function eliminarPadronExtra(id){
const {error}=await db.from('padron_extra').delete().eq('id',id);
if(error) return notify('No se pudo eliminar: '+error.message,'error');
productsCache=[];
await Promise.all([renderPadronExtra(),renderAdminProducts()]);
notify('Producto extra eliminado','info');
}

async function handlePadronUpload(e){
const f=e.target.files[0]; if(!f) return;
if(typeof XLSX==='undefined') return notify('XLSX no cargado','error');
notify('Procesando archivo...','info');
const r=new FileReader();
r.onload=async function(ev){
try{
const wb=XLSX.read(ev.target.result,{type:'binary'});
const ws=wb.Sheets[wb.SheetNames[0]];
const rows=XLSX.utils.sheet_to_json(ws,{header:1});
let hi=-1;
for(let i=0;i<Math.min(rows.length,15);i++){
if(rows[i]&&rows[i].some(c=>String(c||'').toLowerCase().includes('nombre'))){hi=i;break;}
}
if(hi===-1) return notify('No se encontró fila de encabezados','error');
const headers=rows[hi].map(h=>String(h||'').toLowerCase().trim());
const iC=headers.findIndex(h=>h==='código'||h==='codigo');
const iN=headers.findIndex(h=>h==='nombre');
const iM=headers.findIndex(h=>h==='marca');
if(iN===-1) return notify('No se encontró columna Nombre','error');
const products=[];
for(let i=hi+1;i<rows.length;i++){
const row=rows[i]; if(!row||!row[iN]) continue;
products.push({codigo:String(row[iC]||''),nombre:String(row[iN]||''),marca:String(row[iM]||'')});
}
if(!products.length) return notify('Sin productos válidos','error');
// Delete all and re-insert in chunks
await db.from('productos').delete().not('id','is',null);
const chunkSize=500;
for(let i=0;i<products.length;i+=chunkSize){
await db.from('productos').insert(products.slice(i,i+chunkSize));
}
productsCache=[];
notify('Padrón actualizado: '+products.length+' productos','success');
await Promise.all([renderAdminProducts(),renderPadronExtra()]);
}catch(err){notify('Error: '+err.message,'error');}
};
r.readAsBinaryString(f); e.target.value='';
}

// ═══════════════════════════════════════════
//  ETIQUETA PDF — genera e imprime en A4
// ═══════════════════════════════════════════
async function generarEtiqueta(orderId){
const {data:o}=await db.from('pedidos').select('*,pedido_productos(*)').eq('id',orderId).single();
if(!o) return notify('No se pudo cargar el pedido','error');

// Obtener datos completos de los locales
const {data:locales}=await db.from('locales').select('*');
const localMap={};
(locales||[]).forEach(l=>{ localMap[l.nombre]=l; });

const origen  = localMap[o.origen_local]  || {nombre:o.origen_local,  almacen:o.origen_almacen,  direccion:'',telefono:''};
const destino = localMap[o.destino_local] || {nombre:o.destino_local, almacen:o.destino_almacen, direccion:'',telefono:''};

const empresa = sessionStorage.getItem('empresa_nombre') || 'Sucan';
const fecha   = new Date().toLocaleDateString('es-UY',{day:'2-digit',month:'2-digit',year:'2-digit'});
const pedidoId= o.id.slice(-8,-2).toUpperCase();
const prods   = (o.pedido_productos||[]).map(p=>p.nombre+(p.cantidad>1?' x'+p.cantidad:'')).join(', ');
const esc = (v)=>String(v??'').replace(/[&<>"']/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));

// Generar HTML para imprimir (A4, láser blanco y negro, sin emojis)
const html = `<!DOCTYPE html>

<html lang="es">
<head>
<meta charset="UTF-8">
<title>Etiqueta Pedido #${pedidoId}</title>
<style>
  @page { size:A4; margin:12mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,Helvetica,sans-serif; background:#fff; color:#000; }
  .etiqueta {
    width:100%; min-height:calc(297mm - 24mm);
    border:3px solid #000;
    padding:18mm 16mm;
    display:flex;
    flex-direction:column;
    gap:7mm;
  }
  .header { text-align:center; border-bottom:2px solid #000; padding-bottom:5mm; }
  .empresa { font-size:12pt; font-weight:700; letter-spacing:.6px; text-transform:uppercase; }
  .titulo { margin-top:2mm; font-size:18pt; font-weight:800; letter-spacing:1px; text-transform:uppercase; }
  .pedido { margin-top:2mm; font-size:12pt; font-weight:700; }
  .urgente { margin-top:2mm; font-size:12pt; font-weight:800; text-transform:uppercase; }
  .bloque { border:2px solid #000; padding:4mm; }
  .bloque h3 { font-size:11pt; text-transform:uppercase; margin-bottom:3mm; }
  .local-nombre { font-size:20pt; font-weight:800; line-height:1.2; margin-bottom:2mm; text-transform:uppercase; }
  .dato { font-size:11pt; line-height:1.4; }
  .dato strong { font-weight:800; }
  .destino { border-width:3px; }
  .destino .local-nombre { font-size:30pt; }
  .contenido { border:2px solid #000; padding:4mm; }
  .contenido h3 { font-size:11pt; text-transform:uppercase; margin-bottom:2mm; }
  .contenido p { font-size:11pt; line-height:1.35; white-space:pre-wrap; word-break:break-word; }
  .footer {
    margin-top:auto;
    border-top:2px solid #000;
    padding-top:4mm;
    display:grid;
    grid-template-columns:repeat(3,minmax(0,1fr));
    gap:3mm;
  }
  .meta { border:1px solid #000; padding:2.5mm; min-height:16mm; }
  .meta .k { font-size:8pt; text-transform:uppercase; }
  .meta .v { margin-top:1mm; font-size:11pt; font-weight:700; word-break:break-word; }
</style>
</head>
<body>
<div class="etiqueta">

  <div class="header">
    <div class="empresa">${esc(empresa)}</div>
    <div class="titulo">Etiqueta de envío interno</div>
    <div class="pedido">Pedido ${esc(pedidoId)}</div>
    ${o.urgente ? '<div class="urgente">Pedido urgente</div>' : ''}
  </div>

  <div class="bloque">
    <h3>Remitente</h3>
    <div class="local-nombre">${esc(origen.nombre||empresa)}</div>
    <div class="dato"><strong>Almacén:</strong> ${esc(origen.almacen||'-')}</div>
    ${origen.direccion ? '<div class="dato"><strong>Dirección:</strong> '+esc(origen.direccion)+'</div>' : ''}
    ${origen.telefono  ? '<div class="dato"><strong>Teléfono:</strong> '+esc(origen.telefono)+'</div>'  : ''}
  </div>

  <div class="bloque destino">
    <h3>Destino</h3>
    <div class="local-nombre">${esc(destino.nombre||'-')}</div>
    <div class="dato"><strong>Almacén:</strong> ${esc(destino.almacen||'-')}</div>
    ${destino.direccion ? '<div class="dato"><strong>Dirección:</strong> '+esc(destino.direccion)+'</div>' : ''}
    ${destino.telefono  ? '<div class="dato"><strong>Teléfono:</strong> '+esc(destino.telefono)+'</div>'  : ''}
  </div>

  ${o.cliente ? '<div class="bloque"><h3>Cliente final</h3><div class="local-nombre" style="font-size:15pt">'+esc(o.cliente)+'</div>'+(o.telefono?'<div class="dato"><strong>Teléfono:</strong> '+esc(o.telefono)+'</div>':'')+'</div>' : ''}

  <div class="contenido">
    <h3>Contenido</h3>
    <p>${esc(prods||'Sin detalle de productos')}</p>
  </div>

  ${o.notas ? '<div class="contenido"><h3>Notas</h3><p>'+esc(o.notas)+'</p></div>' : ''}

  <div class="footer">
    <div class="meta">
      <div class="k">Fecha</div>
      <div class="v">${esc(fecha)}</div>
    </div>
    <div class="meta">
      <div class="k">Remito</div>
      <div class="v">${esc(o.remito||'-')}</div>
    </div>
    <div class="meta">
      <div class="k">Tracking</div>
      <div class="v">${esc(o.tracking||'-')}</div>
    </div>
  </div>

</div>
<script>window.onload=()=>{ window.print(); window.onafterprint=()=>window.close(); }<\/script>
</body></html>`;

const win = window.open('','_blank','width=800,height=900');
if(!win) return notify('Bloqueador de popups activo — permití ventanas emergentes para generar la etiqueta','error');
win.document.write(html);
win.document.close();
}

// ═══════════════════════════════════════════
//  MODALS / SIDEBAR
// ═══════════════════════════════════════════
function openModal(id){el(id).classList.add('show');document.body.style.overflow='hidden';}
function closeModal(id){el(id).classList.remove('show');document.body.style.overflow='';}
function toggleSidebar(){el('sidebar').classList.toggle('open');el('mobile-overlay').classList.toggle('show');}
function closeSidebar(){el('sidebar').classList.remove('open');el('mobile-overlay').classList.remove('show');}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function(){
clearAuthMessages();
showPage('auth-page');

// Auth bindings (sin inline handlers)
el('empresa-clave')?.addEventListener('keydown', e=>{ if(e.key==='Enter') verificarClaveEmpresa(); });
el('btn-verificar-empresa')?.addEventListener('click', verificarClaveEmpresa);
el('auth-tab-login')?.addEventListener('click', ()=>switchAuthTab('login'));
el('auth-tab-register')?.addEventListener('click', ()=>switchAuthTab('register'));
el('login-password')?.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
el('btn-do-login')?.addEventListener('click', doLogin);
el('btn-reg-step1')?.addEventListener('click', doRegisterStep1);
el('reg-tipo-cuenta')?.addEventListener('change', onTipoCuentaChange);
el('btn-reg-step2')?.addEventListener('click', doRegisterStep2);
el('btn-reg-back')?.addEventListener('click', backToStep1);
el('btn-register-success-close')?.addEventListener('click', closeRegisterSuccess);
el('btn-logout-pending')?.addEventListener('click', doLogout);
el('btn-hamburger')?.addEventListener('click', toggleSidebar);
el('mobile-overlay')?.addEventListener('click', closeSidebar);
el('notif-bell-mobile')?.addEventListener('click', toggleNotifPanel);
el('notif-bell-desktop')?.addEventListener('click', toggleNotifPanel);
el('btn-marcar-todas')?.addEventListener('click', marcarTodasLeidas);
el('btn-limpiar-notifs')?.addEventListener('click', limpiarNotificacionesViejas);
el('btn-suggest-sidebar')?.addEventListener('click', ()=>openModal('modal-sugerencia'));
el('btn-new-consulta')?.addEventListener('click', ()=>openModal('modal-sugerencia'));
el('btn-limpiar-consultas')?.addEventListener('click', limpiarConsultasRespondidas);
el('fab-btn')?.addEventListener('click', openNuevoPedido);

document.querySelectorAll('[data-nav]').forEach(item=>{
item.addEventListener('click', ()=>navigateTo(item.getAttribute('data-nav')));
});

['filter-mis-estado','filter-mis-origen','filter-mis-destino','filter-mis-creador','filter-mis-desde','filter-mis-hasta']
.forEach(id=>el(id)?.addEventListener('change', renderMisPedidos));

el('tab-pendientes')?.addEventListener('click', ()=>switchDespachoTab('pendientes'));
el('tab-completados')?.addEventListener('click', ()=>switchDespachoTab('completados'));
['filter-env-estado','filter-para-origen','filter-para-destino','filter-para-creador','filter-desde','filter-hasta']
.forEach(id=>el(id)?.addEventListener('change', renderParaEnviar));
['filter-hist-tipo','filter-hist-estado','filter-hist-desde','filter-hist-hasta']
.forEach(id=>el(id)?.addEventListener('change', renderHistorial));

// Verificar clave empresa (session storage)
checkEmpresaClave();
onTipoCuentaChange();

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(o=>{
o.addEventListener('click', e=>{ if(e.target===o) closeModal(o.id); });
});

document.addEventListener('click',e=>{
if(!e.target.closest('.product-search-wrap')){
const r=el('product-search-results'); if(r) r.classList.remove('show');
}
if(!e.target.closest('#cliente-search-input')&&!e.target.closest('#cliente-search-results')){
const rc=el('cliente-search-results'); if(rc) rc.classList.remove('show');
}
});

// Si hay sesión activa, cargar directo sin pasar por auth
await checkSession();
});

// ═══════════════════════════════════════════
//  CLAVE DE EMPRESA
// ═══════════════════════════════════════════
async function verificarClaveEmpresa(){
const clave = el('empresa-clave').value.trim();
if(!clave) return showErr('empresa-error','Ingresá la clave de acceso.');
const {data,error} = await db.from('empresa_config').select('*').eq('clave',clave).single();
if(error||!data) return showErr('empresa-error','Clave incorrecta. Contactá al administrador.');
// Guardar en session storage para esta sesión
sessionStorage.setItem('empresa_validada', '1');
sessionStorage.setItem('empresa_nombre', data.nombre);
el('empresa-nombre-display').textContent = data.nombre;
el('empresa-screen').style.display='none';
el('auth-forms').style.display='block';
await populateRegisterLocales();
}

function checkEmpresaClave(){
const validada = sessionStorage.getItem('empresa_validada');
if(validada==='1'){
el('empresa-nombre-display').textContent = sessionStorage.getItem('empresa_nombre')||'';
el('empresa-screen').style.display='none';
el('auth-forms').style.display='block';
populateRegisterLocales().catch(err=>{
console.error('No se pudieron cargar locales para registro:', err);
});
return true;
}
return false;
}

// ═══════════════════════════════════════════
//  WHATSAPP
// ═══════════════════════════════════════════
function abrirWhatsApp(telefono, nombre){
if(!telefono) return notify('Este pedido no tiene teléfono del cliente','info');
// Limpiar el número: sacar espacios, guiones, paréntesis
const num = telefono.replace(/[\s-()]/g,'');
const texto = encodeURIComponent('Hola '+( nombre||'')+'! Te contactamos desde TransferApp respecto a tu pedido.');
// Si el número no tiene código de país, agregar +598 (Uruguay)
const numFinal = num.startsWith('+') ? num : '+598'+num;
window.open('https://wa.me/'+numFinal.replace('+','')+'?text='+texto,'_blank');
}

// ═══════════════════════════════════════════
//  CHATS GENERAL
// ═══════════════════════════════════════════
let currentConvId = null;

async function renderChats(){
// Load conversations where I'm a member
const {data:memberships} = await db.from('conversacion_miembros')
.select('conversacion_id').eq('usuario_id',currentPerfil.id);
const convIds = (memberships||[]).map(m=>m.conversacion_id);

const e = el('list-chats');
if(!convIds.length){
e.innerHTML='<div class="empty-state"><div class="icon">💬</div><p>No tenés conversaciones aún.<br>Creá una nueva con el botón +</p></div>';
el('chat-panel').style.display='none'; return;
}

const {data:convs} = await db.from('conversaciones')
.select('*').in('id',convIds).order('updated_at',{ascending:false});

// Get last message for each
e.innerHTML = '<div class="conv-list">';
for(const conv of convs||[]){
const {data:lastMsg} = await db.from('mensajes')
.select('texto,usuario_nombre,created_at').eq('conversacion_id',conv.id)
.order('created_at',{ascending:false}).limit(1).single();
const nombre = conv.es_grupo ? (conv.nombre||'Grupo') : await getConvNombre(conv.id);
const hora = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'}) : '';
e.innerHTML += '<div class="conv-item'+(currentConvId===conv.id?' active':'')+'" onclick="openConversacion(\''+conv.id+'\')">'+
'<div class="conv-avatar">'+(conv.es_grupo?'👥':'👤')+'</div>'+
'<div class="conv-info">'+
'<div class="conv-nombre">'+escHtml(nombre)+'</div>'+
'<div class="conv-last">'+(lastMsg?(escHtml((lastMsg.usuario_nombre||'').split(' ')[0])+': '+escHtml((lastMsg.texto||'').substring(0,35))):'Sin mensajes')+'</div>'+
'</div>'+
'<div class="conv-time">'+hora+'</div>'+
'</div>';
}
e.innerHTML += '</div>';
}

async function getConvNombre(convId){
// Para 1-a-1, mostrar el nombre del otro
const {data:members} = await db.from('conversacion_miembros')
.select('usuario_id').eq('conversacion_id',convId);
const otherId = members?.find(m=>m.usuario_id!==currentPerfil.id)?.usuario_id;
if(!otherId) return 'Chat';
const {data:perfil} = await db.from('perfiles').select('nombre,apellido,nombre_display').eq('id',otherId).single();
return perfil ? (perfil.nombre_display||(perfil.nombre+' '+perfil.apellido)) : 'Usuario';
}

async function openConversacion(convId){
currentConvId = convId;
el('chat-panel').style.display='flex';
// Get conv info
const {data:conv} = await db.from('conversaciones').select('*').eq('id',convId).single();
const nombre = conv?.es_grupo ? (conv.nombre||'Grupo') : await getConvNombre(convId);
el('chat-conv-title').textContent = nombre;
await renderConvMessages();
await renderChats(); // refresh list to show active
// Realtime
db.channel('conv-'+convId)
.on('postgres_changes',{event:'INSERT',schema:'public',table:'mensajes',filter:'conversacion_id=eq.'+convId},
()=>renderConvMessages()).subscribe();
}

async function renderConvMessages(){
if(!currentConvId) return;
const {data:msgs} = await db.from('mensajes').select('*')
.eq('conversacion_id',currentConvId).order('created_at');
const e = el('conv-messages');
if(!msgs||!msgs.length){
e.innerHTML='<div style="text-align:center;color:var(--text3);font-size:13px;padding:20px">No hay mensajes aún. ¡Escribí el primero!</div>'; return;
}
e.innerHTML = msgs.map(m=>{
const isOwn = m.usuario_id===currentPerfil.id;
const initials = (m.usuario_nombre||'').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
const hora = new Date(m.created_at).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'});
return '<div class="chat-msg '+(isOwn?'own':'other')+'">'+
'<div class="chat-avatar" style="background:'+(isOwn?'var(--accent)':'var(--surface3)')+'">'+escHtml(initials)+'</div>'+
'<div><div class="chat-bubble">'+escHtml(m.texto)+'</div>'+
'<div class="chat-meta" style="text-align:'+(isOwn?'right':'left')+'">'+escHtml(m.usuario_nombre)+' · '+hora+'</div></div></div>';
}).join('');
e.scrollTop=e.scrollHeight;
}

async function sendConvMsg(){
const inp=el('conv-input');
const txt=inp.value.trim(); if(!txt||!currentConvId) return;
await db.from('mensajes').insert({
conversacion_id:currentConvId, usuario_id:currentPerfil.id,
usuario_nombre: currentPerfil.nombre_display||(currentPerfil.nombre+' '+currentPerfil.apellido),
texto:txt
});
await db.from('conversaciones').update({updated_at:new Date().toISOString()}).eq('id',currentConvId);
inp.value=''; await renderConvMessages();
}

async function abrirNuevaConv(){
// Load all users
const {data:users} = await db.from('perfiles').select('id,nombre,apellido,nombre_display,local_nombre,almacen')
.eq('approved',true).neq('id',currentPerfil.id).order('nombre');
el('nueva-conv-body').innerHTML=
'<div class="form-group"><label class="form-label">Nombre del grupo (solo para grupos)</label>'+
'<input class="form-input" type="text" id="nuevo-grupo-nombre" placeholder="Ej: Equipo MDO (dejar vacío para chat individual)"></div>'+
'<div class="form-group"><label class="form-label">Seleccioná participantes</label>'+
'<div style="max-height:280px;overflow-y:auto;background:var(--surface2);border-radius:var(--radius-sm);padding:8px">'+
(users||[]).map(u=>'<label style="display:flex;align-items:center;gap:10px;padding:8px;cursor:pointer;border-radius:6px" onmouseover="this.style.background=\'var(--surface3)\'" onmouseout="this.style.background=\'\'">'+
'<input type="checkbox" value="'+u.id+'" style="width:16px;height:16px">'+
'<div><div style="font-size:13px;font-weight:500">'+escHtml(u.nombre_display||(u.nombre+' '+u.apellido))+'</div>'+
'<div style="font-size:11px;color:var(--text2)">'+escHtml(u.local_nombre)+' ('+escHtml(u.almacen)+')</div></div>'+
'</label>').join('')+
'</div></div>';
openModal('modal-nueva-conv');
}

async function crearConversacion(){
const nombre = el('nuevo-grupo-nombre').value.trim();
const checks = document.querySelectorAll('#nueva-conv-body input[type="checkbox"]:checked');
const participantes = Array.from(checks).map(c=>c.value);
if(!participantes.length) return notify('Seleccioná al menos una persona','error');
const esGrupo = participantes.length>1 || !!nombre;

// Check if 1-a-1 already exists
if(!esGrupo){
const otherId = participantes[0];
const {data:mis} = await db.from('conversacion_miembros').select('conversacion_id').eq('usuario_id',currentPerfil.id);
const {data:sus} = await db.from('conversacion_miembros').select('conversacion_id').eq('usuario_id',otherId);
const misIds = new Set((mis||[]).map(m=>m.conversacion_id));
const existente = (sus||[]).find(m=>misIds.has(m.conversacion_id));
if(existente){ closeModal('modal-nueva-conv'); await openConversacion(existente.conversacion_id); return; }
}

const {data:conv,error} = await db.from('conversaciones').insert({
nombre:nombre||null, es_grupo:esGrupo, creado_por:currentPerfil.id
}).select().single();
if(error) return notify('Error: '+error.message,'error');

const todos = [currentPerfil.id, ...participantes];
await db.from('conversacion_miembros').insert(todos.map(uid=>({conversacion_id:conv.id,usuario_id:uid})));
closeModal('modal-nueva-conv');
await openConversacion(conv.id);
await renderChats();
notify('Conversación creada','success');
}

// ═══════════════════════════════════════════
//  PERFIL PERSONAL
// ═══════════════════════════════════════════
async function renderPerfil(){
const p = currentPerfil;
el('perfil-nombre').value = p.nombre_display || (p.nombre+' '+p.apellido);
el('perfil-email').value = currentUser.email;
el('perfil-local').value = p.local_nombre+' ('+p.almacen+')';
// Foto actual
const fotoEl = el('perfil-foto-preview');
if(p.foto_url){
fotoEl.src=p.foto_url; fotoEl.style.display='block';
} else {
fotoEl.style.display='none';
}
}

async function guardarPerfil(){
const nombre = el('perfil-nombre').value.trim();
if(!nombre) return notify('El nombre no puede estar vacío','error');
const updates = {nombre_display: nombre};
if(window._nuevaFotoPerfil) updates.foto_url = window._nuevaFotoPerfil;
const {error} = await db.from('perfiles').update(updates).eq('id',currentPerfil.id);
if(error) return notify('Error al guardar: '+error.message,'error');
currentPerfil.nombre_display = nombre;
if(window._nuevaFotoPerfil) currentPerfil.foto_url = window._nuevaFotoPerfil;
window._nuevaFotoPerfil = null;
// Actualizar sidebar
safeSet('sidebar-name', nombre);
const avatarEl = el('sidebar-avatar');
if(currentPerfil.foto_url){
avatarEl.style.backgroundImage='url('+currentPerfil.foto_url+')';
avatarEl.style.backgroundSize='cover';
avatarEl.style.backgroundPosition='center';
avatarEl.textContent='';
}
notify('Perfil actualizado','success');
}

function handleFotoPerfil(e){
const f=e.target.files[0]; if(!f) return;
if(f.size>2*1024*1024) return notify('La foto debe ser menor a 2MB','error');
const r=new FileReader();
r.onload=ev=>{
window._nuevaFotoPerfil=ev.target.result;
const prev=el('perfil-foto-preview');
prev.src=ev.target.result; prev.style.display='block';
};
r.readAsDataURL(f);
}

// ═══════════════════════════════════════════
//  BORRAR/EDITAR PEDIDOS — solo admins
// ═══════════════════════════════════════════
async function eliminarPedido(orderId){
showConfirm(
'¿Eliminar este pedido permanentemente? Esta acción no se puede deshacer.',
async()=>{
showSpinner();
try{
const deletePedido = async()=>db
.from('pedidos')
.delete({count:'exact'})
.eq('id',orderId);

let {error:deleteError,count:deletedCount} = await deletePedido();

// Si hay FK que bloquea, borrar hijos y reintentar.
if(deleteError && deleteError.code==='23503'){
const childDeletes = [
db.from('pedido_productos').delete().eq('pedido_id',orderId),
db.from('pedido_historial').delete().eq('pedido_id',orderId),
db.from('chat_mensajes').delete().eq('pedido_id',orderId),
db.from('notificaciones').delete().eq('pedido_id',orderId)
];
const childResults = await Promise.all(childDeletes);
const childError = childResults.find(r=>r.error)?.error;
if(childError) throw childError;
({error:deleteError,count:deletedCount} = await deletePedido());
}
if(deleteError) throw deleteError;
if(!deletedCount){
throw new Error('El pedido no se eliminó (0 filas afectadas). Verificá políticas RLS para DELETE en pedidos.');
}

closeModal('modal-detalle');
notify('Pedido eliminado','info');
await updateBadges();
await refreshView();
}catch(err){
notify('Error al eliminar pedido: '+(err.message||err),'error');
}finally{
hideSpinner();
}
},
{title:'Eliminar pedido', btnLabel:'Sí, eliminar'}
);
}

async function retrocederEstado(orderId){
const {data:o}=await db.from('pedidos').select('*').eq('id',orderId).single();
if(!o) return;
const flujoNormal=['pendiente','aceptado','listo','transito','llegado','completo','incompleto'];
const flujoEscala=['pendiente','aceptado','listo','transito_escala','en_escala','listo_escala','transito','llegado','completo','incompleto'];
const flujo=tieneEscala(o.destino_local)?flujoEscala:flujoNormal;
let estadoAnterior='';
if(o.estado==='denegado'){
// Permitir recuperar pedidos denegados por error
estadoAnterior='pendiente';
}else{
const idx=flujo.indexOf(o.estado);
if(idx<0) return notify('No se puede retroceder desde el estado actual','info');
if(idx===0) return notify('Este pedido ya está en el estado inicial','info');
estadoAnterior=flujo[idx-1];
}
showConfirm(
'¿Volver el pedido al estado "'+estadoAnterior+'"? Solo hacé esto si fue un error.',
async()=>{
await db.from('pedidos').update({estado:estadoAnterior,updated_at:new Date().toISOString()}).eq('id',orderId);
await db.from('pedido_historial').insert({pedido_id:orderId,estado:estadoAnterior+'_retroceso',usuario_id:currentPerfil.id});
closeModal('modal-detalle');
notify('Estado retrocedido a: '+estadoAnterior,'success');
await updateBadges(); refreshView();
},
{title:'Retroceder estado', btnLabel:'Sí, retroceder', btnClass:'btn-warning'}
);
}
