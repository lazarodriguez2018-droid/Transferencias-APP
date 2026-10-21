const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID: uuid } = require("node:crypto"),
  { createDatabase } = require("../../tools/postgres-test-setup");
test("Enjoy authorization, independent counts, blind packages and idempotent offline replay", async () => {
  const db = await createDatabase();
  const q = async (s, a = []) => (await db.query(s, a)).rows,
    scalar = async (s, a = []) => Object.values((await q(s, a))[0])[0];
  const login = async (id) => {
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec("set role authenticated");
  };
  const api = (action, p = {}) =>
    scalar("select public.enjoy_api($1,$2::jsonb)", [
      action,
      JSON.stringify(p),
    ]);
  const finance = uuid(),
    counter = uuid(),
    auditor = uuid(),
    other = uuid(),
    pending = uuid(),
    sup = uuid();
  for (const [id, role, approved, warehouses] of [
    [finance, "finanzas", true, []],
    [counter, "responsable", true, ["AL04"]],
    [auditor, "auditor", true, ["AL04"]],
    [other, "responsable", true, ["AL05"]],
    [pending, "responsable", false, ["AL04"]],
    [sup, "supervisor", true, ["AL05"]],
  ]) {
    await q("insert into auth.users(id) values($1)", [id]);
    await q(
      "insert into enjoy_private.members(user_id,name,role,approved,warehouses) values($1,$2,$3,$4,$5)",
      [id, role, role, approved, warehouses],
    );
  }
  const legacy = uuid();
  await q("insert into auth.users(id) values($1)", [legacy]);
  await q(
    "insert into public.perfiles(id,nombre,apellido,local_nombre,almacen,role,approved) values($1,'Legacy','Prueba','PDE','00','empleado',true)",
    [legacy],
  );
  await q(
    "insert into public.productos(nombre,codigo) values('Producto SUCAN de prueba','SECRET-SUCAN')",
  );
  await login(legacy);
  assert.equal(await scalar("select count(*) from public.productos"), 1);
  await db.exec("reset role");
  const today = await scalar(
      "select to_char(now() at time zone 'America/Montevideo','YYYY-MM-DD')",
    ),
    items = [
      { id: "N", code: "123", lot: "NACIONAL", warehouse: "AL04", unit: "KG" },
      { id: "I", code: "123", lot: "IMPORTADO", warehouse: "AL04", unit: "KG" },
    ];
  await login(finance);
  const draft = {
    title: "Principal",
    warehouse: "AL04",
    procedure: "principal",
    scheduled_date: today,
    mb52_date: today,
    sap_blocked: true,
    status: "ready",
    items,
    assignments: [
      { user_id: counter, actor: "responsable", see_stock: false },
      { user_id: auditor, actor: "auditor", see_stock: true },
    ],
  };
  let pkg = await api("save_inventory", {
      inventory: draft,
      reference: { N: { stock: 5, value: 50 }, I: { stock: 8, value: 80 } },
    }),
    id = pkg.inventory.id;
  assert.equal(pkg.manager, true);
  assert.equal((await api("list"))[0].assigned_to_me, false);
  await login(counter);
  assert.equal((await api("list"))[0].assigned_to_me, true);
  let blind = await api("open", { inventory_id: id });
  assert.deepEqual(blind.reference, {});
  assert.deepEqual(blind.documents, []);
  assert.equal(blind.see_stock, false);
  assert.equal(blind.counts.length, 0);
  await assert.rejects(
    () =>
      api("approve", {
        inventory_id: id,
        item_id: "N",
        quantity: 1,
        comment: "x",
      }),
    /gestión/,
  );
  await assert.rejects(
    () =>
      api("save_member", {
        user_id: counter,
        approved: true,
        role: "finanzas",
      }),
    /Finanzas/,
  );
  assert.equal(await scalar("select count(*) from public.productos"), 0);
  await assert.rejects(
    () => scalar("select count(*) from enjoy_private.inventories"),
    /permission denied/,
  );
  let sequence = 0;
  const event = (action, item, value, extra = {}) => ({
    id: uuid(),
    device_id: "phone",
    sequence: ++sequence,
    occurred_at: new Date().toISOString(),
    actor: "responsable",
    user_id: counter,
    action,
    ...(item ? { item_id: item, value } : {}),
    ...extra,
  });
  const send = (e) => api("event", { inventory_id: id, event: e }),
    a = event("add", "N", 9.95);
  await send(a);
  assert.equal((await send(a)).duplicate, true);
  assert.deepEqual(
    (await api("open", { inventory_id: id, pending_ids: [a.id] })).receipts,
    [a.id],
  );
  await send(event("add", "N", 0.002));
  await send(event("set", "I", 0, { base_version: 0 }));
  blind = await api("open", { inventory_id: id });
  assert.equal(blind.counts.find((c) => c.item_id === "N").quantity, 9.952);
  assert.equal(blind.counts.find((c) => c.item_id === "I").quantity, 0);
  await assert.rejects(
    () => send(event("set", "N", 3, { base_version: 0 })),
    /CONFLICTO/,
  );
  await assert.rejects(() => send(event("subtract", "I", 1)), /negativo/);
  await send(event("finish"));
  await assert.rejects(() => send(event("add", "N", 1)), /entregado/);
  await login(auditor);
  pkg = await api("open", { inventory_id: id });
  assert.equal(pkg.reference.N.stock, 5);
  assert.equal(pkg.counts.length, 0);
  const ae = event("add", "N", 5, {
    actor: "auditor",
    user_id: auditor,
    device_id: "audit",
  });
  await send(ae);
  pkg = await api("open", { inventory_id: id });
  assert.equal(pkg.counts.length, 1);
  assert.equal(pkg.counts[0].quantity, 5);
  for (const uid of [pending, other, sup]) {
    await login(uid);
    await assert.rejects(
      () => api("open", { inventory_id: id }),
      /pendiente|autorizado/,
    );
  }
  await login(auditor);
  await send(
    event("set", "I", 0, {
      actor: "auditor",
      user_id: auditor,
      device_id: "audit",
      base_version: 0,
    }),
  );
  await send(
    event("finish", null, null, {
      actor: "auditor",
      user_id: auditor,
      device_id: "audit",
    }),
  );
  await login(finance);
  pkg = await api("open", { inventory_id: id });
  assert.equal(pkg.counts.length, 4);
  await api("approve", {
    inventory_id: id,
    item_id: "N",
    quantity: 9.952,
    reason: "Error de balanza",
    comment: "Conteo verificado",
  });
  await api("approve", {
    inventory_id: id,
    item_id: "I",
    quantity: 0,
    reason: "Cuadra",
    comment: "Verificado",
  });
  await assert.rejects(
    () => api("close", { inventory_id: id, confirmed: true }),
    /Reporte SAP/,
  );
  await api("document", {
    inventory_id: id,
    document: { kind: "csv_2", name: "sample.csv", documents: ["100000860"] },
  });
  await api("document", {
    inventory_id: id,
    document: { kind: "reporte", name: "r.xlsx" },
    report: {
      warehouses: ["AL04"],
      documents: ["100000860"],
      items: [],
      totals: {},
    },
  });
  await login(counter);
  await assert.rejects(
    () =>
      api("document", {
        inventory_id: id,
        document: { kind: "evidencia", name: "x" },
      }),
    /gestión/,
  );
  const activity = await api("activity", { inventory_id: id });
  assert(activity.every((e) => e.user_id === counter));
  await login(finance);
  await api("reopen", {
    inventory_id: id,
    assignment: counter + ":responsable",
  });
  await login(counter);
  await send(event("add", "N", 0.048));
  assert.equal(
    (await api("open", { inventory_id: id })).counts.find(
      (c) => c.item_id === "N",
    ).quantity,
    10,
  );
  await send(event("finish"));
  await login(finance);
  await api("approve_many", {
    inventory_id: id,
    approvals: [
      {
        item_id: "N",
        quantity: 10,
        reason: "Error de balanza",
        comment: "Verificado",
      },
      { item_id: "I", quantity: 0, reason: "Cuadra", comment: "Verificado" },
    ],
  });
  await api("document", {
    inventory_id: id,
    document: { kind: "reporte", name: "r2.xlsx" },
    report: {
      warehouses: ["AL04"],
      documents: ["0100000860"],
      items: [],
      totals: {},
    },
  });
  const closed = await api("close", { inventory_id: id, confirmed: true });
  assert.equal(closed.inventory.status, "closed");
  await api("adjustments", {
    inventory_id: id,
    adjustments: [{ quantity: 5, executed: false }],
  });
  await assert.rejects(
    () => api("adjustments", { inventory_id: id, adjustments: [] }),
    /historial/,
  );
  await login(counter);
  await assert.rejects(() => send(event("add", "N", 1)), /no admite/);
  await db.exec("reset role");
  const signup = uuid();
  await q(
    "insert into auth.users(id,raw_user_meta_data) values($1,$2::jsonb)",
    [
      signup,
      JSON.stringify({
        company: "ENJOY",
        name: "Pending",
        role: "finanzas",
        approved: true,
      }),
    ],
  );
  assert.equal(
    await scalar(
      "select approved from enjoy_private.members where user_id=$1",
      [signup],
    ),
    false,
  );
  await login(signup);
  await assert.rejects(() => api("list"), /pendiente/);
  await db.exec("reset role");
  await db.exec("set role anon");
  await assert.rejects(() => api("profile"), /permission denied/);
  await db.close();
});
