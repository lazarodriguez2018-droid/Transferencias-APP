const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const migration=read('supabase/migrations/20260825233000_seguimiento_todos_pedidos.sql');
const app=read('app.js');
const publicJs=read('pedido-publico.js');
const index=read('index.html');
const css=read('style.css');
const publicCss=read('pedido-publico.css');

assert.match(migration,/create or replace function public\.can_access_order\(order_id uuid\)/,'La migración debe incluir el control de acceso que requiere producción');
assert.match(migration,/pedido\.escala_local=perfil\.local_nombre/,'El acceso debe contemplar origen, destino y escala');
assert.match(migration,/create or replace function public\.pedido_publico_estado_seguimiento\(p_pedido uuid\)/,'Debe poder consultarse el estado del seguimiento');
assert.match(migration,/not public\.can_access_order\(p_pedido\)/,'El estado y la regeneración deben respetar el acceso al pedido');
assert.match(migration,/encode\(digest\(token,'sha256'\),'hex'\)/,'Los enlaces de todos los pedidos deben seguir usando hashes SHA-256');
assert.match(migration,/grant execute on function public\.pedido_publico_estado_seguimiento\(uuid\) to authenticated/,'Solo usuarios autenticados pueden consultar el estado interno');
assert.doesNotMatch(migration,/grant execute on function public\.pedido_publico_estado_seguimiento\(uuid\) to anon/,'Anon no puede consultar pedidos por ID');

assert.match(app,/await issueOrderTrackingToken\(pedido\.id\)/,'Los pedidos internos nuevos deben recibir seguimiento automáticamente');
assert.match(app,/loadOrderTrackingPanel\(o\.id\)/,'Los pedidos antiguos deben preparar el seguimiento al abrirse');
assert.match(publicJs,/sucan_order_tracking_/,'Un pedido público debe reutilizar su enlace en el detalle si se abre desde el mismo dispositivo');
assert.doesNotMatch(app,/o\.canal_creacion==='publico'\?'<button[^>]+regenerarSeguimientoPublico/,'El seguimiento no debe limitarse al canal público');
assert.match(app,/Historial de estados/,'El historial debe diferenciarse del enlace compartible');
assert.match(app,/Enlace de seguimiento/,'El enlace compartible debe tener su propia sección');
assert.match(app,/order-tool-title">Comunicación/,'Las acciones de comunicación deben estar agrupadas');
assert.match(app,/order-tool-title">Documentos/,'Las acciones de documentos deben estar agrupadas');
assert.match(app,/order-tool-title">Administración/,'Las acciones peligrosas deben estar separadas');
assert.match(app,/Copiar enlace[\s\S]*Compartir[\s\S]*Abrir[\s\S]*Reemplazar/,'El enlace debe ofrecer acciones claras');

assert.doesNotMatch(index,/<div class="modal-close"/,'Los controles de cierre deben ser botones accesibles');
assert.match(index,/class="modal-close"[^>]+aria-label="Cerrar"/,'Los botones de cierre deben tener nombre accesible');
assert.match(index,/aria-label="Usar tema claro"/,'El selector visual debe explicar cada opción');
assert.match(index,/app\.js\?v=user-copy-v1/,'La publicación debe invalidar el JavaScript anterior del navegador');
assert.match(index,/style\.css\?v=public-responsive-v4/,'La publicación debe invalidar los estilos anteriores del navegador');
assert.match(app,/setAttribute\('aria-pressed',String\(active\)\)/,'El tema seleccionado debe comunicarse a tecnologías de asistencia');
assert.match(css,/\.btn:disabled/,'Los botones deshabilitados deben verse como tales');
assert.match(css,/\.btn:focus-visible/,'Los botones deben mostrar foco de teclado');
assert.match(css,/\.tracking-share-card/,'El seguimiento debe usar una tarjeta visual propia');
assert.match(css,/\.order-tools/,'Las herramientas deben tener una grilla ordenada');
assert.match(publicCss,/button:focus-visible/,'Los botones públicos también deben mostrar foco');

console.log('tracking-all-orders: OK');
