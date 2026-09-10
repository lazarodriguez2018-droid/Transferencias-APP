const assert=require('assert');
const fs=require('fs');
const http=require('http');
const path=require('path');

let chromium;
try{({chromium}=require('playwright'));}
catch(_error){console.log('reservations browser skipped (playwright unavailable)');process.exit(0);}

const root=path.resolve(__dirname,'..');
const externalBase=String(process.env.RESERVATIONS_BASE_URL||'').replace(/\/$/,'');
const browserExecutable=[process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(candidate=>candidate&&fs.existsSync(candidate));
const mime={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  const relative=(pathname.endsWith('/')?`${pathname}index.html`:pathname).replace(/^\/+/, '');
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){
    response.writeHead(404);response.end('Not found');return;
  }
  response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(file).pipe(response);
});

const supabaseStub=`
window.__reservationRpcCalls=[];
let reservation=null,items=[],comments=[],events=[];
const context={
  actor:{name:'Empleado prueba',local:'PDE',warehouse:'01',supervisor:false,role:'usuario'},
  locals:[{id:'11111111-1111-4111-8111-111111111111',nombre:'PDE',almacen:'01'}],
  reasons:[{id:'22222222-2222-4222-8222-222222222222',local_nombre:'PDE',nombre:'Retiro en tienda',activo:true,orden:10}],
  config:{PDE:{horas_reserva:48,dias_recepcion:[1,3,5],ubicacion_reservas:'Estante de pruebas',printer_path:null,printer_profile:'star-bsc10-80-max'}}
};
function detail(){return {reservation:{...reservation},items:items.map(item=>({...item})),comments:comments.map(comment=>({...comment})),events:events.map(event=>({...event}))};}
function summary(){return {...reservation,productos:items.length,unidades:items.reduce((sum,item)=>sum+item.cantidad,0),unidades_local:items.reduce((sum,item)=>sum+item.cantidad_local,0),unidades_entregadas:items.reduce((sum,item)=>sum+item.cantidad_entregada,0)};}
function recalculate(){
  const total=items.reduce((sum,item)=>sum+item.cantidad,0),local=items.reduce((sum,item)=>sum+item.cantidad_local,0),delivered=items.reduce((sum,item)=>sum+item.cantidad_entregada,0);
  if(delivered>0&&delivered<total)reservation.estado='parcial';
  else if(total>0&&local+delivered>=total)reservation.estado='listo';
  else if(local>0)reservation.estado='recibido';
  else reservation.estado='buscando';
  reservation.updated_at=new Date().toISOString();
}
const db={
  auth:{getSession:async()=>({data:{session:{user:{id:'33333333-3333-4333-8333-333333333333'}}}})},
  rpc:async(name,args)=>{
    window.__reservationRpcCalls.push({name,args});
    if(name==='op_reserva_contexto')return {data:context,error:null};
    if(name==='op_reserva_listar'){
      const history=!!args.p_filtros.history,closed=reservation&&['completado','cancelado'].includes(reservation.estado);
      return {data:reservation&&history===closed?[summary()]:[],error:null};
    }
    if(name==='op_reserva_buscar_productos')return {data:[{codigo:'ALIM-001',nombre:'Alimento premium',marca:'SUCAN'}],error:null};
    if(name==='op_reserva_buscar_clientes')return {data:[],error:null};
    if(name==='op_reserva_crear'){
      const input=args.p_datos,now=new Date().toISOString();
      reservation={id:'44444444-4444-4444-8444-444444444444',codigo:'SUCAN001',local_nombre:'PDE',local_almacen:'01',motivo_id:input.motivo_id,motivo_nombre:'Retiro en tienda',motivo_comentario:input.motivo_comentario,responsable_nombre:input.responsable,cliente_nombre:input.cliente.nombre,cliente_apellido:input.cliente.apellido,cliente_telefono:input.cliente.telefono,cliente_direccion:input.cliente.direccion,cliente_documento:input.cliente.documento,referencia_externa:input.referencia_externa,estado:'buscando',created_at:now,updated_at:now,mercaderia_local_at:null,vencimiento_at:null,qr_token:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
      items=input.items.map((item,index)=>({id:'55555555-5555-4555-8555-55555555555'+index,reserva_id:reservation.id,codigo:item.codigo,nombre:item.nombre,cantidad:item.cantidad,cantidad_local:item.cantidad_local,cantidad_entregada:0,procedencia:item.procedencia,origen_local:item.origen_local,fecha_estimada:item.fecha_estimada,remito_numero:item.remito_numero,comentario:item.comentario,estado:item.cantidad_local?'separado':'pendiente',created_at:now}));
      comments=[];events=[{id:1,accion:'crear',estado:'buscando',detalle:{},autor_nombre:'Empleado prueba',created_at:now}];recalculate();
      return {data:{ok:true,id:reservation.id,code:reservation.codigo,state:reservation.estado,qr_token:reservation.qr_token},error:null};
    }
    if(name==='op_reserva_detalle')return {data:detail(),error:null};
    if(name==='op_reserva_actualizar_item'){
      const item=items.find(row=>row.id===args.p_item),before=item.cantidad_local;
      item.cantidad_local=args.p_datos.cantidad_local;item.estado=args.p_datos.estado;item.fecha_estimada=args.p_datos.fecha_estimada===undefined?item.fecha_estimada:args.p_datos.fecha_estimada;item.remito_numero=args.p_datos.remito_numero===undefined?item.remito_numero:args.p_datos.remito_numero;item.comentario=args.p_datos.comentario===undefined?item.comentario:args.p_datos.comentario;
      if(before===0&&item.cantidad_local>0){reservation.mercaderia_local_at=new Date().toISOString();reservation.vencimiento_at=new Date(Date.now()+48*3600000).toISOString();}
      recalculate();events.unshift({id:events.length+1,accion:'actualizar_producto',estado:item.estado,detalle:{},autor_nombre:'Empleado prueba',created_at:new Date().toISOString()});return {data:detail(),error:null};
    }
    if(name==='op_reserva_comentar'){
      comments.unshift({id:'66666666-6666-4666-8666-666666666666',texto:args.p_texto,autor_nombre:'Empleado prueba',created_at:new Date().toISOString()});return {data:comments[0],error:null};
    }
    if(name==='op_reserva_cambiar_estado'){
      reservation.estado=args.p_estado;reservation.updated_at=new Date().toISOString();events.unshift({id:events.length+1,accion:'cambiar_estado',estado:args.p_estado,detalle:{},autor_nombre:'Empleado prueba',created_at:new Date().toISOString()});return {data:detail(),error:null};
    }
    if(name==='op_reserva_finalizar'){
      for(const delivery of args.p_entregas){const item=items.find(row=>row.id===delivery.id),delta=delivery.cantidad-item.cantidad_entregada;item.cantidad_entregada=delivery.cantidad;item.cantidad_local=Math.max(0,item.cantidad_local-delta);item.estado=item.cantidad_entregada>=item.cantidad?'entregado':item.estado;}
      const total=items.reduce((sum,item)=>sum+item.cantidad,0),delivered=items.reduce((sum,item)=>sum+item.cantidad_entregada,0);reservation.estado=delivered>=total?'completado':'parcial';reservation.final_tipo=args.p_tipo;reservation.final_comentario=args.p_comentario;reservation.completed_at=reservation.estado==='completado'?new Date().toISOString():null;reservation.updated_at=new Date().toISOString();events.unshift({id:events.length+1,accion:reservation.estado==='completado'?'finalizar':'entrega_parcial',estado:reservation.estado,detalle:{},autor_nombre:'Empleado prueba',created_at:new Date().toISOString()});return {data:detail(),error:null};
    }
    if(name==='op_reserva_corregir_cierre'){
      for(const delivery of args.p_entregas){const item=items.find(row=>row.id===delivery.id),returned=item.cantidad_entregada-delivery.cantidad;item.cantidad_entregada=delivery.cantidad;item.cantidad_local=Math.min(item.cantidad-delivery.cantidad,item.cantidad_local+returned);item.estado=item.cantidad_local+item.cantidad_entregada>=item.cantidad?'separado':'recibido';}
      reservation.final_tipo=null;reservation.final_comentario=null;reservation.completed_at=null;recalculate();events.unshift({id:events.length+1,accion:'corregir_cierre',estado:reservation.estado,detalle:{},autor_nombre:'Empleado prueba',created_at:new Date().toISOString()});return {data:detail(),error:null};
    }
    if(name==='op_reserva_pedidos_disponibles')return {data:[],error:null};
    return {data:{ok:true},error:null};
  },
  channel:()=>{const channel={on:()=>channel,subscribe:()=>{throw new DOMException('The operation is insecure.','SecurityError');}};return channel;},
  removeChannel:async()=>{}
};
window.supabase={createClient:()=>db};
`;

(async()=>{
  if(!externalBase)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(browserExecutable?{executablePath:browserExecutable}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const warnings=[],browserErrors=[];
  page.on('console',message=>{if(message.type()==='warning')warnings.push(message.text());if(message.type()==='error')browserErrors.push(message.text());});
  page.on('pageerror',error=>browserErrors.push(error.message));
  await page.route('**/npm/@supabase/supabase-js@2**',route=>route.fulfill({contentType:'application/javascript',body:supabaseStub}));
  await page.route('**/npm/qrcodejs@1.0.0/**',route=>route.fulfill({contentType:'application/javascript',body:'window.QRCode=function(){};QRCode.CorrectLevel={M:0};'}));
  await page.route('**/npm/jsbarcode@3.12.3/**',route=>route.fulfill({contentType:'application/javascript',body:'window.JsBarcode=function(){};'}));
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  try{
    const address=server.address(),target=externalBase?`${externalBase}/reservas/`:`http://127.0.0.1:${address.port}/reservas/`;
    await page.goto(target,{waitUntil:'domcontentloaded'});
    try{await page.waitForSelector('#app:not([hidden])',{timeout:10000});}
    catch(error){
      const state=await page.evaluate(()=>({title:document.title,bootHidden:document.querySelector('#boot')?.hidden,appHidden:document.querySelector('#app')?.hidden,missingHidden:document.querySelector('#access-missing')?.hidden,toast:document.querySelector('#toast')?.textContent}));
      throw new Error(`El módulo no abrió: ${JSON.stringify({state,browserErrors})}`,{cause:error});
    }
    if(browserErrors.length)throw new Error(`La página produjo errores de JavaScript: ${JSON.stringify(browserErrors)}`);
    assert.equal(await page.locator('#access-missing').isHidden(),true,'Un fallo de WebSocket no debe mostrar que falta el enlace');
    assert.equal(await page.locator('#actor-name').textContent(),'Empleado prueba','La sesión autenticada debe abrir el módulo');
    await page.waitForFunction(()=>document.querySelector('#active-list')?.textContent.includes('No hay reservas'));
    assert.equal(await page.locator('#toast').evaluate(element=>element.classList.contains('show')),false,'El fallo opcional de Realtime no debe mostrarse como error al usuario');
    assert(warnings.some(message=>message.includes('actualización periódica')),'El diagnóstico debe quedar disponible en consola');
    const initialCalls=await page.evaluate(()=>window.__reservationRpcCalls.filter(call=>call.name==='op_reserva_listar').length);
    await page.locator('#refresh-button').click();
    await page.waitForFunction(count=>window.__reservationRpcCalls.filter(call=>call.name==='op_reserva_listar').length>count,initialCalls);

    await page.locator('button[data-view="new"]').click();
    await page.locator('#new-reason').selectOption('22222222-2222-4222-8222-222222222222');
    await page.locator('#customer-name').fill('Ana');
    await page.locator('#customer-surname').fill('Suárez');
    await page.locator('#customer-phone').fill('099 123 456');
    await page.locator('#customer-address').fill('Calle de prueba 123');
    await page.locator('#new-reference').fill('WEB-1001');
    await page.locator('#new-reason-comment').fill('Retira mañana por la tarde');
    await page.locator('#custom-product-button').click();
    await page.locator('#custom-code').fill('ALIM-001');
    await page.locator('#custom-name').fill('Alimento premium');
    await page.locator('#custom-form button[type="submit"]').click();
    const quantity=page.locator('[data-item-field="cantidad"]');
    await quantity.fill('2');await quantity.press('Tab');
    await page.locator('[data-item-field="procedencia"]').selectOption('proveedor');
    const localQuantity=page.locator('[data-item-field="cantidad_local"]');
    await localQuantity.fill('0');await localQuantity.press('Tab');
    await page.locator('[data-item-field="comentario"]').fill('Llega con el próximo proveedor');
    await page.evaluate(()=>{window.__createClicks=0;window.__createSubmits=0;document.querySelector('#create-button').addEventListener('click',()=>window.__createClicks++);document.querySelector('#reservation-form').addEventListener('submit',()=>window.__createSubmits++);});
    await page.locator('#create-button').click();
    try{await page.waitForSelector('#action-modal:not([hidden])',{timeout:10000});}
    catch(error){const state=await page.evaluate(()=>({formError:document.querySelector('#new-error')?.textContent,view:document.querySelector('#view-new')?.className,clicks:window.__createClicks,submits:window.__createSubmits,button:{disabled:document.querySelector('#create-button')?.disabled,type:document.querySelector('#create-button')?.type,visible:!!document.querySelector('#create-button')?.getClientRects().length},valid:document.querySelector('#reservation-form')?.checkValidity(),invalid:[...document.querySelectorAll('#reservation-form :invalid')].map(element=>({id:element.id,value:element.value})),calls:window.__reservationRpcCalls.map(call=>call.name)}));throw new Error(`La creación no abrió su confirmación: ${JSON.stringify({state,browserErrors})}`,{cause:error});}
    assert.match(await page.locator('#action-content').innerText(),/SUCAN001[\s\S]*espera de mercadería/,'La creación sin mercadería debe explicar el siguiente paso');
    const createPayload=await page.evaluate(()=>window.__reservationRpcCalls.find(call=>call.name==='op_reserva_crear').args.p_datos);
    assert.equal(createPayload.cliente.telefono,'099 123 456','El teléfono debe enviarse en la reserva');
    assert.equal(createPayload.items[0].procedencia,'proveedor','La procedencia elegida debe conservarse');
    assert.equal(createPayload.items[0].cantidad_local,0,'No debe marcarse mercadería que todavía no llegó');
    await page.getByRole('button',{name:'Entendido'}).click();

    const detailLocal=page.locator('.item-local');
    await detailLocal.fill('1');
    await page.locator('[data-save-item]').click();
    await page.waitForSelector('#action-modal:not([hidden])');
    assert.match(await page.locator('#action-content').innerText(),/Mercadería registrada[\s\S]*Imprimí la etiqueta/,'Al registrar la llegada debe recordarse la etiqueta');
    await page.getByRole('button',{name:'Ya tiene etiqueta'}).click();
    await page.locator('#detail-comment').fill('Cliente avisado por teléfono');
    await page.locator('[data-add-comment]').click();
    await page.waitForFunction(()=>document.querySelector('#comments-list')?.textContent.includes('Cliente avisado por teléfono'));

    await page.locator('[data-detail-action="progress"]').click();
    await page.locator('#progress-state').selectOption('separando');
    await page.locator('#progress-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('Separando'));
    await page.locator('[data-detail-action="finish"]').click();
    await page.locator('#finish-type').selectOption('retiro_cliente');
    await page.locator('#finish-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('Entrega parcial'));

    const remainingLocal=page.locator('.item-local');
    await remainingLocal.fill('1');
    await page.locator('[data-save-item]').click();
    await page.waitForSelector('#action-modal:not([hidden])');
    await page.getByRole('button',{name:'Ya tiene etiqueta'}).click();
    await page.locator('[data-detail-action="finish"]').click();
    await page.locator('#finish-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('Completada'));
    await page.locator('[data-close-modal]').click();
    await page.locator('button[data-view="history"]').click();
    await page.waitForSelector('#history-list [data-reservation-id]');
    assert.match(await page.locator('#history-list').innerText(),/COMPLETADA[\s\S]*Ana Suárez/,'La reserva cerrada debe quedar en el historial');

    await page.locator('#history-list [data-reservation-id]').click();
    await page.locator('[data-detail-action="correct-close"]').click();
    await page.locator('.corrected-delivery').fill('1');
    await page.locator('#correct-close-reason').fill('Se marcó una unidad de más por error');
    await page.locator('#correct-close-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#action-modal')?.hidden);
    assert.match(await page.locator('#detail-content').innerText(),/Entrega parcial[\s\S]*2 \/ 1/,'La corrección debe reabrir el seguimiento con la cantidad entregada correcta');
    await page.locator('[data-close-modal]').click();
    await page.locator('button[data-view="active"]').click();
    await page.waitForSelector('#active-list [data-reservation-id]');
    const requiredCalls=['op_reserva_crear','op_reserva_actualizar_item','op_reserva_comentar','op_reserva_cambiar_estado','op_reserva_finalizar','op_reserva_corregir_cierre'];
    const called=await page.evaluate(()=>window.__reservationRpcCalls.map(call=>call.name));
    for(const name of requiredCalls)assert(called.includes(name),`El recorrido de usuario debe ejecutar ${name}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'La vista móvil no debe desbordarse horizontalmente');
    console.log('reservations browser user journey and websocket fallback ok');
  }finally{
    await browser.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
