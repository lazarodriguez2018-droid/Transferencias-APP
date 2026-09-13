(function(global){
  'use strict';

  const targets={
    inventario:'analytics-360-inventario',
    reposicion:'analytics-360-reposicion',
    recepcion:'analytics-360-recepcion'
  };
  const controllers=new Map();
  const pending=new Map();

  function reportError(error){
    console.error(error);
    if(typeof global.toast==='function')global.toast('No se pudo cargar el análisis histórico.','e');
  }

  function renderRetry(root,module,rootId,cacheKey,error){
    const controller=controllers.get(cacheKey);
    try{controller?.destroy?.();}catch(destroyError){console.error(destroyError);}
    controllers.delete(cacheKey);
    reportError(error);
    if(!root)return null;
    root.innerHTML='<div class="analytics-360"><div class="a360-empty"><div><strong>No se pudo cargar el análisis histórico.</strong><br><span>Revisá la conexión e intentá nuevamente.</span><br><button class="a360-button secondary" type="button" data-a360-retry>Reintentar</button></div></div></div>';
    const retry=typeof root.querySelector==='function'?root.querySelector('[data-a360-retry]'):null;
    retry?.addEventListener('click',()=>mountAt(module,rootId,cacheKey));
    return null;
  }

  async function locationOptions(cloud){
    if(!cloud.isSupervisor?.())return [];
    const {data,error}=await cloud.db.from('locales').select('nombre,almacen').order('nombre');
    if(error)throw error;
    return data||[];
  }

  async function mountAt(module,rootId,cacheKey){
    if(!targets[module])throw new Error('Módulo de análisis inválido.');
    const root=document.getElementById(rootId);
    if(!root)return null;
    const existing=controllers.get(cacheKey);
    if(existing){
      try{return await existing.refresh();}
      catch(error){return renderRetry(root,module,rootId,cacheKey,error);}
    }
    if(pending.has(cacheKey))return pending.get(cacheKey);

    const task=(async()=>{
      const cloud=global.SucanCloud;
      if(!cloud?.db||!global.Analytics360?.mount)throw new Error('El análisis histórico no está disponible.');
      await cloud.ready;
      const isSupervisor=!!cloud.isSupervisor?.();
      const controller=global.Analytics360.mount({
        root,
        db:cloud.db,
        module,
        local:isSupervisor?'':String(cloud.profile?.local_nombre||''),
        isSupervisor,
        locals:await locationOptions(cloud),
        defaultRange:'all',
        autoload:false,
        onError:reportError
      });
      controllers.set(cacheKey,controller);
      return controller.load();
    })().catch(error=>renderRetry(root,module,rootId,cacheKey,error)).finally(()=>pending.delete(cacheKey));
    pending.set(cacheKey,task);
    return task;
  }

  function mount(module){
    return mountAt(module,targets[module],`page:${module}`);
  }

  async function mountDirectory(module=new URLSearchParams(global.location.search).get('module')){
    if(!targets[module])return null;
    const cacheKey='directory';
    if(pending.has(cacheKey))await pending.get(cacheKey);
    const existing=controllers.get(cacheKey);
    if(existing){
      try{return await existing.setModule(module);}
      catch(error){return renderRetry(document.getElementById('analytics-360-directory'),module,'analytics-360-directory',cacheKey,error);}
    }
    return mountAt(module,'analytics-360-directory',cacheKey);
  }

  global.loadOperationsAnalytics=mount;
  global.loadOperationsDirectoryAnalytics=mountDirectory;
  global.SucanOperationsAnalytics=Object.freeze({load:mount,loadDirectory:mountDirectory});
})(window);
