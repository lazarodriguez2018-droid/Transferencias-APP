(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EnjoyStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  let connection;
  function open() {
    return (connection ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(
        globalThis.EnjoyDemo ? "labama_enjoy_demo_v1" : "labama_enjoy_v1",
        2,
      );
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("packages"))
          db.createObjectStore("packages", { keyPath: "cacheKey" });
        if (!db.objectStoreNames.contains("events")) {
          const s = db.createObjectStore("events", { keyPath: "id" });
          s.createIndex("owner", "owner");
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  async function transaction(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try {
        result = fn(tx);
      } catch (e) {
        tx.abort();
        reject(e);
        return;
      }
      tx.oncomplete = () =>
        resolve(typeof result === "function" ? result() : result);
      tx.onerror = () => reject(tx.error || Error("No se pudo guardar"));
      tx.onabort = () => reject(tx.error || Error("Guardado cancelado"));
    });
  }
  async function get(store, id) {
    let value;
    await transaction([store], "readonly", (tx) => {
      const r = tx.objectStore(store).get(id);
      r.onsuccess = () => (value = r.result);
    });
    return value;
  }
  async function packages(owner) {
    let values = [];
    await transaction(["packages"], "readonly", (tx) => {
      const r = tx.objectStore("packages").getAll();
      r.onsuccess = () => (values = r.result.filter((x) => x.owner === owner));
    });
    return values;
  }
  async function events(owner, inventory) {
    let values = [];
    await transaction(["events"], "readonly", (tx) => {
      const r = tx.objectStore("events").index("owner").getAll(owner);
      r.onsuccess = () =>
        (values = r.result
          .filter((x) => !inventory || x.inventory_id === inventory)
          .sort((a, b) => a.sequence - b.sequence));
    });
    return values;
  }
  async function savePackage(owner, pkg) {
    await transaction(["packages"], "readwrite", (tx) =>
      tx
        .objectStore("packages")
        .put({ ...pkg, owner, cacheKey: owner + "|" + pkg.inventory.id }),
    );
  }
  // Quantity, device sequence and immutable audit event commit atomically.
  async function record(owner, pkg, event) {
    let recorded;
    await transaction(["packages", "events", "meta"], "readwrite", (tx) => {
      const meta = tx.objectStore("meta"),
        r = meta.get(event.device_id);
      r.onsuccess = () => {
        const sequence = (r.result || 0) + 1;
        recorded = { ...event, sequence };
        meta.put(sequence, event.device_id);
        tx.objectStore("packages").put({
          ...pkg,
          owner,
          cacheKey: owner + "|" + pkg.inventory.id,
        });
        tx.objectStore("events").add({ ...recorded, owner, status: "pending" });
      };
    });
    return recorded;
  }
  async function acknowledge(id) {
    await transaction(["events"], "readwrite", (tx) =>
      tx.objectStore("events").delete(id),
    );
  }
  async function flag(id, error) {
    const e = await get("events", id);
    if (e)
      await transaction(["events"], "readwrite", (tx) =>
        tx.objectStore("events").put({ ...e, status: "conflict", error }),
      );
  }
  async function clearOwner(owner) {
    const list = await packages(owner),
      pending = await events(owner);
    if (pending.length)
      throw Error("Hay movimientos pendientes. Sincronizá antes de salir.");
    await transaction(["packages"], "readwrite", (tx) =>
      list.forEach((p) => tx.objectStore("packages").delete(p.cacheKey)),
    );
  }
  return {
    open,
    get,
    packages,
    events,
    savePackage,
    record,
    acknowledge,
    flag,
    clearOwner,
  };
});
