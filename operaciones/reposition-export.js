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

  function cloneCell(cell) {
    return cell ? JSON.parse(JSON.stringify(cell)) : null;
  }

  function findSourceColumns(sheet, XLSX, engine) {
    const rows = XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false});
    for (let rowIndex=0; rowIndex<Math.min(rows.length,30); rowIndex+=1) {
      const headers=(rows[rowIndex]||[]).map(engine.normalizeHeader);
      const sku=headers.findIndex(value=>['sku','codigo','item'].includes(value));
      const qty=headers.findIndex(value=>['qty_replenishment','qty_replen','cantidad','cantidad_reposicion'].includes(value));
      const stock=headers.findIndex(value=>['stock_origin','stock_origen','stock'].includes(value));
      if(sku<0||qty<0||stock<0)continue;
      let calculation=headers.findIndex(value=>['calculo_stock','stock_restante','calculo'].includes(value));
      if(calculation<0)calculation=Math.max(sku,qty,stock)+1;
      return {rowIndex,sku,qty,stock,calculation};
    }
    throw new Error('No se encontró el encabezado del archivo original');
  }

  function yellowCell(cell) {
    const next=cloneCell(cell)||{t:'s',v:''};
    const style=next.s&&typeof next.s==='object'?cloneCell(next.s):{};
    style.fill={patternType:'solid',fgColor:{rgb:'FFFF00'},bgColor:{rgb:'FFFF00'}};
    next.s=style;
    return next;
  }

  function buildProcessedSource(sourceBytes, XLSX, repo, engine, outputType='biff8') {
    if(!sourceBytes)throw new Error('Archivo original no disponible');
    const workbook=XLSX.read(sourceBytes,{type:'array',cellStyles:true,cellFormula:true,cellNF:true,cellDates:true});
    if(!workbook.SheetNames?.length)throw new Error('El archivo original no contiene hojas');
    const name=workbook.SheetNames[0],source=workbook.Sheets[name],columns=findSourceColumns(source,XLSX,engine);
    const range=XLSX.utils.decode_range(source['!ref']||'A1:A1');
    const originalItems=new Map((repo.items||[])
      .filter(item=>Number(item.pedido_reposicion==null?item.pedido:item.pedido_reposicion)>0)
      .map(item=>[String(item.codigo||'').trim(),item]));
    const target={};
    const rowMap=new Map();
    const highlightedRows=[];
    for(let row=range.s.r;row<=columns.rowIndex;row+=1)rowMap.set(row,row);
    let targetRow=columns.rowIndex+1;
    for(let sourceRow=columns.rowIndex+1;sourceRow<=range.e.r;sourceRow+=1){
      const skuCell=source[XLSX.utils.encode_cell({r:sourceRow,c:columns.sku})];
      const sku=String(skuCell?.v??'').trim();
      if(!originalItems.has(sku))continue;
      rowMap.set(sourceRow,targetRow);
      targetRow+=1;
    }
    if(targetRow===columns.rowIndex+1)throw new Error('El archivo original no contiene los productos de esta reposición');

    for(const [sourceRow,newRow] of rowMap){
      const sku=String(source[XLSX.utils.encode_cell({r:sourceRow,c:columns.sku})]?.v??'').trim();
      const item=originalItems.get(sku);
      const highlight=Boolean(item&&Number(item.preparado)>0);
      if(highlight)highlightedRows.push(newRow+1);
      for(let column=range.s.c;column<=range.e.c;column+=1){
        const sourceAddress=XLSX.utils.encode_cell({r:sourceRow,c:column});
        const sourceCell=source[sourceAddress];
        if(!sourceCell)continue;
        const targetAddress=XLSX.utils.encode_cell({r:newRow,c:column});
        let targetCell=cloneCell(sourceCell);
        if(sourceRow>columns.rowIndex&&column===columns.calculation){
          const excelRow=newRow+1;
          const stockColumn=XLSX.utils.encode_col(columns.stock),qtyColumn=XLSX.utils.encode_col(columns.qty);
          targetCell.f=`+${stockColumn}${excelRow}-${qtyColumn}${excelRow}`;
          const stock=Number(source[XLSX.utils.encode_cell({r:sourceRow,c:columns.stock})]?.v)||0;
          const qty=Number(source[XLSX.utils.encode_cell({r:sourceRow,c:columns.qty})]?.v)||0;
          targetCell.t='n';targetCell.v=stock-qty;targetCell.w=String(stock-qty);
        }
        target[targetAddress]=highlight?yellowCell(targetCell):targetCell;
      }
    }

    target['!ref']=XLSX.utils.encode_range({s:range.s,e:{r:targetRow-1,c:range.e.c}});
    target['!autofilter']={ref:XLSX.utils.encode_range({s:{r:columns.rowIndex,c:range.s.c},e:{r:targetRow-1,c:range.e.c}})};
    target['!cols']=(source['!cols']||[]).map(column=>column?{...column}:column);
    [1,4,5].filter(index=>index<=range.e.c).forEach(index=>{
      target['!cols'][index]={...(target['!cols'][index]||{}),hidden:true,level:1,outlineLevel:1};
    });
    target['!rows']=[];
    for(const [sourceRow,newRow] of rowMap){
      if(source['!rows']?.[sourceRow])target['!rows'][newRow]={...source['!rows'][sourceRow]};
    }
    workbook.Sheets[name]=target;
    const output=XLSX.write(workbook,{bookType:outputType,type:'array',cellStyles:true});
    output.highlightedRows=highlightedRows;
    return output;
  }

  async function applyProcessedSourcePresentation(buffer, JSZip) {
    if(!JSZip)throw new Error('No se pudo cargar el generador de formato Excel');
    const highlightedRows=Array.isArray(buffer?.highlightedRows)?buffer.highlightedRows:[];
    if(!highlightedRows.length)return buffer;
    const zip=await JSZip.loadAsync(buffer);
    const stylesFile=zip.file('xl/styles.xml'),sheetFile=zip.file('xl/worksheets/sheet1.xml');
    if(!stylesFile||!sheetFile)throw new Error('El archivo procesado no tiene la estructura esperada');
    let styles=await stylesFile.async('string'),sheet=await sheetFile.async('string');
    const baseStyles=new Set();
    highlightedRows.forEach(rowNumber=>{
      const rowMatch=sheet.match(new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*>([\\s\\S]*?)<\\/row>`));
      if(!rowMatch)return;
      for(const match of rowMatch[1].matchAll(/<c\b([^>]*)>/g))baseStyles.add(Number(match[1].match(/\bs="(\d+)"/)?.[1]||0));
    });
    const fillsMatch=styles.match(/<fills\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/);
    const xfsMatch=styles.match(/<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
    if(!fillsMatch||!xfsMatch)throw new Error('No se pudo preparar el resaltado del reporte');
    const fillId=Number(fillsMatch[1]);
    const yellowFill='<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>';
    styles=styles.replace(fillsMatch[0],fillsMatch[0].replace(`count="${fillsMatch[1]}"`,`count="${fillId+1}"`).replace('</fills>',`${yellowFill}</fills>`));
    const xfNodes=xfsMatch[2].match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)||[];
    const styleMap=new Map();
    const additions=[];
    baseStyles.forEach(baseStyle=>{
      let xf=xfNodes[baseStyle]||xfNodes[0]||'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
      xf=/\bfillId="\d+"/.test(xf)?xf.replace(/\bfillId="\d+"/,`fillId="${fillId}"`):xf.replace(/<xf\b/,`<xf fillId="${fillId}"`);
      xf=/\bapplyFill="\d+"/.test(xf)?xf.replace(/\bapplyFill="\d+"/,'applyFill="1"'):xf.replace(/<xf\b/, '<xf applyFill="1"');
      styleMap.set(baseStyle,Number(xfsMatch[1])+additions.length);
      additions.push(xf);
    });
    styles=styles.replace(xfsMatch[0],xfsMatch[0].replace(`count="${xfsMatch[1]}"`,`count="${Number(xfsMatch[1])+additions.length}"`).replace('</cellXfs>',`${additions.join('')}</cellXfs>`));
    highlightedRows.forEach(rowNumber=>{
      const rowPattern=new RegExp(`(<row\\b[^>]*\\br="${rowNumber}"[^>]*>)([\\s\\S]*?)(<\\/row>)`,'g');
      sheet=sheet.replace(rowPattern,(whole,open,cells,close)=>{
        const styled=cells.replace(/<c\b([^>]*)>/g,(tag,attributes)=>{
          const base=Number(attributes.match(/\bs="(\d+)"/)?.[1]||0),style=styleMap.get(base);
          if(style==null)return tag;
          const next=/\bs="\d+"/.test(attributes)?attributes.replace(/\bs="\d+"/,` s="${style}"`):`${attributes} s="${style}"`;
          return `<c${next}>`;
        });
        return open+styled+close;
      });
    });
    zip.file('xl/styles.xml',styles);zip.file('xl/worksheets/sheet1.xml',sheet);
    return zip.generateAsync({type:'arraybuffer',compression:'DEFLATE',compressionOptions:{level:6}});
  }

  return {buildTransfer,buildMissing,buildSummary,buildProcessedSource,applyProcessedSourcePresentation};
});
