(function () {
  'use strict';

  const config = window.SUCANEITOR_CLOUD_CONFIG;
  const nativeFetch = window.fetch.bind(window);
  const cloud = window.SucanCloud = {
    db: null,
    user: null,
    profile: null,
    displayName: 'Usuario',
    ready: null,
    channels: [],
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
  async function localeFor(value) {
    const target = clean(value).toLocaleLowerCase('es');
    const {data,error} = await cloud.db.from('locales').select('nombre,almacen');
    if (error) throw error;
    return (data || []).find(row => clean(row.nombre).toLocaleLowerCase('es') === target || clean(row.almacen).toLocaleLowerCase('es') === target) || {nombre:clean(value),almacen:clean(value)};
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
    (items || []).forEach(item => { countItems[item.codigo] = {codigo:item.codigo,nombre:item.nombre,barras:item.barras || '',qty:item.cantidad,tipos:item.tipos || {}}; });
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

  function repoItem(row) {
    return {
      codigo:row.codigo,nombre:row.nombre,descripcion_archivo:row.descripcion_archivo || '',barras:row.barras || '',marca:row.marca || '',
      pedido:Number(row.pedido_total || Math.max(row.pedido_reposicion || 0,row.pedido_clientes || 0)),
      pedido_reposicion:Number(row.pedido_reposicion || 0),pedido_clientes:Number(row.pedido_clientes || 0),
      stock_origen:Number(row.stock_origen || 0),preparado:Number(row.preparado || 0),
      no_encontrado:!!row.no_encontrado,cerrado_incompleto:!!row.cerrado_incompleto,
      motivo_codigo:row.motivo_codigo || '',motivo_label:row.motivo_label || '',motivo_otro:row.motivo_otro || '',
      comentario:row.comentario || '',motivo:[row.motivo_label,row.motivo_otro,row.comentario].filter(Boolean).join(' · '),
      pedidos_asignados:row.pedidos_asignados || [],updated_by:row.updated_by_name || '',updated_at:row.updated_at
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
      extras_productos:extras.filter(item=>Number(item.cantidad)>0).length,
      extras_unidades:extras.reduce((sum,item)=>sum+Math.max(0,Number(item.cantidad)||0),0)
    };
  }
  async function repoSnapshot(repoId) {
    const [{data:repo,error:re},{data:items,error:ie},{data:extras,error:xe},{data:parts,error:pe},{data:events,error:ee}] = await Promise.all([
      cloud.db.from('op_reposiciones').select('*').eq('id',repoId).single(),
      cloud.db.from('op_reposicion_items').select('*').eq('reposicion_id',repoId).order('nombre'),
      cloud.db.from('op_reposicion_extras').select('*').eq('reposicion_id',repoId).order('nombre'),
      cloud.db.from('op_reposicion_participantes').select('*').eq('reposicion_id',repoId).order('joined_at'),
      cloud.db.from('op_reposicion_eventos').select('*').eq('reposicion_id',repoId).order('created_at',{ascending:false}).limit(500)
    ]);
    if (re || ie || xe || pe || ee) throw re || ie || xe || pe || ee;
    const snapshot = {
      id:repo.id,nombre:repo.nombre,origin:repo.origen_local,destination:repo.destino_local,estado:repo.estado,
      started_at:repo.started_at,created_at:repo.created_at,updated_at:repo.updated_at,
      original_filename:repo.original_filename,original_file:repo.original_path,import_meta:repo.import_meta || {},
      transporte:repo.transporte,remito:repo.remito,remito_pendiente:repo.remito_pendiente,
      items:(items || []).map(repoItem),
      extras:(extras || []).map(row=>({codigo:row.codigo,nombre:row.nombre,barras:row.barras || '',cantidad:row.cantidad,nota:row.nota || '',updated_by:row.updated_by_name || '',updated_at:row.updated_at})),
      participantes:(parts || []).map(row=>({nombre:row.nombre,joined:asDate(row.joined_at)})),
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

  async function listInventorySessions() {
    const {data,error}=await cloud.db.from('op_inventario_sesiones').select('*').eq('estado','abierta').order('updated_at',{ascending:false});
    if(error) throw error;
    return Promise.all((data||[]).map(async session=>{
      const [{count:products},{data:items},{data:parts}] = await Promise.all([
        cloud.db.from('op_inventario_items').select('codigo',{count:'exact',head:true}).eq('sesion_id',session.id),
        cloud.db.from('op_inventario_items').select('cantidad').eq('sesion_id',session.id),
        cloud.db.from('op_inventario_participantes').select('nombre,joined_at').eq('sesion_id',session.id)
      ]);
      return {id:session.id,nombre:session.nombre,creada:asDate(session.created_at),creada_fecha:session.created_at,updated_at:session.updated_at,usuarios:(parts||[]).map(p=>({nombre:p.nombre,joined:asDate(p.joined_at)})),productos:products||0,unidades:(items||[]).reduce((s,i)=>s+Number(i.cantidad||0),0),local_nombre:session.local_nombre||'',almacen:session.almacen||''};
    }));
  }
  async function listRepositions() {
    const since=new Date(Date.now()-90*24*60*60*1000).toISOString();
    const {data,error}=await cloud.db.from('op_reposiciones').select('*').in('estado',['preparando','enviado']).gte('created_at',since).order('updated_at',{ascending:false});
    if(error) throw error;
    return Promise.all((data||[]).map(async row=>{
      const snap=await repoSnapshot(row.id);
      return {id:row.id,nombre:row.nombre,origin:row.origen_local,destination:row.destino_local,estado:row.estado,remito:row.remito,remito_pendiente:row.remito_pendiente,created_at:row.created_at,updated_at:row.updated_at,participantes:snap.participantes,summary:snap.summary};
    }));
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
      if(path==='/api/padron' && method==='GET') { const products=await paginate('productos','codigo,barras,nombre,fabricante,marca','nombre'); return json({ok:true,padron:products,total:products.length}); }
      if(path==='/api/padron' && method==='POST') { if(!cloud.isSupervisor()) return json({ok:false,error:'Solo supervisores pueden modificar el padrón'},403); const {data:total,error}=await cloud.db.rpc('reemplazar_padron_productos',{payload:data.padron||[]}); if(error)throw error; return json({ok:true,total}); }
      if(path==='/api/sesiones') return json(await listInventorySessions());
      if(path==='/api/reposiciones') return json(await listRepositions());
      if(path==='/api/sesion/crear' && method==='POST') {
        let session;
        if(data.session_id){ const {data:row,error}=await cloud.db.from('op_inventario_sesiones').select('*').eq('id',data.session_id).single(); if(error)throw error; session=row; }
        else { const local=cloud.profile.local_nombre || 'Sin local'; const {data:row,error}=await cloud.db.from('op_inventario_sesiones').insert({nombre:clean(data.nombre_sesion),local_nombre:local,almacen:cloud.profile.almacen||null,created_by:cloud.user.id}).select().single(); if(error)throw error; session=row; }
        await cloud.db.from('op_inventario_participantes').upsert({sesion_id:session.id,usuario_id:cloud.user.id,nombre:cloud.displayName,last_seen:new Date().toISOString()},{onConflict:'sesion_id,usuario_id'});
        return json({ok:true,session_id:session.id,nombre:session.nombre,usuarios:[{nombre:cloud.displayName}],state:await inventoryState(session.id)});
      }
      if(path==='/api/sesion/salir' && method==='POST') { await cloud.db.from('op_inventario_participantes').delete().eq('sesion_id',data.session_id).eq('usuario_id',cloud.user.id); return json({ok:true}); }
      if(path==='/api/state') return json(await inventoryState(url.searchParams.get('sid')));
      if(path==='/api/add' && method==='POST') { const {data:item,error}=await cloud.db.rpc('op_inventario_sumar',{p_sesion:data.session_id,p_codigo:data.codigo,p_nombre:data.nombre,p_barras:data.barras||'',p_cantidad:Number(data.qty)||1,p_tipo:data.tipo||'nombre'}); if(error)throw error; return json({ok:true,item:{codigo:item.codigo,nombre:item.nombre,barras:item.barras||'',qty:item.cantidad,tipos:item.tipos||{}}}); }
      if(path==='/api/update_qty' && method==='POST') { const {error}=await cloud.db.rpc('op_inventario_ajustar',{p_sesion:data.session_id,p_codigo:data.codigo,p_delta:Number(data.delta)||0}); if(error)throw error; return json({ok:true}); }
      if(path==='/api/remove' && method==='POST') { const {error}=await cloud.db.from('op_inventario_items').delete().eq('sesion_id',data.session_id).eq('codigo',data.codigo); if(error)throw error; return json({ok:true}); }
      if(path==='/api/clear' && method==='POST') { const {error}=await cloud.db.from('op_inventario_items').delete().eq('sesion_id',data.session_id); if(error)throw error; await cloud.db.from('op_inventario_eventos').delete().eq('sesion_id',data.session_id); return json({ok:true}); }
      if(path==='/api/set_almacen' && method==='POST') { const {error}=await cloud.db.from('op_inventario_sesiones').update({almacen:data.almacen,updated_at:new Date().toISOString()}).eq('id',data.session_id); if(error)throw error; return json({ok:true}); }
      if(path==='/api/balance' && method==='GET') { const {data:row,error}=await cloud.db.from('op_inventario_balances').select('*').eq('sesion_id',url.searchParams.get('session_id')).maybeSingle(); if(error)throw error; return json({ok:true,balance:row?.balance||[],meta:row?.meta||null,updated:row?.updated_at||null}); }
      if(path==='/api/balance' && method==='POST') { const {error}=await cloud.db.from('op_inventario_balances').upsert({sesion_id:data.session_id,balance:data.balance||[],meta:data.meta||{},updated_by:cloud.user.id,updated_at:new Date().toISOString()},{onConflict:'sesion_id'}); if(error)throw error; return json({ok:true,total:(data.balance||[]).length}); }
      if(path==='/api/reposicion/crear' && method==='POST') { const repo=await createReposition(data); return json({ok:true,reposition_id:repo.id,repo}); }
      if(path==='/api/reposicion/state') { const rid=url.searchParams.get('rid'); await cloud.db.from('op_reposicion_participantes').upsert({reposicion_id:rid,usuario_id:cloud.user.id,nombre:cloud.displayName,last_seen:new Date().toISOString()},{onConflict:'reposicion_id,usuario_id'}); return json({ok:true,repo:await repoSnapshot(rid)}); }
      if(path==='/api/reposicion/update_qty' && method==='POST') { const args={p_reposicion:data.reposition_id,p_codigo:data.codigo,p_delta:data.absolute==null?Number(data.delta||0):null,p_absoluta:data.absolute==null?null:Number(data.absolute),p_origen:data.source||'manual',p_usuario_nombre:cloud.displayName}; const {data:item,error}=await cloud.db.rpc('op_reposicion_cantidad',args); if(error)throw error; const mapped=repoItem(item); const repo=await repoSnapshot(data.reposition_id); return json({ok:true,item:mapped,summary:repo.summary}); }
      if(path==='/api/reposicion/mark' && method==='POST') { const updates={updated_by:cloud.user.id,updated_by_name:cloud.displayName,updated_at:new Date().toISOString(),comentario:clean(data.comentario),motivo_codigo:clean(data.motivo_codigo),motivo_label:clean(data.motivo_label)||({stock_insuficiente:'Stock insuficiente',otro:'Otro',cantidad_incompleta:'Cantidad incompleta'}[data.motivo_codigo]||''),motivo_otro:clean(data.motivo_otro)}; updates[data.field]=!!data.value; if(data.field==='no_encontrado'&&data.value)updates.cerrado_incompleto=true; const {data:item,error}=await cloud.db.from('op_reposicion_items').update(updates).eq('reposicion_id',data.reposition_id).eq('codigo',data.codigo).select().single(); if(error)throw error; await cloud.db.from('op_reposicion_eventos').insert({reposicion_id:data.reposition_id,usuario_id:cloud.user.id,usuario_nombre:cloud.displayName,accion:data.field,codigo:data.codigo,detalle:updates}); const repo=await repoSnapshot(data.reposition_id); return json({ok:true,item:repoItem(item),summary:repo.summary}); }
      if(path==='/api/reposicion/extra' && method==='POST') { const {data:existing}=await cloud.db.from('op_reposicion_extras').select('*').eq('reposicion_id',data.reposition_id).eq('codigo',data.codigo).maybeSingle(); const qty=data.absolute==null?Number(existing?.cantidad||0)+Number(data.delta||1):Number(data.absolute); if(qty<0)throw new Error('Cantidad inválida'); const {data:row,error}=await cloud.db.from('op_reposicion_extras').upsert({reposicion_id:data.reposition_id,codigo:data.codigo,nombre:data.nombre||existing?.nombre||data.codigo,barras:data.barras||existing?.barras||null,cantidad:qty,nota:data.nota||existing?.nota||'',updated_by:cloud.user.id,updated_by_name:cloud.displayName,updated_at:new Date().toISOString()},{onConflict:'reposicion_id,codigo'}).select().single(); if(error)throw error; const repo=await repoSnapshot(data.reposition_id); return json({ok:true,extra:{codigo:row.codigo,nombre:row.nombre,barras:row.barras||'',cantidad:row.cantidad,nota:row.nota||'',updated_by:cloud.displayName,updated_at:row.updated_at},summary:repo.summary}); }
      if(path==='/api/reposicion/extra/remove' && method==='POST') { const {error}=await cloud.db.from('op_reposicion_extras').delete().eq('reposicion_id',data.reposition_id).eq('codigo',data.codigo); if(error)throw error; const repo=await repoSnapshot(data.reposition_id); return json({ok:true,codigo:data.codigo,summary:repo.summary}); }
      if(path==='/api/reposicion/export_log' && method==='POST') { await cloud.db.from('op_reposicion_eventos').insert({reposicion_id:data.reposition_id,usuario_id:cloud.user.id,usuario_nombre:cloud.displayName,accion:'exportar',detalle:{tipo:data.tipo,nombre:data.nombre}}); return json({ok:true}); }
      if(path==='/api/reposicion/export_package' && method==='POST') return exportZip(data);
      if(path==='/api/reposicion/original') { const {data:repo,error}=await cloud.db.from('op_reposiciones').select('original_path,original_filename').eq('id',url.searchParams.get('rid')).single(); if(error)throw error; if(!repo.original_path)return json({ok:false,error:'Archivo original no disponible'},404); const {data:signed,error:signError}=await cloud.db.storage.from('op-reposiciones').createSignedUrl(repo.original_path,60,{download:repo.original_filename||'reposicion.xls'}); if(signError)throw signError; return json({ok:true,url:signed.signedUrl}); }
      if(path==='/api/barcode_assignments' && method==='GET') { const result=await barcodeAssignments(); return json({ok:true,...result,total:result.assignments.length}); }
      if(path==='/api/barcode_assignments' && method==='POST') { const result=await createBarcodeAssignment(data); return json({ok:true,...result}); }
      if(/^\/api\/barcode_assignments\/[^/]+\/discard$/.test(path) && method==='POST') { const id=decodeURIComponent(path.split('/')[3]); const {data:row,error}=await cloud.db.from('op_asignaciones_barras').update({status:'discarded',updated_at:new Date().toISOString()}).eq('id',id).select().single(); if(error)throw error; const result=await barcodeAssignments(); return json({ok:true,assignment:row,effective:result.effective}); }
      if(path==='/api/clients') return json({connected:1});
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
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'op_inventario_eventos',filter:`sesion_id=eq.${sessionId}`},callback).subscribe();
    cloud.channels.push(channel); return channel;
  };
  cloud.watchReposition = function (repoId, callback) {
    const channel=cloud.db.channel(`op-repo-${repoId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposicion_items',filter:`reposicion_id=eq.${repoId}`},callback)
      .on('postgres_changes',{event:'*',schema:'public',table:'op_reposicion_extras',filter:`reposicion_id=eq.${repoId}`},callback).subscribe();
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
  cloud.finalizeDispatch = async function ({repoId,transporte,remito,remitoPendiente,observaciones}) {
    const {data,error}=await cloud.db.rpc('op_finalizar_despacho',{p_reposicion:repoId,p_transporte:transporte,p_remito:remito||null,p_remito_pendiente:!!remitoPendiente,p_observaciones:observaciones||null});
    if(error)throw error; return data;
  };
  cloud.updateDispatchRemito = async function (repoId, remito) {
    if(!clean(remito))throw new Error('Ingresá el número de remito');
    const {error}=await cloud.db.rpc('op_actualizar_remito',{p_reposicion:repoId,p_remito:clean(remito)}); if(error)throw error;
    return {id:repoId};
  };
  cloud.goPortal = () => { location.href=config.portalUrl; };
  cloud.goPedidos = () => { location.href=config.pedidosUrl; };

  window.fetch = function (input, options) {
    return isCloudApiRequest(input) ? handleApi(input,options) : nativeFetch(input,options);
  };
})();
