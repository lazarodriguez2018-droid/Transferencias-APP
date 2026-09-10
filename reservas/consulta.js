(async function(){
  'use strict';
  const $=id=>document.getElementById(id),E=window.ReservaEngine,cfg=window.SUCANEITOR_CLOUD_CONFIG;
  const db=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey);
  const html=v=>String(v==null?'':v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmt=v=>v?new Date(v).toLocaleString('es-UY',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  const itemOrigin=i=>i.procedencia==='proveedor'?`Esperando proveedor${i.proveedor_nombre?' · '+i.proveedor_nombre:''}`:i.procedencia==='pedido_local'?`Pedido a otro local${i.origen_local?' · Desde '+i.origen_local:''}${i.pedido_local_gestion==='crear'?' · Pedido creado':i.pedido_local_gestion==='existente'?' · Pedido vinculado':i.pedido_local_gestion==='externo'?' · WhatsApp o llamada':''}`:(E.sources[i.procedencia]||i.procedencia);
  const token=decodeURIComponent(location.hash.slice(1)).trim();
  try{
    if(!/^[a-f0-9]{48,128}$/i.test(token))throw new Error('El enlace no contiene un QR válido.');
    const {data,error}=await db.rpc('op_reserva_qr_detalle',{p_token:token});if(error)throw error;if(!data?.ok)throw new Error(data?.error||'No encontramos la reserva.');
    const r=data.reservation,d=E.deadlineInfo(r.expires_at);$('lookup-code').textContent=`RESERVA #${r.code} · ${r.local}`;$('lookup-customer').textContent=r.customer||'Sin cliente';$('lookup-reason').textContent=`${r.reason} · Responsable: ${r.responsible}`;$('lookup-state').textContent=E.labels[r.state]||r.state;$('lookup-state').className=`status ${r.state}`;
    $('lookup-data').innerHTML=`<div class="row"><span>Teléfono</span><strong>${html(r.phone||'—')}</strong></div><div class="row"><span>Ubicación en tienda</span><strong>${html(r.location||'Consultar al responsable')}</strong></div><div class="row"><span>Creada</span><strong>${fmt(r.created_at)}</strong></div><div class="row"><span>Mercadería desde</span><strong>${fmt(r.merchandise_at)}</strong></div><div class="row"><span>Plazo</span><strong>${html(d.label)}</strong></div><div class="row"><span>Referencia</span><strong>${html(r.reference||'—')}</strong></div>`;
    $('lookup-products').innerHTML=(r.items||[]).map(i=>`<div class="product"><strong>${html(i.nombre)} · ${i.cantidad}</strong><small>${html(i.codigo)} · ${html(itemOrigin(i))} · ${i.cantidad_local} en local · ${i.cantidad_entregada} entregadas${i.fecha_estimada?' · Estimado '+html(i.fecha_estimada):''}${i.remito_numero?' · Remito '+html(i.remito_numero):''}</small></div>`).join('')||'<p>Sin productos.</p>';
    if(r.state==='vencido'){$('lookup-alert').hidden=false;$('lookup-alert').textContent='Esta mercadería superó el plazo de reserva. Consultá al responsable antes de entregarla.';}
    const {data:{session}}=await db.auth.getSession();$('lookup-manage').href=session?`/reservas?qr=${encodeURIComponent(token)}`:'/?module=reservas';$('lookup-manage').textContent=session?'Gestionar esta reserva':'Iniciar sesión para gestionar';$('lookup-loading').hidden=true;$('lookup-content').hidden=false;
  }catch(error){$('lookup-loading').hidden=true;$('lookup-error').hidden=false;$('lookup-error-message').textContent=error.message||'No encontramos esta reserva.';}
})();
