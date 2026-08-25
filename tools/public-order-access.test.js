const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const migration=read('supabase/migrations/20260825230000_pedidos_publicos.sql');
const publicHtml=read('pedido-publico.html');
const publicJs=read('pedido-publico.js');
const trackingHtml=read('seguimiento-pedido.html');
const trackingJs=read('seguimiento-pedido.js');
const css=read('pedido-publico.css');
const app=read('app.js');
const index=read('index.html');

assert.match(migration,/add column if not exists canal_creacion text not null default 'interno'/,'Los pedidos existentes deben conservar el canal interno');
assert.match(migration,/token_hash text not null unique/g,'Los dos tipos de enlace deben guardar hashes únicos');
assert.match(migration,/encode\(digest\(token,'sha256'\),'hex'\)/,'El enlace público debe guardar únicamente el hash');
assert.match(migration,/encode\(digest\(token_seguimiento,'sha256'\),'hex'\)/,'El seguimiento debe guardar únicamente el hash');
assert.match(migration,/revoke all on table public\.pedido_enlaces_publicos from anon,authenticated/,'La tabla de enlaces no debe exponerse');
assert.match(migration,/revoke all on table public\.pedido_seguimientos_publicos from anon,authenticated/,'La tabla de seguimiento no debe exponerse');
assert.match(migration,/revoke all on table public\.pedido_publico_limites from anon,authenticated/,'Los límites no deben exponerse');
assert.doesNotMatch(migration,/grant (select|insert|update|delete).*pedido_(enlaces|seguimientos|publico_limites)/i,'Anon no debe recibir permisos de tabla');
assert.match(migration,/Solamente un supervisor puede administrar enlaces publicos/,'La administración debe exigir supervisor');
assert.match(migration,/jsonb_array_length\(p_productos\) not between 1 and 100/,'La cantidad de productos debe validarse en el servidor');
assert.match(migration,/cantidad maxima por producto es 999/i,'Las cantidades deben validarse en el servidor');
assert.match(migration,/interval '15 minutes'/,'Debe existir el límite por dispositivo');
assert.match(migration,/interval '1 hour'/,'Debe existir el límite global del enlace');
assert.match(migration,/code','possible_duplicate'/,'La RPC debe devolver una confirmación de duplicado');
assert.match(migration,/insert into public\.pedidos[\s\S]*insert into public\.pedido_productos[\s\S]*insert into public\.pedido_historial[\s\S]*insert into public\.pedido_seguimientos_publicos[\s\S]*insert into public\.notificaciones/,'La creación debe incluir pedido, productos, historial, seguimiento y avisos');
assert.match(migration,/grant execute on function public\.pedido_publico_previsualizar_enlace\(text\) to anon,authenticated/,'El enlace debe validarse sin login');
assert.match(migration,/grant execute on function public\.pedido_publico_crear\(text,text,text,text,uuid,jsonb,boolean,text,text,boolean\) to anon,authenticated/,'La creación pública debe estar disponible solo por RPC');
assert.match(migration,/grant execute on function public\.pedido_publico_resolver_gestion\(text\) to authenticated/,'La resolución para gestionar debe exigir login');

const trackingBody=migration.split('create or replace function public.pedido_publico_seguimiento')[1].split('create or replace function public.pedido_publico_regenerar_seguimiento')[0];
assert.doesNotMatch(trackingBody,/pedido\.(telefono|notas|remito|tracking|motivo_denegacion|faltantes)/,'El seguimiento no debe devolver datos sensibles o internos');
assert.doesNotMatch(trackingBody,/persona_nombre|perfiles\(/,'El seguimiento no debe devolver identidad del personal');
assert.match(trackingBody,/'products',productos,'timeline',historial/,'El seguimiento debe devolver productos y línea de tiempo');

assert.match(publicHtml,/id="identity-form"/,'El flujo debe empezar por la identificación');
assert.match(publicHtml,/id="order-screen"/,'Debe existir el constructor de pedido');
assert.match(publicHtml,/id="confirmation-screen"/,'Debe existir la confirmación con seguimiento');
assert.match(publicHtml,/qrcodejs@1\.0\.0/,'La confirmación debe generar un QR localmente');
assert.match(publicJs,/location\.origin\}\/seguimiento-pedido#/,'El token de seguimiento debe viajar en el fragmento');
assert.match(publicJs,/p_confirmar_duplicado:!!confirmDuplicate/,'La UI debe permitir confirmar un duplicado');
assert.match(publicJs,/localStorage\.setItem\('sucan_public_last_order'/,'El enlace de seguimiento debe sobrevivir una recarga en el dispositivo');
assert.doesNotMatch(publicJs,/\.from\(['"](?:pedidos|productos|pedido_productos|pedido_historial)['"]\)/,'El visitante no debe consultar tablas protegidas directamente');

assert.match(trackingHtml,/Iniciar sesión para gestionar/,'El seguimiento debe enlazar al flujo autenticado');
assert.match(trackingJs,/setInterval\([\s\S]*15000\)/,'El seguimiento debe actualizarse cada 15 segundos');
assert.match(trackingJs,/\/#manage=\$\{encodeURIComponent\(token\)\}/,'La gestión debe conservar el token en el fragmento');
assert.doesNotMatch(trackingJs,/\.from\(/,'El seguimiento debe ser exclusivamente por RPC');
assert.match(css,/@media\(max-width:650px\)/,'La experiencia debe adaptarse a teléfonos');
assert.match(css,/@media\(max-width:380px\)/,'Debe contemplar teléfonos angostos');

assert.match(index,/id="btn-public-order-links"/,'Pedidos debe ofrecer administración de enlaces a supervisores');
assert.match(index,/id="modal-public-order-links"/,'Debe existir el panel de administración');
assert.match(app,/isAdmin\?'inline-flex':'none'/,'El botón debe ocultarse para usuarios no supervisores');
assert.match(app,/value="__public__"/,'Los filtros deben incluir el canal público');
assert.match(app,/public-order-badge/,'Las tarjetas y detalles deben identificar pedidos públicos');
assert.match(app,/pedido_publico_resolver_gestion/,'La app debe resolver el seguimiento después del login');
assert.match(app,/pedido_publico_regenerar_seguimiento/,'El personal autorizado debe poder regenerar el seguimiento');

console.log('public-order-access: OK');
