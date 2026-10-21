const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { JSDOM } = require("../../work/node_modules/jsdom"),
  fs = require("node:fs"),
  { indexedDB } = require("../../work/node_modules/fake-indexeddb");
test("review demo has fictional data, separate browser storage and no GPS permission request", async () => {
  const dom = new JSDOM(
      fs.readFileSync(require.resolve("../demo.html"), "utf8"),
      { url: "https://example.invalid/enjoy/demo", runScripts: "outside-only" },
    ),
    w = dom.window;
  w.structuredClone = structuredClone;
  w.crypto.randomUUID = () => crypto.randomUUID();
  w.indexedDB = indexedDB;
  w.navigator.geolocation = {
    watchPosition() {
      throw Error("Demo must not request location");
    },
  };
  for (const file of ["core.js", "demo-client.js", "store.js", "gps.js"])
    w.eval(fs.readFileSync(require.resolve("../" + file), "utf8"));
  const { data: profile } = await w.EnjoyDemo.client.rpc("enjoy_api", {
    p_action: "profile",
    p_payload: {},
  });
  assert.equal(profile.name, "Equipo de demostración");
  const { data: list } = await w.EnjoyDemo.client.rpc("enjoy_api", {
    p_action: "list",
    p_payload: {},
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].items.length, 5);
  assert.equal(list[0].items[0].code, list[0].items[1].code);
  assert.notEqual(list[0].items[0].lot, list[0].items[1].lot);
  assert.equal(w.localStorage.getItem("enjoy_identity"), null);
  const db = await w.EnjoyStore.open();
  assert.equal(db.name, "labama_enjoy_demo_v1");
  w.EnjoyGPS.start();
  assert.equal(w.EnjoyGPS.get().fix, null);
  db.close();
  w.close();
});
