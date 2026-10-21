(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EnjoyCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAIN = ["AL04", "AL05", "AL02", "AL12"];
  const REASONS = [
    "Reserva sin ingresar",
    "Factura sin ingresar",
    "Factura mal ingresada",
    "Merma",
    "Material de otro almacen",
    "Caida de reserva",
    "Devolucion",
    "Nota de credito pendiente",
    "Cuadra",
    "Se compensa diferencia",
    "Sobrantes sin justificar",
    "Error de balanza",
    "Solicitud de reserva",
    "Error en unidad de solicitud de reserva",
    "Para revisar",
    "Error de conteo",
    "Sin respuesta",
    "Otros",
  ];
  const STEPS = [
    "Datos",
    "Mercadería",
    "Participantes",
    "Programación",
    "Conteo",
    "Revisión",
    "SAP",
    "Cierre",
  ];
  const norm = (v) =>
    String(v ?? "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ");
  const code = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^0+(?=\d)/, "");
  const lot = (v) =>
    String(v ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
  const key = (x) =>
    [x.center, x.warehouse, code(x.code), lot(x.lot), x.unit]
      .map((v) => encodeURIComponent(v ?? ""))
      .join("|");
  function number(v, { allowNegative = false } = {}) {
    if (typeof v === "number") {
      if (
        !Number.isFinite(v) ||
        Math.abs(v) > 1e9 ||
        Math.abs(v * 1e6 - Math.round(v * 1e6)) > 0.001 ||
        (!allowNegative && v < 0)
      )
        throw Error("Cantidad inválida");
      return v;
    }
    let s = String(v ?? "")
      .trim()
      .replace(/\s/g, "");
    if (!s) throw Error("Ingresá una cantidad");
    if (s.includes(",") && s.includes("."))
      s =
        s.lastIndexOf(",") > s.lastIndexOf(".")
          ? s.replace(/\./g, "").replace(",", ".")
          : s.replace(/,/g, "");
    else s = s.replace(",", ".");
    if (!/^-?\d+(\.\d{1,6})?$/.test(s))
      throw Error("Usá una cantidad con hasta seis decimales");
    const n = Number(s);
    if (!Number.isFinite(n) || Math.abs(n) > 1e9 || (!allowNegative && n < 0))
      throw Error("Cantidad inválida");
    return n;
  }
  const round = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
  function quantity(current, action, value) {
    const n = number(value),
      old = current == null ? 0 : number(current);
    const next =
      action === "add"
        ? old + n
        : action === "subtract"
          ? old - n
          : action === "set"
            ? n
            : NaN;
    if (!Number.isFinite(next) || next < 0 || next > 1e9)
      throw Error("El total no puede ser negativo");
    return round(next);
  }
  function parseDelimited(text, delimiter = ";") {
    const rows = [];
    let row = [],
      cell = "",
      quoted = false;
    const s = String(text).replace(/^\uFEFF/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (quoted && s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = !quoted;
      } else if (c === delimiter && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((c === "\r" || c === "\n") && !quoted) {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += c;
    }
    if (quoted) throw Error("El CSV contiene comillas sin cerrar");
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }
  const csvCell = (v) =>
    /[;"\r\n]/.test(String(v ?? ""))
      ? '"' + String(v ?? "").replace(/"/g, '""') + '"'
      : String(v ?? "");
  function serializeDelimited(rows) {
    return rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
  }
  function parseSap(text) {
    const rows = parseDelimited(text),
      header = rows.findIndex(
        (r) => norm(r[0]).startsWith("doc.invent.") && norm(r[2]) === "codigo",
      );
    if (header < 0)
      throw Error("No se encontró el encabezado de posiciones SAP");
    const meta = {};
    rows.slice(0, header).forEach((r) => {
      if (r[0] && r[1]) meta[norm(r[0]).replace(/:$/, "")] = r[1];
    });
    const items = rows
      .slice(header + 1)
      .map((r, i) => ({
        row: header + 1 + i,
        document: r[0],
        position: r[1],
        rawCode: r[2],
        code: code(r[2]),
        unit: r[3],
        name: r[4],
        lot: r[5],
        quantity: r[6] === "" || r[6] == null ? null : number(r[6]),
      }))
      .filter((x) => x.document && x.position && x.code);
    const ids = new Set();
    for (const i of items) {
      const id = i.document + "|" + i.position;
      if (ids.has(id)) throw Error("Posición SAP repetida: " + id);
      ids.add(id);
    }
    return {
      rows,
      header,
      meta,
      items,
      kind: /MI08/i.test(rows[header][0]) ? "confirmacion" : "conteo",
      documents: [...new Set(items.map((x) => x.document))],
    };
  }
  function parseMb52(rows) {
    const hi = rows.findIndex(
      (r) =>
        r.some((v) => norm(v) === "material") &&
        r.some((v) => norm(v) === "almacen"),
    );
    if (hi < 0)
      throw Error("No se encontraron Material y Almacén en el archivo");
    const heads = rows[hi].map(norm),
      col = (...labels) => heads.findIndex((h) => labels.includes(h));
    const at = {
      code: col("material", "codigo"),
      name: col("descripcion del material", "descripcion material", "nombre"),
      center: col("centro"),
      warehouse: col("almacen"),
      unit: col("unidad medida base", "unidad de medida", "umb"),
      stock: col("libre utilizacion", "stock"),
      value: col("valor libre util.", "valor libre utilizacion"),
      lot: col("lote", "lote (cls. valor)"),
      barcode: col("codigo de barras", "barras", "ean"),
    };
    if ([at.code, at.name, at.center, at.warehouse, at.unit].some((x) => x < 0))
      throw Error("Faltan columnas obligatorias de MB52");
    const items = [],
      reference = {},
      seen = new Set();
    let excludedZero = 0;
    for (const r of rows.slice(hi + 1)) {
      if (!/^\d+$/.test(String(r[at.code] ?? "").trim()) || !r[at.name])
        continue;
      const stock =
        at.stock < 0 || r[at.stock] === "" || r[at.stock] == null
          ? null
          : number(r[at.stock], { allowNegative: true });
      if (stock === 0) {
        excludedZero++;
        continue;
      }
      const item = {
        code: code(r[at.code]),
        rawCode: String(r[at.code]),
        name: String(r[at.name]),
        center: String(r[at.center]).trim(),
        warehouse: String(r[at.warehouse]).trim(),
        unit: String(r[at.unit]).trim(),
        lot: at.lot < 0 ? "" : String(r[at.lot] ?? "").trim(),
        barcode: at.barcode < 0 ? "" : String(r[at.barcode] ?? "").trim(),
      };
      item.id = key(item);
      if (seen.has(item.id))
        throw Error(
          "Material y lote repetidos: " +
            item.code +
            " " +
            item.lot +
            ". Revisá si faltan dimensiones del archivo.",
        );
      seen.add(item.id);
      items.push(item);
      reference[item.id] = {
        stock,
        value:
          at.value < 0 || r[at.value] === "" || r[at.value] == null
            ? null
            : number(r[at.value], { allowNegative: true }),
      };
    }
    if (!items.length) throw Error("No hay materiales válidos para importar");
    return {
      items,
      reference,
      excludedZero,
      warehouses: [...new Set(items.map((x) => x.warehouse))],
      hasStock: at.stock >= 0,
    };
  }
  function matchSap(sap, items, warehouse) {
    return sap.items.map((pos) => {
      const matches = items.filter(
        (x) =>
          code(x.code) === pos.code &&
          lot(x.lot) === lot(pos.lot) &&
          x.unit === pos.unit &&
          x.warehouse === warehouse,
      );
      return {
        ...pos,
        itemId: matches.length === 1 ? matches[0].id : null,
        error:
          matches.length === 1
            ? null
            : matches.length
              ? "Correspondencia ambigua"
              : "Sin correspondencia por material, lote y unidad",
      };
    });
  }
  function exportSap(sap, items, approved, { countDate, entryDate } = {}) {
    const warehouse = sap.meta["alm."] || sap.meta["almacen"];
    const center = sap.meta["centro"];
    if (center && items.some((i) => i.center !== center))
      throw Error("El centro del CSV no coincide");
    const matched = matchSap(sap, items, warehouse),
      rows = sap.rows.map((r) => r.slice());
    for (const pos of matched) {
      if (pos.error)
        throw Error(pos.error + ": " + pos.rawCode + " " + pos.lot);
      if (approved[pos.itemId]?.quantity == null)
        throw Error("Falta autorizar la cantidad: " + pos.code + " " + pos.lot);
      rows[pos.row][6] = String(number(approved[pos.itemId].quantity)).replace(
        ".",
        ",",
      );
    }
    if (!countDate || !entryDate)
      throw Error("Completá las fechas de conteo e ingreso");
    for (const r of rows) {
      if (norm(r[0]) === "fecha conteo:") r[1] = countDate;
      if (norm(r[0]) === "fecha ing.:") r[1] = entryDate;
    }
    return serializeDelimited(rows);
  }
  function encode1252(text) {
    const map = {
      "€": 128,
      "‚": 130,
      ƒ: 131,
      "„": 132,
      "…": 133,
      "†": 134,
      "‡": 135,
      ˆ: 136,
      "‰": 137,
      Š: 138,
      "‹": 139,
      Œ: 140,
      Ž: 142,
      "‘": 145,
      "’": 146,
      "“": 147,
      "”": 148,
      "•": 149,
      "–": 150,
      "—": 151,
      "˜": 152,
      "™": 153,
      š: 154,
      "›": 155,
      œ: 156,
      ž: 158,
      Ÿ: 159,
    };
    return Uint8Array.from(
      Array.from(text, (c) => {
        const n = c.charCodeAt(0);
        if (n <= 255) return n;
        if (map[c]) return map[c];
        throw Error("El texto contiene un carácter no admitido por el CSV SAP");
      }),
    );
  }
  function parseReport(rows) {
    const h = rows.findIndex(
      (r) =>
        r.some((v) => norm(v) === "documento inventario") &&
        r.some((v) => norm(v) === "material"),
    );
    if (h < 0) throw Error("No se encontró el encabezado del Reporte SAP");
    const heads = rows[h].map(norm),
      col = (name) => heads.indexOf(name),
      columns = {};
    heads.forEach((name, i) => {
      if (name) (columns[name] ??= []).push(i);
    });
    const data = rows
      .slice(h + 1)
      .filter((r) => /^\d+$/.test(String(r[col("material")] ?? "")))
      .map((r) => ({
        document: String(r[col("documento inventario")]),
        position: String(r[col("posicion")]),
        code: code(r[col("material")]),
        center: String(r[col("centro")]),
        warehouse: String(r[col("almacen")]),
        unit: String(r[col("unidad medida base")]),
        lot: String(r[col("lote")] ?? ""),
        name: String(r[col("descripcion material")] ?? ""),
        theoretical: r[col("cantidad teorica")],
        counted: r[col("contado")],
        recounted: r[col("recuento")],
        recountDate: r[col("fecha de recuento")],
        value: r[col("val.ctd.teorica")],
        countedValue: r[columns["monto contado"]?.[0]],
        differenceValue: r[columns["importe diferencial"]?.[0]],
        finalDifference: r[col("diferencia final")],
        raw: r,
      }));
    const total = rows.find((r) => norm(r[0]) === "total general");
    if (!data.length || !total)
      throw Error("El Reporte no contiene materiales o Total general");
    return {
      columns,
      headers: rows[h],
      items: data,
      documents: [...new Set(data.map((x) => x.document))],
      warehouses: [...new Set(data.map((x) => x.warehouse))],
      totals: {
        theoreticalValue: Number(total[col("val.ctd.teorica")]) || 0,
        countedValue: Number(total[columns["monto contado"]?.[0]]) || 0,
        differenceValue:
          Number(total[columns["importe diferencial"]?.[0]]) || 0,
      },
      rows,
    };
  }
  function comparison(pkg) {
    return pkg.inventory.items.map((item) => {
      const ref = pkg.reference?.[item.id] ?? {},
        entries = (pkg.counts || []).filter((c) => c.item_id === item.id),
        a = pkg.approvals?.[item.id];
      return {
        ...item,
        stock: ref.stock,
        value: ref.value,
        entries,
        approved: a?.quantity ?? null,
        reason: a?.reason || "",
        comment: a?.comment || "",
        diff:
          a?.quantity == null || ref.stock == null
            ? null
            : round(a.quantity - ref.stock),
        diffValue:
          a?.quantity == null ||
          ref.stock == null ||
          ref.stock === 0 ||
          ref.value == null
            ? null
            : ((a.quantity - ref.stock) * ref.value) / ref.stock,
      };
    });
  }
  function metrics(rows) {
    const counted = rows.filter((r) => r.approved != null),
      comparable = counted.filter((r) => r.stock != null),
      priced = counted.filter((r) => r.stock != null && r.value != null),
      total = priced.reduce((s, r) => s + r.value, 0),
      net = priced.reduce((s, r) => s + (r.diffValue || 0), 0),
      gross = priced.reduce((s, r) => s + Math.abs(r.diffValue || 0), 0);
    return {
      total: rows.length,
      approved: counted.length,
      exact: counted.filter((r) => r.diff === 0).length,
      within1000: counted.filter(
        (r) => r.diffValue != null && Math.abs(r.diffValue) < 1000,
      ).length,
      theoreticalValue: total,
      net,
      gross,
      netRate: total ? net / total : null,
      exactRate: comparable.length
        ? comparable.filter((r) => r.diff === 0).length / comparable.length
        : null,
      quality: total ? 1 - gross / total : null,
    };
  }
  function today(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Montevideo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
  return {
    MAIN,
    REASONS,
    STEPS,
    norm,
    code,
    lot,
    key,
    number,
    round,
    quantity,
    parseDelimited,
    serializeDelimited,
    parseSap,
    parseMb52,
    matchSap,
    exportSap,
    encode1252,
    parseReport,
    comparison,
    metrics,
    today,
  };
});
