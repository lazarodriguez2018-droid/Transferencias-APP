(function () {
  'use strict';

  const state = {key:'',host:null,token:null,inviteId:null,open:false,busy:false,lastCheck:0};
  const $ = id => document.getElementById(id);
  const clean = value => String(value == null ? '' : value).trim();
  const html = value => typeof esc === 'function' ? esc(value) : clean(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const moduleLabel = value => value === 'reposicion' ? 'Reposición' : value === 'recepcion' ? 'Control de remitos' : 'Inventario';
  const moduleIcon = value => value === 'reposicion' ? '⇄' : value === 'recepcion' ? '▣' : '✓';

  function currentContext() {
    const moduleName = typeof currentModule === 'string' ? currentModule : '';
    const sid = typeof sessionId === 'string' ? sessionId : '';
    if (!['inventario','reposicion','recepcion'].includes(moduleName) || !sid) return null;
    return {module:moduleName,sessionId:sid,key:`${moduleName}:${sid}`};
  }

  function storageKey(context) { return `sucan_invite_${context.module}_${context.sessionId}`; }
  function loadSecret(context) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(context)) || 'null');
      return saved && saved.token && saved.inviteId ? saved : null;
    } catch (_) { return null; }
  }
  function saveSecret(context, inviteId, token) {
    state.inviteId = clean(inviteId); state.token = clean(token);
    try { localStorage.setItem(storageKey(context),JSON.stringify({inviteId:state.inviteId,token:state.token})); } catch (_) {}
  }
  function clearSecret(context) {
    state.inviteId = null; state.token = null;
    try { localStorage.removeItem(storageKey(context)); } catch (_) {}
  }

  async function rpc(name, params) {
    if (!window.SucanCloud?.db) throw new Error('No se pudo conectar con la aplicación.');
    const {data,error} = await window.SucanCloud.db.rpc(name,params);
    if (error) throw error;
    return data;
  }

  function setFab(visible) { $('session-invite-fab')?.classList.toggle('show',Boolean(visible)); }
  function validPhoto(value) { return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(clean(value)) ? value : ''; }
  function relativeTime(value) {
    const seconds = Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000));
    if (!Number.isFinite(seconds) || seconds < 60) return 'activo ahora';
    const minutes = Math.round(seconds/60); if (minutes < 60) return `hace ${minutes} min`;
    return `hace ${Math.round(minutes/60)} h`;
  }

  async function refreshHost(options = {}) {
    const context = currentContext();
    if (!context) { state.key=''; state.host=null; setFab(false); return null; }
    if (!options.force && state.key === context.key && Date.now()-state.lastCheck < 4500) return state.host;
    state.lastCheck = Date.now(); state.key = context.key;
    try {
      const data = await rpc('op_invitacion_anfitrion',{p_modulo:context.module,p_sesion:context.sessionId});
      state.host = data;
      const saved = loadSecret(context);
      if (saved && clean(saved.inviteId) === clean(data?.invite_id)) { state.inviteId=saved.inviteId; state.token=saved.token; }
      else { state.inviteId=null; state.token=null; }
      setFab(Boolean(data?.can_manage && data?.session?.active));
      if (state.open) renderPanel();
      return data;
    } catch (error) {
      state.host = null; setFab(false);
      if (state.open) renderError(error);
      return null;
    }
  }

  async function createInvitation(confirmReplace = false) {
    const context = currentContext(); if (!context || state.busy) return;
    if (confirmReplace && state.host?.invite_id) {
      const accepted = await appConfirm({title:'Generar un acceso nuevo',icon:'▦',tone:'warning',confirmText:'Generar nuevo QR y enlace',message:'El QR, el enlace y los accesos invitados anteriores quedarán invalidados. Las cantidades ya registradas permanecerán guardadas.'});
      if (!accepted) return;
    }
    state.busy = true; showLoading('Creando invitación…');
    try {
      const data = await rpc('op_crear_invitacion_sesion',{p_modulo:context.module,p_sesion:context.sessionId});
      saveSecret(context,data.invite_id,data.token);
      state.host = {...(state.host||{}),...data,invite_id:data.invite_id,guests:[]};
      await refreshHost({force:true});
      renderPanel();
    } catch (error) { renderError(error); }
    finally { state.busy=false; }
  }

  function inviteUrl() { return state.token ? `${location.origin}/operaciones/invitado#${encodeURIComponent(state.token)}` : ''; }
  function showLoading(message) { const content=$('session-invite-content'); if(content)content.innerHTML=`<div class="session-invite-loading"><div>${html(message)}</div></div>`; }
  function renderError(error) {
    const content=$('session-invite-content'); if(!content)return;
    content.innerHTML=`<div class="session-invite-warning"><strong>No pudimos abrir las invitaciones</strong>${html(error?.message||'Intentá nuevamente.')}</div><button class="btn btn-p btn-full mt2" type="button" onclick="refreshSessionInvitePanel()">Reintentar</button>`;
  }

  function renderGuests(guests) {
    if (!guests.length) return '<div class="session-invite-empty">Todavía no ingresó ningún colaborador.</div>';
    return `<div class="session-guest-list">${guests.map(guest => {
      const photo=validPhoto(guest.photo);
      return `<article class="session-guest">${photo?`<img class="session-guest-photo" src="${photo}" alt="Foto de ${html(guest.name)}">`:`<div class="session-guest-photo" style="display:grid;place-items:center">👤</div>`}<div><strong>${html(guest.name)}</strong><span>${guest.online?'● En línea':relativeTime(guest.last_seen)}</span></div><button class="btn btn-s btn-sm" type="button" title="Quitar acceso" aria-label="Quitar acceso a ${html(guest.name)}" data-guest-id="${html(guest.id)}" data-guest-name="${html(guest.name)}" onclick="removeSessionGuest(this.dataset.guestId,this.dataset.guestName)">×</button></article>`;
    }).join('')}</div>`;
  }

  function renderQr(url) {
    const target=$('session-invite-qr'); if(!target||!url)return;
    target.innerHTML='';
    if (typeof QRCode !== 'function') { target.innerHTML='<span style="color:#111;font-size:12px;text-align:center">No se pudo generar el QR.<br>Usá el enlace.</span>'; return; }
    new QRCode(target,{text:url,width:198,height:198,colorDark:'#11131a',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }

  function renderPanel() {
    const content=$('session-invite-content'), context=currentContext(), host=state.host;
    if(!content||!context)return;
    if(!host){showLoading('Consultando la sesión…');return;}
    if(!host.invite_id){content.innerHTML='<div class="session-invite-help"><strong>Acceso temporal</strong>El colaborador escanea el QR o abre el enlace, escribe su nombre y se toma una foto. No necesita una cuenta.</div>'; createInvitation(false); return;}
    const url=inviteUrl(), active=Boolean(host.active), guests=Array.isArray(host.guests)?host.guests:[], session=host.session||{};
    content.innerHTML=`
      <section class="session-invite-card"><div class="session-invite-session"><span class="session-invite-session-icon">${moduleIcon(context.module)}</span><div><strong>${html(moduleLabel(context.module))} · ${html(session.name||sessionNombre||'Sesión actual')}</strong><span>${html(session.route||session.location||'')}</span></div></div></section>
      <section class="session-invite-card">
        <div class="session-invite-status ${active?'':'paused'}"><b><span class="session-invite-dot"></span>${active?'Acceso disponible':'Acceso pausado'}</b><span>${guests.length} ${guests.length===1?'invitado':'invitados'}</span></div>
        ${url?`<div class="session-invite-qr" id="session-invite-qr" aria-label="Código QR de acceso"></div><div class="session-invite-url"><input class="input" id="session-invite-url" value="${html(url)}" readonly aria-label="Enlace de acceso"><button class="btn btn-p btn-sm" type="button" onclick="copySessionInviteLink()">Copiar</button></div><div class="session-invite-actions"><button class="btn btn-p" type="button" onclick="shareSessionInviteLink()">Compartir enlace</button><button class="btn btn-s" type="button" onclick="toggleSessionInvitation()">${active?'Pausar acceso':'Reactivar acceso'}</button></div>`:`<div class="session-invite-warning mt2"><strong>Este acceso fue creado en otro dispositivo</strong>Abrilo en el dispositivo donde se generó o creá un acceso nuevo. Al reemplazarlo, los invitados deberán volver a ingresar con el nuevo QR o enlace.</div><button class="btn btn-p btn-full mt2" type="button" onclick="regenerateSessionInvitation()">Generar nuevo acceso</button>`}
        ${url?'<button class="btn btn-s btn-full mt2" type="button" onclick="regenerateSessionInvitation()">Regenerar QR y enlace</button>':''}
      </section>
      <div class="session-invite-help"><strong>Acceso limitado</strong>Los invitados solo pueden colaborar en esta sesión. No pueden cambiar de módulo, cerrar o borrar la sesión, modificar configuraciones ni descargar informes.</div>
      <section class="session-invite-card mt2"><div class="session-guests-head"><h3>Colaboradores</h3><span>${guests.length}</span></div>${renderGuests(guests)}</section>`;
    if(url)requestAnimationFrame(()=>renderQr(url));
  }

  async function openPanel() {
    const layer=$('session-invite-layer'); if(!layer)return;
    state.open=true; layer.classList.add('show'); layer.setAttribute('aria-hidden','false'); showLoading('Preparando invitación…');
    await refreshHost({force:true});
    if(state.host&&!state.host.invite_id)await createInvitation(false); else renderPanel();
  }
  function closePanel(options={}) {
    state.open=false; const layer=$('session-invite-layer'); if(!layer)return;
    layer.classList.remove('show'); layer.setAttribute('aria-hidden','true');
  }
  async function toggleInvitation() {
    const context=currentContext(); if(!context||state.busy)return;
    state.busy=true;
    try { await rpc('op_configurar_invitacion_sesion',{p_modulo:context.module,p_sesion:context.sessionId,p_accion:state.host?.active?'pausar':'activar'}); await refreshHost({force:true}); }
    catch(error){toast(error.message||'No se pudo actualizar el acceso','e');}
    finally{state.busy=false;}
  }
  async function copyLink() {
    const url=inviteUrl(); if(!url)return;
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado','s'); }
    catch(_){const input=$('session-invite-url');input?.select();document.execCommand('copy');toast('Enlace copiado','s');}
  }
  async function shareLink() {
    const url=inviteUrl(); if(!url)return;
    if(navigator.share){try{await navigator.share({title:'Colaborar en Sucaneitor',text:`Ingresá a esta ${moduleLabel(currentContext()?.module).toLowerCase()}:`,url});return;}catch(error){if(error?.name==='AbortError')return;}}
    await copyLink();
  }
  async function removeGuest(id,name) {
    const accepted=await appConfirm({title:'Quitar colaborador',subtitle:name,tone:'danger',icon:'×',confirmText:'Quitar acceso',message:'La persona dejará de poder trabajar en esta sesión. Sus cantidades ya registradas permanecerán guardadas.'});
    if(!accepted)return;
    try{await rpc('op_expulsar_invitado_sesion',{p_invitado:id});await refreshHost({force:true});toast('Acceso quitado','s');}catch(error){toast(error.message||'No se pudo quitar el acceso','e');}
  }

  window.openSessionInvitePanel=openPanel;
  window.closeSessionInvitePanel=closePanel;
  window.refreshSessionInvitePanel=()=>refreshHost({force:true});
  window.regenerateSessionInvitation=()=>createInvitation(true);
  window.toggleSessionInvitation=toggleInvitation;
  window.copySessionInviteLink=copyLink;
  window.shareSessionInviteLink=shareLink;
  window.removeSessionGuest=removeGuest;

  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshHost({force:true});});
  setInterval(()=>refreshHost({force:state.open}),4000);
  setTimeout(()=>refreshHost({force:true}),900);
})();
