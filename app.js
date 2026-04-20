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

function notify(msg, type='info'){
  const icons={success:'✅',error:'❌',info:'ℹ️'};
  const e=document.createElement('div');
  e.className='notification '+type;
  e.innerHTML='<span>'+icons[type]+'</span><span>'+msg+'</span>';
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
  const {data,error}=await db.auth.signInWithPassword({email,password:pass});
  if(error) return showErr('login-error', error.message==='Invalid login credentials'?'Email o contraseña incorrectos.':error.message);
  await afterLogin(data.user);
}

let regData={}, verifyCode='';

async function doRegisterStep1(){
  const nombre   = el('reg-nombre').value.trim();
  const apellido = el('reg-apellido').value.trim();
  const localVal = el('reg-local').value;
  const email    = el('reg-email').value.trim();
  const pass     = el('reg-pass').value;
  const pass2    = el('reg-pass2').value;
  if(!nombre||!apellido||!localVal||!email||!pass) return showErr('reg-error','Completá todos los campos.');
  if(pass!==pass2)   return showErr('reg-error','Las contraseñas no coinciden.');
  if(pass.length<6)  return showErr('reg-error','Mínimo 6 caracteres.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('reg-error','Email inválido.');
  const [localNombre,almacen]=localVal.split('|');
  regData={nombre,apellido,localNombre,almacen,email,pass};
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
  // Verify OTP
  const {data,error}=await db.auth.verifyOtp({email:regData.email,token,type:'signup'});
  if(error) return showErr('reg-error','Código incorrecto o expirado. '+error.message);
  // Check if first user → admin
  const {count}=await db.from('perfiles').select('*',{count:'exact',head:true});
  const isFirst=(count||0)===0;
  // Create perfil
  const {error:pe}=await db.from('perfiles').insert({
    id:data.user.id, nombre:regData.nombre, apellido:regData.apellido,
    local_nombre:regData.localNombre, almacen:regData.almacen,
    role:isFirst?'admin':'empleado', approved:isFirst
  });
  if(pe) return showErr('reg-error','Error al crear perfil: '+pe.message);
  el('reg-step2').style.display='none';
  el('reg-step1').style.display='block';
  el('reg-code').value='';
  showRegisterSuccess(isFirst
    ?'¡Cuenta creada! Sos el primer administrador. Ya podés iniciar sesión.'
    :'¡Cuenta creada con éxito! Un administrador debe aprobarla antes de que puedas ingresar.');
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
  currentUser=null; currentPerfil=null;
  // Reset UI completamente para evitar que persistan opciones de admin
  const adminNav = el('admin-nav');
  if(adminNav) adminNav.style.display='none';
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  clearAuthMessages();
  showPage('auth-page');
}

async function afterLogin(user){
  currentUser=user;
  const {data:perfil}=await db.from('perfiles').select('*').eq('id',user.id).single();
  if(!perfil){ showErr('login-error','No se encontró tu perfil. Contactá al administrador.'); return; }
  currentPerfil=perfil;
  if(!perfil.approved){ showPage('pending-page'); return; }
  await loadApp();
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
  // Hay sesión — ir directo a la app sin pasar por auth
  await afterLogin(session.user);
}

// ═══════════════════════════════════════════
//  APP LOAD
// ═══════════════════════════════════════════
async function loadApp(){
  showSpinner();
  showPage('app-page');
  // Siempre resetear nav antes de aplicar rol
  el('admin-nav').style.display='none';
  const isAdmin = currentPerfil.role==='admin';
  safeSet('sidebar-name', currentPerfil.nombre_display||(currentPerfil.nombre+' '+currentPerfil.apellido));
  safeSet('sidebar-role', isAdmin?'Supervisor':'Local');
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
  await updateBadges();
  hideSpinner();
  navigateTo('misPedidos');
  setupRealtime();
}

function setupRealtime(){
  // Listen for new notifications for current user
  db.channel('notifs-'+currentPerfil.id)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'notificaciones',filter:'usuario_id=eq.'+currentPerfil.id},
      payload=>{
        updateNotifBadge();
        const n=payload.new;
        notify('🔔 '+n.titulo,'info');
      })
    .subscribe();
  // Listen for pedido changes in my locals
  db.channel('pedidos-changes')
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'pedidos'},
      ()=>{ refreshView(); updateBadges(); })
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'pedidos'},
      ()=>{ refreshView(); updateBadges(); })
    .subscribe();
}

async function updateBadges(){
  if(!currentPerfil) return;
  const local   = currentPerfil.local_nombre;
  const isAdmin = currentPerfil.role==='admin';

  // Badges siempre filtran por local propio (empleados Y supervisores)
  const qMis  = db.from('pedidos').select('id').not('estado','in','("completo","incompleto","denegado")').eq('destino_local',local);
  // Para enviar: incluir pedidos de escala donde este local es la escala
  const escalasDe = Object.entries(ESCALAS).filter(([d,e])=>e.escala===local).map(([d])=>d);
  let qPara = db.from('pedidos').select('id').in('estado',['pendiente','aceptado','listo','transito_escala','en_escala','listo_escala']);
  if(escalasDe.length>0){
    // Soy local de escala O soy origen
    qPara = qPara.or('origen_local.eq.'+local+',destino_local.in.('+escalasDe.map(d=>'"'+d+'"').join(',')+')');
  } else {
    qPara = qPara.eq('origen_local',local);
  }

  const [{data:misPed},{data:paraEnv},{data:notifs}]=await Promise.all([
    qMis, qPara,
    db.from('notificaciones').select('id').eq('usuario_id',currentPerfil.id).eq('leida',false),
  ]);

  const mp=misPed?.length||0, pe=paraEnv?.length||0, no=notifs?.length||0;

  el('badge-misPedidos').textContent=mp; el('badge-misPedidos').style.display=mp>0?'flex':'none';
  el('badge-paraEnviar').textContent=pe; el('badge-paraEnviar').style.display=pe>0?'flex':'none';
  updateNotifBadgeCount(no);

  if(currentPerfil.role==='admin'){
    const [{data:pendUsers},{data:sugNoLeidas}]=await Promise.all([
      db.from('perfiles').select('id').eq('approved',false),
      db.from('sugerencias').select('id').eq('leida',false),
    ]);
    const pu=pendUsers?.length||0, su=sugNoLeidas?.length||0;
    el('badge-usuarios').textContent=pu; el('badge-usuarios').style.display=pu>0?'flex':'none';
    el('badge-sugerencias').textContent=su; el('badge-sugerencias').style.display=su>0?'flex':'none';
  }

  // Dashboard stats
  const [{data:listos},{data:completados}]=await Promise.all([
    db.from('pedidos').select('id').eq('origen_local',local).eq('estado','listo'),
    db.from('pedidos').select('id').or('origen_local.eq.'+local+',destino_local.eq.'+local).in('estado',['completo','incompleto']),
  ]);
  safeSet('stat-pendientes', pe);
  safeSet('stat-activos', mp);
  safeSet('stat-listos', listos?.length||0);
  safeSet('stat-completados', completados?.length||0);

  // Mis consultas badge
  const {data:misRespuestas}=await db.from('sugerencias').select('id').eq('usuario_id',currentPerfil.id).eq('respuesta_leida',false).not('respuesta','is',null);
  const mr=misRespuestas?.length||0;
  el('badge-misConsultas').textContent=mr; el('badge-misConsultas').style.display=mr>0?'flex':'none';
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
    historial:'Historial',misConsultas:'Mis Consultas',chats:'Chats',
    perfil:'Mi Perfil',usuarios:'Usuarios',sugerencias:'Sugerencias',config:'Configuración'
  };
  safeSet('mobile-title', titles[view]||view);
  el('fab-btn').style.display=['misPedidos','paraEnviar','historial','dashboard'].includes(view)?'flex':'none';
  updateBadges();

  const _rm={dashboard:renderDashboard,misPedidos:renderMisPedidos,paraEnviar:renderParaEnviar,
    historial:renderHistorial,misConsultas:renderMisConsultas,chats:renderChats,
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
  const pn=prods.slice(0,2).map(p=>p.nombre.substring(0,28)).join(', ')+(prods.length>2?' +'+(prods.length-2)+' más':'');
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
    '<div class="order-id">'+rol+' &nbsp;#'+o.id.slice(-8,-2).toUpperCase()+urgente+viejo+'</div>'+
    '<div class="order-title">'+(o.cliente||'Sin cliente')+(o.telefono?' · 📞 '+o.telefono:'')+'</div>'+
    (tieneEscala(o.destino_local)?'<div class="order-route">📤 '+o.origen_local+' → 🔄 '+getEscala(o.destino_local).escala+' → 📥 '+o.destino_local+(o.transporte?' · 🚛 '+o.transporte:'')+'</div>':'<div class="order-route">📤 '+o.origen_local+' ('+o.origen_almacen+') → 📥 '+o.destino_local+' ('+o.destino_almacen+')'+(o.transporte?' · 🚛 '+o.transporte:'')+'</div>')+
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
  if(isAdmin){
    selDestino.style.display='';
    const cvDest=selDestino.value;
    selDestino.innerHTML='<option value="">Todos los destinos</option>'+
      localesCache.map(l=>'<option value="'+l.nombre+'"'+(cvDest===l.nombre?' selected':'')+'>'+l.nombre+'</option>').join('');
  } else {
    selDestino.style.display='none';
  }

  let q=db.from('pedidos').select('*,pedido_productos(*)')
    .not('estado','in','("completo","incompleto","denegado")');

  // Empleado: solo sus pedidos (es destino). Admin: puede ver todos pero con filtros
  if(!isAdmin) q=q.eq('destino_local',local);

  const estado  = el('filter-mis-estado').value;
  const origen  = selOrigen.value;
  const destino = isAdmin ? selDestino.value : '';
  if(estado)  q=q.eq('estado',estado);
  if(origen)  q=q.eq('origen_local',origen);
  if(destino) q=q.eq('destino_local',destino);

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
    '<div class="product-item"><div class="p-info"><div class="p-name">'+p.nombre+'</div><div class="p-code">'+p.codigo+'</div></div><div class="p-qty">x'+p.cantidad+'</div></div>'
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
    timeline='<div style="color:var(--accent2);font-size:13px;padding:6px 0">❌ Pedido denegado<br><span style="color:var(--text2)">Motivo: '+(o.motivo_denegacion||'No especificado')+'</span></div>';
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
  if(o.transporte) extra+='<div class="detail-row"><span class="label">Transporte:</span><span class="value">🚛 '+o.transporte+'</span></div>';
  if(o.tracking)   extra+='<div class="detail-row"><span class="label">Tracking:</span><span class="value" style="font-family:\'DM Mono\',monospace">'+o.tracking+'</span></div>';
  if(o.remito)     extra+='<div class="detail-row"><span class="label">N° Remito:</span><span class="value" style="font-family:\'DM Mono\',monospace">'+o.remito+'</span></div>';
  if(o.foto_url)   extra+='<br><img src="'+o.foto_url+'" class="photo-preview" alt="Foto">';
  if(o.estado==='incompleto'&&o.faltantes) extra+='<div class="detail-row"><span class="label">Faltantes:</span><span class="value" style="color:var(--accent2)">'+o.faltantes+'</span></div>';
  if(o.notas) extra+='<div class="detail-row"><span class="label">Notas:</span><span class="value">'+o.notas+'</span></div>';
  if(o.faltantes_escala) extra+='<div class="detail-row"><span class="label">Faltó en escala:</span><span class="value" style="color:#a855f7">'+o.faltantes_escala+'</span></div>';

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
    '<div class="detail-section"><h4>Ruta</h4><div class="route-box"><div class="route-local"><div class="rl-label">SALE DE</div><div class="rl-name">'+o.origen_local+'</div><div class="rl-code">'+o.origen_almacen+'</div></div><div class="arrow">→</div><div class="route-local"><div class="rl-label">LLEGA A</div><div class="rl-name">'+o.destino_local+'</div><div class="rl-code">'+o.destino_almacen+'</div></div></div></div>'+
    '<div class="detail-section"><h4>Cliente</h4><div class="detail-row"><span class="label">Nombre:</span><span class="value">'+(o.cliente||'–')+'</span></div><div class="detail-row"><span class="label">Teléfono:</span><span class="value">'+(o.telefono||'–')+'</span></div></div>'+
    '<div class="detail-section"><h4>Info</h4><div class="detail-row"><span class="label">Creado:</span><span class="value">'+fmtDateTime(o.created_at)+'</span></div><div class="detail-row"><span class="label">Actualizado:</span><span class="value">'+fmtDateTime(o.updated_at)+'</span></div>'+extra+'</div>'+
    '<div class="detail-section"><h4>Productos ('+(o.pedido_productos||[]).length+')</h4><div class="product-items">'+prods+'</div></div>'+
    '<div class="detail-section"><h4>Seguimiento</h4><div class="timeline">'+timeline+'</div></div>'+
    actions+
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">'+
    '<button class="btn btn-ghost btn-sm" onclick="openChat(\''+o.id+'\')">💬 Chat del pedido</button>'+
    (o.telefono?'<button class="btn btn-success btn-sm" onclick="abrirWhatsApp(\''+o.telefono+'\',\''+( o.cliente||'')+'\')" style="background:#25d366;border-color:#25d366;color:#fff">💬 WhatsApp cliente</button>':'')+
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
    setTimeout(()=>{ const s=el('accion-transporte'); if(s) s.onchange=function(){el('transporte-otro-wrap').style.display=this.value==='__otro__'?'block':'none';}; },100);
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
    if(transp==='__otro__') transp=el('transporte-otro-input')&&el('transporte-otro-input').value.trim();
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
}

// ═══════════════════════════════════════════
//  NUEVO PEDIDO
// ═══════════════════════════════════════════
async function openNuevoPedido(){
  newOrderProducts=[]; fotoBase64=null; selectedProductTemp=null;
  el('new-cliente').value=''; el('new-telefono').value='';
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
    const {data}=await db.from('productos').select('codigo,nombre,marca').order('nombre').limit(6000);
    productsCache=data||[];
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
    // Buscar siempre directo en Supabase para evitar problemas de cache incompleto
    let query=db.from('productos').select('codigo,nombre,marca').order('nombre').limit(30);
    // Intentar búsqueda por nombre Y código
    query=query.or('nombre.ilike.%'+q+'%,codigo.ilike.%'+q+'%');
    const {data:results}=await query;
    if(!results||!results.length){
      res.innerHTML='<div class="product-result"><div class="p-name" style="color:var(--text2)">Sin resultados para "'+q+'"</div></div>';
      res.classList.add('show'); return;
    }
    window._sr=results;
    res.innerHTML=results.map((p,i)=>'<div class="product-result" onclick="selProd('+i+')"><div class="p-name">'+p.nombre+'</div><div class="p-code">'+p.codigo+(p.marca?' · '+p.marca:'')+'</div></div>').join('');
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
    const initials=m.usuario_nombre.split(' ').map(w=>w[0]).join('').slice(0,2);
    const hora=new Date(m.created_at).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'});
    return '<div class="chat-msg '+(isOwn?'own':'other')+'">'+
      '<div class="chat-avatar" style="background:'+(isOwn?'var(--accent)':'var(--surface3)')+'">'+initials+'</div>'+
      '<div><div class="chat-bubble">'+m.texto+'</div><div class="chat-meta" style="text-align:'+(isOwn?'right':'left')+'">'+m.usuario_nombre+' · '+hora+'</div></div></div>';
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
      '<div class="n-title">'+n.titulo+'</div>'+
      (n.cuerpo?'<div class="n-body">'+n.cuerpo+'</div>':'')+
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
      '<div class="c-asunto">'+s.asunto+'</div>'+
      '<div class="c-texto" style="margin-top:6px">'+s.texto+'</div>'+
      (s.respuesta?'<div class="consulta-respuesta"><div class="r-label">💬 Respuesta del administrador:</div>'+s.respuesta+'</div>':'<div class="consulta-pendiente">El administrador aún no respondió.</div>')+
      '</div>';
  }).join('');
  await updateBadges();
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
    '<div class="s-meta">'+s.usuario_nombre+' · '+s.local_nombre+' · '+fmtDate(s.created_at)+'</div>'+
    '<div style="font-weight:600;margin-bottom:4px">'+s.asunto+'</div>'+
    '<div class="s-text">'+s.texto+'</div>'+
    (s.respuesta?'<div class="suggestion-reply">💬 Tu respuesta: '+s.respuesta+'</div>':'')+
    '<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="abrirRespuestaSug(\''+s.id+'\')">'+
    (s.respuesta?'✏️ Editar respuesta':'💬 Responder')+'</button></div></div>').join('');
  await updateBadges();
}

async function abrirRespuestaSug(sugId){
  currentSugId=sugId;
  const {data:sug}=await db.from('sugerencias').select('*').eq('id',sugId).single();
  if(!sug) return;
  el('modal-resp-sug-body').innerHTML=
    '<div class="suggestion-item" style="margin-bottom:14px"><div class="s-meta">'+sug.usuario_nombre+' · '+sug.asunto+'</div><div class="s-text">'+sug.texto+'</div></div>'+
    '<div class="form-group"><label class="form-label">Tu respuesta</label><textarea class="form-input" id="resp-texto" rows="3" placeholder="Escribí tu respuesta...">'+(sug.respuesta||'')+'</textarea></div>';
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
    '<td><span class="badge '+(u.role==='admin'?'badge-admin':'badge-empleado')+'">'+(u.role==='admin'?'Supervisor':'Local')+'</span></td>'+
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
  if(!confirm('¿Eliminar este usuario?')) return;
  await db.from('perfiles').delete().eq('id',uid);
  await renderUsuarios(); notify('Usuario eliminado','info');
}
async function setAdmin(uid,makeAdmin){
  await db.from('perfiles').update({role:makeAdmin?'admin':'empleado'}).eq('id',uid);
  await renderUsuarios(); notify('Rol actualizado','success');
}

// ═══════════════════════════════════════════
//  ADMIN — CONFIG
// ═══════════════════════════════════════════
async function renderConfig(){
  await Promise.all([renderAdminLocales(),renderTransportes(),renderAdminProducts()]);
}

async function renderAdminLocales(){
  const {data}=await db.from('locales').select('*').order('nombre');
  localesCache=data||[];
  el('locales-body').innerHTML=localesCache.map((l)=>{
    const esc=getEscala(l.nombre);
    return '<tr><td style="font-weight:600">'+l.nombre+'</td>'+
    '<td style="font-family:\'DM Mono\',monospace">'+l.almacen+'</td>'+
    '<td>'+(l.email||'<span style="color:var(--text3)">Sin email</span>')+'</td>'+
    '<td>'+(esc?'<span style="color:#a855f7;font-size:12px">🔄 '+esc.escala+'</span>':'<span style="color:var(--text3);font-size:12px">Directo</span>')+'</td>'+
    '<td><button class="btn btn-ghost btn-sm" onclick="editarLocal(\''+l.id+'\')">✏️</button> '+
    '<button class="btn btn-danger btn-sm" onclick="eliminarLocal(\''+l.id+'\')">🗑️</button></td></tr>';
  }).join('');
}
async function agregarLocal(){
  const n=el('new-local-nombre').value.trim(), a=el('new-local-almacen').value.trim().toUpperCase(), em=el('new-local-email').value.trim();
  if(!n||!a) return notify('Completá nombre y código','error');
  const {error}=await db.from('locales').insert({nombre:n,almacen:a,email:em||null});
  if(error) return notify(error.message,'error');
  el('new-local-nombre').value=''; el('new-local-almacen').value=''; el('new-local-email').value='';
  await renderAdminLocales(); notify('Local agregado','success');
}
async function editarLocal(id){
  const l=localesCache.find(x=>x.id===id); if(!l) return;
  el('edit-local-id').value=id;
  el('edit-local-nombre').value=l.nombre;
  el('edit-local-almacen').value=l.almacen;
  el('edit-local-email').value=l.email||'';
  openModal('modal-editar-local');
}

async function guardarLocal(){
  const id=el('edit-local-id').value;
  const n=el('edit-local-nombre').value.trim();
  const a=el('edit-local-almacen').value.trim().toUpperCase();
  const em=el('edit-local-email').value.trim();
  if(!n||!a) return notify('Completá nombre y código','error');
  const {error}=await db.from('locales').update({nombre:n,almacen:a,email:em||null}).eq('id',id);
  if(error) return notify('Error al guardar: '+error.message,'error');
  closeModal('modal-editar-local');
  await renderAdminLocales();
  notify('Local actualizado','success');
}
async function eliminarLocal(id){
  if(!confirm('¿Eliminar este local?')) return;
  await db.from('locales').delete().eq('id',id);
  await renderAdminLocales(); notify('Local eliminado','info');
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
  const {count}=await db.from('productos').select('*',{count:'exact',head:true});
  safeSet('products-count', count||0);
  const q=(el('admin-search-prod')&&el('admin-search-prod').value.trim())||'';
  let query=db.from('productos').select('codigo,nombre,marca').order('nombre').limit(100);
  if(q) query=query.ilike('nombre','%'+q+'%');
  const {data}=await query;
  el('admin-products-body').innerHTML=(data||[]).map(p=>
    '<tr><td style="font-family:\'DM Mono\',monospace;font-size:11px">'+p.codigo+'</td>'+
    '<td style="font-size:13px">'+p.nombre+'</td>'+
    '<td style="font-size:12px;color:var(--text2)">'+(p.marca||'–')+'</td></tr>').join('');
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
      await db.from('productos').delete().neq('id','00000000-0000-0000-0000-000000000000');
      const chunkSize=500;
      for(let i=0;i<products.length;i+=chunkSize){
        await db.from('productos').insert(products.slice(i,i+chunkSize));
      }
      productsCache=products;
      notify('Padrón actualizado: '+products.length+' productos','success');
      await renderAdminProducts();
    }catch(err){notify('Error: '+err.message,'error');}
  };
  r.readAsBinaryString(f); e.target.value='';
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

  // Verificar clave empresa (session storage)
  checkEmpresaClave();

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(o=>{
    o.addEventListener('click', e=>{ if(e.target===o) closeModal(o.id); });
  });

  document.addEventListener('click',e=>{
    if(!e.target.closest('.product-search-wrap')){
      const r=el('product-search-results'); if(r) r.classList.remove('show');
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
  sessionStorage.setItem('empresa_clave', clave);
  sessionStorage.setItem('empresa_nombre', data.nombre);
  el('empresa-nombre-display').textContent = data.nombre;
  el('empresa-screen').style.display='none';
  el('auth-forms').style.display='block';
  await populateRegisterLocales();
}

function checkEmpresaClave(){
  const saved = sessionStorage.getItem('empresa_clave');
  if(saved){
    el('empresa-nombre-display').textContent = sessionStorage.getItem('empresa_nombre')||'';
    el('empresa-screen').style.display='none';
    el('auth-forms').style.display='block';
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
  const num = telefono.replace(/[\s\-\(\)]/g,'');
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
        '<div class="conv-nombre">'+nombre+'</div>'+
        '<div class="conv-last">'+(lastMsg?(lastMsg.usuario_nombre.split(' ')[0]+': '+lastMsg.texto.substring(0,35)):'Sin mensajes')+'</div>'+
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
    const initials = m.usuario_nombre.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const hora = new Date(m.created_at).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'});
    return '<div class="chat-msg '+(isOwn?'own':'other')+'">'+
      '<div class="chat-avatar" style="background:'+(isOwn?'var(--accent)':'var(--surface3)')+'">'+initials+'</div>'+
      '<div><div class="chat-bubble">'+m.texto+'</div>'+
      '<div class="chat-meta" style="text-align:'+(isOwn?'right':'left')+'">'+m.usuario_nombre+' · '+hora+'</div></div></div>';
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
      '<div><div style="font-size:13px;font-weight:500">'+(u.nombre_display||(u.nombre+' '+u.apellido))+'</div>'+
      '<div style="font-size:11px;color:var(--text2)">'+u.local_nombre+' ('+u.almacen+')</div></div>'+
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

