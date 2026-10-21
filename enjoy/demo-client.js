/* Isolated, fictional preview. It never calls Supabase, SAP or GPS. */
(function (root) {
  "use strict";
  const C = root.EnjoyCore,
    KEY = "enjoy_demo_data_v2";
  let state;
  try {
    state = JSON.parse(localStorage.getItem(KEY));
  } catch {}
  const clone = structuredClone;
  if (!state) {
    const uid = crypto.randomUUID(),
      id = crypto.randomUUID(),
      second = crypto.randomUUID(),
      responsible = crypto.randomUUID(),
      auditor = crypto.randomUUID(),
      now = new Date().toISOString(),
      items = [
        [
          "11000001",
          "Harina de trigo",
          "KG",
          "NACIONAL",
          "773100001",
          12.5,
          625,
        ],
        ["11000001", "Harina de trigo", "KG", "IMPORTADO", "773100001", 8, 560],
        ["11000002", "Aceite de girasol", "L", "", "773100002", 24, 2400],
        ["11000003", "Arroz largo fino", "KG", "", "773100003", 40, 1800],
        ["11000004", "Sal fina", "KG", "", "773100004", 10, 180],
      ].map(([code, name, unit, lot, barcode, stock, value]) => {
        const i = {
          code,
          rawCode: code.padStart(18, "0"),
          name,
          unit,
          lot,
          barcode,
          center: "UY01",
          warehouse: "AL04",
        };
        i.id = C.key(i);
        return { ...i, _stock: stock, _value: value };
      }),
      reference = Object.fromEntries(
        items.map((i) => [i.id, { stock: i._stock, value: i._value }]),
      );
    items.forEach((i) => {
      delete i._stock;
      delete i._value;
    });
    const doc = "0100000001",
      csv =
        "Centro:;UY01\r\nAlm.:;AL04\r\nFecha Conteo:;\r\nFecha Ing.:;\r\nDoc.Invent.(MI04);Posición;Código;Unidad;Descripción;Lote;Q.Física\r\n" +
        items
          .map((i, k) =>
            [doc, k + 1, i.rawCode, i.unit, i.name, i.lot, ""].join(";"),
          )
          .join("\r\n") +
        "\r\n";
    const pkg = {
      inventory: {
        id,
        version: 1,
        title: "Inventario principal · Ejemplo Enjoy",
        warehouse: "AL04",
        scheduled_date: C.today(),
        mb52_date: C.today(),
        sap_blocked: true,
        procedure: "principal",
        status: "ready",
        items,
        management_notes: "Ejemplo para revisar el recorrido de las pantallas.",
        assignments: [
          {
            user_id: uid,
            name: "Equipo de demostración",
            actor: "contador",
            counts_enabled: true,
            absent: false,
            see_stock: false,
          },
          {
            user_id: second,
            name: "Ana · Ejemplo",
            actor: "contador",
            counts_enabled: true,
            absent: false,
            see_stock: false,
          },
          {
            user_id: responsible,
            name: "Diego · Ejemplo",
            actor: "responsable",
            counts_enabled: false,
            absent: false,
            see_stock: false,
          },
          {
            user_id: auditor,
            name: "Sofía · Ejemplo",
            actor: "auditor",
            counts_enabled: false,
            absent: true,
            see_stock: true,
          },
        ],
      },
      counts: items.map((i) => ({
        user_id: second,
        item_id: i.id,
        actor: "contador",
        quantity: reference[i.id].stock,
        version: 1,
      })),
      reference,
      approvals: {},
      documents: [
        {
          kind: "csv",
          name: "Plantilla_EJEMPLO.csv",
          sap: C.parseSap(csv),
          documents: [doc],
          at: now,
        },
      ],
      adjustments: [],
      submissions: { [second + ":contador"]: { submitted: true, at: now } },
      invitation: { token: crypto.randomUUID(), enabled: true },
      manager: true,
      see_stock: true,
      downloaded_at: now,
    };
    state = {
      uid,
      profile: {
        user_id: uid,
        name: "Equipo de demostración",
        role: "finanzas",
        approved: true,
        can_manage: true,
        warehouses: C.MAIN,
      },
      members: [
        {
          user_id: second,
          name: "Ana · Ejemplo",
          role: "contador",
          approved: true,
          warehouses: ["AL04"],
        },
        {
          user_id: responsible,
          name: "Diego · Ejemplo",
          role: "responsable",
          approved: true,
          warehouses: ["AL04"],
        },
        {
          user_id: auditor,
          name: "Sofía · Ejemplo",
          role: "auditor",
          approved: true,
          warehouses: ["AL04"],
        },
      ],
      inventories: [pkg],
      events: [],
    };
    save();
  }
  const files = new Map();
  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
  }
  function find(id) {
    const p = state.inventories.find((p) => p.inventory.id === id);
    if (!p) throw Error("Inventario no disponible");
    return p;
  }
  async function api(action, p) {
    if (action === "profile" || action === "request_access")
      return clone(state.profile);
    if (action === "members") return clone([state.profile, ...state.members]);
    if (action === "list")
      return state.inventories.map((p) => clone(p.inventory));
    if (action === "save_member") return { ok: true };
    if (action === "join") {
      const x = state.inventories.find((x) => x.invitation?.token === p.token);
      if (
        !x ||
        !x.invitation.enabled ||
        x.inventory.status === "closed" ||
        x.inventory.status === "draft"
      )
        throw Error("El enlace no está disponible");
      if (p.confirm) {
        if (!x.inventory.assignments.some((a) => a.user_id === state.uid)) {
          x.inventory.assignments.push({
            user_id: state.uid,
            name: state.profile.name,
            actor: "contador",
            counts_enabled: true,
            absent: false,
            see_stock: false,
          });
          x.inventory.version++;
          save();
        }
        return clone(x);
      }
      const { id, title, warehouse, scheduled_date } = x.inventory;
      return { id, title, warehouse, scheduled_date };
    }
    if (action === "save_inventory") {
      let x = p.inventory.id ? find(p.inventory.id) : null;
      if (!p.inventory.title.trim()) throw Error("Completá el nombre");
      if (!x) {
        x = {
          inventory: {},
          counts: [],
          reference: {},
          approvals: {},
          documents: [],
          adjustments: [],
          submissions: {},
          manager: true,
          see_stock: true,
          invitation: { enabled: false, token: crypto.randomUUID() },
        };
        state.inventories.push(x);
      }
      if (
        x.inventory.assignments &&
        JSON.stringify(x.inventory.assignments) !==
          JSON.stringify(p.inventory.assignments)
      ) {
        x.approvals = {};
        x.report = null;
      }
      x.inventory = {
        ...clone(p.inventory),
        id: p.inventory.id || crypto.randomUUID(),
        version: (x.inventory.version || 0) + 1,
      };
      x.reference = clone(p.reference);
      save();
      return clone(x);
    }
    const x = find(p.inventory_id);
    if (action === "open")
      return {
        ...clone(x),
        receipts: state.events
          .filter((e) => (p.pending_ids || []).includes(e.id))
          .map((e) => e.id),
      };
    if (action === "activity")
      return clone(
        state.events.filter((e) => e.inventory_id === p.inventory_id).reverse(),
      );
    if (action === "event") {
      const e = p.event;
      if (state.events.some((v) => v.id === e.id))
        return { ok: true, duplicate: true };
      if (x.inventory.status !== "ready")
        throw Error("El inventario no admite movimientos");
      if (x.submissions[state.uid + ":" + e.actor]?.submitted)
        throw Error("Conteo entregado");
      const assignment = x.inventory.assignments.find(
        (a) => a.user_id === state.uid && a.actor === e.actor,
      );
      if (!root.EnjoyParticipants.counts(assignment))
        throw Error("Tu participación no incluye conteo");
      let row = x.counts.find(
        (c) =>
          c.user_id === state.uid &&
          c.item_id === e.item_id &&
          c.actor === e.actor,
      );
      const before = row?.quantity ?? null;
      if (["add", "subtract", "set"].includes(e.action)) {
        if (e.action === "set" && (row?.version || 0) !== e.base_version)
          throw Error("CONFLICTO: revisá el total");
        const qty = C.quantity(row?.quantity, e.action, e.value);
        if (!row) {
          row = {
            user_id: state.uid,
            item_id: e.item_id,
            actor: e.actor,
            version: 0,
          };
          x.counts.push(row);
        }
        row.quantity = qty;
        row.version++;
      }
      if (e.action === "finish") {
        if (
          !x.counts.some((c) => c.user_id === state.uid && c.actor === e.actor)
        )
          throw Error("Registrá al menos un producto");
        x.submissions[state.uid + ":" + e.actor] = {
          submitted: true,
          at: new Date().toISOString(),
        };
      }
      x.started = true;
      state.events.push({
        ...clone(e),
        inventory_id: p.inventory_id,
        user_id: state.uid,
        name: state.profile.name,
        client_sequence: e.sequence,
        received_at: new Date().toISOString(),
        before_quantity: before,
        after_quantity: row?.quantity ?? null,
        payload: clone(e),
      });
      save();
      return { ok: true };
    }
    if (action === "discard_event") {
      state.events.push({
        ...clone(p.event),
        action: "discarded",
        payload: { original: p.event, reason: p.reason },
        received_at: new Date().toISOString(),
        name: state.profile.name,
      });
      save();
      return { ok: true };
    }
    if (action === "invitation") {
      if (p.enabled && (Object.keys(x.approvals).length || x.report))
        throw Error("La revisión de cantidades ya comenzó");
      x.invitation.enabled = !!p.enabled;
      if (p.rotate) x.invitation.token = crypto.randomUUID();
    } else if (["approve", "approve_many"].includes(action)) {
      if (!root.EnjoyParticipants.delivered(x))
        throw Error("Primero deben entregarse los conteos");
      x.invitation.enabled = false;
      for (const a of action === "approve" ? [p] : p.approvals)
        x.approvals[a.item_id] = {
          quantity: C.number(a.quantity),
          reason: a.reason,
          comment: a.comment,
          user_id: state.uid,
          at: new Date().toISOString(),
        };
    } else if (action === "reopen") {
      delete x.submissions[p.assignment];
      x.approvals = {};
      x.report = null;
    } else if (action === "late_sync") x.inventory.allow_late_sync = p.enabled;
    else if (action === "document") {
      x.documents.push({ ...clone(p.document), at: new Date().toISOString() });
      if (p.report) x.report = clone(p.report);
    } else if (action === "adjustments") x.adjustments = clone(p.adjustments);
    else if (action === "close") {
      if (Object.keys(x.approvals).length !== x.inventory.items.length)
        throw Error("Faltan cantidades autorizadas");
      if (x.inventory.procedure === "principal" && !x.report)
        throw Error("Falta incorporar el Reporte SAP");
      if (!root.EnjoyParticipants.delivered(x))
        throw Error("Faltan conteos entregados");
      x.invitation.enabled = false;
      x.inventory.status = "closed";
      x.inventory.closed_at = new Date().toISOString();
    } else throw Error("Acción no disponible");
    save();
    return clone(x);
  }
  root.EnjoyDemo = {
    client: {
      auth: {
        getSession: async () => ({
          data: {
            session: { user: { id: state.uid, email: "demo@example.invalid" } },
          },
        }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (_, args) => {
        try {
          return {
            data: await api(args.p_action, args.p_payload),
            error: null,
          };
        } catch (e) {
          return { data: null, error: { message: e.message } };
        }
      },
      storage: {
        from: () => ({
          upload: async (path, file) => {
            files.set(path, file);
            return { data: { path }, error: null };
          },
          download: async (path) => ({
            data: files.get(path),
            error: files.has(path)
              ? null
              : Error("El original de demostración no se conserva al recargar"),
          }),
        }),
      },
    },
  };
  document.getElementById("reset-demo")?.addEventListener("click", () => {
    localStorage.removeItem(KEY);
    localStorage.removeItem("enjoy_identity_demo");
    location.reload();
  });
})(window);
