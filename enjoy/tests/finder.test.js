const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  F = require("../finder"),
  engine = require("../../operaciones/search-engine");
const items = [
    {
      id: "n",
      name: "Harina de trigo",
      nombre: "Harina de trigo",
      code: "123",
      codigo: "123",
      lot: "NACIONAL",
      barcode: "773123",
    },
    {
      id: "i",
      name: "Harina de trigo",
      nombre: "Harina de trigo",
      code: "123",
      codigo: "123",
      lot: "IMPORTADO",
      barcode: "773123",
    },
    {
      id: "a",
      name: "Aceite de girasol",
      nombre: "Aceite de girasol",
      code: "456",
      codigo: "456",
      lot: "",
      barcode: "773456",
    },
  ],
  index = engine.createSearchIndex(items);
test("the same lookup accepts partial names, material codes, padded codes and barcode prefixes without merging lots", () => {
  for (const query of ["har", "123", "000123", "773123"])
    assert.deepEqual(
      F.find(index, query, engine).map((i) => i.id),
      ["n", "i"],
    );
  assert.equal(F.find(index, "7734", engine)[0].id, "a");
  assert.equal(F.find(index, "aceite", engine)[0].id, "a");
});
test("completion preserves accents and only fills a true prefix; label segments keep the original characters", () => {
  assert.equal(F.completion("har", items[0]), "Harina de trigo");
  assert.equal(F.completion("HÁR", items[0]), "Harina de trigo");
  assert.equal(F.completion("trigo", items[0]), "");
  assert.equal(F.completion("773", items[0]), "773123");
  assert.deepEqual(F.segments("Café molido", "cafe"), [
    { text: "Café", match: true },
    { text: " molido", match: false },
  ]);
});
