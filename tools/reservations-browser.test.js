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
  actor:{name:'Empleado prueba',local:'PDE',warehouse:'01',supervisor:true,role:'supervisor'},
  locals:[{id:'11111111-1111-4111-8111-111111111111',nombre:'PDE',almacen:'01'},{id:'22222222-1111-4111-8111-111111111111',nombre:'CDM',almacen:'02'}],
  reasons:[
    {id:'11111111-2222-4222-8222-222222222222',local_nombre:'PDE',nombre:'Pedido a otro local',activo:true,orden:10},
    {id:'22222222-2222-4222-8222-222222222222',local_nombre:'PDE',nombre:'Esperando proveedor',activo:true,orden:20},
    {id:'33333333-2222-4222-8222-222222222222',local_nombre:'PDE',nombre:'Ya estaba en local',activo:true,orden:30}
  ],
  config:{PDE:{horas_reserva:48,ubicacion_reservas:'Estante de pruebas',printer_path:null,printer_profile:'star-bsc10-80-max'}},
  reception_schedules:[
    {id:'77777777-7777-4777-8777-777777777771',local_nombre:'PDE',origen_tipo:'proveedor',origen_nombre:'Distribuidora X',dias_recepcion:[1,3,5],activo:true},
    {id:'77777777-7777-4777-8777-777777777772',local_nombre:'PDE',origen_tipo:'local',origen_nombre:'CDM',dias_recepcion:[2],activo:true}
  ]
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
      if(window.__holdNextReservationList){window.__holdNextReservationList=false;await new Promise(resolve=>setTimeout(resolve,350));}
      const history=!!args.p_filtros.history,closed=reservation&&['completado','cancelado'].includes(reservation.estado);
      return {data:reservation&&history===closed?[summary()]:[],error:null};
    }
    if(name==='op_reserva_buscar_productos')return {data:[{codigo:'010031110010408',nombre:'CORREA ZEE DOG - SELVA - XS',marca:'ZEE DOG'}],error:null};
    if(name==='op_reserva_buscar_clientes')return {data:[],error:null};
    if(name==='op_reserva_crear_v2'){
      const input=args.p_datos,now=new Date().toISOString();
      const sources=[...new Set(input.items.map(item=>item.procedencia))],motiveName=sources.length>1?'Origen mixto':sources[0]==='local'?'Ya estaba en local':sources[0]==='pedido_local'?'Pedido a otro local':'Esperando proveedor';
      reservation={id:'44444444-4444-4444-8444-444444444444',codigo:'SUCAN001',local_nombre:'PDE',local_almacen:'01',motivo_id:null,motivo_nombre:motiveName,motivo_comentario:input.motivo_comentario,responsable_nombre:input.responsable,cliente_id:input.cliente.id,cliente_nombre:input.cliente.nombre,cliente_apellido:input.cliente.apellido,cliente_telefono:input.cliente.telefono,cliente_direccion:input.cliente.direccion,cliente_documento:input.cliente.documento,referencia_externa:input.referencia_externa,estado:'buscando',created_at:now,updated_at:now,mercaderia_local_at:null,vencimiento_at:null,qr_token:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
      items=input.items.map((item,index)=>({id:'55555555-5555-4555-8555-55555555555'+index,reserva_id:reservation.id,codigo:item.codigo,nombre:item.nombre,cantidad:item.cantidad,cantidad_local:item.cantidad_local,cantidad_entregada:0,procedencia:item.procedencia,origen_local:item.origen_local,proveedor_nombre:item.proveedor_nombre,pedido_local_gestion:item.pedido_local_gestion,pedido_id:item.pedido_existente_id||null,fecha_estimada:item.fecha_estimada,remito_numero:item.remito_numero,comentario:item.comentario,estado:item.cantidad_local?'separado':'pendiente',created_at:now}));
      comments=[];events=[{id:1,accion:'crear',estado:'buscando',detalle:{},autor_nombre:'Empleado prueba',created_at:now}];recalculate();
      return {data:{ok:true,id:reservation.id,code:reservation.codigo,state:reservation.estado,qr_token:reservation.qr_token},error:null};
    }
    if(name==='op_reserva_editar'){
      const input=args.p_datos,now=new Date().toISOString(),sources=[...new Set(input.items.map(item=>item.procedencia))],motiveName=sources.length>1?'Origen mixto':sources[0]==='local'?'Ya estaba en local':sources[0]==='pedido_local'?'Pedido a otro local':'Esperando proveedor';
      Object.assign(reservation,{motivo_id:null,motivo_nombre:motiveName,motivo_comentario:input.motivo_comentario,responsable_nombre:input.responsable,cliente_id:input.cliente.id,cliente_nombre:input.cliente.nombre,cliente_apellido:input.cliente.apellido,cliente_telefono:input.cliente.telefono,cliente_direccion:input.cliente.direccion,cliente_documento:input.cliente.documento,referencia_externa:input.referencia_externa,estado:'buscando',updated_at:now});
      items=input.items.map((item,index)=>({id:item.id||'55555555-5555-4555-8555-55555555555'+index,reserva_id:reservation.id,codigo:item.codigo,nombre:item.nombre,cantidad:item.cantidad,cantidad_local:item.cantidad_local,cantidad_entregada:0,procedencia:item.procedencia,origen_local:item.origen_local,proveedor_nombre:item.proveedor_nombre,pedido_local_gestion:item.pedido_local_gestion,pedido_id:item.pedido_existente_id||null,fecha_estimada:item.fecha_estimada,remito_numero:item.remito_numero,comentario:item.comentario,estado:item.cantidad_local?'separado':'pendiente',created_at:now}));
      recalculate();events.unshift({id:events.length+1,accion:'editar',estado:reservation.estado,detalle:{},autor_nombre:'Empleado prueba',created_at:now});return {data:detail(),error:null};
    }
    if(name==='op_reserva_eliminar'){const result={ok:true,id:reservation.id,code:reservation.codigo};reservation=null;items=[];comments=[];events=[];return {data:result,error:null};}
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
    if(name==='op_reserva_guardar_recepcion_habitual'){
      const current=context.reception_schedules.find(row=>row.id===args.p_id),row={id:args.p_id||'77777777-7777-4777-8777-777777777779',local_nombre:args.p_local,origen_tipo:args.p_origen_tipo,origen_nombre:args.p_origen_nombre,dias_recepcion:args.p_dias,activo:args.p_activo};
      if(current)Object.assign(current,row);else context.reception_schedules.push(row);return {data:row,error:null};
    }
    if(name==='op_reserva_guardar_config')return {data:{horas_reserva:48,ubicacion_reservas:args.p_ubicacion,printer_path:args.p_printer_path,printer_profile:args.p_printer_profile},error:null};
    if(name==='op_reserva_enlace_estado')return {data:{exists:false,active:false},error:null};
    if(name==='op_reserva_pedidos_disponibles'||name==='op_reserva_pedidos_candidatos')return {data:[],error:null};
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
  await page.route('**/npm/qrcodejs@1.0.0/**',route=>route.fulfill({contentType:'application/javascript',body:`window.QRCode=function(box,options){const canvas=document.createElement('canvas');canvas.width=options.width;canvas.height=options.height;const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#000';for(let y=0;y<21;y++)for(let x=0;x<21;x++)if((x*y+x+y)%3===0)context.fillRect(x*canvas.width/21,y*canvas.height/21,canvas.width/21+1,canvas.height/21+1);box.appendChild(canvas);};QRCode.CorrectLevel={M:0};`}));
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
    assert.equal(await page.locator('#new-reason').count(),0,'La reserva no debe imponer un único motivo general');
    assert.match(await page.locator('#view-new').innerText(),/seleccioná el origen de cada uno[\s\S]*Dividir origen/,'La creación debe explicar el origen por producto y las cantidades divididas');
    await page.locator('#customer-name').fill('Ana');
    await page.locator('#customer-surname').fill('Suárez');
    await page.locator('#customer-phone').fill('099 123 456');
    await page.locator('#customer-address').fill('Calle de prueba 123');
    await page.locator('#new-reference').fill('WEB-1001');
    await page.locator('#new-reason-comment').fill('Retira mañana por la tarde');
    await page.locator('#product-search').fill('CORREA ZEE');
    await page.waitForSelector('#product-results [data-product-index="0"]');
    await page.locator('#product-results [data-product-index="0"]').click();
    const quantity=page.locator('[data-item-field="cantidad"]');
    await quantity.fill('3');await quantity.press('Tab');
    await page.locator('[data-split-item="0"]').click();await page.locator('[data-split-item="0"]').click();
    assert.equal(await page.locator('.item-editor').count(),3,'Un mismo producto debe poder dividirse en varias líneas de origen');
    await page.locator('[data-item-field="procedencia"]').nth(1).selectOption('proveedor');
    await page.locator('[data-item-field="proveedor_nombre"]').fill('Distribuidora X');await page.locator('[data-item-field="proveedor_nombre"]').press('Tab');
    assert.match(await page.locator('.item-editor').nth(1).innerText(),/Días habituales de recepción desde Distribuidora X:[\s\S]*lunes[\s\S]*miércoles[\s\S]*viernes/,'El calendario del proveedor debe orientar ese producto');
    await page.locator('[data-item-field="procedencia"]').nth(2).selectOption('pedido_local');
    await page.locator('[data-item-field="origen_local"]').selectOption('CDM');
    await page.locator('[data-item-field="pedido_local_gestion"]').selectOption('externo');
    assert.match(await page.locator('.item-editor').nth(2).innerText(),/Días habituales de recepción desde CDM:[\s\S]*martes/,'El calendario del local de origen debe orientar ese producto');
    await page.locator('[data-item-field="comentario"]').nth(1).fill('Llega con el próximo proveedor');
    if(process.env.RESERVATIONS_UI_SCREENSHOT)await page.screenshot({path:process.env.RESERVATIONS_UI_SCREENSHOT,fullPage:true});
    await page.evaluate(()=>{window.__createClicks=0;window.__createSubmits=0;document.querySelector('#create-button').addEventListener('click',()=>window.__createClicks++);document.querySelector('#reservation-form').addEventListener('submit',()=>window.__createSubmits++);});
    await page.locator('#create-button').click();
    try{await page.waitForSelector('#action-modal:not([hidden])',{timeout:10000});}
    catch(error){const state=await page.evaluate(()=>({formError:document.querySelector('#new-error')?.textContent,view:document.querySelector('#view-new')?.className,clicks:window.__createClicks,submits:window.__createSubmits,button:{disabled:document.querySelector('#create-button')?.disabled,type:document.querySelector('#create-button')?.type,visible:!!document.querySelector('#create-button')?.getClientRects().length},valid:document.querySelector('#reservation-form')?.checkValidity(),invalid:[...document.querySelectorAll('#reservation-form :invalid')].map(element=>({id:element.id,value:element.value})),calls:window.__reservationRpcCalls.map(call=>call.name)}));throw new Error(`La creación no abrió su confirmación: ${JSON.stringify({state,browserErrors})}`,{cause:error});}
    assert.match(await page.locator('#action-content').innerText(),/SUCAN001[\s\S]*etiqueta ya se puede imprimir[\s\S]*estado desde el QR/,'La creación sin mercadería debe permitir imprimir el seguimiento completo');
    const createPayload=await page.evaluate(()=>window.__reservationRpcCalls.find(call=>call.name==='op_reserva_crear_v2').args.p_datos);
    assert.equal(createPayload.cliente.telefono,'099 123 456','El teléfono debe enviarse en la reserva');
    assert.deepEqual(createPayload.items.map(item=>item.procedencia),['local','proveedor','pedido_local'],'Cada línea debe conservar su propio origen');
    assert.equal(createPayload.items[1].proveedor_nombre,'Distribuidora X','El proveedor debe viajar con su producto');
    assert.equal(createPayload.items[2].origen_local,'CDM','El local de origen debe viajar con su producto');
    assert.equal(createPayload.items[2].pedido_local_gestion,'externo','La gestión por fuera debe registrarse por producto');
    assert.equal(createPayload.items.reduce((sum,item)=>sum+item.cantidad_local,0),0,'No debe marcarse mercadería que todavía no se separó');
    await page.getByRole('button',{name:'Continuar sin imprimir'}).click();

    await page.locator('[data-close-modal]').click();
    await page.evaluate(()=>{window.__holdNextReservationList=true;});
    await page.locator('#refresh-button').click();
    assert.equal(await page.locator('#active-list [data-reservation-id]').isVisible(),true,'Una actualización lenta debe conservar visible la tarjeta existente');
    assert.doesNotMatch(await page.locator('#active-list').innerText(),/Actualizando reservas/,'La lista no debe desaparecer mientras sincroniza');
    await page.waitForFunction(()=>!document.querySelector('#active-list')?.matches('[aria-busy="true"]'));
    await page.locator('#active-list [data-reservation-id]').click();
    assert.equal(await page.locator('.print-shortcut [data-detail-action="print"]').isVisible(),true,'Imprimir etiqueta debe estar visible en cualquier estado');
    assert.match(await page.locator('.print-shortcut').innerText(),/Imprimila cuando necesites identificar la mercadería[\s\S]*unidades disponibles[\s\S]*pendientes/,'La impresión permanente debe explicar que el QR muestra el avance actual');
    assert.match(await page.locator('#detail-content').innerText(),/Origen mixto[\s\S]*Disponible en el local[\s\S]*Esperando proveedor · Distribuidora X[\s\S]*Pedido a otro local · Desde CDM[\s\S]*Coordinado fuera del sistema/i,'El detalle debe explicar el origen independiente de cada producto');

    await page.locator('.more-actions summary').click();
    await page.locator('[data-detail-action="edit"]').click();
    await page.waitForFunction(()=>document.querySelector('#form-title')?.textContent.includes('Editar reserva'));
    await page.locator('#new-responsible').fill('Empleado corregido');
    await page.locator('#customer-address').fill('Calle corregida 456');
    await page.locator('#new-reference').fill('WEB-1001-EDITADO');
    await page.locator('#create-button').click();
    await page.waitForSelector('#detail-modal:not([hidden])');
    assert.match(await page.locator('#detail-content').innerText(),/Empleado corregido[\s\S]*Calle corregida 456[\s\S]*WEB-1001-EDITADO/,'La edición debe reflejar los datos corregidos');
    const editPayload=await page.evaluate(()=>window.__reservationRpcCalls.find(call=>call.name==='op_reserva_editar').args.p_datos);
    assert.equal(editPayload.items[0].codigo,'010031110010408','La edición debe conservar el producto real seleccionado');
    assert.deepEqual(editPayload.items.map(item=>item.procedencia),['local','proveedor','pedido_local'],'La edición debe conservar todos los orígenes independientes');

    assert.match(await page.locator('.next-step').innerText(),/Registrar la mercadería cuando llegue[\s\S]*Registrar llegada y separación/,'El detalle debe explicar el siguiente paso');
    await page.locator('[data-next-step="receive"]').click();
    await page.locator('.next-local-qty').nth(1).fill('1');
    await page.locator('#arrival-form button[type="submit"]').click();
    await page.waitForSelector('#action-modal:not([hidden])');
    assert.match(await page.locator('#action-content').innerText(),/Mercadería registrada[\s\S]*Imprimí la etiqueta/,'Al registrar la llegada debe recordarse la etiqueta');
    await page.evaluate(()=>{const nativeOpen=window.open.bind(window);window.open=(...args)=>{const popup=nativeOpen(...args);popup.print=()=>{};popup.close=()=>{};return popup;};});
    const popupPromise=page.waitForEvent('popup');
    await page.locator('#action-content [data-print-created]').click();
    const popup=await popupPromise;await popup.waitForSelector('.label');
    const labelLayout=await popup.evaluate(()=>{const label=document.querySelector('.label').getBoundingClientRect(),qr=document.querySelector('.qr').getBoundingClientRect(),style=document.querySelector('style').textContent;return {label:{width:label.width,height:label.height},qr:{width:qr.width,height:qr.height},style};});
    assert.match(labelLayout.style,/@page\{size:80mm 200mm;margin:0\}/,'La impresión debe coincidir con el papel 80 por 200 mm del controlador');
    assert.match(labelLayout.style,/transform:rotate\(90deg\)/,'El contenido debe conservar el diseño horizontal dentro de la hoja física');
    assert(labelLayout.label.width>295&&labelLayout.label.width<305&&labelLayout.label.height>745&&labelLayout.label.height<760,'La etiqueta rotada debe caber dentro de una única hoja de 80 por 200 mm');
    assert(labelLayout.qr.width>240&&labelLayout.qr.height>240,'El QR debe aprovechar casi toda la altura del rollo');
    if(process.env.RESERVATIONS_LABEL_SCREENSHOT){await popup.setViewportSize({width:400,height:900});await popup.screenshot({path:process.env.RESERVATIONS_LABEL_SCREENSHOT,clip:{x:0,y:0,width:labelLayout.label.width,height:labelLayout.label.height}});}
    const printPdf=await popup.pdf({preferCSSPageSize:true,printBackground:true});
    const printPages=(printPdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
    assert.equal(printPages,1,'La etiqueta no debe paginarse ni generar una primera hoja en blanco');
    if(process.env.RESERVATIONS_LABEL_PDF)fs.writeFileSync(process.env.RESERVATIONS_LABEL_PDF,printPdf);
    await popup.close();
    await page.locator('#detail-comment').fill('Cliente avisado por teléfono');
    await page.locator('[data-add-comment]').click();
    await page.waitForFunction(()=>document.querySelector('#comments-list')?.textContent.includes('Cliente avisado por teléfono'));

    await page.locator('.more-actions summary').click();
    await page.locator('[data-detail-action="progress"]').click();
    await page.locator('#progress-state').selectOption('separando');
    await page.locator('#progress-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('Separando'));
    await page.locator('.more-actions summary').click();
    await page.locator('[data-detail-action="finish"]').click();
    await page.locator('#finish-type').selectOption('retiro_cliente');
    await page.locator('#finish-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('Entrega parcial'));

    await page.locator('.item-local').nth(0).fill('1');await page.locator('[data-save-item]').nth(0).click();
    await page.waitForSelector('#action-modal:not([hidden])');await page.getByRole('button',{name:'La etiqueta ya está colocada'}).click();
    await page.locator('.item-local').nth(2).fill('1');await page.locator('[data-save-item]').nth(2).click();
    await page.waitForSelector('#action-modal:not([hidden])');await page.getByRole('button',{name:'La etiqueta ya está colocada'}).click();
    await page.locator('[data-next-step="finish"]').click();
    await page.locator('#finish-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('Completada'));
    await page.locator('[data-close-modal]').click();
    await page.locator('button[data-view="history"]').click();
    await page.waitForSelector('#history-list [data-reservation-id]');
    assert.match(await page.locator('#history-list').innerText(),/COMPLETADA[\s\S]*Ana Suárez/,'La reserva cerrada debe quedar en el historial');

    await page.locator('#history-list [data-reservation-id]').click();
    await page.locator('.more-actions summary').click();
    await page.locator('[data-detail-action="correct-close"]').click();
    for(let index=0;index<3;index++)await page.locator('.corrected-delivery').nth(index).fill('0');
    await page.locator('#correct-close-reason').fill('Se marcó una unidad de más por error');
    await page.locator('#correct-close-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#action-modal')?.hidden);
    assert.match(await page.locator('#detail-content').innerText(),/Avisar al cliente[\s\S]*Solicitadas[\s\S]*1[\s\S]*Ya entregadas[\s\S]*0/i,'La corrección debe reabrir el seguimiento sin entregas antes de eliminarlo');
    await page.locator('.more-actions summary').click();
    await page.locator('[data-detail-action="delete"]').click();
    await page.locator('#delete-code').fill('SUCAN001');
    await page.locator('#delete-reason').fill('Reserva creada para prueba integral');
    await page.locator('#delete-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#active-list')?.textContent.includes('No hay reservas'));
    assert.equal(await page.locator('#detail-modal').isHidden(),true,'La reserva eliminada debe desaparecer del detalle');
    await page.locator('button[data-view="settings"]').click();
    assert.match(await page.locator('#view-settings').innerText(),/ADMINISTRACIÓN[\s\S]*Definí los días en que el local suele recibir mercadería de cada proveedor o de otro local[\s\S]*fecha estimada/i,'Configuración debe explicar el alcance de los días de recepción');
    await page.locator('#schedule-provider').fill('Proveedor de prueba');
    await page.locator('.schedule-days input[value="2"]').check();
    await page.locator('#save-schedule').click();
    await page.waitForFunction(()=>document.querySelector('#schedule-list')?.textContent.includes('Proveedor de prueba'));
    const requiredCalls=['op_reserva_crear_v2','op_reserva_editar','op_reserva_actualizar_item','op_reserva_comentar','op_reserva_cambiar_estado','op_reserva_finalizar','op_reserva_corregir_cierre','op_reserva_eliminar','op_reserva_guardar_recepcion_habitual'];
    const called=await page.evaluate(()=>window.__reservationRpcCalls.map(call=>call.name));
    for(const name of requiredCalls)assert(called.includes(name),`El recorrido de usuario debe ejecutar ${name}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'La vista móvil no debe desbordarse horizontalmente');

    const employeePage=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const employeeStub=supabaseStub.replace("supervisor:true,role:'supervisor'","supervisor:'false',role:'empleado'");
    await employeePage.route('**/npm/@supabase/supabase-js@2**',route=>route.fulfill({contentType:'application/javascript',body:employeeStub}));
    await employeePage.route('**/npm/qrcodejs@1.0.0/**',route=>route.fulfill({contentType:'application/javascript',body:'window.QRCode=function(){};QRCode.CorrectLevel={M:0};'}));
    await employeePage.route('**/npm/jsbarcode@3.12.3/**',route=>route.fulfill({contentType:'application/javascript',body:'window.JsBarcode=function(){};'}));
    await employeePage.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
    await employeePage.goto(target,{waitUntil:'domcontentloaded'});
    await employeePage.waitForSelector('#app:not([hidden])');
    assert.equal(await employeePage.locator('button[data-view="settings"]').isHidden(),true,'Un empleado no debe ver la pestaña Configuración');
    assert.equal(await employeePage.locator('#view-settings').isHidden(),true,'Un empleado no debe ver el panel administrativo');
    await employeePage.locator('button[data-view="settings"]').evaluate(button=>button.click());
    assert.equal(await employeePage.locator('#view-active').evaluate(section=>section.classList.contains('active')),true,'La vista administrativa debe rechazar accesos sin permiso');
    await employeePage.locator('#guide-button').click();
    assert.doesNotMatch(await employeePage.locator('#action-content').innerText(),/Administrar locales|Configuración|impresora|días de recepción/i,'La ayuda del empleado no debe mostrar tareas administrativas');
    await employeePage.close();
    console.log('reservations browser user journey and websocket fallback ok');
  }finally{
    await browser.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
