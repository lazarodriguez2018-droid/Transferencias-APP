const assert=require('assert');
const fs=require('fs');
const http=require('http');
const path=require('path');

let chromium;
try{({chromium}=require('playwright'));}
catch(_error){console.log('reservations browser skipped (playwright unavailable)');process.exit(0);}

const root=path.resolve(__dirname,'..');
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
const context={
  actor:{name:'Empleado prueba',local:'PDE',warehouse:'01',supervisor:false,role:'usuario'},
  locals:[{id:'11111111-1111-4111-8111-111111111111',nombre:'PDE',almacen:'01'}],
  reasons:[{id:'22222222-2222-4222-8222-222222222222',local_nombre:'PDE',nombre:'Retiro en tienda',activo:true,orden:10}],
  config:{PDE:{horas_reserva:48,dias_recepcion:[1,3,5],ubicacion_reservas:'Estante de pruebas',printer_path:null,printer_profile:'star-bsc10-80-max'}}
};
const db={
  auth:{getSession:async()=>({data:{session:{user:{id:'33333333-3333-4333-8333-333333333333'}}}})},
  rpc:async(name,args)=>{window.__reservationRpcCalls.push({name,args});if(name==='op_reserva_contexto')return {data:context,error:null};if(name==='op_reserva_listar')return {data:[],error:null};return {data:{ok:true},error:null};},
  channel:()=>{const channel={on:()=>channel,subscribe:()=>{throw new DOMException('The operation is insecure.','SecurityError');}};return channel;},
  removeChannel:async()=>{}
};
window.supabase={createClient:()=>db};
`;

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
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
    const address=server.address();
    await page.goto(`http://127.0.0.1:${address.port}/reservas/`,{waitUntil:'domcontentloaded'});
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
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'La vista móvil no debe desbordarse horizontalmente');
    console.log('reservations browser websocket fallback ok');
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
