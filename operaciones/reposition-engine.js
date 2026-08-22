(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SucaneitorReposition = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADER_ALIASES = {
    sku: ['sku', 'codigo', 'código', 'product_code', 'item'],
    description: ['description', 'descripcion', 'descripción', 'nombre', 'producto'],
    qty: ['qty_replenishment', 'qty_replen', 'cantidad', 'cantidad_reposicion', 'cantidad_reposición', 'qty'],
    origin: ['origin', 'origen', 'local_origen'],
    destination: ['location', 'destination', 'destino', 'local_destino'],
    stock: ['stock_origin', 'stock_origen', 'stock origen', 'stock']
  };

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeHeader(value) {
    return clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function integer(value, field, rowNumber) {
    const raw = clean(value).replace(',', '.');
    if (!raw) throw new Error(`Falta ${field} en la fila ${rowNumber}`);
    const number = Number(raw);
    if (!Number.isFinite(number) || !Number.isInteger(number)) {
      throw new Error(`${field} debe ser entero en la fila ${rowNumber}`);
    }
    return number;
  }

  function resolveColumns(header) {
    const normalized = header.map(normalizeHeader);
    const result = {};
    Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
      const wanted = aliases.map(normalizeHeader);
      result[field] = normalized.findIndex(value => wanted.includes(value));
    });
    const missing = Object.entries(result).filter(([, index]) => index < 0).map(([field]) => field);
    if (missing.length) throw new Error(`Faltan columnas requeridas: ${missing.join(', ')}`);
    return result;
  }

  function findHeaderRow(rows) {
    for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
      const normalized = rows[index].map(normalizeHeader);
      if (normalized.includes('sku') && normalized.some(value => ['qty_replenishment', 'qty_replen', 'cantidad'].includes(value))) {
        return index;
      }
    }
    throw new Error('No se encontró el encabezado de la reposición');
  }

  function parseRows(rows, padron) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('La planilla está vacía');
    const headerRow = findHeaderRow(rows);
    const columns = resolveColumns(rows[headerRow]);
    const productMap = new Map((padron || []).map(product => [clean(product.codigo), product]));
    const routes = new Set();
    const seen = new Set();
    const retained = [];
    const excluded = [];
    let totalRequested = 0;

    for (let index = headerRow + 1; index < rows.length; index += 1) {
      const row = rows[index] || [];
      const codigo = clean(row[columns.sku]);
      if (!codigo) continue;
      if (seen.has(codigo)) throw new Error(`El SKU ${codigo} está repetido en el archivo`);
      seen.add(codigo);
      const pedido = integer(row[columns.qty], 'La cantidad', index + 1);
      const stock = integer(row[columns.stock], 'El stock de origen', index + 1);
      if (pedido <= 0) continue;
      const origin = clean(row[columns.origin]);
      const destination = clean(row[columns.destination]);
      if (!origin || !destination) throw new Error(`Falta origen o destino en la fila ${index + 1}`);
      routes.add(`${origin}\u0000${destination}`);
      totalRequested += pedido;
      const sourceDescription = clean(row[columns.description]);
      const product = productMap.get(codigo);
      const item = {
        codigo,
        nombre: clean(product && product.nombre) || sourceDescription || codigo,
        descripcion_archivo: sourceDescription,
        barras: clean(product && product.barras),
        marca: clean(product && product.marca),
        pedido,
        stock_origen: stock,
        stock_restante: stock - pedido,
        en_padron: Boolean(product),
        source_row: index + 1
      };
      // Regla idéntica al macro: si la solicitud deja stock en cero o negativo,
      // se excluye toda la fila; no se reduce automáticamente la cantidad.
      if (item.stock_restante > 0) retained.push(item);
      else excluded.push(item);
    }
    if (routes.size !== 1) throw new Error('El archivo debe contener un único origen y un único destino');
    if (!retained.length) throw new Error('Ningún producto cumple la regla de conservar stock en el origen');
    const [origin, destination] = [...routes][0].split('\u0000');
    retained.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base', numeric: true }));
    return {
      origin,
      destination,
      items: retained,
      excluded,
      meta: {
        source_rows: retained.length + excluded.length,
        retained_rows: retained.length,
        excluded_rows: excluded.length,
        source_requested_units: totalRequested,
        retained_requested_units: retained.reduce((sum, item) => sum + item.pedido, 0),
        excluded_requested_units: excluded.reduce((sum, item) => sum + item.pedido, 0),
        missing_padron: retained.filter(item => !item.en_padron).map(item => item.codigo)
      }
    };
  }

  function parseWorkbook(workbook, XLSX, padron) {
    if (!workbook || !workbook.SheetNames || !workbook.SheetNames.length) throw new Error('Libro sin hojas');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    return parseRows(rows, padron);
  }

  function status(item) {
    const requested = Math.max(0, Number(item.pedido) || 0);
    const prepared = Math.max(0, Number(item.preparado) || 0);
    if (prepared > requested) return 'excedido';
    if (prepared === requested && requested > 0) return 'completo';
    if (item.no_encontrado) return 'no_encontrado';
    if (item.cerrado_incompleto) return 'incompleto';
    if (prepared > 0) return 'parcial';
    return 'pendiente';
  }

  function summary(repo) {
    const items = repo && Array.isArray(repo.items) ? repo.items : [];
    const extras = repo && Array.isArray(repo.extras) ? repo.extras : [];
    const requestedUnits = items.reduce((sum, item) => sum + Math.max(0, Number(item.pedido) || 0), 0);
    const preparedUnits = items.reduce((sum, item) => sum + Math.max(0, Number(item.preparado) || 0), 0);
    const result = {
      productos: items.length,
      pedidos: requestedUnits,
      preparados: preparedUnits,
      faltantes: items.reduce((sum, item) => sum + Math.max(0, (Number(item.pedido) || 0) - (Number(item.preparado) || 0)), 0),
      completos: 0,
      parciales: 0,
      pendientes: 0,
      excedidos: 0,
      no_encontrados: 0,
      cerrados_incompletos: 0,
      extras_productos: extras.filter(item => Number(item.cantidad) > 0).length,
      extras_unidades: extras.reduce((sum, item) => sum + Math.max(0, Number(item.cantidad) || 0), 0)
    };
    items.forEach(item => {
      const value = status(item);
      if (value === 'completo') result.completos += 1;
      else if (value === 'parcial') result.parciales += 1;
      else if (value === 'pendiente') result.pendientes += 1;
      else if (value === 'excedido') result.excedidos += 1;
      else if (value === 'no_encontrado') result.no_encontrados += 1;
      else if (value === 'incompleto') result.cerrados_incompletos += 1;
    });
    result.productos_faltantes = items.filter(item => Math.max(0, (Number(item.pedido) || 0) - (Number(item.preparado) || 0)) > 0).length;
    return result;
  }

  function mainTransferRows(repo) {
    return (repo.items || []).filter(item => Number(item.preparado) > 0)
      .map(item => {
        const prepared = Math.trunc(Number(item.preparado) || 0);
        const orderRequested = Math.trunc(Number(item.pedido_clientes) || 0);
        const repoRequested = Math.max(0, Math.trunc(Number(item.pedido_reposicion == null ? item.pedido : item.pedido_reposicion) || 0));
        const allocatedToOrders = orderRequested > 0 ? (repoRequested > 0 ? Math.min(prepared, orderRequested) : prepared) : 0;
        return [clean(item.codigo), repoRequested > 0 ? Math.max(0, prepared - allocatedToOrders) : 0];
      }).filter(row => row[1] > 0);
  }

  // Los pedidos de clientes tienen prioridad de asignacion. La misma unidad nunca
  // aparece tambien en el archivo de reposicion automatica.
  function orderTransferRows(repo) {
    return (repo.items || []).filter(item => Number(item.preparado) > 0 && Number(item.pedido_clientes) > 0)
      .map(item => {
        const prepared = Math.trunc(Number(item.preparado) || 0);
        const orderRequested = Math.trunc(Number(item.pedido_clientes) || 0);
        const repoRequested = Math.max(0,Math.trunc(Number(item.pedido_reposicion) || 0));
        return [clean(item.codigo),repoRequested > 0 ? Math.min(prepared,orderRequested) : prepared];
      })
      .filter(row => row[1] > 0);
  }

  function extraTransferRows(repo) {
    return (repo.extras || []).filter(item => Number(item.cantidad) > 0)
      .map(item => [clean(item.codigo), Math.trunc(Number(item.cantidad))]);
  }

  function missingRows(repo) {
    return (repo.items || []).map(item => {
      const missing = Math.max(0, Math.trunc(Number(item.pedido) || 0) - Math.trunc(Number(item.preparado) || 0));
      return missing > 0 ? {
        codigo: clean(item.codigo), nombre: clean(item.nombre), pedido: Math.trunc(Number(item.pedido) || 0),
        preparado: Math.trunc(Number(item.preparado) || 0), faltante: missing,
        estado: status(item), motivo: clean(item.motivo),
        motivo_codigo: clean(item.motivo_codigo), motivo_label: clean(item.motivo_label),
        motivo_otro: clean(item.motivo_otro), comentario: clean(item.comentario),
        actualizado_por: clean(item.updated_by)
      } : null;
    }).filter(Boolean);
  }

  return {
    parseRows,
    parseWorkbook,
    status,
    summary,
    mainTransferRows,
    orderTransferRows,
    extraTransferRows,
    missingRows,
    normalizeHeader
  };
});
