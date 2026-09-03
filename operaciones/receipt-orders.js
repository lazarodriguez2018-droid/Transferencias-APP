(function(root){
  'use strict';
  const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const code=id=>String(id||'').slice(-8,-2).toUpperCase();
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const states={pendiente:'Pendiente de aceptación',aceptado:'En preparación',listo:'Listo para enviar',transito:'En viaje',transito_escala:'En viaje a escala',en_escala:'En escala',llegado:'Llegó al local',incompleto:'Recibido con faltantes',completo:'Recibido completo',denegado:'Denegado',cancelado:'Cancelado'};
  const relations={vinculado:'Vinculado a este remito',remito:'Número de remito coincidente',fecha_productos:'Coincidencia por fecha y productos · confirmar',fecha_posterior:'Pedido o envío posterior al remito',otro_remito:'Corresponde a otro remito',sin_enviar:'Todavía no enviado',sin_productos:'Sus productos no figuran en este remito'};
  const lines=o=>o.pedido_productos||[];
  const pending=o=>lines(o).reduce((sum,p)=>sum+Math.max(0,Number(p.cantidad_aceptada??p.cantidad)-Number(p.cantidad_recibida||0)),0);
  const matching=(orders,sku)=>(orders||[]).filter(o=>lines(o).some(p=>String(p.codigo)===String(sku)&&p.en_remito));
  function allocation(order){
    const free=new Map();
    return lines(order).map(p=>{
      const left=free.has(p.codigo)?free.get(p.codigo):Number(p.disponible||0);
      const quantity=Math.min(left,Math.max(0,Number(p.cantidad_aceptada??p.cantidad)-Number(p.cantidad_recibida||0)));
      free.set(p.codigo,left-quantity);return {...p,quantity};
    });
  }
  function canLink(order){return ['transito','llegado','incompleto'].includes(order.estado)&&['remito','vinculado','fecha_productos'].includes(order.relation)&&lines(order).some(p=>p.en_remito);}
  function filtered(orders,query='',filter='all'){
    const q=normalize(query).trim();
    return orders.filter(o=>(filter!=='linked'||o.linked)&&(filter!=='pending'||pending(o)>0)&&(filter!=='notify'||o.cliente_aviso_pendiente))
      .filter(o=>!q||normalize([code(o.id),o.cliente,o.remito,...lines(o).flatMap(p=>[p.codigo,p.nombre])].join(' ')).includes(q))
      .sort((a,b)=>{const priority=o=>o.cliente_aviso_pendiente?0:o.linked&&pending(o)>0?1:canLink(o)?2:pending(o)>0?3:4;return priority(a)-priority(b);});
  }
  const api={html,code,states,relations,lines,pending,matching,allocation,canLink,filtered};
  root.SucanReceiptOrders=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);

let receiptLastOrderCode='',receiptOrderBusy=false;
function receiptOrderData(){return receiptState?.order_panel?.orders||[];}
function receiptOrderLink(id){return `/?module=pedidos&pedido=${encodeURIComponent(id)}`;}
function receiptOrderDate(value){if(!value)return 'Sin registrar';const d=new Date(value);return Number.isNaN(d.getTime())?'Sin registrar':d.toLocaleString('es-UY',{dateStyle:'short',timeStyle:'short'});}
function receiptApplyOrderPanel(data,code){
  if(data.order_panel){receiptState.order_panel=data.order_panel;receiptState.orders=data.order_panel.orders.filter(o=>o.linked);}
  if(code)receiptLastOrderCode=code;
}
function receiptOrderProductNotice(sku){
  const ui=SucanReceiptOrders,orders=ui.matching(receiptOrderData(),sku);
  if(!orders.length)return '';
  return `<aside class="receipt-order-notice" role="status"><strong>Este producto figura en ${orders.length===1?'un pedido':`${orders.length} pedidos`}</strong>${orders.map(o=>`<div><a href="${receiptOrderLink(o.id)}" target="_blank" rel="noopener">Ver pedido #${ui.code(o.id)} · ${ui.html(o.cliente||'Sin cliente')}</a><span>${ui.html(ui.relations[o.relation]||'Revisar pedido')} · ${ui.pending(o)} unidades pendientes en el pedido</span></div>`).join('')}<button type="button" class="btn btn-s" onclick="showReceiptTab('pedidos')">Revisar pedidos esperados</button></aside>`;
}
function renderReceiptOrderNotice(){
  const camera=document.getElementById('receipt-camera-orders');if(camera)camera.hidden=!SucanReceiptOrders.matching(receiptOrderData(),receiptCurrentCode||receiptLastOrderCode).length;
  const host=document.getElementById('receipt-order-notice');if(!host)return;
  host.innerHTML=receiptOrderProductNotice(receiptCurrentCode||receiptLastOrderCode);host.hidden=!host.innerHTML;
}
function renderReceiptOrders(){
  if(!receiptState)return;
  const ui=SucanReceiptOrders,all=receiptOrderData(),canReceive=receiptState.order_panel?.can_receive&&receiptCanEdit(),canNotify=receiptState.order_panel?.can_notify;
  const counter=document.getElementById('receipt-orders-count');
  if(counter){const count=all.filter(o=>ui.pending(o)>0||o.cliente_aviso_pendiente).length;counter.textContent=count;counter.classList.toggle('show',count>0);}
  const route=document.getElementById('receipt-orders-route');if(route)route.textContent=`${receiptState.origin} → ${receiptState.destination} · Remito ${receiptState.document_number}`;
  const summary=document.getElementById('receipt-orders-list');
  if(summary)summary.innerHTML=`<p>${all.filter(o=>o.linked).length} pedidos vinculados · ${all.filter(o=>o.cliente_aviso_pendiente).length} clientes por avisar</p><button class="btn btn-s" onclick="showReceiptTab('pedidos')">Ver pedidos esperados</button>`;
  const host=document.getElementById('receipt-expected-orders');if(!host)return;
  const orders=ui.filtered(all,document.getElementById('receipt-order-search')?.value,document.getElementById('receipt-order-filter')?.value);
  host.innerHTML=orders.map(o=>{
    const quantity=ui.allocation(o).reduce((sum,p)=>sum+p.quantity,0),verify=ui.lines(o).some(p=>p.en_remito&&p.verificar);
    const receivable=canReceive&&ui.canLink(o),remaining=ui.pending(o);
    const products=ui.lines(o).map(p=>`<li><div><strong>${ui.html(p.nombre)}</strong><span>Código ${ui.html(p.codigo)} · ${p.en_remito?`En remito: ${p.remito_esperado} · Controlado: ${p.remito_recibido}${p.verificar?' · Control final pendiente':''}`:'No figura en este remito'}</span></div><div class="receipt-order-quantity"><b>${Number(p.cantidad_recibida||0)} / ${Number(p.cantidad_aceptada??p.cantidad)}</b><span>recibido en el pedido</span><span>${Number(p.asignada_aqui||0)} de este remito</span></div></li>`).join('');
    return `<article class="receipt-order ${o.cliente_aviso_pendiente?'alert':''}" id="expected-order-${ui.html(o.id)}">
      <div class="receipt-order-head"><div><h2>Pedido #${ui.code(o.id)} · ${ui.html(o.cliente||'Sin cliente')}</h2><span>${ui.html(ui.states[o.estado]||o.estado)}${o.urgente?' · Urgente':''}</span></div><a class="btn btn-s" href="${receiptOrderLink(o.id)}" target="_blank" rel="noopener">Ver pedido ↗</a></div>
      <p class="receipt-order-relation">${ui.html(ui.relations[o.relation]||'Revisar vinculación')}</p>
      <div class="receipt-order-meta"><span>Pedido: ${receiptOrderDate(o.created_at)}</span><span>Envío: ${receiptOrderDate(o.shipped_at)}</span><span>Remito del envío: ${ui.html(o.remito||'Sin número')}</span><span>Transporte: ${ui.html(o.transporte||'Sin registrar')}</span>${o.shipping_responsible?`<span>Responsable: ${ui.html(o.shipping_responsible)}</span>`:''}${o.tracking?`<span>Seguimiento: ${ui.html(o.tracking)}</span>`:''}${o.telefono?`<span>Teléfono: ${ui.html(o.telefono)}</span>`:''}</div>
      <ul class="receipt-order-products">${products}</ul>
      <div class="receipt-order-actions">
      ${receivable&&verify?`<button class="btn btn-s" onclick="openReceiptQuantityVerification()">Verificar cantidades</button>`:receivable&&quantity>0?`<button class="btn btn-p" data-receive-order="${ui.html(o.id)}" ${receiptOrderBusy?'disabled':''} onclick="receiptConfirmOrder(this.dataset.receiveOrder)">${o.linked?'Registrar recepción del pedido':'Vincular y registrar recepción'}</button>`:''}
      ${remaining>0?`<span class="tm">Faltan ${remaining} unidades en el pedido.${receivable&&!verify&&!quantity?' No hay nuevas unidades controladas disponibles.':''}</span>`:'<span class="tm">Todas las unidades del pedido están recibidas.</span>'}
      ${o.cliente_aviso_pendiente?`<strong>Avisar al cliente</strong>${canNotify?`${o.telefono?`<button class="btn btn-g" data-contact-order="${ui.html(o.id)}" onclick="receiptContactOrder(this.dataset.contactOrder)">Abrir WhatsApp</button>`:''}<button class="btn btn-s" data-notified-order="${ui.html(o.id)}" onclick="receiptMarkCustomerNotified(this.dataset.notifiedOrder)">Marcar cliente avisado</button>`:'<span class="tm">El local de destino debe contactar al cliente.</span>'}`:o.cliente_avisado_at?`<span class="tm">Cliente avisado: ${receiptOrderDate(o.cliente_avisado_at)}</span>`:''}
      </div>${o.cliente_aviso_pendiente&&canNotify?'<p class="tm">El mensaje no se envía automáticamente. Marcá el aviso después de contactar al cliente.</p>':''}
      </article>`;
  }).join('')||`<div class="repo-empty">${all.length?'No hay pedidos con estos filtros.':'No hay pedidos pendientes desde este origen.'}</div>`;
  renderReceiptOrderNotice();
}
async function receiptConfirmOrder(id){
  if(receiptOrderBusy||!receiptCanEdit())return;
  receiptOrderBusy=true;
  try{
    const {data,error}=await window.SucanCloud.db.rpc('op_recepcion_panel_pedidos',{p_recepcion:sessionId});if(error)throw error;
    receiptApplyOrderPanel({order_panel:data});
    const o=data.orders.find(o=>o.id===id),ui=SucanReceiptOrders;
    if(!o||!ui.canLink(o)||!data.can_receive)throw new Error('El pedido ya no está disponible para recibir.');
    if(ui.lines(o).some(p=>p.verificar&&p.en_remito))throw new Error('Completá primero el control final de cantidades.');
    const rows=ui.allocation(o).filter(p=>p.quantity>0),quantity=rows.reduce((sum,p)=>sum+p.quantity,0);
    if(!quantity)throw new Error('No hay nuevas unidades controladas disponibles para este pedido.');
    const confirmed=await openAppDialog({title:o.linked?'Registrar recepción del pedido':'Confirmar vinculación',subtitle:`Pedido #${ui.code(id)} · ${o.cliente||'Sin cliente'}`,icon:'✓',confirmText:'Confirmar recepción',bodyHtml:`<p>${o.linked?'Se asignarán estas unidades al pedido.':'Coinciden el recorrido, las fechas y los productos. Confirmá que estas unidades están destinadas a este pedido.'}</p><ul>${rows.map(p=>`<li>${ui.html(p.nombre)} · ${p.quantity} unidades</li>`).join('')}</ul><p>${quantity<ui.pending(o)?'El pedido quedará recibido con faltantes.':'El pedido quedará completo y podrás avisar al cliente.'}</p><p class="tm">Estas unidades quedarán registradas para este pedido y no podrán descontarse del remito.</p>`});
    if(confirmed!==true)return;
    const result=await window.SucanCloud.db.rpc('op_recepcion_confirmar_pedido',{p_recepcion:sessionId,p_pedido:id,p_confirmar_vinculo:!o.linked});if(result.error)throw result.error;
    await refreshReceptionState(true);
    toast(result.data.estado==='completo'?'Pedido completo. Ya podés avisar al cliente.':`Recepción registrada: ${result.data.recibidas} de ${result.data.esperadas} unidades.`,'s');
  }catch(error){toast(error.message||'No se pudo confirmar el pedido.','e');}
  finally{receiptOrderBusy=false;renderReceiptOrders();}
}
function receiptContactOrder(id){const order=receiptOrderData().find(o=>o.id===id);if(order&&receiptState.order_panel?.can_notify&&order.cliente_aviso_pendiente)receiptOpenWhatsapp(order.telefono,order.cliente);}
