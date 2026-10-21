const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  C = require("../core");
const item = (lot = "NACIONAL") => {
  const i = {
    code: "123",
    rawCode: "000123",
    name: "Harina",
    center: "UY01",
    warehouse: "AL04",
    unit: "KG",
    lot,
    barcode: "7731",
  };
  return { ...i, id: C.key(i) };
};
test("zeros, decimals and reversible arithmetic", () => {
  assert.equal(C.quantity(null, "add", "0"), 0);
  assert.equal(C.quantity(9.95, "add", "0,002"), 9.952);
  assert.equal(C.quantity(10, "subtract", "1,5"), 8.5);
  assert.equal(C.quantity(10, "set", "0"), 0);
  assert.throws(() => C.quantity(1, "subtract", 2));
  assert.throws(() => C.number("1,0000001"));
});
test("MB52 excludes theoretical zeros and preserves national/imported lots", () => {
  const p = C.parseMb52([
    [
      "Material",
      "Descripción del material",
      "Centro",
      "Almacén",
      "Unidad medida base",
      "Libre utilización",
      "Valor libre util.",
      "Lote",
    ],
    ["123", "Harina", "UY01", "AL04", "KG", 2, 20, "NACIONAL"],
    ["123", "Harina", "UY01", "AL04", "KG", 4, 60, "IMPORTADO"],
    ["456", "Sal", "UY01", "AL04", "KG", 0, 0, ""],
  ]);
  assert.equal(p.items.length, 2);
  assert.equal(p.excludedZero, 1);
  assert.notEqual(p.items[0].id, p.items[1].id);
  assert(!("stock" in p.items[0]));
});
test("SAP lots, padded codes, document positions, zero and encoding survive export", () => {
  const text =
    "Alm.:;AL04\r\nFecha Conteo:;01.01.2026\r\nFecha Ing.:;01.01.2026\r\nDoc.Invent.(MI04);Posición;Código;Unidad;Descripción;Lote;Q.Física\r\n01000001;001;000123;KG;Harina;NACIONAL;\r\n01000001;002;000123;KG;Harina;IMPORTADO;\r\n";
  const p = C.parseSap(text),
    items = [item(), item("IMPORTADO")],
    out = C.parseSap(
      C.exportSap(
        p,
        items,
        { [items[0].id]: { quantity: 0 }, [items[1].id]: { quantity: 9.952 } },
        { countDate: "21.10.2026", entryDate: "21.10.2026" },
      ),
    );
  assert.deepEqual(
    out.items.map((p) => [p.position, p.rawCode, p.quantity]),
    [
      ["001", "000123", 0],
      ["002", "000123", 9.952],
    ],
  );
  assert.equal(
    new TextDecoder("windows-1252").decode(
      C.encode1252("Posición;Descripción"),
    ),
    "Posición;Descripción",
  );
  assert.throws(() => C.exportSap(p, items, {}, {}));
});
test("exactitude differs from tolerance and null is not zero", () => {
  const m = C.metrics([
    { approved: 0, stock: 0, value: 0, diff: 0, diffValue: 0 },
    { approved: 5, stock: 6, value: 60, diff: -1, diffValue: -10 },
    { approved: null, stock: 5, value: 50, diff: null, diffValue: null },
  ]);
  assert.equal(m.exactRate, 0.5);
  assert.equal(m.within1000, 2);
  assert.equal(m.approved, 2);
});
const dir = process.env.ENJOY_FIXTURES;
if (dir) {
  const XLSX = require("../../operaciones/xlsx.full.min.js");
  test("real October: 254 MB52 positions match the SAP template", () => {
    const book = XLSX.read(fs.readFileSync(dir + "/Stock AL04 Octubre.xlsx"), {
        type: "buffer",
      }),
      p = C.parseMb52(
        XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
          header: 1,
          defval: "",
        }),
      ),
      csv = C.parseSap(
        new TextDecoder("windows-1252").decode(
          fs.readFileSync(dir + "/Stock AL04 Octubre .csv"),
        ),
      );
    assert.equal(p.items.length, 254);
    assert.equal(csv.items.length, 254);
    assert(C.matchSap(csv, p.items, "AL04").every((x) => !x.error));
  });
  test("real September: two SAP document IDs are separate linked stages; Reporte totals retain their original values", () => {
    const a = C.parseSap(
        new TextDecoder("windows-1252").decode(
          fs.readFileSync(dir + "/AL04 Sep 26.csv"),
        ),
      ),
      b = C.parseSap(
        new TextDecoder("windows-1252").decode(
          fs.readFileSync(dir + "/AL04 Sep 26_2.csv"),
        ),
      );
    assert.equal(a.items.length, 268);
    assert.equal(b.items.length, 268);
    assert.notDeepEqual(a.documents, b.documents);
    assert.equal(b.kind, "confirmacion");
    const book = XLSX.read(fs.readFileSync(dir + "/Reporte AL04 Sep 26.xlsx"), {
        type: "buffer",
      }),
      report = C.parseReport(
        XLSX.utils.sheet_to_json(book.Sheets.Reporte, {
          header: 1,
          defval: "",
        }),
      );
    assert.equal(report.items.length, 268);
    assert(Math.abs(report.totals.theoreticalValue - 3341041.32) < 0.00001);
    assert(Math.abs(report.totals.differenceValue - 24497.9) < 0.00001);
    assert.equal(report.columns["monto contado"].length, 2);
  });
}
