(function(global){
  'use strict';

  const MODULES=new Set(['global','inventario','reposicion','recepcion','pedidos','reservas']);
  const PRESETS=new Set(['30d','90d','365d','all','custom']);
  const numberFormat=new Intl.NumberFormat('es-UY',{maximumFractionDigits:1});
  const integerFormat=new Intl.NumberFormat('es-UY',{maximumFractionDigits:0});

  function escapeHtml(value){
    return String(value==null?'':value).replace(/[&<>"']/g,char=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[char]));
  }

  function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(String(value||''));}
  const montevideoDateFormat=new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'
  });
  function isoLocal(date){
    const parts=Object.fromEntries(montevideoDateFormat.formatToParts(date).map(part=>[part.type,part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function shiftIsoDate(value,days){
    const [year,month,day]=value.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));
    date.setUTCDate(date.getUTCDate()+days);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
  }
  function presetDates(preset){
    if(preset==='all')return {dateFrom:null,dateTo:null};
    const days=Number(String(preset).replace('d',''))||90;
    const dateTo=isoLocal(new Date());
    return {dateFrom:shiftIsoDate(dateTo,-(days-1)),dateTo};
  }
  function normalizeLocal(row){
    if(typeof row==='string')return {nombre:row,almacen:'',historical:false};
    return {
      nombre:String(row?.nombre||row?.name||''),
      almacen:String(row?.almacen||row?.warehouse||''),
      historical:row?.historical===true||row?.historico===true
    };
  }
  function mergeLocations(...groups){
    const locations=new Map();
    groups.flat().map(normalizeLocal).filter(item=>item.nombre).forEach(item=>{
      const previous=locations.get(item.nombre);
      if(!previous||previous.historical&&!item.historical||!previous.almacen&&item.almacen){
        locations.set(item.nombre,{...previous,...item});
      }
    });
    return [...locations.values()].sort((left,right)=>left.nombre.localeCompare(right.nombre,'es',{sensitivity:'base'}));
  }
  function locationOptionsHtml(rows){
    return rows.map(row=>`<option value="${escapeHtml(row.nombre)}">${escapeHtml(row.nombre)}${row.almacen?` · ${escapeHtml(row.almacen)}`:''}${row.historical?' · histórico':''}</option>`).join('');
  }
  function normalizeOptions(options){
    const root=typeof options?.root==='string'?document.querySelector(options.root):options?.root;
    if(!root||root.nodeType!==1)throw new Error('Analytics360 necesita un contenedor válido.');
    if(!options?.db||typeof options.db.rpc!=='function')throw new Error('Analytics360 necesita un cliente de datos válido.');
    const module=MODULES.has(options.module)?options.module:'global';
    const defaultRange=PRESETS.has(options.defaultRange)?options.defaultRange:'90d';
    return {
      root,db:options.db,module,local:String(options.local||''),isSupervisor:options.isSupervisor===true,
      locals:mergeLocations(options.locals||[]),defaultRange,
      onError:typeof options.onError==='function'?options.onError:null,autoload:options.autoload!==false
    };
  }
  function asNumber(value){const number=Number(value);return Number.isFinite(number)?number:0;}
  function formatValue(value,format){
    if(value==null||value==='')return 'Sin datos';
    const number=Number(value);
    if(!Number.isFinite(number))return 'Sin datos';
    if(format==='percent')return `${numberFormat.format(number)} %`;
    if(format==='duration'){
      if(number<1)return `${integerFormat.format(Math.round(number*60))} min`;
      if(number<24)return `${numberFormat.format(number)} h`;
      return `${numberFormat.format(number/24)} días`;
    }
    if(format==='decimal')return numberFormat.format(number);
    return integerFormat.format(number);
  }
  function valueClass(tone){return ['good','warning','danger','info'].includes(tone)?` a360-tone-${tone}`:'';}
  function renderSkeleton(){
    return `<div class="a360-skeleton" aria-hidden="true">${Array.from({length:4},()=>'<i></i>').join('')}</div>`;
  }
  function renderEmpty(message){return `<div class="a360-empty">${escapeHtml(message||'No hay datos para los filtros seleccionados.')}</div>`;}

  function renderKpis(rows){
    if(!Array.isArray(rows)||!rows.length)return renderEmpty('Todavía no hay indicadores para este período.');
    return `<section class="a360-kpis" aria-label="Indicadores principales">${rows.map(row=>{
      const hint=row.hint?`<small>${escapeHtml(row.hint)}</small>`:'';
      return `<article class="a360-kpi${valueClass(row.value==null?null:row.tone)}"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(formatValue(row.value,row.format))}</strong>${hint}</article>`;
    }).join('')}</section>`;
  }

  function renderTrend(trend){
    const points=Array.isArray(trend?.points)?trend.points:[],series=Array.isArray(trend?.series)?trend.series:[];
    if(!points.length||!series.length)return `<article class="a360-panel a360-trend"><header><h3>${escapeHtml(trend?.title||'Evolución')}</h3></header>${renderEmpty()}</article>`;
    const maximum=Math.max(1,...points.flatMap(point=>series.map(item=>asNumber(point[item.key]))));
    const legend=series.map((item,index)=>`<span><i class="a360-series-${index%3}"></i>${escapeHtml(item.label)}</span>`).join('');
    const columns=points.map(point=>{
      const bars=series.map((item,index)=>{
        const value=asNumber(point[item.key]),height=value<=0?0:value/maximum*100;
        return `<i class="a360-bar a360-series-${index%3}" style="--a360-height:${height}%" title="${escapeHtml(item.label)}: ${escapeHtml(formatValue(value,item.format))}"></i>`;
      }).join('');
      return `<div class="a360-trend-column"><div class="a360-bars">${bars}</div><span title="${escapeHtml(point.label||point.period)}">${escapeHtml(point.label||point.period)}</span></div>`;
    }).join('');
    const accessibleHead=series.map(item=>`<th scope="col">${escapeHtml(item.label)}</th>`).join('');
    const accessibleRows=points.map(point=>`<tr><th scope="row">${escapeHtml(point.label||point.period)}</th>${series.map(item=>`<td>${escapeHtml(formatValue(point[item.key],item.format))}</td>`).join('')}</tr>`).join('');
    const accessibleTable=`<div class="a360-sr-only"><table><caption>${escapeHtml(trend.title||'Evolución')}</caption><thead><tr><th scope="col">Período</th>${accessibleHead}</tr></thead><tbody>${accessibleRows}</tbody></table></div>`;
    return `<article class="a360-panel a360-trend"><header><div><span class="a360-eyebrow">TENDENCIA</span><h3>${escapeHtml(trend.title||'Evolución')}</h3></div><div class="a360-legend">${legend}</div></header><div class="a360-chart" aria-hidden="true">${columns}</div>${accessibleTable}</article>`;
  }

  function renderTable(block){
    const columns=Array.isArray(block.columns)?block.columns:[],rows=Array.isArray(block.rows)?block.rows:[];
    const description=block.description?`<p>${escapeHtml(block.description)}</p>`:'';
    if(!rows.length)return `<article class="a360-panel a360-breakdown"><header><div><h3>${escapeHtml(block.title||'Detalle')}</h3>${description}</div></header>${renderEmpty()}</article>`;
    const head=columns.map(column=>`<th scope="col">${escapeHtml(column.label)}</th>`).join('');
    const body=rows.map(row=>`<tr>${columns.map(column=>{
      const raw=row?.[column.key],formatted=column.format?formatValue(raw,column.format):String(raw==null?'—':raw);
      return `<td${column.format?' class="a360-numeric"':''}>${escapeHtml(formatted)}</td>`;
    }).join('')}</tr>`).join('');
    return `<article class="a360-panel a360-breakdown"><header><div><h3>${escapeHtml(block.title||'Detalle')}</h3>${description}</div></header><div class="a360-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></article>`;
  }

  function renderCross(rows){
    if(!Array.isArray(rows)||!rows.length)return '';
    return `<section class="a360-cross" aria-label="Cruces entre módulos">${rows.map(row=>{
      const secondary=row.secondary==null?'':`<small>${escapeHtml(row.secondary_label||'Referencia')}: <b>${escapeHtml(formatValue(row.secondary,row.secondary_format||'number'))}</b></small>`;
      return `<article><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(formatValue(row.primary??row.count,row.format||'number'))}</strong><small>${escapeHtml(row.primary_label||'Registros')}</small>${secondary}</article>`;
    }).join('')}</section>`;
  }

  function renderResult(data){
    const breakdowns=Array.isArray(data.breakdowns)?data.breakdowns:[];
    const notes=Array.isArray(data.notes)?data.notes.filter(Boolean):[];
    return `<div class="a360-result">
      <div class="a360-heading"><div><span class="a360-eyebrow">ANÁLISIS 360</span><h2>${escapeHtml(data.title||'Panel histórico')}</h2><p>${escapeHtml(data.subtitle||'Indicadores consolidados del período seleccionado.')}</p></div><time>${escapeHtml(data.generated_at?new Date(data.generated_at).toLocaleString('es-UY'):'')}</time></div>
      ${renderKpis(data.kpis)}
      ${renderCross(data.cross_module)}
      <section class="a360-main-grid">${renderTrend(data.trend)}${breakdowns.map(renderTable).join('')}</section>
      ${notes.length?`<aside class="a360-notes"><strong>Cómo leer estos datos</strong><ul>${notes.map(note=>`<li>${escapeHtml(note)}</li>`).join('')}</ul></aside>`:''}
    </div>`;
  }

  function mount(rawOptions){
    const options=normalizeOptions(rawOptions),root=options.root;
    let destroyed=false,requestId=0,module=options.module,lastData=null,locationRows=options.locals;
    const initial=presetDates(options.defaultRange);
    const filters={preset:options.defaultRange,dateFrom:initial.dateFrom,dateTo:initial.dateTo,local:options.isSupervisor?options.local:options.local,product:''};

    root.classList.add('analytics-360');
    root.innerHTML=`<form class="a360-filters" data-a360-filters>
      <label><span>Período</span><select data-a360-preset><option value="30d">Últimos 30 días</option><option value="90d">Últimos 90 días</option><option value="365d">Último año</option><option value="all">Todo el historial</option><option value="custom">Personalizado</option></select></label>
      <label data-a360-from-wrap><span>Desde</span><input type="date" data-a360-from></label>
      <label data-a360-to-wrap><span>Hasta</span><input type="date" data-a360-to></label>
      ${options.isSupervisor?`<label><span>Local</span><select data-a360-local><option value="">Todos los locales</option>${locationOptionsHtml(locationRows)}</select></label>`:''}
      <label class="a360-product-filter"><span>Producto</span><input type="search" maxlength="100" placeholder="Código, nombre o marca" data-a360-product></label>
      <button type="submit" class="a360-button">Aplicar</button>
      <button type="button" class="a360-button secondary" data-a360-clear>Limpiar</button>
    </form><div class="a360-status" role="status" aria-live="polite" data-a360-status></div><div data-a360-output>${renderSkeleton()}</div>`;

    const form=root.querySelector('[data-a360-filters]'),presetEl=root.querySelector('[data-a360-preset]'),fromEl=root.querySelector('[data-a360-from]'),toEl=root.querySelector('[data-a360-to]'),localEl=root.querySelector('[data-a360-local]'),productEl=root.querySelector('[data-a360-product]'),statusEl=root.querySelector('[data-a360-status]'),output=root.querySelector('[data-a360-output]');
    presetEl.value=filters.preset;fromEl.value=filters.dateFrom||'';toEl.value=filters.dateTo||'';if(localEl)localEl.value=filters.local||'';

    function syncLocationOptions(rows){
      if(!localEl||!Array.isArray(rows))return;
      const selected=localEl.value;
      locationRows=mergeLocations(options.locals,rows);
      localEl.innerHTML=`<option value="">Todos los locales</option>${locationOptionsHtml(locationRows)}`;
      localEl.value=locationRows.some(item=>item.nombre===selected)?selected:'';
    }

    function syncDates(){
      const custom=presetEl.value==='custom';
      root.querySelector('[data-a360-from-wrap]').hidden=!custom;
      root.querySelector('[data-a360-to-wrap]').hidden=!custom;
      if(!custom){const dates=presetDates(presetEl.value);fromEl.value=dates.dateFrom||'';toEl.value=dates.dateTo||'';}
    }
    function readFilters(){
      const preset=PRESETS.has(presetEl.value)?presetEl.value:'90d';
      const dates=preset==='custom'?{dateFrom:validDate(fromEl.value)?fromEl.value:null,dateTo:validDate(toEl.value)?toEl.value:null}:presetDates(preset);
      return {preset,...dates,local:options.isSupervisor?(localEl?.value||''):options.local,product:String(productEl.value||'').trim()};
    }
    function applyOverrides(overrides={}){
      if(overrides.module&&MODULES.has(overrides.module))module=overrides.module;
      if(overrides.preset&&PRESETS.has(overrides.preset)){presetEl.value=overrides.preset;syncDates();}
      if(Object.prototype.hasOwnProperty.call(overrides,'dateFrom')){fromEl.value=validDate(overrides.dateFrom)?overrides.dateFrom:'';presetEl.value='custom';}
      if(Object.prototype.hasOwnProperty.call(overrides,'dateTo')){toEl.value=validDate(overrides.dateTo)?overrides.dateTo:'';presetEl.value='custom';}
      if(localEl&&Object.prototype.hasOwnProperty.call(overrides,'local'))localEl.value=String(overrides.local||'');
      if(Object.prototype.hasOwnProperty.call(overrides,'product'))productEl.value=String(overrides.product||'');
      syncDates();
    }
    async function load(overrides={}){
      if(destroyed)return null;
      applyOverrides(overrides);
      const current=readFilters();Object.assign(filters,current);
      const ownRequest=++requestId;
      if(current.dateFrom&&current.dateTo&&current.dateFrom>current.dateTo){
        const error=new Error('La fecha desde no puede ser posterior a la fecha hasta.');
        lastData=null;output.innerHTML=renderEmpty('Corregí el período para volver a calcular el panel.');
        root.classList.remove('is-loading');statusEl.textContent=error.message;statusEl.className='a360-status error';options.onError?.(error);return null;
      }
      root.classList.add('is-loading');statusEl.textContent='Actualizando indicadores…';statusEl.className='a360-status';
      if(!lastData)output.innerHTML=renderSkeleton();
      try{
        const payload={date_from:current.dateFrom,date_to:current.dateTo,local:current.local||null,product:current.product||null};
        const {data,error}=await options.db.rpc('op_dashboard_360',{p_modulo:module,p_filtros:payload});
        if(error)throw error;
        if(destroyed||ownRequest!==requestId)return null;
        lastData=data||{};syncLocationOptions(lastData?.scope?.locations);output.innerHTML=renderResult(lastData);statusEl.textContent='Indicadores actualizados.';statusEl.className='a360-status success';
        return lastData;
      }catch(error){
        if(destroyed||ownRequest!==requestId)return null;
        statusEl.textContent=error?.message||'No se pudieron cargar los indicadores.';statusEl.className='a360-status error';
        lastData=null;output.innerHTML=renderEmpty('No se pudo calcular el panel con estos filtros. Los resultados anteriores se ocultaron para evitar confusiones.');
        options.onError?.(error);return null;
      }finally{if(!destroyed&&ownRequest===requestId)root.classList.remove('is-loading');}
    }
    function refresh(){return load();}
    function setModule(next){if(!MODULES.has(next))throw new Error('Módulo de Analytics360 inválido.');if(next!==module&&localEl)localEl.value=options.local||'';module=next;return load();}
    function getFilters(){return {...filters,module};}
    function destroy(){destroyed=true;requestId++;root.replaceChildren();root.classList.remove('analytics-360','is-loading');}
    function submit(event){event.preventDefault();load();}
    function clear(){presetEl.value=options.defaultRange;productEl.value='';if(localEl)localEl.value=options.local||'';syncDates();load();}
    presetEl.addEventListener('change',syncDates);form.addEventListener('submit',submit);root.querySelector('[data-a360-clear]').addEventListener('click',clear);syncDates();
    const controller={load,refresh,setModule,destroy,getFilters};
    if(options.autoload)load();
    return controller;
  }

  global.Analytics360=Object.freeze({mount,formatValue,version:1});
})(typeof window!=='undefined'?window:globalThis);
