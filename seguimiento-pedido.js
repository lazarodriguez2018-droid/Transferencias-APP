(function(){
'use strict';
const config=window.SUCANEITOR_CLOUD_CONFIG||{};
const db=window.supabase?.createClient(config.supabaseUrl,config.supabaseKey);
const $=id=>document.getElementById(id);
const clean=value=>String(value==null?'':value).trim();
const html=value=>clean(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const token=(()=>{try{return decodeURIComponent(location.hash.replace(/^#/,''));}catch(_){return '';}})();
const states={pendiente:['⏳','Pendiente','warn'],aceptado:['✅','Aceptado','success'],denegado:['❌','Denegado','warn'],listo:['📦','Listo para enviar','success'],transito_escala:['🚚','En viaje a escala',''],en_escala:['📍','En depósito escala',''],listo_escala:['📦','Listo para destino','success'],transito:['🚚','En viaje al destino',''],llegado:['📍','Llegó a sucursal','success'],completo:['✅','Completado','success'],incompleto:['⚠️','Incompleto','warn']};
let loading=false,pollTimer=null;
function stateInfo(value){return states[value]||['•',value||'Sin estado',''];}
function fmt(value){if(!value)return '–';return new Date(value).toLocaleString('es-UY',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function hideBoot(){const boot=$('tracking-boot');if(!boot)return;boot.style.opacity='0';setTimeout(()=>boot.hidden=true,180);}
function showError(message){$('tracking-content').hidden=true;$('tracking-error').hidden=false;$('tracking-error-message').textContent=message||'Comprobá el enlace o pedí uno nuevo al local.';hideBoot();}
function toast(message,tone=''){const target=$('tracking-toast');target.textContent=message;target.className='toast show'+(tone?' '+tone:'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>target.className='toast',2600);}
async function rpc(name,params){if(!db)throw new Error('La conexión no está disponible');const {data,error}=await db.rpc(name,params);if(error)throw error;return data||{};}
async function loadTracking(silent=false){
  if(loading)return;loading=true;if(!silent)$('refresh-tracking').textContent='Actualizando…';
  try{const result=await rpc('pedido_publico_seguimiento',{p_token:token});if(!result.ok)return showError(result.error);render(result.order);$('tracking-error').hidden=true;$('tracking-content').hidden=false;hideBoot();if(silent)toast('Seguimiento actualizado');}
  catch(error){if($('tracking-content').hidden)showError(error.message||'No se pudo consultar el seguimiento.');else toast('No se pudo actualizar','error');}
  finally{loading=false;$('refresh-tracking').textContent='↻ Actualizar';}
}
function renderRoute(order){
  const stops=[{label:'Sale de',...order.origin}];if(order.scale&&order.scale.name!==order.origin?.name&&order.scale.name!==order.destination?.name)stops.push({label:'Escala',...order.scale});stops.push({label:'Llega a',...order.destination});
  $('tracking-route').innerHTML=stops.map((stop,index)=>`${index?'<b>→</b>':''}<div class="route-stop"><span>${html(stop.label)}</span><strong>${html(stop.name)}${stop.warehouse?' ('+html(stop.warehouse)+')':''}</strong></div>`).join('');
  if(stops.length>2)$('tracking-route').style.gridTemplateColumns='1fr 22px 1fr 22px 1fr';else $('tracking-route').style.gridTemplateColumns='1fr 30px 1fr';
}
function renderProducts(products){
  $('tracking-products').innerHTML=(products||[]).map(product=>{let detail=`Solicitado: ${product.cantidad}`;if(product.cantidad_aceptada!=null)detail+=` · Aceptado: ${product.cantidad_aceptada}`;if(Number(product.cantidad_preparada)>0)detail+=` · Preparado: ${product.cantidad_preparada}`;return `<div class="tracking-product"><span><strong>${html(product.nombre)}</strong><small>${html(product.codigo)} · ${html(detail)}</small></span><b>x${Number(product.cantidad)||0}</b></div>`;}).join('')||'<div class="selected-empty">No hay productos para mostrar.</div>';
}
function renderTimeline(events,currentState){
  const rows=(events||[]).length?events:[{estado:currentState,created_at:null}];
  $('tracking-timeline').innerHTML=rows.map((event,index)=>{const info=stateInfo(event.estado),current=index===rows.length-1;return `<div class="timeline-event${current?' current':''}"><div class="timeline-mark"><i>${info[0]}</i></div><div class="timeline-copy"><strong>${html(info[1])}</strong><span>${fmt(event.created_at)}</span></div></div>`;}).join('');
}
function render(order){
  const info=stateInfo(order.state);$('tracking-code').textContent=`PEDIDO #${order.code}`;$('tracking-customer').textContent=order.customer||'Pedido';$('tracking-updated').textContent=fmt(order.updated_at);$('tracking-state').textContent=`${info[0]} ${info[1]}`;$('tracking-state').className=`status-badge ${info[2]}`;
  renderRoute(order);renderProducts(order.products);renderTimeline(order.timeline,order.state);$('manage-order').href=`/#manage=${encodeURIComponent(token)}`;document.title=`Pedido #${order.code} · Sucaneitor`;
}
async function copyText(value){try{await navigator.clipboard.writeText(value);toast('Enlace copiado');}catch(_){const area=document.createElement('textarea');area.value=value;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();toast('Enlace copiado');}}
async function share(){const url=location.href;if(navigator.share){try{await navigator.share({title:'Seguimiento de pedido · Sucaneitor',text:'Consultá el estado del pedido:',url});return;}catch(error){if(error?.name==='AbortError')return;}}await copyText(url);}
function schedule(){clearInterval(pollTimer);pollTimer=setInterval(()=>{if(document.visibilityState==='visible')loadTracking(false);},15000);}
document.addEventListener('DOMContentLoaded',()=>{if(!token)return showError('El enlace está incompleto.');$('refresh-tracking').addEventListener('click',()=>loadTracking(true));$('share-followup').addEventListener('click',share);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')loadTracking(false);});loadTracking(false);schedule();});
})();
