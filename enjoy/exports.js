(function (root) {
  "use strict";
  const C = root.EnjoyCore,
    P = root.EnjoyParticipants;
  const xml = (s) =>
    String(s ?? "").replace(
      /[<>&"']/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
  function download(bytes, name, type) {
    const blob = new Blob([bytes], { type }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return blob;
  }
  const display = (n) =>
    n == null
      ? "Sin dato"
      : new Intl.NumberFormat("es-UY", { maximumFractionDigits: 6 }).format(n);
  function comparisonRows(pkg) {
    return C.comparison(pkg).map((r) => ({
      Material: r.rawCode,
      Descripción: r.name,
      Centro: r.center,
      Almacén: r.warehouse,
      Lote: r.lot,
      Unidad: r.unit,
      "Stock MB52": r.stock ?? null,
      ...Object.fromEntries(
        P.columns(pkg).map((a, k) => [
          `Conteo ${k + 1} · ${P.name(a)} · ${P.roles[a.actor] || a.actor}`,
          r.entries.find((c) => c.user_id === a.user_id && c.actor === a.actor)
            ?.quantity ?? null,
        ]),
      ),
      "Cantidad autorizada": r.approved,
      "Dif. autorizada - stock": r.diff,
      "Valor MB52": r.value ?? null,
      "Dif. valor estimada": r.diffValue,
      Motivo: r.reason,
      Comentario: r.comment,
    }));
  }
  function workbook(pkg) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(comparisonRows(pkg)),
      "Justificaciones",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        pkg.inventory.assignments.map((a) => ({
          Nombre: P.name(a),
          Rol: P.roles[a.actor] || a.actor,
          Participación: P.state(pkg, a),
          Usuario: a.user_id,
          Entrega: pkg.submissions[P.key(a)]?.at || null,
        })),
      ),
      "Participantes",
    );
    if (pkg.report?.rows)
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(pkg.report.rows),
        "Reporte SAP",
      );
    if (pkg.adjustments?.length)
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(pkg.adjustments),
        "Ajustes",
      );
    const m = C.metrics(C.comparison(pkg));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        { Indicador: "Exactitud estricta", Valor: m.exactRate },
        {
          Indicador: "Productos con diferencia menor a 1000 UYU",
          Valor: m.within1000,
        },
        { Indicador: "Aprobados", Valor: m.approved },
        { Indicador: "Diferencia neta estimada", Valor: m.net },
        { Indicador: "Diferencia absoluta estimada", Valor: m.gross },
      ]),
      "Indicadores",
    );
    return download(
      XLSX.write(wb, { bookType: "xlsx", type: "array" }),
      `Enjoy_${pkg.inventory.warehouse}_${pkg.inventory.scheduled_date}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }
  function p(text, bold = false) {
    return `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  }
  function table(rows) {
    return (
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
      ["top", "left", "bottom", "right", "insideH", "insideV"]
        .map((x) => `<w:${x} w:val="single" w:sz="4" w:color="CCCCCC"/>`)
        .join("") +
      "</w:tblBorders></w:tblPr>" +
      rows
        .map(
          (row) =>
            "<w:tr>" +
            row.map((v) => "<w:tc>" + p(v) + "</w:tc>").join("") +
            "</w:tr>",
        )
        .join("") +
      "</w:tbl>"
    );
  }
  async function acta(pkg, names = {}) {
    const rows = C.comparison(pkg),
      m = C.metrics(rows),
      inv = pkg.inventory,
      top = rows
        .filter((r) => r.diffValue != null)
        .sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue))
        .slice(0, 10);
    let body =
      p("ENJOY · ACTA DE INVENTARIO", true) +
      p(inv.title, true) +
      p(
        `Almacén ${inv.warehouse} · Fecha ${inv.scheduled_date} · ID ${inv.id}`,
      ) +
      p(
        `Estado: ${inv.status === "closed" ? "Cerrado" : "Borrador para revisión"} · Emitida ${new Date().toLocaleString("es-UY")}`,
      ) +
      p("Participantes", true) +
      table([
        ["Función", "Nombre", "Entrega"],
        ...inv.assignments.map((a) => [
          P.roles[a.actor] || a.actor,
          a.name || names[a.user_id] || a.user_id,
          P.state(pkg, a) +
            (pkg.submissions[P.key(a)]?.at
              ? " · " + pkg.submissions[P.key(a)].at
              : ""),
        ]),
      ]) +
      p("Indicadores sobre cantidades autorizadas", true) +
      p(
        `Materiales: ${m.total}. Autorizados: ${m.approved}. Exactitud estricta: ${m.exactRate == null ? "Sin referencia" : display(m.exactRate * 100) + "%"}. Productos con diferencia valorizada menor a 1.000 UYU: ${m.within1000}.`,
      ) +
      p(
        "La diferencia se expresa como cantidad autorizada menos stock. La valorización MB52 es estimada; el Reporte SAP mantiene sus importes originales.",
      ) +
      table([
        ["Fuente", "Valor teórico UYU", "Valor contado UYU", "Diferencia UYU"],
        [
          "MB52 / autorizado",
          display(m.theoreticalValue),
          display(m.theoreticalValue + m.net),
          display(m.net),
        ],
        ...(pkg.report
          ? [
              [
                "Reporte SAP",
                display(pkg.report.totals.theoreticalValue),
                display(pkg.report.totals.countedValue),
                display(pkg.report.totals.differenceValue),
              ],
            ]
          : []),
      ]) +
      p("Diez diferencias de mayor importe absoluto (MB52)", true) +
      table([
        ["Material / lote", "Stock", "Autorizado", "Diferencia UYU"],
        ...top.map((r) => [
          r.code + " / " + (r.lot || "Sin lote"),
          display(r.stock),
          display(r.approved),
          display(r.diffValue),
        ]),
      ]) +
      p("Justificaciones y descargos", true) +
      table([
        ["Material / lote", "Motivo", "Comentario"],
        ...rows
          .filter((r) => r.diff !== 0 || r.comment)
          .map((r) => [r.code + " / " + r.lot, r.reason, r.comment]),
      ]) +
      p("Ajustes posteriores", true) +
      (pkg.adjustments?.length
        ? table([
            ["Material / lote", "Cantidad", "Estado", "Evidencia"],
            ...pkg.adjustments.map((a) => [
              a.code + " / " + a.lot,
              display(a.quantity),
              a.executed ? "Ejecutado " + a.date : "Propuesto",
              a.evidence || "",
            ]),
          ])
        : p("Sin ajustes registrados.")) +
      p("Documentos vinculados", true) +
      table([
        ["Tipo", "Archivo", "Documento SAP"],
        ...(pkg.documents || []).map((d) => [
          d.kind,
          d.name,
          (d.documents || []).join(", "),
        ]),
      ]) +
      p("Observaciones de cierre", true) +
      p(inv.management_notes || "Sin observaciones adicionales.") +
      p("Firmas", true) +
      table([
        ["Participante", "Función", "Firma"],
        ...inv.assignments
          .filter((a) => !a.absent)
          .map((a) => [
            a.name || names[a.user_id] || a.user_id,
            P.roles[a.actor] || a.actor,
            "____________________",
          ]),
      ]) +
      p("Conformidad de Finanzas / Supervisor: ____________________");
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="850"/></w:sectPr></w:body></w:document>',
    );
    return download(
      await zip.generateAsync({ type: "uint8array" }),
      `Acta_Enjoy_${inv.warehouse}_${inv.scheduled_date}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  }
  function consolidated(packages) {
    const wb = XLSX.utils.book_new(),
      detail = packages.flatMap((pkg) =>
        comparisonRows(pkg).map((r) => ({
          Inventario: pkg.inventory.id,
          Fecha: pkg.inventory.scheduled_date,
          ...r,
        })),
      ),
      groups = new Map();
    for (const r of detail) {
      const id = [r.Centro, r.Almacén, r.Material, r.Lote, r.Unidad].join("|");
      if (!groups.has(id))
        groups.set(id, {
          Material: r.Material,
          Descripción: r.Descripción,
          Centro: r.Centro,
          Almacén: r.Almacén,
          Lote: r.Lote,
          Unidad: r.Unidad,
          "Cantidad autorizada": 0,
          Inventarios: [],
        });
      const g = groups.get(id);
      if (r["Cantidad autorizada"] == null)
        throw Error("Hay cantidades pendientes de autorizar");
      g["Cantidad autorizada"] += r["Cantidad autorizada"];
      g.Inventarios.push(r.Inventario);
    }
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(detail),
      "Origen por inventario",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        [...groups.values()].map((g) => ({
          ...g,
          Inventarios: [...new Set(g.Inventarios)].join(", "),
        })),
      ),
      "Consolidado por lote",
    );
    return download(
      XLSX.write(wb, { bookType: "xlsx", type: "array" }),
      "Enjoy_AL05_consolidado.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }
  root.EnjoyExports = {
    download,
    workbook,
    acta,
    consolidated,
    comparisonRows,
  };
})(window);
