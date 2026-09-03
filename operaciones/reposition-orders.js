(function (root) {
  'use strict';
  const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const code = id => String(id || '').slice(-8,-2).toUpperCase();
  const stateLabel = order => ({pendiente:'Pendiente de aceptación',aceptado:order.reposicion_id?'En preparación':'Aceptado · sin incorporar',listo:'Listo para enviar',transito:'En viaje',completo:'Recibido completo',incompleto:'Recibido con faltantes'})[order.estado] || order.estado;
  function quantities(order) {
    return (order.products || []).reduce((sum, p) => ({requested:sum.requested+Number(p.aceptada||0),prepared:sum.prepared+Number(p.preparada||0)}),{requested:0,prepared:0});
  }
  function transition(before, after) {
    if (!before || before.estado === after.estado) return '';
    if (after.estado === 'listo') return `Pedido #${code(after.id)} de ${after.cliente}: listo para enviar.`;
    if (before.estado === 'listo' && after.estado === 'aceptado') return `Pedido #${code(after.id)}: faltan unidades después de la corrección.`;
    return '';
  }
  function validateQuantities(order, values) {
    const products = order.products || [];
    if (!products.length || values.length !== products.length || new Set(values.map(v=>v.id)).size !== products.length) throw new Error('Revisá las cantidades de todos los productos.');
    for (const value of values) {
      const product=products.find(p=>p.id===value.id);
      if (!product || !Number.isInteger(value.cantidad) || value.cantidad<0 || value.cantidad>Number(product.solicitada)) throw new Error('Ingresá cantidades enteras entre cero y lo solicitado.');
    }
    if (!values.some(v=>v.cantidad>0)) throw new Error('Aceptá al menos una unidad o dejá el pedido pendiente.');
    return values;
  }
  function create(options) {
    let orders=[],canAccept=false,pendingCount=0,disposed=false,dialog=null,loading=null,refreshSequence=0;
    const seen=new Map(),seenSequence=new Map();
    let transports=[],responsible='';
    const context=options.context;
    const guest=!!options.guest;
    function render() {
      if (disposed) return;
      for (const id of options.hosts || []) {
        const host=root.document.getElementById(id); if (!host) continue;
        const pending=guest?pendingCount:orders.filter(o=>o.estado==='pendiente'&&!o.reposicion_id).length;
        const accepted=orders.filter(o=>o.estado==='aceptado'&&!o.reposicion_id).length;
        const linked=orders.filter(o=>o.reposicion_id===context.id).length;
        const ready=orders.filter(o=>o.reposicion_id===context.id&&o.estado==='listo').length;
        host.className='repo-orders-panel';
        host.innerHTML=`<div class="repo-orders-heading"><div><strong>Pedidos de este recorrido</strong><p>${guest?'Los pedidos aceptados se juntan con la reposición.':`${html(context.origin)} → ${html(context.destination)}`}</p></div><button type="button" data-order-action="refresh" aria-label="Actualizar pedidos">↻</button></div>
          ${pending?`<p class="repo-orders-warning">${pending} ${pending===1?'pedido pendiente':'pedidos pendientes'} de aceptación.${guest||!canAccept?' Avisale al responsable del local de origen.':''}</p>`:''}
          ${accepted?`<p>${accepted} ${accepted===1?'pedido aceptado disponible':'pedidos aceptados disponibles'} para agregar a esta reposición.</p>`:''}
          ${ready&&!guest?`<p>${ready} ${ready===1?'pedido listo':'pedidos listos'} para enviar. Abrí el pedido para consultar o registrar su envío.</p>`:''}
          ${!guest?`<button type="button" data-order-action="all">${pending?'Revisar pedidos pendientes':accepted?'Ver pedidos para agregar':'Ver pedidos'}${linked?` · ${linked} en esta reposición`:''}</button>`:''}
          ${guest&&orders.length?orders.map(order=>`<button type="button" data-order-id="${html(order.id)}">Ver pedido #${code(order.id)} · ${html(order.cliente)}</button>`).join(''):''}
          ${!pending&&!accepted&&!linked&&!guest?'<p>No hay pedidos pendientes de este recorrido.</p>':''}`;
        host.onclick=event=>{
          const action=event.target.closest('button'); if(!action)return;
          if(action.dataset.orderAction==='refresh')refresh(options.getCode?.(),true).catch(()=>{});
          else if(action.dataset.orderAction==='all')show();
          else if(action.dataset.orderId)show(action.dataset.orderId);
        };
        if(guest)host.hidden=!pending&&!orders.length;
      }
    }
    async function refresh(productCode, loud=false) {
      if(disposed)return;
      const sequence=++refreshSequence;
      try {
        const data=await options.load(productCode);
        if(disposed)return;
        // Observe every requested product, even if the picker advanced meanwhile.
        let announced=false;
        for(const order of data.orders||[]){if((seenSequence.get(order.id)||0)>sequence)continue;const message=transition(seen.get(order.id),order);if(message){options.notify?.(message);announced=true;}seen.set(order.id,order);seenSequence.set(order.id,sequence);}
        data.announced=announced;
        if(sequence!==refreshSequence)return data;
        orders=data.orders||[];canAccept=!guest&&data.can_accept===true;pendingCount=Number(data.pending_count)||0;
        transports=data.transports||[];responsible=data.responsible||'';
        render(); return data;
      }catch(error){
        if(disposed||sequence!==refreshSequence)return;
        root.console?.warn('No se pudieron consultar los pedidos de reposición',error);
        if(loud)options.notify?.('No se pudieron actualizar los pedidos. Intentá nuevamente.','error');
        for(const id of options.hosts||[]){const host=root.document.getElementById(id);if(host&&!orders.length){host.hidden=false;host.className='repo-orders-panel';host.innerHTML='<p>No se pudieron cargar los pedidos.</p><button type="button">Reintentar</button>';host.onclick=()=>refresh(options.getCode?.(),true).catch(()=>{});}}
        throw error;
      }
    }
    function close() {if(dialog&&!dialog._busy)dialog.close();}
    function shell(title) {
      let returnFocus;
      if(dialog){if(dialog._busy)return null;const old=dialog;returnFocus=old._returnFocus;old.close();old._cleanup?.(false);}
      const previous=returnFocus||root.document.activeElement,overflow=root.document.documentElement.style.overflow;
      const current=root.document.createElement('dialog');dialog=current;current.className='repo-order-dialog';
      current._returnFocus=previous;
      current.setAttribute('aria-labelledby','repo-order-dialog-title');
      current.innerHTML=`<header><h2 id="repo-order-dialog-title">${html(title)}</h2><button type="button" data-close aria-label="Cerrar pedido">×</button></header><div data-content></div><p data-error role="alert"></p><footer data-actions></footer>`;
      current.querySelector('[data-close]').onclick=close;
      current.addEventListener('keydown',event=>event.stopPropagation());
      current.addEventListener('cancel',event=>{if(current._busy)event.preventDefault();});
      let cleaned=false;
      current._cleanup=restoreFocus=>{if(cleaned)return;cleaned=true;current.remove();if(dialog===current)dialog=null;root.document.documentElement.style.overflow=overflow;options.unlock?.();if(restoreFocus)previous?.focus?.({preventScroll:true});};
      current.addEventListener('close',()=>current._cleanup(true));
      root.document.body.appendChild(current);options.lock?.();root.document.documentElement.style.overflow='hidden';current.showModal();
      return current;
    }
    function showList() {
      const current=shell('Pedidos de este recorrido');if(!current)return;
      current.querySelector('[data-content]').innerHTML=`<p>${html(context.origin)} → ${html(context.destination)}</p><p>Los aceptados se incorporan al crear una reposición. Si llegaron después, podés agregarlos acá. Revisá el recorrido antes de aceptar.</p><div class="repo-order-list">${orders.map(order=>{
        const q=quantities(order);return `<button type="button" data-order-id="${html(order.id)}"><strong>#${code(order.id)} · ${html(order.cliente)}</strong><span>${html(stateLabel(order))}${order.urgente?' · Urgente':''}</span><small>${order.products.length} producto(s) · ${q.prepared}/${q.requested} unidades juntadas</small></button>`;
      }).join('')||'<p>No hay pedidos disponibles para este recorrido.</p>'}</div>`;
      current.querySelector('[data-content]').onclick=event=>{const button=event.target.closest('[data-order-id]');if(button)showDetail(orders.find(o=>o.id===button.dataset.orderId));};
    }
    function showDetail(order) {
      if(!order){options.notify?.('El pedido ya no está disponible. Actualizá los pedidos.','error');return;}
      const current=shell(`Pedido #${code(order.id)}`);if(!current)return;
      const pending=order.estado==='pendiente',editable=canAccept&&!order.reposicion_id&&['pendiente','aceptado'].includes(order.estado);
      current.querySelector('[data-content]').innerHTML=`<p><strong>${html(order.cliente)}</strong><br>${html(order.origin)} → ${html(order.destination)}</p><p class="repo-order-state">${html(stateLabel(order))}${order.urgente?' · Urgente':''}</p>
        <div class="repo-order-products">${order.products.map(p=>`<article><strong>${html(p.nombre)}</strong><small>Código ${html(p.codigo)}</small><p>Solicitado: ${Number(p.solicitada)} · Aceptado: ${pending?'—':Number(p.aceptada)} · Juntado: ${Number(p.preparada)}</p>${editable&&pending?`<label>Cantidad a aceptar<input data-product-id="${html(p.id)}" type="number" min="0" max="${Number(p.solicitada)}" step="1" inputmode="numeric" value="${Number(p.solicitada)}"></label>`:''}</article>`).join('')}</div>
        <p>${editable?`Se agregará a <strong>${html(context.name)}</strong>. ${pending?'Podés aceptar una cantidad menor; el pedido quedará identificado como parcial.':'No hace falta volver a aceptar el pedido.'}`:guest?'Consulta del pedido vinculado a esta reposición. La aceptación la realiza el local de origen o un supervisor.':order.reposicion_id?'Al juntar todas las unidades aceptadas, el pedido queda listo para enviar. No significa que ya llegó al destino.':'Solo el local de origen o un supervisor puede aceptar este pedido.'}</p>`;
      current.querySelector('[data-actions]').innerHTML=`<button type="button" data-back>${editable&&pending?'Dejar pendiente':'Cerrar'}</button>${editable?`<button type="button" class="repo-order-primary" data-accept>${pending?'Aceptar y agregar':'Agregar a esta reposición'}</button>`:''}`;
      current.querySelector('[data-back]').onclick=close;
      const accept=current.querySelector('[data-accept]');
      if(accept)accept.onclick=async()=>{
        try {
          const values=pending?validateQuantities(order,Array.from(current.querySelectorAll('[data-product-id]'),input=>({id:input.dataset.productId,cantidad:input.value.trim()===''?NaN:Number(input.value)}))):null;
          current._busy=true;current.setAttribute('aria-busy','true');current.querySelectorAll('button,input').forEach(el=>el.disabled=true);current.querySelector('[data-error]').textContent='';accept.textContent='Guardando…';
          const result=await options.accept(order.id,pending,values);
          if(disposed)return;
          current._busy=false;current.close();
          options.notify?.(result.already_added?'El pedido ya estaba en esta reposición.':`Pedido #${code(order.id)} ${pending?'aceptado y agregado':'agregado'} a la reposición.`);
          try{await options.onIntegrated?.();await refresh();}catch(_){options.notify?.('El pedido se guardó. Actualizá la reposición para ver los cambios.','error');}
        }catch(error){
          if(disposed)return;
          root.console?.warn('No se pudo incorporar el pedido',error);
          current._busy=false;current.removeAttribute('aria-busy');current.querySelectorAll('button,input').forEach(el=>el.disabled=false);accept.textContent=pending?'Aceptar y agregar':'Agregar a esta reposición';
          current.querySelector('[data-error]').textContent=/^(Revisá|Ingresá|Aceptá|El pedido|Otra reposición|Solo el local|Las cantidades|Confirmá|Un producto)/.test(error.message||'')?error.message:'No se pudo guardar el pedido. Actualizá los pedidos y volvé a intentar.';
        }
      };
      renderShipping(current,order);
    }
    function renderShipping(current,order) {
      if(guest||!order.reposicion_id)return;
      const sent=order.shipping?.sent_at;
      const enabled=canAccept&&order.estado==='listo'&&!order.has_scale&&!order.needs_verification&&!!options.ship;
      const section=root.document.createElement('section');section.className='repo-order-shipping';
      section.innerHTML=`<h3>Envío del pedido</h3>${sent?`<p>Registrado el ${html(new Date(sent).toLocaleString('es-UY'))}${order.shipping.responsible?` por ${html(order.shipping.responsible)}`:''}.</p><p>Transporte: ${html(order.shipping.transport||'—')}<br>Remito: ${html(order.shipping.receipt||'No indicado')}<br>Seguimiento: ${html(order.shipping.tracking||'No indicado')}</p>`:enabled?`<p>Completá estos datos cuando el pedido salga del local. Quedarán registrados en <strong>Pedidos entre locales</strong>. Esto envía solo este pedido, no toda la reposición.</p><label>Transporte (obligatorio)<select data-transport><option value="">Seleccionar…</option>${transports.map(t=>`<option value="${html(t)}">${html(t)}</option>`).join('')}<option value="__other__">Otro transporte…</option></select></label><label data-other-wrap hidden>Nombre del transporte<input data-other maxlength="120"></label><label>N.º de remito (opcional)<input data-receipt maxlength="100" value="${html(order.shipping?.receipt||'')}"></label><label>N.º de seguimiento (opcional)<input data-tracking maxlength="160" value="${html(order.shipping?.tracking||'')}"></label><label>Responsable del envío (obligatorio)<input data-responsible maxlength="80" value="${html(responsible)}"></label><label class="repo-order-confirm"><input type="checkbox" data-confirm> Confirmo que este pedido ya salió del local.</label><p data-shipping-error role="alert"></p><button type="button" class="repo-order-primary" data-ship>Registrar envío</button>`:`<p>${order.has_scale?'Este pedido tiene una escala. Registrá su salida desde Pedidos entre locales para respetar el recorrido.':order.estado==='aceptado'?'Disponible cuando se hayan juntado todas las unidades aceptadas.':order.estado==='listo'?'El responsable del local de origen o un supervisor puede registrar la salida.':'Consultá el registro completo en Pedidos entre locales.'}</p>`}`;
      current.querySelector('[data-content]').appendChild(section);
      if(order.needs_verification&&!sent&&!order.has_scale)section.querySelector('p').textContent='Antes de enviar, confirmá las cantidades en el control final de Resumen.';
      if(!enabled||sent)return;
      section.querySelector('[data-transport]').onchange=event=>{section.querySelector('[data-other-wrap]').hidden=event.target.value!=='__other__';};
      section.querySelector('[data-ship]').onclick=async()=>{
        const get=selector=>section.querySelector(selector).value.trim();
        const data={transport:get('[data-transport]')==='__other__'?get('[data-other]'):get('[data-transport]'),receipt:get('[data-receipt]'),tracking:get('[data-tracking]'),responsible:get('[data-responsible]')};
        const errorHost=section.querySelector('[data-shipping-error]');errorHost.textContent='';
        if(!data.transport||!data.responsible||!section.querySelector('[data-confirm]').checked){errorHost.textContent='Completá el transporte, el responsable y la confirmación de salida.';return;}
        current._busy=true;current.setAttribute('aria-busy','true');current.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
        try{
          const result=await options.ship(order.id,data);if(disposed)return;
          current._busy=false;current.close();options.notify?.(result.already_sent?'El envío ya estaba registrado.':'Envío registrado en Pedidos entre locales.');
          try{await options.onIntegrated?.();await refresh();showDetail(orders.find(o=>o.id===order.id));}catch(_){options.notify?.('El envío se guardó. Actualizá la reposición para ver el registro.','error');}
        }catch(error){if(disposed)return;current._busy=false;current.removeAttribute('aria-busy');current.querySelectorAll('button,input,select').forEach(el=>el.disabled=false);errorHost.textContent=/^(El pedido|Solo el local|Completá|Este pedido|Las cantidades)/.test(error.message||'')?error.message:'No se pudo registrar el envío. Actualizá el pedido y volvé a intentar.';}
      };
    }
    async function show(orderId,productCode) {
      if(loading)return;
      loading=refresh(productCode??options.getCode?.(),true);
      try{await loading;if(disposed)return;if(orderId)showDetail(orders.find(o=>o.id===orderId));else showList();}
      catch(_){/* The refresh action already explains how to retry. */}
      finally{loading=null;}
    }
    function destroy(){disposed=true;refreshSequence++;if(dialog){dialog._busy=false;dialog.close();}seen.clear();seenSequence.clear();}
    return {refresh,show,destroy};
  }
  root.SucanRepositionOrders={create,code,stateLabel,quantities,transition,validateQuantities,html};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.SucanRepositionOrders;
})(typeof window!=='undefined'?window:globalThis);
