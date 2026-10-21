const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { demo } = require("./ui-helpers");
const P = require("../participants");
test("several people keep distinct columns; observing and absent participants do not owe a count", () => {
  const assignments = [
    { user_id: "a", actor: "contador", name: "Alex" },
    { user_id: "b", actor: "contador", name: "Alex" },
    { user_id: "c", actor: "responsable", counts_enabled: false },
    { user_id: "d", actor: "auditor", absent: true },
  ];
  const pkg = {
    inventory: { assignments },
    counts: [{ user_id: "d", actor: "auditor", item_id: "A", quantity: 1 }],
    submissions: {
      "a:contador": { submitted: true },
      "b:contador": { submitted: true },
    },
  };
  assert.equal(P.delivered(pkg), true);
  assert.equal(
    P.columns(pkg).length,
    3,
    "an absent participant’s existing work remains available",
  );
  assert.equal(P.state(pkg, assignments[2]), "Participa sin contar");
  assert.equal(P.state(pkg, assignments[3]), "Ausente");
});
test("configuration shows a list of people with independent role and participation choices, plus a usable link/QR", async (t) => {
  const { w, doc, click } = await demo(t);
  await click('[data-action="dashboard-admin"]');
  await click('[data-action="open-configure"]');
  await click('[data-step="2"]');
  const rows = [...doc.querySelectorAll("[data-participant]")];
  assert.equal(rows.length, 4);
  assert.equal(
    rows.filter(
      (r) => r.querySelector('[data-field="actor"]').value === "contador",
    ).length,
    2,
  );
  const resp = rows.find(
    (r) => r.querySelector('[data-field="actor"]').value === "responsable",
  );
  assert.equal(
    resp.querySelector('[data-field="participation"]').value,
    "observe",
  );
  const audit = rows.find(
    (r) => r.querySelector('[data-field="actor"]').value === "auditor",
  );
  assert.equal(
    audit.querySelector('[data-field="participation"]').value,
    "absent",
  );
  const link = doc.getElementById("invitation-link").value;
  assert(link.includes("/enjoy/demo#unirse/"));
  assert(doc.querySelector("#invitation-qr svg"));
  await click('[data-action="rotate-invitation"]');
  assert.notEqual(doc.getElementById("invitation-link").value, link);
  await click('[data-action="toggle-invitation"]');
  assert.equal(doc.getElementById("invitation-link"), null);
  assert.equal(doc.getElementById("search"), null);
});
test("a person joins with their own identity and can deliver a partial count without overwriting another person", async (t) => {
  const { w, doc, click, until, idle } = await demo(t);
  const api = async (action, p = {}) => {
    const r = await w.EnjoyDemo.client.rpc("enjoy_api", {
      p_action: action,
      p_payload: p,
    });
    if (r.error) throw Error(r.error.message);
    return r.data;
  };
  const original = (await api("list"))[0];
  const other = original.assignments.find((a) => a.name.startsWith("Ana"));
  const inv = structuredClone(original);
  delete inv.id;
  inv.assignments = [other];
  inv.title = "Ingresar por QR";
  const created = await api("save_inventory", {
    inventory: inv,
    reference: {},
  });
  const id = created.inventory.id,
    invite = await api("invitation", { inventory_id: id, enabled: true });
  w.history.pushState(null, "", "#unirse/" + invite.invitation.token);
  w.dispatchEvent(new w.PopStateEvent("popstate"));
  await until(() => doc.querySelector('[data-action="confirm-join"]'));
  await idle();
  assert(
    doc
      .getElementById("join-info")
      .textContent.includes("Equipo de demostración"),
  );
  await click('[data-action="confirm-join"]');
  assert.equal(doc.querySelector(".countbar h2").textContent, "Mi conteo");
  assert.equal(doc.getElementById("actor-select"), null);
  await click('[data-action="start"]');
  const search = doc.getElementById("search");
  search.value = "11000002";
  search.dispatchEvent(new w.Event("input"));
  search.dispatchEvent(
    new w.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  doc.getElementById("quantity").value = "4";
  doc
    .getElementById("quantity-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.activeElement.id === "search");
  await click('[data-action="finish"]');
  assert(
    doc
      .getElementById("quantity-area")
      .textContent.includes("No se convertirán en cero"),
  );
  await click('[data-action="confirm-finish"]');
  await until(async () => {
    const p = await api("open", { inventory_id: id });
    return Object.values(p.submissions).some((s) => s.submitted);
  });
  const pkg = await api("open", { inventory_id: id });
  assert.equal(pkg.counts.length, 1);
  assert.equal(pkg.counts[0].quantity, 4);
  assert.notEqual(pkg.counts[0].user_id, other.user_id);
  assert.equal(
    pkg.inventory.assignments.filter((a) => a.user_id === pkg.counts[0].user_id)
      .length,
    1,
  );
  assert.equal(
    pkg.counts.filter((c) => c.item_id === inv.items[0].id).length,
    0,
  );
});
test("QR independently decodes to the inventory invitation URL", async (t) => {
  const { w } = await demo(t),
    jsQR = require("../../work/node_modules/jsqr");
  let built;
  const generator = w.qrcode;
  w.qrcode = (...args) => (built = generator(...args));
  const url = w.EnjoyInvitations.url("abcdef00-0000-4000-9000-123456789abc"),
    svg = w.EnjoyInvitations.svg(url);
  assert(svg.includes("<svg"));
  assert(svg.includes("<path"));
  const scale = 6,
    margin = 4,
    n = built.getModuleCount(),
    width = (n + 2 * margin) * scale,
    rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const r = Math.floor(y / scale) - margin,
        c = Math.floor(x / scale) - margin;
      if (r >= 0 && c >= 0 && r < n && c < n && built.isDark(r, c)) {
        const k = (y * width + x) * 4;
        rgba[k] = rgba[k + 1] = rgba[k + 2] = 0;
      }
    }
  assert.equal(jsQR(rgba, width, width).data, url);
});
