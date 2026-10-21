const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../../tools/postgres-test-setup");
test("joining by token creates one private count per person; optional roles, absences, partial delivery and revocation are enforced by PostgreSQL", async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const q = (sql, args = []) => db.query(sql, args);
  const scalar = async (sql, args = []) =>
    Object.values((await q(sql, args)).rows[0])[0];
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
  const [finance, one, two, responsible, auditor, other, pending] = Array.from(
    { length: 7 },
    () => crypto.randomUUID(),
  );
  for (const [id, role, wh, approved] of [
    [finance, "finanzas", [], true],
    [one, "contador", ["AL04"], true],
    [two, "contador", ["AL04"], true],
    [responsible, "responsable", ["AL04"], true],
    [auditor, "auditor", ["AL04"], true],
    [other, "contador", ["AL05"], true],
    [pending, "contador", ["AL04"], false],
  ]) {
    await q("insert into auth.users(id) values($1)", [id]);
    await q(
      "insert into enjoy_private.members(user_id,name,role,warehouses,approved) values($1,$2,$3,$4,$5)",
      [id, role + " " + id.slice(0, 4), role, wh, approved],
    );
  }
  await login(finance);
  const today = await scalar(
    "select to_char(now() at time zone 'America/Montevideo','YYYY-MM-DD')",
  );
  let pkg = await api("save_inventory", {
    inventory: {
      title: "Equipo",
      warehouse: "AL04",
      procedure: "otro",
      scheduled_date: today,
      status: "ready",
      items: [
        { id: "A", code: "123", lot: "NACIONAL", warehouse: "AL04" },
        { id: "B", code: "123", lot: "IMPORTADO", warehouse: "AL04" },
      ],
      assignments: [
        { user_id: one, actor: "contador", see_stock: false },
        { user_id: responsible, actor: "responsable", counts_enabled: false },
        {
          user_id: auditor,
          actor: "auditor",
          counts_enabled: false,
          absent: true,
        },
      ],
    },
    reference: { A: { stock: 5, value: 100 }, B: { stock: 8, value: 200 } },
  });
  const id = pkg.inventory.id;
  const manage = (action, p = {}) => api(action, { inventory_id: id, ...p });
  pkg = await manage("invitation", { enabled: true });
  const oldToken = pkg.invitation.token;
  pkg = await manage("invitation", { enabled: true, rotate: true });
  const token = pkg.invitation.token;
  assert.notEqual(token, oldToken);
  await login(two);
  await assert.rejects(() => api("join", { token: oldToken }), /disponible/);
  assert.equal((await api("list")).length, 0);
  const preview = await api("join", { token });
  assert.equal(preview.title, "Equipo");
  assert.equal(preview.items, undefined);
  assert.equal(preview.reference, undefined);
  await assert.rejects(() => manage("open"), /autorizado/);
  pkg = await api("join", {
    token,
    confirm: true,
    actor: "finanzas",
    see_stock: true,
    user_id: finance,
  });
  assert.equal(pkg.reference.A, undefined);
  assert.equal(pkg.invitation, null);
  assert.equal(
    pkg.inventory.assignments.find((a) => a.user_id === two).actor,
    "contador",
  );
  assert.equal(
    pkg.inventory.assignments.find((a) => a.user_id === two).see_stock,
    false,
  );
  assert.equal(pkg.counts.length, 0);
  assert.equal(
    (await api("join", { token, confirm: true })).inventory.assignments.filter(
      (a) => a.user_id === two,
    ).length,
    1,
  );
  assert.equal((await api("list"))[0].assigned_to_me, true);
  const event = (uid, actor, action, value, sequence = 1) => ({
    id: crypto.randomUUID(),
    device_id: uid,
    sequence,
    occurred_at: new Date().toISOString(),
    user_id: uid,
    actor,
    action,
    ...(value == null ? {} : { item_id: "A", value }),
  });
  await manage("event", { event: event(two, "contador", "add", 7) });
  await login(one);
  await manage("event", { event: event(one, "contador", "add", 3) });
  const blind = await manage("open");
  assert.equal(blind.counts.length, 1);
  assert.equal(blind.counts[0].quantity, 3);
  assert.equal(blind.counts[0].user_id, one);
  // Partial delivery leaves the other lot uncounted, rather than silently setting it to zero.
  await manage("event", { event: event(one, "contador", "finish", null, 2) });
  assert.equal(
    (await manage("open")).counts.some((c) => c.item_id === "B"),
    false,
  );
  for (const uid of [other, pending]) {
    await login(uid);
    await assert.rejects(
      () => api("join", { token, confirm: true }),
      /almacén|pendiente/,
    );
  }
  await login(responsible);
  await assert.rejects(
    () =>
      manage("event", { event: event(responsible, "responsable", "add", 5) }),
    /no incluye conteo/,
  );
  await login(auditor);
  await assert.rejects(
    () => manage("event", { event: event(auditor, "auditor", "start") }),
    /no incluye conteo/,
  );
  await login(finance);
  const approval = {
    item_id: "A",
    quantity: 3,
    comment: "Conteo de persona uno verificado",
  };
  await assert.rejects(() => manage("approve", approval), /entregarse/);
  pkg = await manage("open");
  assert.equal(pkg.counts.filter((c) => c.item_id === "A").length, 2);
  const original = structuredClone(pkg.inventory);
  pkg.inventory.assignments.find((a) => a.user_id === two).absent = true;
  await assert.rejects(
    () =>
      api("save_inventory", {
        inventory: pkg.inventory,
        reference: pkg.reference,
        version: pkg.inventory.version,
      }),
    /motivo/,
  );
  pkg = await api("save_inventory", {
    inventory: pkg.inventory,
    reference: pkg.reference,
    version: pkg.inventory.version,
    participant_change_reason:
      "Persona dos se retiró; conservar su conteo como referencia",
  });
  const preserve = structuredClone(pkg.inventory);
  preserve.assignments = preserve.assignments.filter((a) => a.user_id !== two);
  await assert.rejects(
    () =>
      api("save_inventory", {
        inventory: preserve,
        reference: pkg.reference,
        version: pkg.inventory.version,
        participant_change_reason: "Eliminar",
      }),
    /Conservá/,
  );
  pkg = await manage("approve", approval);
  assert.equal(pkg.invitation.enabled, false);
  await login(two);
  await assert.rejects(
    () => api("join", { token, confirm: true }),
    /disponible/,
  );
  await assert.rejects(
    () => manage("event", { event: event(two, "contador", "add", 1, 2) }),
    /no incluye conteo/,
  );
  await login(finance);
  await assert.rejects(
    () => manage("invitation", { enabled: true }),
    /revisión/,
  );
  await manage("approve", {
    item_id: "B",
    quantity: 0,
    comment: "Ausencia física del lote importado comprobada por supervisor",
  });
  pkg = await manage("close", { confirmed: true });
  assert.equal(pkg.inventory.status, "closed");
  assert.equal(pkg.counts.length, 2);
  assert.equal(pkg.counts.find((c) => c.user_id === two).quantity, 7);
  assert.equal(
    original.assignments.find((a) => a.user_id === responsible).counts_enabled,
    false,
  );
});
