(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ReservaEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const labels={buscando:'Buscando mercadería',en_transito:'En tránsito',recibido:'Recibida',separando:'Separando',listo:'Lista para entregar',avisado:'Cliente avisado',parcial:'Entrega parcial',vencido:'Más de 48 horas',completado:'Completada',cancelado:'Cancelada'};
  const sources={local:'Ya estaba en el local',proveedor:'Esperando proveedor',pedido_local:'Pedido a otro local',reposicion:'Próxima reposición',remito:'Remito',otro:'Otra procedencia'};
  const outcomes={retiro_cliente:'Retiró el cliente',reparto:'Enviado por reparto',envio_otro_local:'Enviado a otro local',uso_interno:'Utilizado internamente',no_retirado:'No fue retirado; volvió a exhibición',otro:'Otro resultado'};
  function n(value){const x=Number(value);return Number.isFinite(x)?x:0;}
  function customer(row){return [row?.cliente_nombre,row?.cliente_apellido].filter(Boolean).join(' ').trim()||'Sin cliente';}
  function progress(row){const total=Math.max(0,n(row?.unidades));const done=Math.max(0,n(row?.unidades_local)+n(row?.unidades_entregadas));return total?Math.min(100,Math.round(done*100/total)):0;}
  function isTerminal(state){return state==='completado'||state==='cancelado';}
  function deadlineInfo(value,now=Date.now()){
    if(!value)return {kind:'none',label:'Sin plazo iniciado',milliseconds:null};
    const ms=new Date(value).getTime()-Number(now);
    if(!Number.isFinite(ms))return {kind:'none',label:'Sin plazo iniciado',milliseconds:null};
    const abs=Math.abs(ms),hours=Math.floor(abs/3600000),minutes=Math.max(0,Math.ceil((abs-hours*3600000)/60000));
    if(ms<=0)return {kind:'late',label:`Venció hace ${hours?hours+' h':minutes+' min'}`,milliseconds:ms};
    if(ms<=12*3600000)return {kind:'soon',label:`Vence en ${hours?hours+' h':minutes+' min'}`,milliseconds:ms};
    return {kind:'ok',label:`Vence ${new Date(value).toLocaleString('es-UY',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`,milliseconds:ms};
  }
  function derive(items,current='buscando'){
    if(isTerminal(current)||current==='vencido')return current;
    const rows=items||[],total=rows.reduce((s,x)=>s+n(x.cantidad),0),local=rows.reduce((s,x)=>s+n(x.cantidad_local),0),delivered=rows.reduce((s,x)=>s+n(x.cantidad_entregada),0);
    if(total&&delivered>0&&delivered<total)return 'parcial';
    if(total&&local+delivered>=total)return current==='avisado'?'avisado':'listo';
    if(local>0)return current==='separando'?'separando':rows.some(x=>x.estado==='recibido')?'recibido':'separando';
    if(rows.some(x=>x.estado==='en_transito'))return 'en_transito';
    return 'buscando';
  }
  function needsCorrectionReason(before,after){return n(after)<n(before);}
  function canMarkReady(items){return (items||[]).length>0&&(items||[]).every(x=>n(x.cantidad_local)+n(x.cantidad_entregada)>=n(x.cantidad));}
  function cleanText(value,max=1000){return String(value==null?'':value).trim().slice(0,max);}
  return {labels,sources,outcomes,customer,progress,isTerminal,deadlineInfo,derive,needsCorrectionReason,canMarkReady,cleanText};
});
