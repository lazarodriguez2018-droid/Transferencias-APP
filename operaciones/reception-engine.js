(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SucaneitorReception = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalize(value) {
    return clean(value).toLocaleLowerCase('es').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function integer(value, label, location) {
    const raw = clean(value).replace(/\s/g, '').replace(',', '.');
    const number = Number(raw);
    if (!raw || !Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
      throw new Error(`${label} debe ser un entero mayor que cero en ${location}`);
    }
    return number;
  }

  function findLabel(rows, aliases) {
    const wanted = aliases.map(normalize);
    for (let row = 0; row < Math.min(rows.length, 40); row += 1) {
      for (let column = 0; column < (rows[row] || []).length; column += 1) {
        if (wanted.includes(normalize(rows[row][column]))) return {row, column};
      }
    }
    return null;
  }

  function valueBelow(rows, aliases) {
    const cell = findLabel(rows, aliases);
    if (!cell) return '';
    for (let row = cell.row + 1; row < Math.min(rows.length, cell.row + 5); row += 1) {
      const sameColumn = clean(rows[row]?.[cell.column]);
      if (sameColumn) return sameColumn;
    }
    return '';
  }

  function findHeader(rows) {
    for (let row = 0; row < Math.min(rows.length, 45); row += 1) {
      const normalized = (rows[row] || []).map(normalize);
      const code = normalized.findIndex(value => ['codigo', 'sku', 'codigo producto'].includes(value));
      const quantity = normalized.findIndex(value => ['cantidad', 'qty', 'unidades'].includes(value));
      if (code >= 0 && quantity >= 0) {
        return {
          row,
          code,
          description: normalized.findIndex(value => ['mercaderias', 'mercaderia', 'descripcion', 'producto', 'nombre'].includes(value)),
          manufacturer: normalized.findIndex(value => ['fabrica', 'fabricante', 'marca'].includes(value)),
          unit: normalized.findIndex(value => ['unidad', 'unidades'].includes(value)),
          quantity,
          lot: normalized.findIndex(value => ['lote', 'lot'].includes(value))
        };
      }
    }
    throw new Error('No se encontró la tabla de productos del remito');
  }

  function isoDate(value) {
    const text = clean(value);
    const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (!match) return text;
    return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }

  function pageData(name, rows) {
    const header = findHeader(rows);
    const documentType = valueBelow(rows, ['Documento']);
    const documentNumber = valueBelow(rows, ['Número', 'Numero']);
    const date = valueBelow(rows, ['Fecha']);
    const origin = valueBelow(rows, ['Almacén Salida', 'Almacen Salida', 'Origen']);
    const destination = valueBelow(rows, ['Almacén Entrada', 'Almacen Entrada', 'Destino']);
    if (!documentNumber || !date || !origin || !destination) {
      throw new Error(`Faltan número, fecha, origen o destino en ${name}`);
    }
    const lines = [];
    for (let row = header.row + 1; row < rows.length; row += 1) {
      const source = rows[row] || [];
      const code = clean(source[header.code]);
      if (!code) continue;
      const quantity = integer(source[header.quantity], 'La cantidad', `${name}, fila ${row + 1}`);
      lines.push({
        codigo: code,
        descripcion_archivo: header.description >= 0 ? clean(source[header.description]) : '',
        fabricante_archivo: header.manufacturer >= 0 ? clean(source[header.manufacturer]) : '',
        unidad: header.unit >= 0 ? clean(source[header.unit]) : '',
        cantidad: quantity,
        lote: header.lot >= 0 ? clean(source[header.lot]) : '',
        source_sheet: name,
        source_row: row + 1
      });
    }
    if (!lines.length) throw new Error(`No se encontraron productos en ${name}`);
    return {name, documentType, documentNumber, date:isoDate(date), origin, destination, lines};
  }

  function compatiblePage(base, current) {
    return clean(base.documentNumber) === clean(current.documentNumber)
      && clean(base.date) === clean(current.date)
      && normalize(base.origin) === normalize(current.origin)
      && normalize(base.destination) === normalize(current.destination);
  }

  function parseWorkbook(workbook, XLSX, catalog) {
    if (!workbook?.SheetNames?.length) throw new Error('El archivo no contiene hojas');
    const pages = workbook.SheetNames.map(name => pageData(
      name,
      XLSX.utils.sheet_to_json(workbook.Sheets[name], {header:1, defval:'', raw:false})
    ));
    const base = pages[0];
    pages.slice(1).forEach(page => {
      if (!compatiblePage(base, page)) throw new Error(`La hoja ${page.name} pertenece a otro remito, fecha o recorrido`);
    });
    const catalogByCode = new Map((catalog || []).map(product => [clean(product.codigo), product]));
    const grouped = new Map();
    pages.flatMap(page => page.lines).forEach(line => {
      const product = catalogByCode.get(line.codigo);
      const current = grouped.get(line.codigo) || {
        codigo:line.codigo,
        nombre:clean(product?.nombre) || line.descripcion_archivo || line.codigo,
        descripcion_archivo:line.descripcion_archivo,
        barras:clean(product?.barras),
        marca:clean(product?.marca) || clean(product?.fabricante) || line.fabricante_archivo,
        esperado:0,
        en_padron:Boolean(product),
        source_lines:[]
      };
      current.esperado += line.cantidad;
      current.source_lines.push({sheet:line.source_sheet,row:line.source_row,quantity:line.cantidad,lot:line.lote,unit:line.unidad});
      grouped.set(line.codigo, current);
    });
    const items = [...grouped.values()].sort((left, right) => left.nombre.localeCompare(right.nombre, 'es', {sensitivity:'base', numeric:true}));
    return {
      document_number:base.documentNumber,
      document_type:base.documentType || 'Transferencia',
      date:base.date,
      origin:base.origin,
      destination:base.destination,
      items,
      meta:{
        sheets:pages.map(page => page.name),
        sheet_count:pages.length,
        source_lines:pages.reduce((sum, page) => sum + page.lines.length, 0),
        unique_products:items.length,
        expected_units:items.reduce((sum, item) => sum + item.esperado, 0),
        missing_catalog:items.filter(item => !item.en_padron).map(item => item.codigo),
        without_barcode:items.filter(item => !item.barras).map(item => item.codigo)
      }
    };
  }

  function status(item) {
    const expected = Math.max(0, Number(item?.esperado) || 0);
    const received = Math.max(0, Number(item?.recibido) || 0);
    if (received > expected) return 'sobrante';
    if (received === expected && expected > 0) return 'exacto';
    if (item?.no_recibido && received === 0) return 'no_recibido';
    if (received > 0) return 'parcial';
    return 'pendiente';
  }

  function summary(reception) {
    const items = reception?.items || [];
    const extras = reception?.extras || [];
    const result = {
      productos:items.length,
      unidades_esperadas:items.reduce((sum, item) => sum + Math.max(0, Number(item.esperado) || 0), 0),
      unidades_recibidas:items.reduce((sum, item) => sum + Math.max(0, Number(item.recibido) || 0), 0),
      unidades_faltantes:items.reduce((sum, item) => sum + Math.max(0, Number(item.esperado || 0) - Number(item.recibido || 0)), 0),
      unidades_sobrantes:items.reduce((sum, item) => sum + Math.max(0, Number(item.recibido || 0) - Number(item.esperado || 0)), 0),
      pendientes:0, parciales:0, exactos:0, sobrantes:0, no_recibidos:0,
      extras_productos:extras.filter(item => Number(item.cantidad) > 0).length,
      extras_unidades:extras.reduce((sum, item) => sum + Math.max(0, Number(item.cantidad) || 0), 0)
    };
    items.forEach(item => { const value=status(item); result[value === 'exacto' ? 'exactos' : value === 'sobrante' ? 'sobrantes' : value === 'no_recibido' ? 'no_recibidos' : value === 'parcial' ? 'parciales' : 'pendientes'] += 1; });
    const usesDirectedControl = items.some(item => Object.prototype.hasOwnProperty.call(item,'controlado_at'));
    result.productos_pendientes = usesDirectedControl
      ? items.filter(item => !item.controlado_at).length
      : result.pendientes + result.parciales;
    result.tiene_diferencias = result.unidades_faltantes > 0 || result.unidades_sobrantes > 0 || result.extras_unidades > 0;
    return result;
  }

  function differenceRows(reception) {
    return (reception?.items || []).filter(item => Number(item.recibido) !== Number(item.esperado)).map(item => ({
      codigo:clean(item.codigo), nombre:clean(item.nombre), esperado:Number(item.esperado)||0,
      recibido:Number(item.recibido)||0, diferencia:(Number(item.recibido)||0)-(Number(item.esperado)||0),
      estado:status(item), observacion:clean(item.observacion), actualizado_por:clean(item.updated_by)
    }));
  }

  function transferRows(reception, type) {
    const source = type === 'extras' ? (reception?.extras || []) : (reception?.items || []);
    const quantityField = type === 'extras' ? 'cantidad' : 'recibido';
    return source
      .map(item => [clean(item.codigo), Math.trunc(Math.max(0, Number(item[quantityField]) || 0))])
      .filter(row => row[0] && row[1] > 0);
  }

  return {clean, normalize, parseWorkbook, status, summary, differenceRows, transferRows};
});
