(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SucaneitorBarcode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeHeader(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function expandScientificIdentifier(value) {
    const source = String(value ?? '').trim();
    const match = source.match(/^([+-]?)(\d*\.?\d+)[eE]([+-]?\d+)$/);
    if (!match) return source;
    const sign = match[1] === '-' ? '-' : '';
    const mantissa = match[2];
    const exponent = Number(match[3]);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return source;
    const parts = mantissa.split('.');
    const digits = `${parts[0]}${parts[1] || ''}`;
    const decimalAt = parts[0].length + exponent;
    if (decimalAt <= 0) return `${sign}0.${'0'.repeat(-decimalAt)}${digits}`;
    if (decimalAt >= digits.length) return `${sign}${digits}${'0'.repeat(decimalAt - digits.length)}`;
    return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
  }

  function cleanIdentifier(value) {
    let text = String(value ?? '').replace(/\u00a0/g, ' ').trim();
    if (/^(nan|undefined|null)$/i.test(text)) return '';
    text = text.replace(/^'+/, '').trim();
    text = expandScientificIdentifier(text);
    if (/^\d+\.0+$/.test(text)) text = text.replace(/\.0+$/, '');
    return text;
  }

  function findColumns(headers) {
    const normalized = (headers || []).map(normalizeHeader);
    const barcode = normalized.findIndex(header =>
      /(^| )(codigo )?(de )?barras?( |$)/.test(header) ||
      /(^| )barcode( |$)/.test(header) ||
      /(^| )(ean|gtin|upc)( ?\d+)?( |$)/.test(header)
    );
    const code = normalized.findIndex((header, index) => index !== barcode && (
      header === 'codigo' || header === 'codigo producto' || header === 'codigo de producto' ||
      header === 'sku' || header === 'codigo sku'
    ));
    const name = normalized.findIndex(header =>
      header === 'nombre' || header === 'nombre producto' || header === 'nombre de producto' ||
      header === 'descripcion' || header === 'description'
    );
    const brand = normalized.findIndex(header => header === 'marca' || header === 'brand');
    const manufacturer = normalized.findIndex(header => header === 'fabricante' || header === 'manufacturer');
    return { code, barcode, name, brand, manufacturer, normalized };
  }

  function parseCatalogRows(rows, options = {}) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    const scanLimit = Math.min(sourceRows.length, Number(options.headerScanLimit) || 30);
    let headerRow = -1;
    let columns = null;
    for (let index = 0; index < scanLimit; index += 1) {
      const candidate = findColumns(Array.isArray(sourceRows[index]) ? sourceRows[index] : []);
      if (candidate.code >= 0 && candidate.name >= 0) {
        headerRow = index;
        columns = candidate;
        break;
      }
    }
    if (headerRow < 0 || !columns) {
      return { ok: false, error: 'No se encontraron las columnas Código y Nombre.' };
    }
    if (columns.barcode < 0) {
      return {
        ok: false,
        error: 'No se encontró la columna Código de Barras. El padrón anterior no fue modificado.'
      };
    }

    const byCode = new Map();
    let duplicateProductCodes = 0;
    for (let index = headerRow + 1; index < sourceRows.length; index += 1) {
      const row = Array.isArray(sourceRows[index]) ? sourceRows[index] : [];
      const codigo = cleanIdentifier(row[columns.code]);
      const nombre = cleanIdentifier(row[columns.name]);
      if (!codigo || !nombre) continue;
      if (byCode.has(codigo)) duplicateProductCodes += 1;
      byCode.set(codigo, {
        codigo,
        barras: cleanIdentifier(row[columns.barcode]),
        nombre,
        fabricante: columns.manufacturer >= 0 ? cleanIdentifier(row[columns.manufacturer]) : '',
        marca: columns.brand >= 0 ? cleanIdentifier(row[columns.brand]) : ''
      });
    }

    const products = Array.from(byCode.values());
    const barcodeCounts = new Map();
    for (const product of products) {
      const key = normalizeBarcode(product.barras);
      if (!key) continue;
      barcodeCounts.set(key, (barcodeCounts.get(key) || 0) + 1);
    }
    const barcodeProducts = products.filter(product => normalizeBarcode(product.barras)).length;
    if (!products.length) return { ok: false, error: 'El archivo no contiene productos válidos.' };
    if (!barcodeProducts) {
      return {
        ok: false,
        error: 'La columna Código de Barras está vacía. El padrón anterior no fue modificado.'
      };
    }

    return {
      ok: true,
      products,
      headerRow,
      columns,
      stats: {
        products: products.length,
        barcodeProducts,
        withoutBarcode: products.length - barcodeProducts,
        duplicateBarcodes: Array.from(barcodeCounts.values()).filter(count => count > 1).length,
        duplicateProductCodes
      }
    };
  }

  function normalizeBarcode(value) {
    let text = cleanIdentifier(value).toUpperCase();
    text = text.replace(/^\][A-Z0-9]{2}/, '');
    return text.replace(/\s+/g, '');
  }

  function barcodeVariants(value) {
    const variants = new Set();
    const normalized = normalizeBarcode(value);
    if (!normalized) return variants;
    const parts = normalized.split(/[;,|/]+/).map(part => part.trim()).filter(Boolean);
    for (let part of parts.length ? parts : [normalized]) {
      part = part.replace(/\.0+$/, '');
      if (!part) continue;
      variants.add(part);
      if (part.startsWith('.') && part.length > 1) variants.add(part.slice(1));
      if (/^\d+$/.test(part)) {
        const withoutLeadingZeros = part.replace(/^0+/, '') || '0';
        variants.add(withoutLeadingZeros);
        if (part.length >= 7 && part.length <= 13) variants.add(`0${part}`);
      }
      const coloredVariant = part.match(/^(\d{6,})([A-Z]+)$/);
      if (coloredVariant) variants.add(coloredVariant[1]);
    }
    return variants;
  }

  function matchesBarcode(left, right) {
    const leftVariants = barcodeVariants(left);
    const rightVariants = barcodeVariants(right);
    for (const value of leftVariants) if (rightVariants.has(value)) return true;
    return false;
  }

  return {
    normalizeHeader,
    expandScientificIdentifier,
    cleanIdentifier,
    findColumns,
    parseCatalogRows,
    normalizeBarcode,
    barcodeVariants,
    matchesBarcode
  };
});
