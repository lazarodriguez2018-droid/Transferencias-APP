(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SucaneitorRepositionExport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function buildTransfer(templateBytes, XLSX, rows) {
    const workbook = XLSX.read(templateBytes, {type:'array',cellStyles:true});
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    Object.keys(sheet).forEach(address => {
      if (address[0] === '!') return;
      const decoded = XLSX.utils.decode_cell(address);
      if (decoded.r >= 1) delete sheet[address];
    });
    (rows || []).forEach((row,index) => {
      const excelRow = index + 1;
      sheet[XLSX.utils.encode_cell({r:excelRow,c:0})] = {t:'s',v:String(row[0]),z:'@'};
      sheet[XLSX.utils.encode_cell({r:excelRow,c:1})] = {t:'n',v:Math.trunc(Number(row[1]) || 0),z:'0'};
    });
    sheet['!ref'] = `A1:B${Math.max(1,(rows || []).length + 1)}`;
    return XLSX.write(workbook, {bookType:'biff8',type:'array',cellStyles:true});
  }

  function buildMissing(repo, XLSX, engine) {
    const rows = [['CODIGO','NOMBRE','SOLICITADO','JUNTADO','FALTANTE','ESTADO','MOTIVO','OTRO MOTIVO','COMENTARIO','ACTUALIZADO POR']];
    engine.missingRows(repo).forEach(item => rows.push([item.codigo,item.nombre,item.pedido,item.preparado,item.faltante,item.estado,item.motivo_label || item.motivo,item.motivo_otro,item.comentario,item.actualizado_por]));
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [{wch:18},{wch:55},{wch:12},{wch:10},{wch:10},{wch:18},{wch:38},{wch:38},{wch:55},{wch:20}];
    XLSX.utils.book_append_sheet(workbook,sheet,'Faltantes');
    return XLSX.write(workbook,{bookType:'xlsx',type:'array'});
  }

  function buildSummary(repo, XLSX, engine) {
    const stats = engine.summary(repo);
    const workbook = XLSX.utils.book_new();
    const overview = [
      ['RESUMEN DE REPOSICION',''],['Sesión',repo.nombre],['Origen',repo.origin],['Destino',repo.destination],['Creada',repo.created_at],['Última actualización',repo.updated_at],
      ['Productos solicitados',stats.productos],['Unidades solicitadas',stats.pedidos],['Unidades juntadas',stats.preparados],['Unidades faltantes',stats.faltantes],['Productos completos',stats.completos],['Productos excedidos',stats.excedidos],['Productos no encontrados',stats.no_encontrados],['Unidades extra',stats.extras_unidades],
      ['Participantes',(repo.participantes || []).map(item => item.nombre).join(', ')]
    ];
    const overviewSheet = XLSX.utils.aoa_to_sheet(overview);
    overviewSheet['!cols']=[{wch:28},{wch:70}];
    XLSX.utils.book_append_sheet(workbook,overviewSheet,'Resumen');
    const details = [['CODIGO','NOMBRE','DESCRIPCION ARCHIVO','REPOSICION AUTOMATICA','PEDIDOS CLIENTES','TOTAL FISICO','STOCK ARCHIVO','JUNTADO','ESTADO','CLIENTES','USUARIO','ACTUALIZADO']];
    (repo.items || []).forEach(item => details.push([String(item.codigo),item.nombre,item.descripcion_archivo,item.pedido_reposicion || 0,item.pedido_clientes || 0,item.pedido,item.stock_origen,item.preparado,engine.status(item),(item.pedidos_asignados || []).map(p=>`${p.cliente} x${p.cantidad}`).join(' | '),item.updated_by,item.updated_at]));
    const detailSheet = XLSX.utils.aoa_to_sheet(details); detailSheet['!cols']=[{wch:18},{wch:55},{wch:55},{wch:18},{wch:16},{wch:12},{wch:12},{wch:10},{wch:18},{wch:55},{wch:20},{wch:22}];
    XLSX.utils.book_append_sheet(workbook,detailSheet,'Detalle');
    const extras = [['CODIGO','NOMBRE','CANTIDAD','NOTA','USUARIO','ACTUALIZADO']];
    (repo.extras || []).filter(item => Number(item.cantidad)>0).forEach(item => extras.push([String(item.codigo),item.nombre,item.cantidad,item.nota,item.updated_by,item.updated_at]));
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(extras),'Extras');
    const audit = [['FECHA','USUARIO','ACCION','CODIGO','DETALLE']];
    (repo.log || []).forEach(item => audit.push([item.ts,item.usuario,item.accion,String(item.codigo || ''),JSON.stringify(item.detalle || {})]));
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(audit),'Auditoria');
    return XLSX.write(workbook,{bookType:'xlsx',type:'array'});
  }

  return {buildTransfer,buildMissing,buildSummary};
});
