const fs = require("node:fs"),
  { JSDOM } = require("../../work/node_modules/jsdom"),
  { IDBFactory } = require("../../work/node_modules/fake-indexeddb");
async function until(fn) {
  for (let k = 0; k < 1000; k++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("UI did not become ready");
}
async function demo(t) {
  const dom = new JSDOM(
      fs.readFileSync(require.resolve("../demo.html"), "utf8"),
      {
        url: "https://example.invalid/enjoy/demo",
        runScripts: "outside-only",
        pretendToBeVisual: true,
      },
    ),
    w = dom.window;
  w.structuredClone = structuredClone;
  w.crypto.randomUUID = () => crypto.randomUUID();
  w.indexedDB = new IDBFactory();
  w.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.navigator, "onLine", {
    value: true,
    configurable: true,
  });
  const idle = () =>
    until(
      () =>
        w.document.getElementById("app").getAttribute("aria-busy") !== "true",
    );
  t.after(async () => {
    await idle();
    await new Promise((r) => setTimeout(r, 30));
    w.close();
  });
  for (const f of [
    "../../operaciones/search-engine.js",
    "../core.js",
    "../finder.js",
    "../participants.js",
    "../vendor/qrcode-1.4.4.js",
    "../invitations.js",
    "../demo-client.js",
    "../store.js",
    "../gps.js",
    "../sync.js",
    "../exports.js",
    "../app.js",
  ])
    w.eval(fs.readFileSync(require.resolve(f), "utf8"));
  await until(() => w.document.querySelector('[data-action="open"]'));
  const click = async (selector) => {
    await idle();
    const el = w.document.querySelector(selector);
    if (!el) throw Error("Missing control: " + selector);
    el.click();
    await idle();
  };
  return { w, doc: w.document, click, idle, until };
}
module.exports = { demo, until };
