const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { demo } = require("./ui-helpers");
test("a manager prepares and publishes separately, reviews results separately, then enters a count-only screen", async (t) => {
  const { w, doc, click } = await demo(t);
  assert.equal(doc.querySelector('[data-action="new"]'), null);
  await click('[data-action="dashboard-admin"]');
  assert(doc.querySelector('[data-action="new"]'));
  assert.equal(doc.querySelector('[data-action="open"]'), null);
  await click('[data-action="open-configure"]');
  assert(w.location.hash.startsWith("#configuracion/"));
  assert.equal(doc.querySelectorAll(".steps button").length, 4);
  assert.equal(doc.getElementById("search"), null);
  assert.equal(doc.getElementById("count-table"), null);
  assert(!doc.querySelector(".steps").textContent.includes("Conteo"));
  await click('[data-action="next"]');
  assert(doc.getElementById("mb52-file"));
  assert.equal(doc.getElementById("search"), null);
  await click('[data-step="3"]');
  assert(doc.querySelector('[data-action="publish"]'));
  assert.equal(doc.getElementById("count-table"), null);
  await click('[data-action="publish"]');
  assert.equal(w.location.hash, "#administracion");
  await click('[data-action="open-results"]');
  assert(w.location.hash.startsWith("#resultados/"));
  assert.equal(doc.querySelectorAll(".steps button").length, 3);
  assert.equal(doc.getElementById("search"), null);
  assert.equal(doc.getElementById("mb52-file"), null);
  await click('[data-step="6"]');
  assert(doc.getElementById("sap-file"));
  await click("#home");
  await click('[data-action="dashboard-counts"]');
  await click('[data-action="open"]');
  assert(w.location.hash.startsWith("#conteo/"));
  assert.equal(doc.querySelector(".steps"), null);
  assert.equal(doc.querySelector(".footer"), null);
  assert.equal(doc.querySelector('[data-action="activity"]'), null);
  assert.equal(doc.getElementById("sap-file"), null);
  assert.equal(doc.getElementById("mb52-file"), null);
  assert.equal(doc.querySelector('[name="responsable"]'), null);
  assert(doc.getElementById("search"));
});
test("live autocomplete completes with Tab; arrows and Enter choose the correct lot and return to a cleared search after adding", async (t) => {
  const { w, doc, click, until } = await demo(t);
  await click('[data-action="open"]');
  await click('[data-action="start"]');
  const search = doc.getElementById("search"),
    type = (value) => {
      search.value = value;
      search.dispatchEvent(new w.Event("input"));
    },
    key = (value) =>
      search.dispatchEvent(
        new w.KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
  type("har");
  assert.equal(search.value, "har");
  assert(
    doc
      .getElementById("search-ghost")
      .textContent.toLowerCase()
      .includes("harina de trigo"),
  );
  assert.equal(search.getAttribute("aria-expanded"), "true");
  assert(doc.querySelector("#results mark"));
  search.setSelectionRange(3, 3);
  key("Tab");
  assert.equal(search.value, "Harina de trigo");
  assert.equal(doc.getElementById("quantity"), null);
  type("773100001");
  key("Enter");
  assert.equal(doc.getElementById("quantity"), null);
  assert(
    doc.getElementById("search-status").textContent.includes("varios lotes"),
  );
  key("ArrowDown");
  assert.equal(search.getAttribute("aria-activedescendant"), "suggestion-1");
  key("Enter");
  assert(
    doc.querySelector(".selected-product").textContent.includes("IMPORTADO"),
  );
  assert.equal(doc.activeElement.id, "quantity");
  doc.getElementById("quantity").value = "2,5";
  doc
    .getElementById("quantity-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.activeElement.id === "search");
  assert.equal(search.value, "");
  assert(doc.getElementById("count-feedback").textContent.includes("2,5"));
  assert(
    doc.getElementById("count-feedback").textContent.includes("IMPORTADO"),
  );
  assert(
    doc.getElementById("count-progress-text").textContent.startsWith("1 de 5"),
  );
  type("zzzzzzsinproducto");
  assert.equal(doc.getElementById("search-popup").hidden, true);
  assert(
    doc.getElementById("search-status").textContent.includes("No encontramos"),
  );
});
