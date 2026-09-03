(function(root){
  'use strict';
  const categories={humedos:'Húmedos',snacks:'Snacks',chapitas:'Chapitas',higiene:'Higiene',arenas:'Arenas',accesorios:'Accesorios',farmacia:'Farmacia',raciones:'Raciones',sin_categoria:'Sin categoría identificada'};
  const states={abierta:'Abierto',cerrada:'Cerrado',archivada:'Archivado',preparando:'En preparación',enviado:'Enviada',cerrado:'Cerrado',archivado:'Archivado',en_control:'En control'};
  const stocks={'':'Cualquier stock',positive:'Con stock registrado',zero:'Stock registrado en cero',negative:'Stock registrado negativo',unknown:'Sin dato de stock'};
  const quantities={'':'Todas las cantidades',pending:'Por completar / sin controlar',shortage:'Cantidad menor a la esperada',excess:'Cantidad mayor / extras',exact:'Cantidad exacta'};
  const html=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const blank=()=>({query:'',product:'',local:'',origin:'',destination:'',user:'',date_field:'created',date_from:'',date_to:'',states:[],categories:[],stock:'',stock_min:'',stock_max:'',quantity:'',sort:'updated'});
  function validate(f){
    if(f.date_from&&f.date_to&&f.date_from>f.date_to)return 'La fecha inicial debe ser anterior a la final.';
    for(const key of ['stock_min','stock_max'])if(f[key]!==''&&!Number.isFinite(Number(f[key])))return 'Ingresá un stock válido.';
    if(f.stock_min!==''&&f.stock_max!==''&&Number(f.stock_min)>Number(f.stock_max))return 'El stock mínimo debe ser menor o igual al máximo.';
    return '';
  }
  function sanitize(input={}){const f=blank();for(const key of Object.keys(f)){if(Array.isArray(f[key]))f[key]=Array.isArray(input[key])?input[key].filter(v=>typeof v==='string').slice(0,20):[];else if(typeof input[key]==='string')f[key]=input[key].slice(0,200);}return f;}
  function hasProductFilter(f){return !!(f.product||f.categories.length||f.stock||f.stock_min!==''||f.stock_max!==''||f.quantity);}
  function date(value,time=false){if(!value)return '—';if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value.split('-').reverse().join('/');const d=new Date(value);if(!Number.isFinite(d.getTime()))return '—';return d.toLocaleString('es-UY',{timeZone:'America/Montevideo',day:'2-digit',month:'2-digit',year:'numeric',...(time?{hour:'2-digit',minute:'2-digit'}:{})});}
  let options=null,filters=blank(),page=0,total=0,rows=[],facets={},facetsAt=0,sequence=0,timer=null,key='',dialog=null;
  const $=id=>root.document.getElementById(id);
  function active(){return !!options&&!!options.cloud?.searchSessions;}
  function persist(){try{root.sessionStorage.setItem(key,JSON.stringify({filters,page}));}catch(_){}}
  function mount(config){
    if(!config.cloud?.searchSessions)return;
    const nextKey=`sucan.directory.v1.${config.cloud.user?.id||'user'}.${config.module}`;
    $('session-module-name').textContent={inventario:'Inventarios',reposicion:'Reposiciones',recepcion:'Control de remitos'}[config.module];
    $('session-module-subtitle').hidden=true;
    if(key===nextKey&&options){$('session-search').value=filters.query;$('session-sort').value=filters.sort;renderFilters();renderChips();render();return;}
    sequence++;clearTimeout(timer);closeDialog();options=config;key=nextKey;rows=[];facets={};page=0;filters=blank();
    try{const saved=JSON.parse(root.sessionStorage.getItem(key)||'null');if(saved){filters=sanitize(saved.filters);page=Math.max(0,Number(saved.page)||0);}}catch(_){}
    if(config.module==='recepcion'){filters.stock='';filters.stock_min='';filters.stock_max='';}
    const create=$('session-create-panel');$('directory-create-slot').appendChild(create);
    $('session-search').value=filters.query;
    $('session-search').oninput=()=>change('query',$('session-search').value,true);
    $('session-search-clear').onclick=()=>{filters.query='';$('session-search').value='';page=0;load();$('session-search').focus();};
    $('session-sort').value=filters.sort;$('session-sort').onchange=e=>change('sort',e.target.value);
    $('session-clear-filters').onclick=clear;
    $('session-previous').onclick=async()=>{if(page>0){page--;await load();$('sesiones-lista').scrollIntoView({block:'start'});}};
    $('session-next').onclick=async()=>{if((page+1)*24<total){page++;await load();$('sesiones-lista').scrollIntoView({block:'start'});}};
    $('session-filter-panel').open=!root.matchMedia('(max-width: 800px)').matches;
    renderFilters();renderChips();
  }
  function selectOptions(values,selected,first){return `<option value="">${html(first)}</option>`+values.map(v=>{const id=typeof v==='string'?v:v.id,label=typeof v==='string'?v:v.nombre+(v.guest?' · invitado':'');return `<option value="${html(id)}"${id===selected?' selected':''}>${html(label)}</option>`;}).join('');}
  function renderFilters(){
    const focused=root.document.activeElement,focusKey=focused?.dataset?.filter,focusGroup=focused?.dataset?.group,focusValue=focused?.value;
    const caret=focusKey&&focused.tagName==='INPUT'?focused.selectionStart:null;
    const f=filters,route=options.module!=='inventario',stock=options.module!=='recepcion';
    const locals=facets.locals||[],users=facets.users||[];
    const availableStates=options.module==='inventario'?['abierta','cerrada','archivada']:options.module==='reposicion'?['preparando','enviado','cerrado','archivado']:['en_control','cerrado','archivado'];
    $('session-filter-body').innerHTML=`<label>Local<select id="session-location-filter" data-filter="local">${selectOptions(locals,f.local,'Todos mis locales')}</select></label>
      ${route?`<div class="directory-route-filters"><label>Origen<select data-filter="origin">${selectOptions(locals,f.origin,'Cualquier origen')}</select></label><label>Destino<select data-filter="destination">${selectOptions(locals,f.destination,'Cualquier destino')}</select></label></div>`:''}
      <label>Usuario o invitado<select data-filter="user">${selectOptions(users,f.user,'Todas las personas')}</select></label>
      <fieldset><legend>Fechas</legend><label>Buscar por<select data-filter="date_field"><option value="created">Fecha de creación</option><option value="updated">Última actualización</option>${options.module==='recepcion'?'<option value="document">Fecha del remito</option>':''}</select></label><div class="directory-date-range"><label>Desde<input type="date" data-filter="date_from" value="${html(f.date_from)}"></label><label>Hasta<input type="date" data-filter="date_to" value="${html(f.date_to)}"></label></div><p class="directory-hint">Sin fechas: todo el historial. Horario de Uruguay.</p></fieldset>
      <fieldset><legend>Estado</legend>${availableStates.map(s=>`<label class="directory-check"><input type="checkbox" data-group="states" value="${s}"${f.states.includes(s)?' checked':''}>${states[s]}</label>`).join('')}</fieldset>
      <label>Producto<input type="search" data-filter="product" value="${html(f.product)}" placeholder="Nombre, código, barras o marca" maxlength="200" autocomplete="off"></label>
      <details class="directory-categories"${f.categories.length?' open':''}><summary>Categorías${f.categories.length?` · ${f.categories.length}`:''}</summary><p class="directory-hint">Orientativas: se identifican por el nombre del producto. Un producto puede tener más de una.</p>${Object.entries(categories).map(([id,label])=>`<label class="directory-check"><input type="checkbox" data-group="categories" value="${id}"${f.categories.includes(id)?' checked':''}>${label}</label>`).join('')}</details>
      <label>Cantidades<select data-filter="quantity">${Object.entries(quantities).map(([v,l])=>`<option value="${v}"${f.quantity===v?' selected':''}>${l}</option>`).join('')}</select></label>
      ${stock?`<fieldset><legend>Stock del archivo</legend><label>Disponibilidad<select data-filter="stock">${Object.entries(stocks).map(([v,l])=>`<option value="${v}"${f.stock===v?' selected':''}>${l}</option>`).join('')}</select></label><div class="directory-date-range"><label>Mínimo<input type="number" data-filter="stock_min" step="any" inputmode="decimal" value="${html(f.stock_min)}" placeholder="Sin mínimo"></label><label>Máximo<input type="number" data-filter="stock_max" step="any" inputmode="decimal" value="${html(f.stock_max)}" placeholder="Sin máximo"></label></div></fieldset>`:''}
      <details class="directory-help"><summary>Cómo funcionan los filtros</summary><p class="directory-hint">El filtro de personas incluye al creador y a quienes participaron. En invitados, agrupa los ingresos con el mismo nombre.</p><p class="directory-hint">${stock?(options.module==='inventario'?'El stock es el saldo del balance cargado en ese inventario.':'El stock es el de origen informado en el archivo de reposición.')+' No es stock en tiempo real. Sin archivo o sin dato no equivale a cero.':'En los remitos se comparan las cantidades esperadas y recibidas; no representan el stock del local.'}</p><p class="directory-hint">Producto, categoría y cantidades${stock?' o stock':''} deben coincidir en el mismo producto.</p></details><button type="button" class="btn btn-p btn-full directory-show-results">Ver resultados</button>`;
    $('session-filter-body').querySelector('[data-filter="date_field"]').value=f.date_field;
    $('session-filter-body').querySelector('.directory-show-results').onclick=()=>{$('session-filter-panel').open=false;$('sesiones-lista').scrollIntoView({block:'start'});};
    $('session-filter-body').oninput=event=>{const el=event.target;if(el.matches('input[data-filter]:not([type="date"])'))change(el.dataset.filter,el.value,true);};
    $('session-filter-body').onchange=event=>{const el=event.target;if(el.dataset.group){const group=el.dataset.group;filters[group]=[...$('session-filter-body').querySelectorAll(`input[data-group="${group}"]:checked`)].map(i=>i.value);page=0;load();}else if(el.dataset.filter&&(!el.matches('input')||el.type==='date'))change(el.dataset.filter,el.value);};
    const replacement=focusKey?$('session-filter-body').querySelector(`[data-filter="${focusKey}"]`):focusGroup?[...$('session-filter-body').querySelectorAll(`[data-group="${focusGroup}"]`)].find(el=>el.value===focusValue):null;
    if(replacement){replacement.focus({preventScroll:true});if(caret!==null&&typeof replacement.setSelectionRange==='function'&&['search','text'].includes(replacement.type))replacement.setSelectionRange(caret,caret);}
  }
  function change(field,value,debounce=false){filters[field]=value;page=0;clearTimeout(timer);sequence++;persist();renderChips();if(debounce)timer=setTimeout(()=>load(),350);else load();}
  function clear(){filters=blank();page=0;$('session-search').value='';$('session-sort').value='updated';renderFilters();load();}
  function chipEntries(){const f=filters,out=[];for(const [field,label] of [['query','Búsqueda'],['product','Producto'],['local','Local'],['origin','Origen'],['destination','Destino'],['date_from','Desde'],['date_to','Hasta'],['stock_min','Stock mínimo'],['stock_max','Stock máximo']])if(f[field]!=='')out.push([field,`${label}: ${field.startsWith('date_')?date(f[field]):f[field]}`]);if(f.user)out.push(['user',facets.users?.find(u=>u.id===f.user)?.nombre||'Usuario seleccionado']);if(f.stock)out.push(['stock',stocks[f.stock]||f.stock]);if(f.quantity)out.push(['quantity',quantities[f.quantity]]);for(const g of ['states','categories'])for(const value of f[g])out.push([g,(g==='states'?states:categories)[value]||value,value]);return out;}
  function renderChips(){const chips=chipEntries();$('session-active-filters').innerHTML=chips.map(([key,label,value])=>`<button type="button" data-remove="${key}" data-value="${html(value||'')}" aria-label="Quitar filtro ${html(label)}">${html(label)} <span aria-hidden="true">×</span></button>`).join('');$('session-filter-count').textContent=chips.length?` (${chips.length})`:'';$('session-clear-filters').hidden=!chips.length;$('session-search-clear').hidden=!filters.query;$('session-active-filters').onclick=e=>{const button=e.target.closest('[data-remove]');if(!button)return;const field=button.dataset.remove;filters[field]=Array.isArray(filters[field])?filters[field].filter(v=>v!==button.dataset.value):'';page=0;$('session-search').value=filters.query;renderFilters();load();};}
  async function load({silent=false,refreshFacets=false}={}){
    if(!active())return;clearTimeout(timer);const seq=++sequence,config=options,f=sanitize(filters);persist();renderChips();
    const warning=validate(f);$('session-directory-error').textContent=warning;
    if(warning){$('sesiones-items').innerHTML='';$('session-results-count').textContent='Revisá los filtros para buscar.';$('session-pagination').hidden=true;return;}
    $('session-browser').setAttribute('aria-busy','true');if(!silent){$('session-results-count').textContent='Buscando…';$('sesiones-items').innerHTML='<div class="directory-empty" role="status">Buscando en el historial…</div>';}
    try{
      const data=await config.cloud.searchSessions(config.module,{...f,facets:refreshFacets||!facets.locals||Date.now()-facetsAt>60000},page);
      if(seq!==sequence||config!==options)return;
      total=Number(data.total)||0;
      if(page>0&&page*24>=total){page=Math.max(0,Math.ceil(total/24)-1);return load({silent});}
      rows=data.sessions||[];if(data.facets){facets=data.facets;facetsAt=Date.now();renderFilters();renderChips();}
      config.onResults?.(rows);render();persist();
    }catch(error){if(seq!==sequence||config!==options)return;root.console?.warn('No se pudo buscar en las sesiones',error);$('session-results-count').textContent='Búsqueda sin actualizar';$('session-directory-error').textContent='No se pudo completar la búsqueda. Revisá tu conexión y tocá Actualizar.';$('sesiones-items').innerHTML='<div class="directory-empty">No se muestran resultados anteriores para evitar confusiones.</div>';$('session-pagination').hidden=true;
    }finally{if(seq===sequence)$('session-browser').removeAttribute('aria-busy');}
  }
  function lineMarkup(p){const module=options.module,actual=module==='inventario'&&!p.registrado?'Sin contar':`${Number(p.cantidad)||0} ${Number(p.cantidad)===1?'unidad':'unidades'} ${module==='inventario'?(Number(p.cantidad)===1?'contada':'contadas'):module==='reposicion'?(Number(p.cantidad)===1?'juntada':'juntadas'):(Number(p.cantidad)===1?'recibida':'recibidas')}`;return `<strong>${html(p.nombre)}</strong><small>Código ${html(p.codigo)}${p.barras_actuales?` · Barras ${html(p.barras_actuales)}`:''}${p.extra?' · Extra':''}</small><span>${html(actual)}${p.esperado!==null?` / ${Number(p.esperado)} ${module==='inventario'?'en balance':'esperadas'}`:''}${module!=='recepcion'?` · Stock archivo: ${p.stock===null?'sin dato':Number(p.stock)}`:''}</span>`;}
  function render(){
    $('session-results-count').textContent=total?`${total} ${total===1?'sesión encontrada':'sesiones encontradas'} · ${page*24+1}–${Math.min((page+1)*24,total)}`:'No hay resultados';
    $('session-pagination').hidden=!total;$('session-page-label').textContent=`Página ${page+1} de ${Math.max(1,Math.ceil(total/24))}`;$('session-previous').disabled=page===0;$('session-next').disabled=(page+1)*24>=total;
    $('sesiones-items').innerHTML=rows.map(s=>{const route=s.module==='inventario'?[s.local_nombre,s.almacen].filter(Boolean).join(' · '):`${s.origin} → ${s.destination}`,sum=s.summary||{},matching=hasProductFilter(filters)||filters.query,unit=Number(sum.quantity)===1,action=s.module==='inventario'?'contada':s.module==='reposicion'?'juntada':'recibida';return `<article class="directory-session"><header><span class="directory-state ${s.can_edit?'open':''}">${html(states[s.estado]||s.estado)}</span><span class="directory-date">${date(s.created_at)}</span></header><h2>${html(s.nombre)}</h2><p class="directory-route">${html(route)}</p>${s.document_number?`<p class="directory-document">Remito ${html(s.document_number)}${s.date?` · ${date(s.date)}`:''}</p>`:''}<div class="directory-stats"><span><strong>${Number(sum.products)||0}</strong> ${Number(sum.products)===1?'producto':'productos'}</span><span><strong>${Number(sum.quantity)||0}</strong> ${unit?'unidad':'unidades'} ${action}${unit?'':'s'}</span>${sum.pending?`<span class="directory-pending"><strong>${sum.pending}</strong> por completar</span>`:''}${sum.extras?`<span>${sum.extras} extras</span>`:''}</div>
      <p class="directory-people">${(s.participants||[]).slice(0,3).map(p=>html(p.nombre)+(p.guest?' (invitado)':'')).join(' · ')||'Sin participantes registrados'}${s.participants?.length>3?` · +${s.participants.length-3}`:''}</p><small>Actualizada: ${date(s.updated_at,true)}</small>
      ${matching&&s.matches?.length?`<div class="directory-matches"><p>${hasProductFilter(filters)?`${sum.matches} ${sum.matches===1?'producto coincide':'productos coinciden'}`:'Productos de la sesión'}</p>${s.matches.map(p=>`<div>${lineMarkup(p)}</div>`).join('')}${sum.matches>3?'<small>Ver productos para consultar más.</small>':''}</div>`:''}
      <footer><button type="button" data-inspect="${html(s.id)}">Ver productos</button>${s.module==='inventario'&&s.estado!=='abierta'?'':`<button type="button" class="directory-primary" data-enter="${html(s.id)}">${s.can_edit?'Abrir sesión':'Consultar sesión'} →</button>`}${s.can_delete?`<button type="button" class="directory-delete" data-delete="${html(s.id)}" aria-label="Eliminar ${html(s.nombre)}">Eliminar</button>`:''}</footer></article>`;}).join('')||'<div class="directory-empty"><strong>No encontramos sesiones con estos filtros.</strong><p>Probá otro producto, ampliá las fechas o quitá filtros.</p><button type="button" data-clear>Limpiar búsqueda</button></div>';
    $('sesiones-items').onclick=e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.enter||b.dataset.inspect||b.dataset.delete,s=rows.find(r=>r.id===id);if(b.hasAttribute('data-clear'))return clear();if(!s)return;if(b.dataset.inspect)inspect(s);else if(b.dataset.enter)options.onOpen?.(s);else options.onDelete?.(s);};
  }
  function closeDialog(){if(dialog){dialog.close();dialog.remove();dialog=null;}}
  function inspect(session){
    closeDialog();const previous=root.document.activeElement,d=root.document.createElement('dialog');dialog=d;d.className='directory-detail';d.setAttribute('aria-labelledby','directory-detail-title');
    d.innerHTML=`<header><div><small>CONSULTA · NO RESERVA PRODUCTOS</small><h2 id="directory-detail-title">${html(session.nombre)}</h2></div><button type="button" data-close aria-label="Cerrar detalle">×</button></header><p>${html(session.local_nombre||`${session.origin} → ${session.destination}`)} · ${html(states[session.estado]||session.estado)}</p><p>${html((session.participants||[]).map(p=>p.nombre+(p.guest?' (invitado)':'')).join(' · '))}</p><label>Buscar dentro de esta sesión<input type="search" data-search placeholder="Nombre, código, barras o marca" value="${html(filters.product)}" maxlength="200"></label><p data-count role="status"></p><div data-lines></div><footer><button type="button" data-prev>Anterior</button><span data-page></span><button type="button" data-next>Siguiente</button></footer>`;
    root.document.body.appendChild(d);d.showModal();let detailPage=0,detailSeq=0,detailTimer;
    d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>{detailSeq++;clearTimeout(detailTimer);d.remove();if(dialog===d)dialog=null;previous?.focus?.();});d.addEventListener('keydown',e=>e.stopPropagation());
    async function details(){const seq=++detailSeq;d.querySelector('[data-prev]').disabled=true;d.querySelector('[data-next]').disabled=true;d.querySelector('[data-count]').textContent='Consultando productos…';d.querySelector('[data-lines]').innerHTML='';try{const data=await options.cloud.sessionProducts(session.module,session.id,d.querySelector('[data-search]').value,detailPage);if(seq!==detailSeq||!d.open)return;d.querySelector('[data-count]').textContent=`${data.total} ${data.total===1?'producto':'productos'} · ${session.module==='inventario'?'El balance no es stock en tiempo real.':'Cantidades de esta sesión.'}`;d.querySelector('[data-lines]').innerHTML=data.products.map(p=>`<article>${lineMarkup(p)}</article>`).join('')||'<p>No hay productos con esta búsqueda.</p>';d.querySelector('[data-page]').textContent=`${detailPage+1} / ${Math.max(1,Math.ceil(data.total/40))}`;d.querySelector('[data-prev]').disabled=detailPage===0;d.querySelector('[data-next]').disabled=(detailPage+1)*40>=data.total;}catch(_){if(seq===detailSeq)d.querySelector('[data-count]').textContent='No se pudieron consultar los productos. Cambiá la búsqueda para reintentar.';}}
    d.querySelector('[data-search]').oninput=()=>{clearTimeout(detailTimer);detailSeq++;detailPage=0;detailTimer=setTimeout(details,350);};d.querySelector('[data-prev]').onclick=()=>{if(detailPage>0){detailPage--;details();}};d.querySelector('[data-next]').onclick=()=>{detailPage++;details();};details();
  }
  const api={mount,load,active,refresh:load,validate,sanitize,blank,normalize,hasProductFilter,categories,states,date};
  root.SucanSessionDirectory=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
