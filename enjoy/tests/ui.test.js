const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { JSDOM } = require("../../work/node_modules/jsdom"),
  { indexedDB } = require("../../work/node_modules/fake-indexeddb"),
  C = require("../core");
const until = async (fn) => {
  for (let i = 0; i < 1000; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Timed out waiting for UI");
};
test("single-search Enter adds a decimal, returns focus, rejects ambiguous lot, subtracts and survives offline reopening", async (t) => {
  const owner = crypto.randomUUID(),
    id = crypto.randomUUID(),
    item = (lot) => {
      const i = {
        code: "123",
        rawCode: "000123",
        name: "Harina",
        center: "UY01",
        warehouse: "AL04",
        unit: "KG",
        lot,
        barcode: "773",
      };
      return { ...i, id: C.key(i) };
    },
    items = [item("NACIONAL"), item("IMPORTADO")];
  let online = true;
  const profile = {
      user_id: owner,
      name: "Prueba",
      role: "responsable",
      approved: true,
      warehouses: ["AL04"],
    },
    pkg = {
      inventory: {
        id,
        title: "Prueba de conteo",
        status: "ready",
        warehouse: "AL04",
        procedure: "principal",
        scheduled_date: C.today(),
        items,
        assignments: [
          { user_id: owner, actor: "responsable", see_stock: false },
        ],
      },
      counts: [],
      submissions: {},
      reference: {},
      documents: [],
      approvals: {},
      adjustments: [],
      manager: false,
      see_stock: false,
    };
  const dom = new JSDOM(
      fs.readFileSync(require.resolve("../index.html"), "utf8"),
      {
        url: "https://labama.es/enjoy/",
        runScripts: "outside-only",
        pretendToBeVisual: true,
      },
    ),
    w = dom.window;
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 30));
    w.close();
  });
  w.structuredClone = structuredClone;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.indexedDB = indexedDB;
  w.crypto.randomUUID = () => crypto.randomUUID();
  Object.defineProperty(w.navigator, "onLine", { get: () => online });
  w.EnjoyGPS = {
    stop() {},
    get() {
      return { state: "Sin permiso", fix: null };
    },
    start() {},
  };
  w.sessionStorage.setItem("empresa_nombre", "ENJOY");
  w.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({
          data: {
            session: { user: { id: owner, email: "test@example.invalid" } },
          },
        }),
      },
      rpc: async (name, { p_action }) => ({
        data:
          p_action === "profile"
            ? profile
            : p_action === "list"
              ? [pkg.inventory]
              : p_action === "members"
                ? [profile]
                : structuredClone(pkg),
        error: null,
      }),
    }),
  };
  for (const f of [
    "../../operaciones/search-engine.js",
    "../core.js",
    "../store.js",
    "../sync.js",
    "../exports.js",
    "../app.js",
  ])
    w.eval(fs.readFileSync(require.resolve(f), "utf8"));
  await until(() => w.document.querySelector('[data-action="open"]'));
  online = false;
  await w.EnjoyStore.savePackage(owner, pkg);
  await until(
    () => w.document.getElementById("app").getAttribute("aria-busy") !== "true",
  );
  w.document.querySelector('[data-action="open"]').click();
  await until(() => w.document.querySelector('[data-action="start"]'));
  await until(
    () => w.document.getElementById("app").getAttribute("aria-busy") !== "true",
  );
  w.document.querySelector('[data-action="start"]').click();
  await until(
    () =>
      w.document.getElementById("search") &&
      !w.document.getElementById("search").disabled,
  );
  const search = w.document.getElementById("search");
  search.value = "123";
  search.dispatchEvent(new w.Event("input"));
  search.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.equal(
    w.document.getElementById("quantity"),
    null,
    "must disambiguate national/imported lots",
  );
  w.document.querySelector('[data-result="0"]').click();
  assert.equal(w.document.activeElement.id, "quantity");
  w.document.getElementById("quantity").value = "9,952";
  w.document
    .getElementById("quantity-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => w.document.activeElement.id === "search");
  let saved = await w.EnjoyStore.get("packages", owner + "|" + id);
  assert.equal(saved.counts[0].quantity, 9.952);
  assert.equal(search.value, "");
  w.document.querySelector('[data-action="correct"]').click();
  await until(() => w.document.getElementById("correction-form"));
  const form = w.document.getElementById("correction-form");
  form.elements.namedItem("value").value = "0,002";
  form.dispatchEvent(
    new w.Event("submit", { bubbles: true, cancelable: true }),
  );
  await until(() => w.document.activeElement.id === "search");
  saved = await w.EnjoyStore.get("packages", owner + "|" + id);
  assert.equal(saved.counts[0].quantity, 9.95);
  assert.equal((await w.EnjoyStore.events(owner, id)).length, 3);
  assert.deepEqual(Object.keys(saved.reference), []);
  await until(() => !w.document.getElementById("home").disabled);
  w.document.getElementById("home").click();
  await until(() => w.document.querySelector('[data-action="open"]'));
  await until(
    () => w.document.getElementById("app").getAttribute("aria-busy") !== "true",
  );
  w.document.querySelector('[data-action="open"]').click();
  await until(() => w.document.getElementById("count-table"));
  assert(w.document.getElementById("count-table").textContent.includes("9,95"));
  await until(
    () => w.document.getElementById("app").getAttribute("aria-busy") !== "true",
  );
});
