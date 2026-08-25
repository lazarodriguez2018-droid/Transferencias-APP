(function () {
  'use strict';

  const config = window.SUCANEITOR_CLOUD_CONFIG;
  const nativeFetch = window.fetch.bind(window);
  let catalogRestoreAttempted = false;
  function deviceId() {
    const key = 'sucan_ops_device_id';
    try {
      let value = localStorage.getItem(key);
      if (!value) {
        value = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(key,value);
      }
      return value;
    } catch (_) { return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  }
  const cloud = window.SucanCloud = {
    db: null,
    user: null,
    profile: null,
    displayName: 'Usuario',
    ready: null,
    channels: [],
    clientId: deviceId(),
    isSupervisor() { return ['admin','supervisor_general'].includes(this.profile?.role); }
  };

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8'}});
  }
  function errorResponse(error, fallback = 'Error de sincronización') {
    console.error('[Sucaneitor Cloud]', error);
    return json({ok:false,error:error?.message || fallback}, Number(error?.status) || 500);
  }
  function clean(value) { return String(value == null ? '' : value).trim(); }
  function bodyOf(options) {
    try { return options?.body ? JSON.parse(options.body) : {}; } catch (_) { return {}; }
  }
  function profileName(profile) {
    return clean(profile?.nombre_display) || clean(`${profile?.nombre || ''} ${profile?.apellido || ''}`) || 'Usuario';
  }
  function asDate(value) {
    try { return new Date(value).toLocaleString('es-UY'); } catch (_) { return clean(value); }
  }
  function isCloudApiRequest(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw) return false;
    if (raw.startsWith('/api/')) return true;
    try {
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/');
    } catch (_) { return false; }
  }
  function requestedUrl(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    return new URL(raw, location.href);
  }
  async function paginate(table, columns = '*', order = 'nombre') {
    const result = [];
    for (let from = 0;; from += 1000) {
      let query = cloud.db.from(table).select(columns).range(from, from + 999);
      if (order) query = query.order(order);
      const {data,error} = await query;
      if (error) throw error;
      result.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return result;
  }
  async function catalogWithSafeFallback() {
    const products = await paginate('productos','codigo,barras,nombre,fabricante,marca','nombre');
    if (products.some(product => clean(product.barras))) return {products, fallback:false};
    try {
      const response = await nativeFetch('/products.json', {cache:'no-store'});
      if (!response.ok) return {products, fallback:false};
      const bundled = await response.json();
      if (Array.isArray(bundled) && bundled.some(product => clean(product.barras))) {
        if (cloud.isSupervisor() && !catalogRestoreAttempted) {
          catalogRestoreAttempted = true;
          const {data:total,error} = await cloud.db.rpc('reemplazar_padron_productos',{payload:bundled});
          if (!error) return {products:bundled, fallback:false, restored:true, total:total || bundled.length};
          console.warn('No se pudo restaurar automáticamente el padrón central:', error);
        }
        return {products:bundled, fallback:true};
      }
    } catch (error) {
      console.warn('No se pudo abrir el padrón de respaldo:', error);
    }
    return {products, fallback:false};
  }
  async function selectInBatches(table, columns, foreignKey, ids, order) {
    const rows = [];
    for (let index = 0; index < ids.length; index += 100) {
      let query = cloud.db.from(table).select(columns).in(foreignKey, ids.slice(index, index + 100));
      if (order) query = query.order(order);
      const {data,error} = await query;
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows;
  }
  async function selectDirectoryDetail(table, columns, foreignKey, ids, order) {
    try {
      return {rows:await selectInBatches(table,columns,foreignKey,ids,order),available:true};
    } catch (error) {
      console.warn(`[Sucaneitor] No se pudo cargar el resumen de ${table}. Las sesiones igualmente permanecerán disponibles.`,error);
      return {rows:[],available:false,error:error?.message || 'Resumen no disponible'};
    }
  }
  function groupRows(rows, key) {
    const groups = new Map();
    (rows || []).forEach(row => {
      const value = row[key];
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(row);
    });
    return groups;
  }
  async function localeFor(value) {
    const target = clean(value).toLocaleLowerCase('es');
    const {data,error} = await cloud.db.from('locales').select('nombre,almacen');
    if (error) throw error;
    let aliases = [];
    try {
      const result = await cloud.db.from('op_local_aliases').select('alias,local_nombre');
      if (!result.error) aliases = result.data || [];
    } catch (_) {}
    const direct = (data || []).find(row => clean(row.nombre).toLocaleLowerCase('es') === target || clean(row.almacen).toLocaleLowerCase('es') === target);
    if (direct) return direct;
    const alias = aliases.find(row => clean(row.alias).toLocaleLowerCase('es') === target);
    if (alias) return (data || []).find(row => row.nombre === alias.local_nombre) || {nombre:alias.local_nombre,almacen:''};
    const comparable = target.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\b(bloqueo|almacen|sucursal|local|entrada|salida)\b/g,' ').replace(/\s+/g,' ').trim();
    const fuzzy = (data || []).find(row => {
      const name=clean(row.nombre).toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
      return name === comparable || comparable.endsWith(name) || name.endsWith(comparable);
    });
    return fuzzy || {nombre:clean(value),almacen:clean(value)};
  }

  cloud.ready = (async () => {
    if (!window.supabase?.createClient) throw new Error('No se pudo iniciar la conexión segura');
    cloud.db = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    const {data:{session}} = await cloud.db.auth.getSession();
    if (!session) {
      location.replace(config.portalUrl);
      throw new Error('Iniciá sesión para continuar');
    }
    cloud.user = session.user;
    const {data:profile,error} = await cloud.db.from('perfiles').select('*').eq('id',session.user.id).single();
    if (error || !profile?.approved) {
      location.replace(config.portalUrl);
      throw error || new Error('Cuenta pendiente de aprobación');
    }
    cloud.profile = profile;
    cloud.displayName = profileName(profile);
    return cloud;
  })();

  async function inventoryState(sessionId) {
    const [{data:session,error:se},{data:items,error:ie},{data:events,error:ee},{data:participants,error:pe}] = await Promise.all([
      cloud.db.from('op_inventario_sesiones').select('*').eq('id',sessionId).single(),
      cloud.db.from('op_inventario_items').select('*').eq('sesion_id',sessionId).order('updated_at',{ascending:false}),
      cloud.db.from('op_inventario_eventos').select('*').eq('sesion_id',sessionId).order('created_at',{ascending:false}).limit(200),
      cloud.db.from('op_inventario_participantes').select('*').eq('sesion_id',sessionId).order('joined_at')
    ]);
    if (se || ie || ee || pe) throw se || ie || ee || pe;
    const countItems = {};
    (items || []).forEach(item => { countItems[item.codigo] = {codigo:item.codigo,nombre:item.nombre,barras:item.barras || '',qty:item.cantidad,tipos:item.tipos || {},requiere_verificacion:!!item.requiere_verificacion,verificado_at:item.verificado_at||null,verificado_by:item.verificado_by_name||''}; });
    const log = (events || []).map(event => ({
      ts:new Date(event.created_at).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),
      tipo:event.tipo,codigo:event.codigo,nombre:event.nombre,qty:event.cantidad || 0
    }));
    return {
      countItems, log, totalScans:(events || []).filter(event => event.tipo === 'scanner').length,
      almacen:session.almacen || '', lastUpdate:new Date(session.updated_at).getTime()/1000,
      session_id:session.id,nombre:session.nombre,
      usuarios:(participants || []).map(p => ({nombre:p.nombre,joined:asDate(p.joined_at)}))
    };
  }

  function repoItem(row, catalogByCode) {
    const product = typeof catalogByCode?.get === 'function'
      ? catalogByCode.get(clean(row.codigo))
      : null;
    return {
      codigo:row.codigo,nombre:row.nombre,descripcion_archivo:row.descripcion_archivo || '',
      barras:clean(product?.barras) || row.barras || '',marca:clean(product?.marca) || row.marca || '',
      pedido:Number(row.pedido_total || Math.max(row.pedido_reposicion || 0,row.pedido_clientes || 0)),
      pedido_reposicion:Number(row.pedido_reposicion || 0),pedido_clientes:Number(row.pedido_clientes || 0),
      stock_origen:Number(row.stock_origen || 0),preparado:Number(row.preparado || 0),
      no_encontrado:!!row.no_encontrado,cerrado_incompleto:!!row.cerrado_incompleto,
      motivo_codigo:row.motivo_codigo || '',motivo_label:row.motivo_label || '',motivo_otro:row.motivo_otro || '',
      comentario:row.comentario || '',motivo:[row.motivo_label,row.motivo_otro,row.comentario].filter(Boolean).join(' · '),
      pedidos_asignados:row.pedidos_asignados || [],updated_by:row.updated_by_name || '',updated_at:row.updated_at,
      requiere_verificacion:!!row.requiere_verificacion,verificado_at:row.verificado_at||null,verificado_by:row.verificado_by_name||'',
      asignado_a:row.asignado_a || '',asignado_cliente:row.asignado_cliente || '',
      asignado_nombre:row.asignado_nombre || '',asignado_at:row.asignado_at || null
    };
  }
  function repoSummary(repo) {
    const items = repo.items || [], extras = repo.extras || [];
    const requested = items.reduce((sum,item)=>sum+Number(item.pedido || 0),0);
    const prepared = items.reduce((sum,item)=>sum+Number(item.preparado || 0),0);
    return {
      productos:items.length,unidades_pedidas:requested,unidades_preparadas:prepared,
      unidades_faltantes:items.reduce((sum,item)=>sum+Math.max(0,Number(item.pedido||0)-Number(item.preparado||0)),0),
      pendientes:items.filter(item=>Number(item.preparado||0)<Number(item.pedido||0)).length,
      verificaciones_pendientes:items.filter(item=>item.requiere_verificacion).length,
      extras_productos:extras.filter(item=>Number(item.cantidad)>0).length,
      extras_unidades:extras.reduce((sum,item)=>sum+Math.max(0,Number(item.cantidad)||0),0)
    };
  }
  function canEditReposition(repo) {
    return repo?.estado === 'preparando' && (cloud.isSupervisor() || clean(repo?.origen_local || repo?.origin) === clean(cloud.profile?.local_nombre));
  }
  async function repoSnapshot(repoId) {
    const [{data:repo,error:re},{data:items,error:ie},{data:extras,error:xe},{data:parts,error:pe},{data:devices,error:de},{data:events,error:ee}] = await Promise.all([
      cloud.db.from('op_reposiciones').select('*').eq('id',repoId).single(),
      cloud.db.from('op_reposicion_items').select('*').eq('reposicion_id',repoId).order('nombre'),
      cloud.db.from('op_reposicion_extras').select('*').eq('reposicion_id',repoId).order('nombre'),
      cloud.db.from('op_reposicion_participantes').select('*').eq('reposicion_id',repoId).order('joined_at'),
      cloud.db.from('op_reposicion_dispositivos').select('cliente_id,usuario_id,nombre,last_seen').eq('reposicion_id',repoId).gt('last_seen',new Date(Date.now()-3*60*1000).toISOString()).order('last_seen',{ascending:false}),
      cloud.db.from('op_reposicion_eventos').select('*').eq('reposicion_id',repoId).order('created_at',{ascending:false}).limit(500)
    ]);
    if (re || ie || xe || pe || de || ee) throw re || ie || xe || pe || de || ee;
    const productCodes = [...new Set([...(items || []), ...(extras || [])].map(row => clean(row.codigo)).filter(Boolean))];
    const catalogRows = await selectInBatches('productos','codigo,barras,marca','codigo',productCodes);
    const catalogByCode = new Map(catalogRows.map(product => [clean(product.codigo),product]));
    const snapshot = {
      id:repo.id,nombre:repo.nombre,origin:repo.origen_local,destination:repo.destino_local,estado:repo.estado,
      started_at:repo.started_at,created_at:repo.created_at,updated_at:repo.updated_at,
      original_filename:repo.original_filename,original_file:repo.original_path,import_meta:repo.import_meta || {},
      transporte:repo.transporte,remito:repo.remito,remito_pendiente:repo.remito_pendiente,
      can_edit:canEditReposition(repo),can_update_remito:cloud.isSupervisor() || clean(repo.origen_local) === clean(cloud.profile?.local_nombre),
      viewer_client_id:cloud.clientId,
      items:(items || []).map(row=>repoItem(row,catalogByCode)),
      extras:(extras || []).map(row=>({codigo:row.codigo,nombre:row.nombre,barras:clean(catalogByCode.get(clean(row.codigo))?.barras) || row.barras || '',cantidad:row.cantidad,nota:row.nota || '',updated_by:row.updated_by_name || '',updated_at:row.updated_at})),
      participantes:(devices || []).map(row=>({nombre:row.nombre,cliente_id:row.cliente_id,usuario_id:row.usuario_id,last_seen:row.last_seen,joined:asDate(row.last_seen)})),
      log:(events || []).map(row=>({ts:row.created_at,usuario:row.usuario_nombre,accion:row.accion,codigo:row.codigo,detalle:row.detalle || {}})),exports:[]
    };
    snapshot.summary = repoSummary(snapshot);
    return snapshot;
  }

  async function createReposition(data) {
    const originLocale = await localeFor(data.origin), destinationLocale = await localeFor(data.destination);
    const {data:repoId,error} = await cloud.db.rpc('op_crear_reposicion',{
      p_nombre:clean(data.nombre)||`Reposición ${originLocale.nombre} a ${destinationLocale.nombre}`,
      p_origen:originLocale.nombre,p_destino:destinationLocale.nombre,p_items:data.items || [],
      p_import_meta:data.import_meta || {},p_original_filename:clean(data.original_filename)||null
    });
    if (error) throw error;

    if (data.original_base64) {
      try {
        const binary=atob(String(data.original_base64).split(',').pop()), bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
        const safe=clean(data.original_filename).replace(/[^A-Za-z0-9._-]+/g,'_') || 'reposicion.xls';
        const path=`${repoId}/${safe}`;
        const {error:upError}=await cloud.db.storage.from('op-reposiciones').upload(path,new Blob([bytes]),{upsert:true});
        if(!upError) await cloud.db.from('op_reposiciones').update({original_path:path}).eq('id',repoId);
      } catch (uploadError) { console.warn('No se conservó el original',uploadError); }
    }
    return repoSnapshot(repoId);
  }

  function receiptItem(row, catalogByCode) {
    const product=catalogByCode?.get(clean(row.codigo));
    return {codigo:row.codigo,nombre:clean(product?.nombre)||row.nombre,descripcion_archivo:row.descripcion_archivo||'',barras:clean(product?.barras)||row.barras||'',marca:clean(product?.marca)||row.marca||'',esperado:Number(row.esperado||0),recibido:Number(row.recibido||0),no_recibido:!!row.no_recibido,observacion:row.observacion||'',source_lines:row.source_lines||[],updated_by:row.updated_by_name||'',updated_at:row.updated_at,requiere_verificacion:!!row.requiere_verificacion,verificado_at:row.verificado_at||null,verificado_by:row.verificado_by_name||'',controlado_at:row.controlado_at||null,controlado_by:row.controlado_by_name||'',asignado_a:row.asignado_a||null,asignado_cliente:row.asignado_cliente||'',asignado_nombre:row.asignado_nombre||'',asignado_at:row.asignado_at||null};
  }
  function receiptSummary(receipt) {
    const items=receipt.items||[],extras=receipt.extras||[];
    const expected=items.reduce((sum,item)=>sum+Number(item.esperado||0),0),received=items.reduce((sum,item)=>sum+Number(item.recibido||0),0);
    const directed=items.some(item=>Object.prototype.hasOwnProperty.call(item,'controlado_at'));
    return {productos:items.length,unidades_esperadas:expected,unidades_recibidas:received,unidades_faltantes:items.reduce((sum,item)=>sum+Math.max(0,Number(item.esperado||0)-Number(item.recibido||0)),0),unidades_sobrantes:items.reduce((sum,item)=>sum+Math.max(0,Number(item.recibido||0)-Number(item.esperado||0)),0),pendientes:directed?items.filter(item=>!item.controlado_at).length:items.filter(item=>Number(item.recibido||0)<Number(item.esperado||0)&&!item.no_recibido).length,exactos:items.filter(item=>Number(item.recibido||0)===Number(item.esperado||0)).length,verificaciones_pendientes:items.filter(item=>item.requiere_verificacion).length,extras_productos:extras.filter(item=>Number(item.cantidad)>0).length,extras_unidades:extras.reduce((sum,item)=>sum+Number(item.cantidad||0),0)};
  }
  function canEditReception(receipt) {
    return receipt?.estado==='en_control'&&(cloud.isSupervisor()||clean(receipt.destino_local||receipt.destination)===clean(cloud.profile?.local_nombre));
  }
  async function receptionSnapshot(receiptId) {
    const [{data:receipt,error:re},{data:items,error:ie},{data:extras,error:xe},{data:parts,error:pe},{data:devices,error:de},{data:events,error:ee},{data:links,error:le}]=await Promise.all([
      cloud.db.from('op_recepciones').select('*').eq('id',receiptId).single(),
      cloud.db.from('op_recepcion_items').select('*').eq('recepcion_id',receiptId).order('nombre'),
      cloud.db.from('op_recepcion_extras').select('*').eq('recepcion_id',receiptId).order('nombre'),
      cloud.db.from('op_recepcion_participantes').select('*').eq('recepcion_id',receiptId).order('joined_at'),
      cloud.db.from('op_recepcion_dispositivos').select('cliente_id,usuario_id,invitado_id,nombre,last_seen').eq('recepcion_id',receiptId).gt('last_seen',new Date(Date.now()-3*60*1000).toISOString()).order('last_seen',{ascending:false}),
      cloud.db.from('op_recepcion_eventos').select('*').eq('recepcion_id',receiptId).order('created_at',{ascending:false}).limit(500),
      cloud.db.from('op_recepcion_pedidos').select('pedido_id,coincidencia').eq('recepcion_id',receiptId)
    ]);
    if(re||ie||xe||pe||de||ee||le)throw re||ie||xe||pe||de||ee||le;
    const codes=[...new Set([...(items||[]),...(extras||[])].map(row=>clean(row.codigo)).filter(Boolean))];
    const products=await selectInBatches('productos','codigo,nombre,barras,marca','codigo',codes);
    const catalogByCode=new Map(products.map(product=>[clean(product.codigo),product]));
    const orderIds=(links||[]).map(link=>link.pedido_id);
    const orders=orderIds.length?await selectInBatches('pedidos','id,cliente,telefono,estado,remito,cliente_aviso_pendiente,cliente_avisado_at,created_at,pedido_productos(codigo,nombre,cantidad,cantidad_aceptada,cantidad_preparada,cantidad_recibida)','id',orderIds,'created_at'):[];
    const linkByOrder=new Map((links||[]).map(link=>[link.pedido_id,link]));
    const snapshot={id:receipt.id,nombre:receipt.nombre,document_number:receipt.numero_remito,date:receipt.fecha_remito,origin:receipt.origen_local,destination:receipt.destino_local,estado:receipt.estado,original_filename:receipt.original_filename,original_file:receipt.original_path,import_meta:receipt.import_meta||{},observaciones_cierre:receipt.observaciones_cierre||'',created_at:receipt.created_at,updated_at:receipt.updated_at,closed_at:receipt.closed_at,can_edit:canEditReception(receipt),can_delete:canEditReception(receipt),viewer_client_id:cloud.clientId,items:(items||[]).map(row=>receiptItem(row,catalogByCode)),extras:(extras||[]).map(row=>({codigo:row.codigo,nombre:clean(catalogByCode.get(clean(row.codigo))?.nombre)||row.nombre,barras:clean(catalogByCode.get(clean(row.codigo))?.barras)||row.barras||'',cantidad:Number(row.cantidad||0),observacion:row.observacion||'',updated_by:row.updated_by_name||'',updated_at:row.updated_at})),participantes:(devices||[]).map(row=>({nombre:row.nombre,cliente_id:row.cliente_id,usuario_id:row.usuario_id,invitado_id:row.invitado_id,last_seen:row.last_seen,joined:asDate(row.last_seen)})),orders:orders.map(order=>({...order,coincidencia:linkByOrder.get(order.id)?.coincidencia||'ruta_sku'})),log:(events||[]).map(row=>({ts:row.created_at,usuario:row.usuario_nombre,accion:row.accion,codigo:row.codigo,detalle:row.detalle||{}}))};
    snapshot.summary=receiptSummary(snapshot); return snapshot;
  }
  async function listReceptions() {
    const since=new Date(Date.now()-180*24*60*60*1000).toISOString();
    const {data,error}=await cloud.db.from('op_recepciones').select('*').in('estado',['en_control','cerrado']).gte('created_at',since).order('updated_at',{ascending:false});
    if(error)throw error; const receipts=data||[],ids=receipts.map(row=>row.id); if(!ids.length)return [];
    const [itemsResult,extrasResult,partsResult,linksResult]=await Promise.all([
      selectDirectoryDetail('op_recepcion_items','recepcion_id,esperado,recibido,no_recibido,controlado_at','recepcion_id',ids),
      selectDirectoryDetail('op_recepcion_extras','recepcion_id,cantidad','recepcion_id',ids),
      selectDirectoryDetail('op_recepcion_participantes','recepcion_id,nombre,joined_at','recepcion_id',ids,'joined_at'),
      selectDirectoryDetail('op_recepcion_pedidos','recepcion_id,pedido_id','recepcion_id',ids)
    ]);
    const items=itemsResult.rows,extras=extrasResult.rows,parts=partsResult.rows,links=linksResult.rows;
    const itemsBy=groupRows(items,'recepcion_id'),extrasBy=groupRows(extras,'recepcion_id'),partsBy=groupRows(parts,'recepcion_id'),linksBy=groupRows(links,'recepcion_id');
    return receipts.map(row=>{const snapshot={items:itemsBy.get(row.id)||[],extras:extrasBy.get(row.id)||[]};return {id:row.id,nombre:row.nombre,document_number:row.numero_remito,date:row.fecha_remito,origin:row.origen_local,destination:row.destino_local,estado:row.estado,created_at:row.created_at,updated_at:row.updated_at,can_edit:canEditReception(row),can_delete:canEditReception(row),summary_available:itemsResult.available&&extrasResult.available,participants_available:partsResult.available,links_available:linksResult.available,participantes:(partsBy.get(row.id)||[]).map(part=>({nombre:part.nombre,joined:asDate(part.joined_at)})),linked_orders:(linksBy.get(row.id)||[]).length,summary:receiptSummary(snapshot)};});
  }
  async function createReception(data) {
    const origin=await localeFor(data.origin),destination=await localeFor(data.destination);
    const {data:receiptId,error}=await cloud.db.rpc('op_crear_recepcion',{p_nombre:clean(data.nombre)||`Remito ${clean(data.document_number)}`,p_numero_remito:clean(data.document_number),p_fecha_remito:data.date,p_origen:origin.nombre,p_destino:destination.nombre,p_items:data.items||[],p_import_meta:data.import_meta||{},p_original_filename:clean(data.original_filename)||null});
    if(error)throw error;
    if(data.original_base64){try{const binary=atob(String(data.original_base64).split(',').pop()),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);const safe=clean(data.original_filename).replace(/[^A-Za-z0-9._-]+/g,'_')||'remito.xls',path=`${receiptId}/${safe}`;const {error:upError}=await cloud.db.storage.from('op-recepciones').upload(path,new Blob([bytes]),{upsert:true});if(!upError)await cloud.db.from('op_recepciones').update({original_path:path}).eq('id',receiptId);}catch(uploadError){console.warn('No se conservó el remito original',uploadError);}}
    return receptionSnapshot(receiptId);
  }

  async function listInventorySessions() {
    const {data,error}=await cloud.db.from('op_inventario_sesiones').select('*').eq('estado','abierta').order('updated_at',{ascending:false});
    if(error) throw error;
    const sessions=data||[], ids=sessions.map(session=>session.id);
    if(!ids.length) return [];
    const [itemsResult,partsResult]=await Promise.all([
      selectDirectoryDetail('op_inventario_items','sesion_id,codigo,cantidad','sesion_id',ids),
      selectDirectoryDetail('op_inventario_participantes','sesion_id,nombre,joined_at','sesion_id',ids,'joined_at')
    ]);
    const items=itemsResult.rows,parts=partsResult.rows;
    const itemsBySession=groupRows(items,'sesion_id'), partsBySession=groupRows(parts,'sesion_id');
    return sessions.map(session=>{
      const sessionItems=itemsBySession.get(session.id)||[], sessionParts=partsBySession.get(session.id)||[];
      return {id:session.id,nombre:session.nombre,creada:asDate(session.created_at),creada_fecha:session.created_at,updated_at:session.updated_at,usuarios:sessionParts.map(p=>({nombre:p.nombre,joined:asDate(p.joined_at)})),details_available:itemsResult.available,participants_available:partsResult.available,productos:sessionItems.length,unidades:sessionItems.reduce((s,i)=>s+Number(i.cantidad||0),0),local_nombre:session.local_nombre||'',almacen:session.almacen||''};
    });
  }
  async function listRepositions() {
    const since=new Date(Date.now()-90*24*60*60*1000).toISOString();
    const {data,error}=await cloud.db.from('op_reposiciones').select('*').in('estado',['preparando','enviado']).gte('created_at',since).order('updated_at',{ascending:false});
    if(error) throw error;
    const repos=data||[], ids=repos.map(row=>row.id);
    if(!ids.length) return [];
    const [itemsResult,extrasResult,partsResult]=await Promise.all([
      selectDirectoryDetail('op_reposicion_items','reposicion_id,codigo,pedido_total,pedido_reposicion,pedido_clientes,preparado,no_encontrado,cerrado_incompleto','reposicion_id',ids),
      selectDirectoryDetail('op_reposicion_extras','reposicion_id,cantidad','reposicion_id',ids),
      selectDirectoryDetail('op_reposicion_participantes','reposicion_id,nombre,joined_at','reposicion_id',ids,'joined_at')
    ]);
    const items=itemsResult.rows,extras=extrasResult.rows,parts=partsResult.rows;
    const itemsByRepo=groupRows(items,'reposicion_id'), extrasByRepo=groupRows(extras,'reposicion_id'), partsByRepo=groupRows(parts,'reposicion_id');
    return repos.map(row=>{
      const snapshot={items:(itemsByRepo.get(row.id)||[]).map(item=>repoItem(item)),extras:(extrasByRepo.get(row.id)||[]).map(extra=>({cantidad:extra.cantidad}))};
      const canEdit = canEditReposition(row);
      return {id:row.id,nombre:row.nombre,origin:row.origen_local,destination:row.destino_local,estado:row.estado,remito:row.remito,remito_pendiente:row.remito_pendiente,created_at:row.created_at,updated_at:row.updated_at,can_edit:canEdit,can_delete:row.estado==='preparando'&&canEdit,participantes:(partsByRepo.get(row.id)||[]).map(part=>({nombre:part.nombre,joined:asDate(part.joined_at)})),summary_available:itemsResult.available&&extrasResult.available,participants_available:partsResult.available,summary:repoSummary(snapshot)};
    });
  }

  async function barcodeAssignments() {
    const {data,error}=await cloud.db.from('op_asignaciones_barras').select('*').order('created_at',{ascending:false}).limit(500);
    if(error) throw error;
    const products=await paginate('productos','codigo,nombre,barras','nombre');
    const byCode=new Map(products.map(p=>[clean(p.codigo),p]));
    const byBarcode=new Map(products.filter(p=>clean(p.barras)).map(p=>[clean(p.barras),p]));
    const rows=await Promise.all((data||[]).map(async row=>{
      let status=row.status;
      const product=byCode.get(clean(row.product_code));
      if(!product) status='product_missing';
      else if(clean(product.barras)===clean(row.barcode)) status='incorporated';
      else if(byBarcode.has(clean(row.barcode))&&clean(byBarcode.get(clean(row.barcode)).codigo)!==clean(row.product_code)) status='conflict';
      let photo_url='';
      if(row.photo_path){ const {data:signed}=await cloud.db.storage.from('op-barras-fotos').createSignedUrl(row.photo_path,3600); photo_url=signed?.signedUrl||''; }
      return {id:row.id,barcode:row.barcode,product_code:row.product_code,product_name:row.product_name,official_barcode:row.official_barcode||'',user:row.created_by===cloud.user.id?cloud.displayName:'Usuario',session_id:row.session_id,session_name:row.session_name||'',created_at:row.created_at,updated_at:row.updated_at,status,photo_file:row.photo_path||'',photo_url};
    }));
    return {assignments:rows,effective:rows.filter(row=>row.status==='pending').map(row=>({barcode:row.barcode,product_code:row.product_code}))};
  }

  async function createBarcodeAssignment(data) {
    const barcode=clean(data.barcode), productCode=clean(data.product_code);
    if(barcode.length<5) throw new Error('Código de barras inválido');
    const {data:product,error:pe}=await cloud.db.from('productos').select('codigo,nombre,barras').eq('codigo',productCode).single();
    if(pe||!product) throw pe||new Error('El producto ya no existe en el padrón');
    const {data:official}=await cloud.db.from('productos').select('codigo,nombre').eq('barras',barcode).neq('codigo',productCode).maybeSingle();
    if(official) throw new Error(`Ese código ya pertenece a ${official.nombre}`);
    const {data:pending}=await cloud.db.from('op_asignaciones_barras').select('product_code,product_name').eq('barcode',barcode).eq('status','pending').neq('product_code',productCode).maybeSingle();
    if(pending) throw new Error(`Ese código ya fue propuesto para ${pending.product_name}`);
    await cloud.db.from('op_asignaciones_barras').update({status:'superseded',updated_at:new Date().toISOString()}).eq('product_code',productCode).eq('status','pending').neq('barcode',barcode);
    let photoPath=null;
    if(data.photo_data){
      const match=String(data.photo_data).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
      if(!match) throw new Error('Formato de foto inválido');
      const binary=atob(match[2]), bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      if(bytes.length>4194304) throw new Error('La foto supera 4 MB');
      photoPath=`${cloud.user.id}/${crypto.randomUUID()}.${match[1].toLowerCase()==='jpeg'?'jpg':match[1].toLowerCase()}`;
      const {error:ue}=await cloud.db.storage.from('op-barras-fotos').upload(photoPath,new Blob([bytes],{type:`image/${match[1]}`}),{upsert:false}); if(ue) throw ue;
    }
    const {data:row,error}=await cloud.db.from('op_asignaciones_barras').insert({barcode,product_code:productCode,product_name:product.nombre,official_barcode:product.barras||null,photo_path:photoPath,created_by:cloud.user.id,session_id:data.session_id||null,session_name:data.session_name||null}).select().single();
    if(error) throw error;
    const result=await barcodeAssignments();
    return {assignment:result.assignments.find(item=>item.id===row.id),effective:result.effective};
  }

  async function exportZip(data) {
    if(!window.JSZip) throw new Error('No se pudo cargar el generador de paquetes');
    const zip=new JSZip();
    (data.files||[]).forEach(file=>zip.file(file.name,file.base64,{base64:true}));
    return new Response(await zip.generateAsync({type:'blob'}),{status:200,headers:{'Content-Type':'application/zip'}});
  }

  async function handleApi(input, options = {}) {
    await cloud.ready;
    const url=requestedUrl(input), path=url.pathname, method=(options.method||'GET').toUpperCase(), data=bodyOf(options);
    try {
      if(path==='/api/ping') return json({ok:true,server:'Sucaneitor Operaciones Web'});
      if(path==='/api/locales' && method==='GET') { const locales=await paginate('locales','id,nombre,almacen','nombre'); return json({ok:true,locales}); }
      if(path==='/api/padron' && method==='GET') { const catalog=await catalogWithSafeFallback(); return json({ok:true,padron:catalog.products,total:catalog.products.length,fallback:catalog.fallback,restored:!!catalog.restored}); }
      if(path==='/api/padron' && method==='POST') { if(!cloud.isSupervisor()) return json({ok:false,error:'Solo supervisores pueden modificar el padrón'},403); const {data:total,error}=await cloud.db.rpc('reemplazar_padron_productos',{payload:data.padron||[]}); if(error)throw error; return json({ok:true,total}); }
      if(path==='/api/sesiones') return json(await listInventorySessions());
      if(path==='/api/reposiciones') return json(await listRepositions());
      if(path==='/api/recepciones') return json(await listReceptions());
      if(path==='/api/sesion/crear' && method==='POST') {
        let session;
        if(data.session_id){ const {data:row,error}=await cloud.db.from('op_inventario_sesiones').select('*').eq('id',data.session_id).single(); if(error)throw error; session=row; }
        else {
          let local={nombre:cloud.profile.local_nombre || 'Sin local',almacen:cloud.profile.almacen || null};
          if(cloud.isSupervisor() && clean(data.local_nombre)) local=await localeFor(data.local_nombre);
          if(!clean(data.nombre_sesion)) throw new Error('Ingresá un nombre para la sesión');
          const {data:row,error}=await cloud.db.from('op_inventario_sesiones').insert({nombre:clean(data.nombre_sesion),local_nombre:local.nombre,almacen:local.almacen||null,created_by:cloud.user.id}).select().single(); if(error)throw error; session=row;
        }
        await cloud.db.from('op_inventario_participantes').upsert({sesion_id:session.id,usuario_id:cloud.user.id,nombre:cloud.displayName,last_seen:new Date().toISOString()},{onConflict:'sesion_id,usuario_id'});
        return json({ok:true,session_id:session.id,nombre:session.nombre,usuarios:[{nombre:cloud.displayName}],state:await inventoryState(session.id)});
      }
      if(path==='/api/sesion/salir' && method==='POST') { await cloud.db.from('op_inventario_participantes').delete().eq('sesion_id',data.session_id).eq('usuario_id',cloud.user.id); return json({ok:true}); }
      if(path==='/api/state') return json(await inventoryState(url.searchParams.get('sid')));
      if(path==='/api/add' && method==='POST') { const {data:item,error}=await cloud.db.rpc('op_inventario_sumar',{p_sesion:data.session_id,p_codigo:data.codigo,p_nombre:data.nombre,p_barras:data.barras||'',p_cantidad:Number(data.qty)||1,p_tipo:data.tipo||'nombre'}); if(error)throw error; return json({ok:true,item:{codigo:item.codigo,nombre:item.nombre,barras:item.barras||'',qty:item.cantidad,tipos:item.tipos||{},requiere_verificacion:!!item.requiere_verificacion,verificado_at:item.verificado_at||null,verificado_by:item.verificado_by_name||''}}); }
      if(path==='/api/update_qty' && method==='POST') { const {error}=await cloud.db.rpc('op_inventario_ajustar',{p_sesion:data.session_id,p_codigo:data.codigo,p_delta:Number(data.delta)||0}); if(error)throw error; return json({ok:true}); }
      if(path==='/api/inventario/verify_qty' && method==='POST') { const {data:item,error}=await cloud.db.rpc('op_verificar_inventario_cantidad',{p_sesion:data.session_id,p_codigo:data.codigo,p_cantidad:Number(data.cantidad)});if(error)throw error;return json({ok:true,item:{codigo:item.codigo,nombre:item.nombre,barras:item.barras||'',qty:item.cantidad,tipos:item.tipos||{},requiere_verificacion:!!item.requiere_verificacion,verificado_at:item.verificado_at||null,verificado_by:item.verificado_by_name||''}}); }
      if(path==='/api/remove' && method==='POST') { const {error}=await cloud.db.from('op_inventario_items').delete().eq('sesion_id',data.session_id).eq('codigo',data.codigo); if(error)throw error; return json({ok:true}); }
      if(path==='/api/clear' && method==='POST') { const {error}=await cloud.db.from('op_inventario_items').delete().eq('sesion_id',data.session_id); if(error)throw error; await cloud.db.from('op_inventario_eventos').delete().eq('sesion_id',data.session_id); return json({ok:true}); }
      if(path==='/api/set_almacen' && method==='POST') { const {error}=await cloud.db.from('op_inventario_sesiones').update({almacen:data.almacen,updated_at:new Date().toISOString()}).eq('id',data.session_id); if(error)throw error; return json({ok:true}); }
      if(path==='/api/balance' && method==='GET') { const {data:row,error}=await cloud.db.from('op_inventario_balances').select('*').eq('sesion_id',url.searchParams.get('session_id')).maybeSingle(); if(error)throw error; return json({ok:true,balance:row?.balance||[],meta:row?.meta||null,updated:row?.updated_at||null}); }
      if(path==='/api/balance' && method==='POST') { const {error}=await cloud.db.from('op_inventario_balances').upsert({sesion_id:data.session_id,balance:data.balance||[],meta:data.meta||{},updated_by:cloud.user.id,updated_at:new Date().toISOString()},{onConflict:'sesion_id'}); if(error)throw error; return json({ok:true,total:(data.balance||[]).length}); }
      if(path==='/api/reposicion/crear' && method==='POST') { const repo=await createReposition(data); return json({ok:true,reposition_id:repo.id,repo}); }
      if(path==='/api/recepcion/crear' && method==='POST') { const receipt=await createReception(data); return json({ok:true,reception_id:receipt.id,receipt}); }
      if(path==='/api/recepcion/delete' && method==='POST') {
        const receiptId=clean(data.reception_id); if(!receiptId)throw new Error('Recepción no indicada');
        const {data:deleted,error}=await cloud.db.rpc('op_eliminar_recepcion',{p_recepcion:receiptId}); if(error)throw error;
        if(deleted?.original_path){const {error:storageError}=await cloud.db.storage.from('op-recepciones').remove([deleted.original_path]);if(storageError)console.warn('La recepción se eliminó, pero no se pudo borrar el archivo',storageError);}
        return json({ok:true,deleted});
      }
      if(path==='/api/recepcion/state') {
        const rid=url.searchParams.get('rid');
        const {error}=await cloud.db.rpc('op_recepcion_tocar',{p_recepcion:rid,p_cliente:cloud.clientId,p_usuario_nombre:cloud.displayName}); if(error)throw error;
        return json({ok:true,receipt:await receptionSnapshot(rid)});
      }
      if(path==='/api/recepcion/claim' && method==='POST') {
        const {data:item,error}=await cloud.db.rpc('op_recepcion_reclamar',{p_recepcion:data.reception_id,p_codigo:data.codigo||null,p_cliente:cloud.clientId,p_usuario_nombre:cloud.displayName});if(error)throw error;
        return json({ok:true,item:item?receiptItem(item):null,viewer_client_id:cloud.clientId});
      }
      if(path==='/api/recepcion/release' && method==='POST') {
        const {data:released,error}=await cloud.db.rpc('op_recepcion_liberar',{p_recepcion:data.reception_id,p_cliente:cloud.clientId,p_codigo:data.codigo||null,p_usuario_nombre:cloud.displayName});if(error)throw error;
        return json({ok:true,released:Number(released)||0});
      }
      if(path==='/api/recepcion/heartbeat' && method==='POST') {
        const {error}=await cloud.db.rpc('op_recepcion_tocar',{p_recepcion:data.reception_id,p_cliente:cloud.clientId,p_usuario_nombre:cloud.displayName});if(error)throw error;
        return json({ok:true,at:new Date().toISOString()});
      }
      if(path==='/api/recepcion/update_qty' && method==='POST') {
        const {data:item,error}=await cloud.db.rpc('op_recepcion_cantidad_colaborativa',{p_recepcion:data.reception_id,p_codigo:data.codigo,p_delta:data.absolute==null?Number(data.delta||0):null,p_absoluta:data.absolute==null?null:Number(data.absolute),p_origen:data.source||'manual',p_usuario_nombre:cloud.displayName,p_cliente:cloud.clientId}); if(error)throw error;
        const receipt=await receptionSnapshot(data.reception_id); return json({ok:true,item:receiptItem(item),summary:receipt.summary});
      }
      if(path==='/api/recepcion/verify_qty' && method==='POST') {
        const {data:item,error}=await cloud.db.rpc('op_verificar_recepcion_cantidad',{p_recepcion:data.reception_id,p_codigo:data.codigo,p_cantidad:Number(data.cantidad),p_usuario_nombre:cloud.displayName});if(error)throw error;
        return json({ok:true,item:receiptItem(item)});
      }
      if(path==='/api/recepcion/no_recibido' && method==='POST') {
        const {data:item,error}=await cloud.db.rpc('op_recepcion_no_recibido_colaborativo',{p_recepcion:data.reception_id,p_codigo:data.codigo,p_valor:!!data.value,p_observacion:clean(data.observation)||null,p_usuario_nombre:cloud.displayName,p_cliente:cloud.clientId}); if(error)throw error;
        const receipt=await receptionSnapshot(data.reception_id); return json({ok:true,item:receiptItem(item),summary:receipt.summary});
      }
      if(path==='/api/recepcion/extra' && method==='POST') {
        const {data:extra,error}=await cloud.db.rpc('op_recepcion_extra',{p_recepcion:data.reception_id,p_codigo:data.codigo,p_nombre:data.nombre||data.codigo,p_barras:data.barras||null,p_delta:data.absolute==null?Number(data.delta||0):null,p_absoluta:data.absolute==null?null:Number(data.absolute),p_observacion:data.observation||null,p_usuario_nombre:cloud.displayName}); if(error)throw error;
        const receipt=await receptionSnapshot(data.reception_id); return json({ok:true,extra:{codigo:extra.codigo,nombre:extra.nombre,barras:extra.barras||'',cantidad:extra.cantidad,observacion:extra.observacion||'',updated_by:extra.updated_by_name||'',updated_at:extra.updated_at},summary:receipt.summary});
      }
      if(path==='/api/recepcion/extra/remove' && method==='POST') { const {error}=await cloud.db.from('op_recepcion_extras').delete().eq('recepcion_id',data.reception_id).eq('codigo',data.codigo);if(error)throw error;const receipt=await receptionSnapshot(data.reception_id);return json({ok:true,summary:receipt.summary}); }
      if(path==='/api/recepcion/close' && method==='POST') { const result=await cloud.finalizeReception(data.reception_id,data.observations);return json({ok:true,result,receipt:await receptionSnapshot(data.reception_id)}); }
      if(path==='/api/recepcion/original') { const {data:receipt,error}=await cloud.db.from('op_recepciones').select('original_path,original_filename').eq('id',url.searchParams.get('rid')).single();if(error)throw error;if(!receipt.original_path)return json({ok:false,error:'Archivo original no disponible'},404);const {data:signed,error:signError}=await cloud.db.storage.from('op-recepciones').createSignedUrl(receipt.original_path,60,{download:receipt.original_filename||'remito.xls'});if(signError)throw signError;return json({ok:true,url:signed.signedUrl}); }
      if(path==='/api/reposicion/delete' && method==='POST') {
        const repoId=clean(data.reposition_id);
        if(!repoId) throw new Error('Reposición no indicada');
        const {data:deleted,error}=await cloud.db.rpc('op_eliminar_reposicion',{p_reposicion:repoId});
        if(error) throw error;
        if(deleted?.original_path) {
          const {error:storageError}=await cloud.db.storage.from('op-reposiciones').remove([deleted.original_path]);
          if(storageError) console.warn('La reposición se eliminó, pero no se pudo borrar su archivo original',storageError);
        }
        return json({ok:true,deleted});
      }
      if(path==='/api/reposicion/state') {
        const rid=url.searchParams.get('rid');
        const [participantResult,touchResult]=await Promise.all([
          cloud.db.from('op_reposicion_participantes').upsert({reposicion_id:rid,usuario_id:cloud.user.id,nombre:cloud.displayName,last_seen:new Date().toISOString()},{onConflict:'reposicion_id,usuario_id'}),
          cloud.db.rpc('op_reposicion_tocar',{p_reposicion:rid,p_cliente:cloud.clientId,p_usuario_nombre:cloud.displayName})
        ]);
        if(participantResult.error||touchResult.error)throw participantResult.error||touchResult.error;
        return json({ok:true,repo:await repoSnapshot(rid)});
      }
      if(path==='/api/reposicion/claim' && method==='POST') {
        const {data:item,error}=await cloud.db.rpc('op_reposicion_reclamar',{
          p_reposicion:data.reposition_id,p_codigo:data.codigo||null,p_cliente:cloud.clientId,
          p_usuario_nombre:cloud.displayName,p_excluir_codigo:data.exclude_codigo||null
        });
        if(error)throw error;
        return json({ok:true,item:item?repoItem(item):null,viewer_client_id:cloud.clientId});
      }
      if(path==='/api/reposicion/release' && method==='POST') {
        const {data:released,error}=await cloud.db.rpc('op_reposicion_liberar',{
          p_reposicion:data.reposition_id,p_cliente:cloud.clientId,p_codigo:data.codigo||null,p_usuario_nombre:cloud.displayName
        });
        if(error)throw error; return json({ok:true,released:Number(released)||0});
      }
      if(path==='/api/reposicion/heartbeat' && method==='POST') {
        const {error}=await cloud.db.rpc('op_reposicion_tocar',{p_reposicion:data.reposition_id,p_cliente:cloud.clientId,p_usuario_nombre:cloud.displayName});
        if(error)throw error; return json({ok:true,at:new Date().toISOString()});
      }
      if(path==='/api/reposicion/update_qty' && method==='POST') {
        const args={p_reposicion:data.reposition_id,p_codigo:data.codigo,p_delta:data.absolute==null?Number(data.delta||0):null,p_absoluta:data.absolute==null?null:Number(data.absolute),p_origen:data.source||'manual',p_usuario_nombre:cloud.displayName,p_cliente:cloud.clientId};
        const {data:item,error}=await cloud.db.rpc('op_reposicion_cantidad_colaborativa',args); if(error)throw error;
        const mapped=repoItem(item); const repo=await repoSnapshot(data.reposition_id); return json({ok:true,item:mapped,summary:repo.summary});
      }
      if(path==='/api/reposicion/verify_qty' && method==='POST') {
        const {data:item,error}=await cloud.db.rpc('op_verificar_reposicion_cantidad',{p_reposicion:data.reposition_id,p_codigo:data.codigo,p_cantidad:Number(data.cantidad),p_usuario_nombre:cloud.displayName});if(error)throw error;
        return json({ok:true,item:repoItem(item)});
      }
      if(path==='/api/reposicion/mark' && method==='POST') {
        const args={
          p_reposicion:data.reposition_id,p_codigo:data.codigo,p_campo:data.field,p_valor:!!data.value,
          p_motivo_codigo:clean(data.motivo_codigo)||null,
          p_motivo_label:clean(data.motivo_label)||({stock_insuficiente:'Stock insuficiente',otro:'Otro',cantidad_incompleta:'Cantidad incompleta'}[data.motivo_codigo]||null),
          p_motivo_otro:clean(data.motivo_otro)||null,p_comentario:clean(data.comentario)||null,
          p_usuario_nombre:cloud.displayName,p_cliente:cloud.clientId
        };
        const {data:item,error}=await cloud.db.rpc('op_reposicion_marcar_colaborativa',args); if(error)throw error;
        const repo=await repoSnapshot(data.reposition_id); return json({ok:true,item:repoItem(item),summary:repo.summary});
      }
      if(path==='/api/reposicion/extra' && method==='POST') { const {data:existing}=await cloud.db.from('op_reposicion_extras').select('*').eq('reposicion_id',data.reposition_id).eq('codigo',data.codigo).maybeSingle(); const qty=data.absolute==null?Number(existing?.cantidad||0)+Number(data.delta||1):Number(data.absolute); if(qty<0)throw new Error('Cantidad inválida'); const {data:row,error}=await cloud.db.from('op_reposicion_extras').upsert({reposicion_id:data.reposition_id,codigo:data.codigo,nombre:data.nombre||existing?.nombre||data.codigo,barras:data.barras||existing?.barras||null,cantidad:qty,nota:data.nota||existing?.nota||'',updated_by:cloud.user.id,updated_by_name:cloud.displayName,updated_at:new Date().toISOString()},{onConflict:'reposicion_id,codigo'}).select().single(); if(error)throw error; const repo=await repoSnapshot(data.reposition_id); return json({ok:true,extra:{codigo:row.codigo,nombre:row.nombre,barras:row.barras||'',cantidad:row.cantidad,nota:row.nota||'',updated_by:cloud.displayName,updated_at:row.updated_at},summary:repo.summary}); }
      if(path==='/api/reposicion/extra/remove' && method==='POST') { const {error}=await cloud.db.from('op_reposicion_extras').delete().eq('reposicion_id',data.reposition_id).eq('codigo',data.codigo); if(error)throw error; const repo=await repoSnapshot(data.reposition_id); return json({ok:true,codigo:data.codigo,summary:repo.summary}); }
      if(path==='/api/reposicion/export_log' && method==='POST') { await cloud.db.from('op_reposicion_eventos').insert({reposicion_id:data.reposition_id,usuario_id:cloud.user.id,usuario_nombre:cloud.displayName,accion:'exportar',detalle:{tipo:data.tipo,nombre:data.nombre}}); return json({ok:true}); }
      if(path==='/api/reposicion/export_package' && method==='POST') return exportZip(data);
      if(path==='/api/reposicion/original') { const {data:repo,error}=await cloud.db.from('op_reposiciones').select('original_path,original_filename').eq('id',url.searchParams.get('rid')).single(); if(error)throw error; if(!repo.original_path)return json({ok:false,error:'Archivo original no disponible'},404); const {data:signed,error:signError}=await cloud.db.storage.from('op-reposiciones').createSignedUrl(repo.original_path,60,{download:repo.original_filename||'reposicion.xls'}); if(signError)throw signError; return json({ok:true,url:signed.signedUrl}); }
      if(path==='/api/barcode_assignments' && method==='GET') { const result=await barcodeAssignments(); return json({ok:true,...result,total:result.assignments.length}); }
      if(path==='/api/barcode_assignments' && method==='POST') { const result=await createBarcodeAssignment(data); return json({ok:true,...result}); }
      if(/^\/api\/barcode_assignments\/[^/]+\/discard$/.test(path) && method==='POST') { const id=decodeURIComponent(path.split('/')[3]); const {data:row,error}=await cloud.db.from('op_asignaciones_barras').update({status:'discarded',updated_at:new Date().toISOString()}).eq('id',id).select().single(); if(error)throw error; const result=await barcodeAssignments(); return json({ok:true,assignment:row,effective:result.effective}); }
      if(path==='/api/clients') {
        const sid=url.searchParams.get('sid');
        if(!sid) return json({connected:0});
        const {count,error}=await cloud.db.from('op_inventario_participantes').select('usuario_id',{count:'exact',head:true}).eq('sesion_id',sid);
        if(error) throw error;
        return json({connected:count||0});
      }
      if(path==='/api/imagen'||path==='/api/imagen_ready') return json({ok:false,url:null});
      return json({ok:false,error:`Ruta no disponible: ${path}`},404);
    } catch (error) { return errorResponse(error); }
  }

  cloud.loadOriginal = async function (repoId) {
    const response=await handleApi(`/api/reposicion/original?rid=${encodeURIComponent(repoId)}`);
    const data=await response.json(); if(!response.ok||!data.ok)throw new Error(data.error||'Original no disponible');
    location.href=data.url;
  };
  cloud.watchInventory = function (sessionId, callback) {
    const channel=cloud.db.channel(`op-inventory-${sessionId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_inventario_items',filter:`sesion_id=eq.${sessionId}`},callback)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'op_inventario_eventos',filter:`sesion_id=eq.${sessionId}`},callback)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_inventario_balances',filter:`sesion_id=eq.${sessionId}`},callback)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_inventario_participantes',filter:`sesion_id=eq.${sessionId}`},callback)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'op_inventario_sesiones',filter:`id=eq.${sessionId}`},callback).subscribe();
    cloud.channels.push(channel); return channel;
  };
  cloud.watchReposition = function (repoId, callback) {
    const channel=cloud.db.channel(`op-repo-${repoId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposicion_items',filter:`reposicion_id=eq.${repoId}`},payload=>callback({kind:'item',event:payload.eventType,item:payload.new?.codigo?repoItem(payload.new):null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposicion_extras',filter:`reposicion_id=eq.${repoId}`},payload=>callback({kind:'extra',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposicion_dispositivos',filter:`reposicion_id=eq.${repoId}`},payload=>callback({kind:'device',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposiciones',filter:`id=eq.${repoId}`},payload=>callback({kind:'repository',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .subscribe(status=>callback({kind:'status',status}));
    cloud.channels.push(channel); return channel;
  };
  cloud.watchReception = function (receiptId, callback) {
    const channel=cloud.db.channel(`op-reception-${receiptId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_recepcion_items',filter:`recepcion_id=eq.${receiptId}`},payload=>callback({kind:'item',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_recepcion_extras',filter:`recepcion_id=eq.${receiptId}`},payload=>callback({kind:'extra',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_recepcion_participantes',filter:`recepcion_id=eq.${receiptId}`},payload=>callback({kind:'participant',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_recepcion_dispositivos',filter:`recepcion_id=eq.${receiptId}`},payload=>callback({kind:'device',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .on('postgres_changes',{event:'*',schema:'public',table:'op_recepciones',filter:`id=eq.${receiptId}`},payload=>callback({kind:'reception',event:payload.eventType,row:payload.new||null,old:payload.old||null}))
      .subscribe(status=>callback({kind:'status',status}));
    cloud.channels.push(channel); return channel;
  };
  cloud.watchCatalog = function (callback) {
    const channel=cloud.db.channel(`op-catalog-${cloud.user.id}`)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'catalogo_version'},callback).subscribe();
    cloud.channels.push(channel); return channel;
  };
  cloud.watchSessionDirectory = function (callback) {
    const channel=cloud.db.channel(`op-directory-${cloud.user.id}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_inventario_sesiones'},callback)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'op_inventario_participantes'},callback)
      .on('postgres_changes',{event:'DELETE',schema:'public',table:'op_inventario_participantes'},callback)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposiciones'},callback)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'op_reposicion_participantes'},callback)
      .on('postgres_changes',{event:'DELETE',schema:'public',table:'op_reposicion_participantes'},callback)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_recepciones'},callback)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'op_recepcion_participantes'},callback)
      .on('postgres_changes',{event:'DELETE',schema:'public',table:'op_recepcion_participantes'},callback).subscribe();
    cloud.channels.push(channel); return channel;
  };
  cloud.checkUrgentOrders = async function (repo) {
    if(!repo?.started_at) return [];
    const {data,error}=await cloud.db.from('pedidos').select('id,cliente,telefono,urgente,updated_at,pedido_productos(*)')
      .eq('estado','aceptado').eq('urgente',true).eq('origen_local',repo.origin).eq('destino_local',repo.destination)
      .is('reposicion_id',null).gt('updated_at',repo.started_at);
    if(error)throw error; return data||[];
  };
  cloud.addUrgentOrder = async function (repoId, orderId) {
    if(!cloud.isSupervisor()) throw new Error('Solo un supervisor puede agregar pedidos urgentes a la reposición actual');
    const {error}=await cloud.db.rpc('op_agregar_pedido_urgente',{p_reposicion:repoId,p_pedido:orderId});
    if(error)throw error;
    return repoSnapshot(repoId);
  };
  cloud.finalizeReception = async function (receiptId, observations) {
    const {data,error}=await cloud.db.rpc('op_recepcion_cerrar',{p_recepcion:receiptId,p_observaciones:observations||null}); if(error)throw error; return data;
  };
  cloud.markCustomerNotified = async function (orderId) {
    const {data,error}=await cloud.db.rpc('op_marcar_cliente_avisado',{p_pedido:orderId}); if(error)throw error; return data;
  };
  cloud.goPortal = () => { location.href=config.portalUrl; };
  cloud.goPedidos = () => { location.href=config.pedidosUrl; };

  window.fetch = function (input, options) {
    return isCloudApiRequest(input) ? handleApi(input,options) : nativeFetch(input,options);
  };
})();
