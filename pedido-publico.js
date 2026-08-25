(function(){
'use strict';
const config=window.SUCANEITOR_CLOUD_CONFIG||{};
const db=window.supabase?.createClient(config.supabaseUrl,config.supabaseKey);
const state={token:'',local:null,origins:[],identity:null,products:[],searchResults:[],searchTimer:null,busy:false,pendingDuplicate:false};
const $=id=>document.getElementById(id);
const clean=value=>String(value==null?'':value).trim();
const html=value=>clean(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

function hideBoot(){const boot=$('public-boot');if(!boot)return;boot.style.opacity='0';setTimeout(()=>boot.hidden=true,180);}
function showError(message){$('public-flow').hidden=true;$('public-error').hidden=false;$('public-error-message').textContent=message||'Solicitá un enlace nuevo al local.';hideBoot();}
function setError(id,message){const target=$(id);if(target)target.textContent=message||'';}
function toast(message,tone=''){const target=$('public-toast');target.textContent=message;target.className='toast show'+(tone?' '+tone:'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>target.className='toast',2800);}
function tokenFromHash(){try{return decodeURIComponent(location.hash.replace(/^#/,''));}catch(_){return '';}}
function trackingUrl(token){return `${location.origin}/seguimiento-pedido#${encodeURIComponent(token)}`;}
function getDeviceId(){
  const key='sucan_public_order_device';let value='';
  try{value=localStorage.getItem(key)||'';}catch(_){}
  if(value.length>=8)return value;
  value=window.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  try{localStorage.setItem(key,value);}catch(_){}
  return value;
}
async function rpc(name,params){if(!db)throw new Error('La conexión no está disponible');const {data,error}=await db.rpc(name,params);if(error)throw error;return data||{};}
function step(number){
  ['identity','order','track'].forEach((name,index)=>{const node=$(`step-${name}`);node.classList.toggle('active',index===number);node.classList.toggle('done',index<number);});
}
function showScreen(name){
  $('identity-screen').hidden=name!=='identity';$('order-screen').hidden=name!=='order';$('confirmation-screen').hidden=name!=='confirmation';
  step(name==='identity'?0:name==='order'?1:2);window.scrollTo({top:0,behavior:'smooth'});
}
async function loadOrigins(){
  const {data,error}=await db.from('locales').select('id,nombre,almacen').neq('id',state.local.id).order('nombre');
  if(error)throw error;state.origins=data||[];
  $('public-origin').innerHTML=state.origins.map(row=>`<option value="${html(row.id)}">${html(row.nombre)} (${html(row.almacen)})</option>`).join('');
  if(!state.origins.length)throw new Error('No hay locales de origen disponibles');
}
function lastOrder(){try{return JSON.parse(localStorage.getItem('sucan_public_last_order')||'null');}catch(_){return null;}}
function saveLastOrder(order){try{localStorage.setItem('sucan_public_last_order',JSON.stringify({...order,entryToken:state.token}));}catch(_){}
}
function clearLastOrder(){try{localStorage.removeItem('sucan_public_last_order');}catch(_){}
}
async function initialize(){
  state.token=tokenFromHash();if(!state.token)return showError('El enlace está incompleto. Solicitá uno nuevo al local.');
  try{
    const preview=await rpc('pedido_publico_previsualizar_enlace',{p_token:state.token});
    if(!preview.ok)return showError(preview.error);
    state.local=preview.local;$('destination-label').textContent=state.local.nombre.toUpperCase();$('public-destination').value=`${state.local.nombre} (${state.local.almacen})`;
    await loadOrigins();$('public-flow').hidden=false;hideBoot();
    const saved=lastOrder();
    if(saved?.entryToken===state.token&&saved?.tracking_token){showConfirmation(saved);return;}
    showScreen('identity');
  }catch(error){showError(error.message||'No se pudo validar el enlace.');}
}
function submitIdentity(event){
  event.preventDefault();setError('identity-error','');
  const nombre=clean($('public-name').value),apellido=clean($('public-surname').value),telefono=clean($('public-phone').value);
  if(nombre.length<2||nombre.length>80)return setError('identity-error','El nombre debe tener entre 2 y 80 caracteres.');
  if(apellido.length<2||apellido.length>80)return setError('identity-error','El apellido debe tener entre 2 y 80 caracteres.');
  if(telefono.length>30)return setError('identity-error','El teléfono es demasiado largo.');
  state.identity={nombre,apellido,telefono};$('identity-chip').textContent=`👤 ${nombre} ${apellido}`;showScreen('order');setTimeout(()=>$('public-product-search').focus(),180);
}
async function searchProducts(){
  const query=clean($('public-product-search').value);const panel=$('public-search-results');
  setError('order-error','');if(query.length<2){panel.hidden=true;return setError('order-error','Escribí al menos dos caracteres para buscar.');}
  $('public-search-button').disabled=true;$('public-search-button').textContent='…';
  try{
    const result=await rpc('pedido_publico_buscar_productos',{p_token:state.token,p_consulta:query});
    if(!result.ok)throw new Error(result.error);state.searchResults=result.products||[];renderSearchResults();
  }catch(error){panel.hidden=true;setError('order-error',friendlyError(error));}
  finally{$('public-search-button').disabled=false;$('public-search-button').textContent='Buscar';}
}
function renderSearchResults(){
  const panel=$('public-search-results');
  if(!state.searchResults.length){panel.innerHTML='<div class="selected-empty">No encontramos productos para esta búsqueda.</div>';panel.hidden=false;return;}
  panel.innerHTML=state.searchResults.map((product,index)=>`<button class="search-result" type="button" data-product-index="${index}"><span><strong>${html(product.nombre)}</strong><small>${html(product.codigo)}${product.marca?' · '+html(product.marca):''}</small></span><b>＋</b></button>`).join('');panel.hidden=false;
}
function addProduct(index){
  const product=state.searchResults[index];if(!product)return;
  const existing=state.products.find(row=>String(row.codigo)===String(product.codigo));if(existing)existing.cantidad=Math.min(999,existing.cantidad+1);else state.products.push({...product,cantidad:1});
  $('public-search-results').hidden=true;$('public-product-search').value='';renderSelected();toast('Producto agregado');
}
function changeQuantity(code,delta){const row=state.products.find(item=>String(item.codigo)===String(code));if(!row)return;row.cantidad=Math.max(1,Math.min(999,row.cantidad+delta));renderSelected();}
function removeProduct(code){state.products=state.products.filter(item=>String(item.codigo)!==String(code));renderSelected();}
function renderSelected(){
  const panel=$('selected-products');$('selected-count').textContent=`${state.products.length} ${state.products.length===1?'ítem':'ítems'}`;
  if(!state.products.length){panel.innerHTML='<div class="selected-empty">Buscá un producto y agregalo al pedido.</div>';return;}
  panel.innerHTML=state.products.map(product=>`<div class="selected-row" data-code="${html(product.codigo)}"><span><strong>${html(product.nombre)}</strong><small>${html(product.codigo)}${product.marca?' · '+html(product.marca):''}</small></span><div class="qty-control"><button type="button" data-action="minus">−</button><b>${product.cantidad}</b><button type="button" data-action="plus">＋</button></div><button class="remove" type="button" data-action="remove" aria-label="Quitar">×</button></div>`).join('');
}
function friendlyError(error){
  const message=clean(error?.message||error);const map=[['limite de pedidos','Se alcanzó temporalmente el límite de pedidos. Esperá unos minutos e intentá nuevamente.'],['dispositivo alcanzo','Creaste varios pedidos en poco tiempo. Esperá 15 minutos e intentá nuevamente.'],['enlace de pedidos','Este enlace ya no está disponible. Solicitá uno nuevo al local.'],['Productos inexistentes','Uno de los productos ya no está disponible. Quitalo y volvé a buscarlo.']];
  const match=map.find(([needle])=>message.toLowerCase().includes(needle.toLowerCase()));return match?match[1]:(message||'No se pudo completar la operación.');
}
async function createOrder(confirmDuplicate=false){
  if(state.busy)return;setError('order-error','');
  if(!state.identity)return showScreen('identity');if(!state.products.length)return setError('order-error','Agregá al menos un producto.');
  const origin=clean($('public-origin').value);if(!origin)return setError('order-error','Seleccioná el local de origen.');
  state.busy=true;$('submit-public-order').disabled=true;$('submit-public-order').textContent='Creando pedido…';
  try{
    const result=await rpc('pedido_publico_crear',{
      p_enlace:state.token,p_nombre:state.identity.nombre,p_apellido:state.identity.apellido,p_telefono:state.identity.telefono||null,
      p_origen:origin,p_productos:state.products.map(item=>({codigo:item.codigo,cantidad:item.cantidad})),p_urgente:$('public-urgent').checked,
      p_notas:clean($('public-notes').value)||null,p_dispositivo:getDeviceId(),p_confirmar_duplicado:!!confirmDuplicate
    });
    if(result.code==='possible_duplicate'){state.pendingDuplicate=true;$('duplicate-products').textContent=(result.products||[]).join(', ')||'Productos repetidos';$('duplicate-modal').hidden=false;return;}
    if(!result.ok)throw new Error(result.error||'No se pudo crear el pedido');
    saveLastOrder(result);showConfirmation(result);
  }catch(error){setError('order-error',friendlyError(error));}
  finally{state.busy=false;$('submit-public-order').disabled=false;$('submit-public-order').textContent='Crear pedido';}
}
function showConfirmation(result){
  const url=trackingUrl(result.tracking_token);showScreen('confirmation');$('confirmation-code').textContent=`PEDIDO #${result.order_code}`;$('tracking-link-value').textContent=url;$('confirmation-origin').textContent=result.origin||'–';$('confirmation-destination').textContent=result.destination||state.local?.nombre||'–';
  $('tracking-qr').innerHTML='';if(window.QRCode)new QRCode($('tracking-qr'),{text:url,width:184,height:184,colorDark:'#111119',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  $('copy-tracking').onclick=()=>copyText(url);$('share-tracking').onclick=()=>shareLink(url,result.order_code);$('open-tracking').onclick=()=>location.href=url;
}
async function copyText(value){try{await navigator.clipboard.writeText(value);toast('Enlace copiado');}catch(_){const area=document.createElement('textarea');area.value=value;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();toast('Enlace copiado');}}
async function shareLink(url,code){if(navigator.share){try{await navigator.share({title:`Pedido #${code} · Sucaneitor`,text:'Seguimiento de mi pedido:',url});return;}catch(error){if(error?.name==='AbortError')return;}}await copyText(url);}
function createAnother(){clearLastOrder();state.products=[];state.identity=null;$('identity-form').reset();$('public-notes').value='';$('public-urgent').checked=false;renderSelected();showScreen('identity');}

function bind(){
  $('identity-form').addEventListener('submit',submitIdentity);$('back-identity').addEventListener('click',()=>showScreen('identity'));$('public-search-button').addEventListener('click',searchProducts);
  $('public-product-search').addEventListener('input',event=>{clearTimeout(state.searchTimer);if(event.target.value.trim().length<2){state.searchResults=[];$('public-search-results').hidden=true;return;}state.searchTimer=setTimeout(searchProducts,350);});$('public-product-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();searchProducts();}});
  $('public-search-results').addEventListener('click',event=>{const button=event.target.closest('[data-product-index]');if(button)addProduct(Number(button.dataset.productIndex));});
  $('selected-products').addEventListener('click',event=>{const button=event.target.closest('[data-action]'),row=event.target.closest('[data-code]');if(!button||!row)return;const code=row.dataset.code;if(button.dataset.action==='minus')changeQuantity(code,-1);if(button.dataset.action==='plus')changeQuantity(code,1);if(button.dataset.action==='remove')removeProduct(code);});
  $('submit-public-order').addEventListener('click',()=>createOrder(false));$('duplicate-cancel').addEventListener('click',()=>{$('duplicate-modal').hidden=true;state.pendingDuplicate=false;});$('duplicate-confirm').addEventListener('click',()=>{$('duplicate-modal').hidden=true;state.pendingDuplicate=false;createOrder(true);});$('create-another').addEventListener('click',createAnother);
  document.addEventListener('click',event=>{if(!event.target.closest('.search-card'))$('public-search-results').hidden=true;});
}
document.addEventListener('DOMContentLoaded',()=>{bind();initialize();});
})();
