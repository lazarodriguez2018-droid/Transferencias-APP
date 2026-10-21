const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { JSDOM } = require("../../work/node_modules/jsdom"),
  fs = require("node:fs"),
  C = require("../core");
test("Excel preserves separate lots and Word is a real OOXML document with escaped user text", async () => {
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only" }),
    w = dom.window;
  w.EnjoyCore = C;
  w.JSZip = require("../vendor/jszip-3.10.1.js");
  w.XLSX = require("../../operaciones/xlsx.full.min.js");
  w.Blob = Blob;
  w.URL.createObjectURL = () => "blob:testing";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.setTimeout = () => {};
  w.eval(fs.readFileSync(require.resolve("../exports"), "utf8"));
  const pkg = {
    inventory: {
      id: "test",
      title: "Prueba & revisión <Enjoy>",
      warehouse: "AL04",
      scheduled_date: "2026-10-21",
      status: "closed",
      assignments: [],
    },
    counts: [],
    reference: { N: { stock: 2, value: 20 }, I: { stock: 1, value: 30 } },
    approvals: {
      N: { quantity: 2, reason: "Cuadra", comment: "A & B" },
      I: { quantity: 0, reason: "Error de conteo", comment: "<Revisado>" },
    },
    documents: [],
    adjustments: [],
    submissions: {},
  };
  pkg.inventory.items = ["N", "I"].map((id, i) => ({
    id,
    code: "123",
    rawCode: "000123",
    name: "Harina",
    center: "UY01",
    warehouse: "AL04",
    lot: i ? "IMPORTADO" : "NACIONAL",
    unit: "KG",
  }));
  const xlsx = w.EnjoyExports.workbook(pkg),
    book = w.XLSX.read(new Uint8Array(await xlsx.arrayBuffer()), {
      type: "array",
    }),
    rows = w.XLSX.utils.sheet_to_json(book.Sheets.Justificaciones);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].Lote, rows[1].Lote);
  assert.equal(rows[1]["Cantidad autorizada"], 0);
  const doc = await w.EnjoyExports.acta(pkg),
    zip = await w.JSZip.loadAsync(await doc.arrayBuffer()),
    xml = await zip.file("word/document.xml").async("string");
  const parsed = new JSDOM(xml, { contentType: "application/xml" });
  assert.equal(parsed.window.document.querySelector("parsererror"), null);
  assert(xml.includes("Prueba &amp; revisión &lt;Enjoy&gt;"));
  assert(zip.file("[Content_Types].xml"));
  if (process.env.ENJOY_EXPORT_SAMPLE)
    fs.writeFileSync(
      process.env.ENJOY_EXPORT_SAMPLE,
      Buffer.from(await doc.arrayBuffer()),
    );
  dom.window.close();
});
