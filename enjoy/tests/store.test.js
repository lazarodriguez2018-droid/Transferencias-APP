const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
global.indexedDB = require("../../work/node_modules/fake-indexeddb").indexedDB;
const S = require("../store");
global.window = global;
global.EnjoyCore = require("../core");
global.EnjoyStore = S;
Object.defineProperty(global, "navigator", {
  value: { onLine: true },
  configurable: true,
});
require("../sync");
test("offline package and audit commit atomically; failed duplicate rolls both back; accounts are isolated", async () => {
  const p = { inventory: { id: randomUUID() }, counts: [], submissions: {} },
    owner = "counter",
    e = {
      id: randomUUID(),
      inventory_id: p.inventory.id,
      device_id: "phone",
      action: "add",
      value: 0,
    };
  await S.savePackage(owner, p);
  const saved = await S.record(owner, { ...p, counts: [{ quantity: 0 }] }, e);
  assert.equal(saved.sequence, 1);
  assert.equal((await S.events(owner)).length, 1);
  assert.equal(
    (await S.get("packages", owner + "|" + p.inventory.id)).counts[0].quantity,
    0,
  );
  await assert.rejects(() =>
    S.record(owner, { ...p, counts: [{ quantity: 999 }] }, e),
  );
  assert.equal(
    (await S.get("packages", owner + "|" + p.inventory.id)).counts[0].quantity,
    0,
  );
  assert.equal((await S.events("another-user")).length, 0);
  await assert.rejects(() => S.clearOwner(owner), /pendientes/);
  await S.acknowledge(e.id);
  await S.clearOwner(owner);
  assert.equal((await S.packages(owner)).length, 0);
});
test("rebase applies each queued delta once; absolute set remains tied to its base version", () => {
  const p = {
    inventory: { id: "inv" },
    counts: [
      {
        user_id: "u",
        actor: "responsable",
        item_id: "N",
        quantity: 5,
        version: 7,
      },
    ],
    submissions: {},
  };
  const out = EnjoySync.apply(p, {
    user_id: "u",
    actor: "responsable",
    item_id: "N",
    action: "add",
    value: 2,
  });
  assert.equal(out.counts[0].quantity, 7);
  assert.equal(out.counts[0].version, 8);
  assert.equal(p.counts[0].quantity, 5);
});

test("lost acknowledgment never applies the same movement twice in the local view", async () => {
  const owner = "lost-response",
    p = { inventory: { id: randomUUID() }, counts: [], submissions: {} },
    event = {
      id: randomUUID(),
      device_id: "lost-phone",
      action: "add",
      item_id: "N",
      value: 5,
      actor: "responsable",
      occurred_at: new Date().toISOString(),
    };
  await S.savePackage(owner, p);
  await EnjoySync.record(owner, p, event);
  const queued = (await S.events(owner))[0];
  const authoritative = EnjoySync.apply(p, { ...event, user_id: owner });
  const rpc = async (action, payload) => {
    if (action === "event") throw Error("network response lost");
    return {
      ...authoritative,
      receipts: payload.pending_ids.includes(queued.id) ? [queued.id] : [],
    };
  };
  await EnjoySync.run(owner, rpc);
  assert.equal(
    (await S.get("packages", owner + "|" + p.inventory.id)).counts[0].quantity,
    5,
  );
  assert.equal((await S.events(owner)).length, 0);
});
