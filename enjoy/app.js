/* Enjoy company boundary. All authorization and blind-data filtering live in enjoy_api. */
(function () {
  "use strict";
  const C = EnjoyCore,
    S = EnjoyStore,
    Y = EnjoySync,
    E = EnjoyExports,
    $ = (id) => document.getElementById(id),
    h = (s) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const identityKey = window.EnjoyDemo
    ? "enjoy_identity_demo"
    : "enjoy_identity";
  const db =
    window.EnjoyDemo?.client ||
    supabase.createClient(
      "https://akqqpodyijzjdoibkint.supabase.co",
      "sb_publishable_ClVgs8WdyAu0McGi0eAaEQ_MovUmDCC",
      {
        global: {
          fetch: (url, opts = {}) =>
            fetch(url, {
              ...opts,
              signal: opts.signal || AbortSignal.timeout(12000),
            }),
        },
      },
    );
  let user,
    profile,
    members = [],
    list = [],
    pkg = null,
    step = 0,
    actor = "",
    active = false,
    selected = null,
    results = [],
    highlight = 0,
    index = [],
    busy = false,
    view = "login",
    toastTimer;
  const device = sessionStorage.getItem("enjoy_device") || crypto.randomUUID();
  sessionStorage.setItem("enjoy_device", device);
  const n = (v) =>
      v == null
        ? "—"
        : new Intl.NumberFormat("es-UY", { maximumFractionDigits: 6 }).format(
            v,
          ),
    date = (v) => (v ? new Date(v).toLocaleString("es-UY") : "—");
  const manager = () =>
    profile?.role === "finanzas" ||
    profile?.role === "supervisor" ||
    profile?.can_manage;
  function toast(text) {
    $("toast").textContent = text;
    $("toast").style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").style.display = "none"), 6000);
  }
  async function rpc(action, payload = {}) {
    if (!navigator.onLine)
      throw Error(
        "Necesitás conexión para esta acción. El conteo sigue disponible sin conexión.",
      );
    const { data, error } = await db.rpc("enjoy_api", {
      p_action: action,
      p_payload: payload,
    });
    if (error) throw Error(error.message);
    return data;
  }
  async function guarded(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
    }
  }
  function button(action, text, cls = "secondary", extra = "") {
    return `<button type="button" data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
  }
  function field(label, name, value, type = "text", extra = "") {
    return `<label>${label}<input name="${name}" type="${type}" value="${h(value)}" ${extra}></label>`;
  }
  function option(value, label, current) {
    return `<option value="${h(value)}" ${value === current ? "selected" : ""}>${h(label)}</option>`;
  }
  async function status() {
    const pending = user ? await S.events(user.id) : [];
    $("connection").textContent =
      (navigator.onLine ? "Con conexión" : "Sin conexión") +
      (pending.length
        ? ` · ${pending.length} movimientos pendientes`
        : " · Guardado");
    $("connection").className = navigator.onLine ? "" : "offline";
    $("sync").hidden = !user;
    $("logout").hidden = !user;
    $("home").hidden = !profile?.approved;
  }
  function auth(register = false) {
    view = "login";
    $("app").innerHTML =
      `<div class="auth card"><p class="eyebrow">Enjoy · LABAMA</p><h1>${register ? "Solicitar acceso" : "Tu inventario, a mano."}</h1><p class="muted">${register ? "Finanzas aprobará tu usuario y los almacenes habilitados." : "Ingresá con tu usuario para ver los inventarios asignados."}</p><form id="auth-form">${register ? field("Nombre y apellido", "name", "", "text", 'required autocomplete="name"') : ""}${field("Correo", "email", "", "email", 'required autocomplete="username"')}${field("Contraseña", "password", "", "password", 'required minlength="8" autocomplete="' + (register ? "new-password" : "current-password") + '"')}<button>${register ? "Crear solicitud" : "Ingresar"}</button></form><div class="actions">${button(register ? "login" : "register", register ? "Ya tengo cuenta" : "Solicitar acceso", "quiet")}${button("change-company", "Cambiar empresa", "quiet")}</div><small>Para trabajar sin conexión, descargá antes el inventario y abrí esta aplicación en el dispositivo.</small></div>`;
    $("auth-form").onsubmit = (e) => {
      e.preventDefault();
      guarded(async () => {
        if (!navigator.onLine)
          throw Error("El primer ingreso requiere conexión");
        const f = new FormData(e.target);
        if (register) {
          const { data, error } = await db.auth.signUp({
            email: f.get("email"),
            password: f.get("password"),
            options: { data: { company: "ENJOY", name: f.get("name") } },
          });
          if (error) throw error;
          if (!data.session) {
            toast(
              "Revisá tu correo para confirmar la cuenta. Luego Finanzas aprobará tu acceso.",
            );
            auth();
            return;
          }
          await enter(data.user);
        } else {
          const { data, error } = await db.auth.signInWithPassword({
            email: f.get("email"),
            password: f.get("password"),
          });
          if (error) throw error;
          await enter(data.user);
        }
      });
    };
  }
  function gate() {
    view = "gate";
    $("app").innerHTML =
      `<div class="auth card"><p class="eyebrow">Acceso empresa</p><h1>Enjoy</h1><p>Ingresá la clave de empresa para continuar.</p><form id="gate">${field("Clave de empresa", "key", "", "password", "required")}<button>Continuar</button></form><p><a href="/">Volver a LABAMA</a></p></div>`;
    $("gate").onsubmit = (e) => {
      e.preventDefault();
      guarded(async () => {
        const r = await fetch("/api/company-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: new FormData(e.target).get("key") }),
        });
        const data = await r.json();
        if (!r.ok || data.nombre !== "ENJOY")
          throw Error("Clave de empresa incorrecta");
        sessionStorage.setItem("empresa_validada", "1");
        sessionStorage.setItem("empresa_nombre", "ENJOY");
        await bootAuth();
      });
    };
  }
  async function enter(u) {
    user = u;
    profile = await rpc("profile");
    if (!profile)
      profile = await rpc("request_access", {
        name: u.user_metadata?.name || u.email,
      });
    localStorage.setItem(
      identityKey,
      JSON.stringify({ user: { id: u.id, email: u.email }, profile }),
    );
    await status();
    if (!profile.approved) {
      $("app").innerHTML =
        `<div class="auth card"><p class="eyebrow">Solicitud recibida</p><h1>Tu acceso está pendiente</h1><p>Finanzas debe asignarte un rol y los almacenes en los que podés trabajar.</p>${button("refresh-profile", "Comprobar aprobación")}</div>`;
      return;
    }
    await dashboard();
    sync();
  }
  async function bootAuth() {
    try {
      const {
        data: { session },
      } = await db.auth.getSession();
      if (session && navigator.onLine) {
        await enter(session.user);
        return;
      }
      if (!navigator.onLine) {
        const cached = JSON.parse(localStorage.getItem(identityKey) || "null");
        if (cached?.profile?.approved) {
          user = cached.user;
          profile = cached.profile;
          await dashboard();
          return;
        }
      }
      auth();
    } catch (e) {
      if (!navigator.onLine) {
        const cached = JSON.parse(localStorage.getItem(identityKey) || "null");
        if (cached?.profile?.approved) {
          user = cached.user;
          profile = cached.profile;
          await dashboard();
          return;
        }
      }
      toast(e.message);
      auth();
    }
  }
  async function dashboard() {
    stopGPS();
    pkg = null;
    view = "dashboard";
    if (navigator.onLine) {
      list = await rpc("list");
      members = await rpc("members");
    } else list = (await S.packages(user.id)).map((p) => p.inventory);
    const cache = await S.packages(user.id),
      ids = new Set(cache.map((p) => p.inventory.id));
    $("app").innerHTML =
      `<div class="heading"><div><p class="eyebrow">${h(profile.role)} · Enjoy</p><h1>Hola, ${h(profile.name.split(" ")[0])}.</h1><p class="muted">Tus inventarios y el estado de cada conteo.</p></div><div class="actions">${manager() ? button("new", "+ Nuevo inventario", "") : ""}${profile.role === "finanzas" ? button("members", "Usuarios y permisos") : ""}</div></div><div class="grid">${list.map((i) => `<article class="card"><div class="row-open"><span class="pill">${h(i.status === "ready" ? "Listo para contar" : i.status === "scheduled" ? "Programado" : i.status === "closed" ? "Cerrado" : "Borrador")}</span><small>${h(i.warehouse)}</small></div><h2 style="margin-top:16px">${h(i.title)}</h2><p class="muted">${h(i.scheduled_date)} · ${i.procedure === "principal" ? "Inventario principal" : "Inventario de almacén"}</p><div class="row-open">${button("open", "Abrir inventario", "", `data-id="${i.id}"`)}<small>${ids.has(i.id) ? "Disponible en este dispositivo" : "Descargar al abrir"}</small></div></article>`).join("") || '<div class="card empty">No hay inventarios disponibles para hoy. Los programados aparecerán en la fecha asignada.</div>'}</div><div class="card"><h3>Preparado para trabajar sin conexión</h3><p class="muted">Abrí tu inventario con conexión antes de ir al almacén. Se guardan los productos, tus permisos y cada movimiento. Las nuevas asignaciones requieren una descarga.</p><div id="offline-ready"></div></div>`;
    await status();
    const registration =
      await navigator.serviceWorker?.getRegistration("/enjoy/");
    $("offline-ready").textContent = registration?.active
      ? "Aplicación preparada · Verificá que tu inventario figure como disponible."
      : "La preparación de la aplicación sigue en curso. Mantené esta pantalla abierta con conexión.";
  }
  function emptyPackage() {
    return {
      inventory: {
        title: "",
        warehouse: profile.warehouses?.[0] || "AL04",
        scheduled_date: C.today(),
        procedure: "principal",
        status: "draft",
        items: [],
        assignments: [],
        mb52_date: "",
        sap_blocked: false,
        management_notes: "",
      },
      reference: {},
      counts: [],
      approvals: {},
      documents: [],
      report: null,
      adjustments: [],
      submissions: {},
      manager: true,
      see_stock: true,
    };
  }
  async function openInventory(id) {
    stopGPS();
    const cached = await S.get("packages", user.id + "|" + id);
    if (navigator.onLine) pkg = await Y.refresh(user.id, rpc, id);
    else {
      if (!cached)
        throw Error("Descargá este inventario antes de trabajar sin conexión");
      pkg = cached;
    }
    navigator.storage?.persist?.().catch(() => {});
    step = pkg.manager ? (pkg.inventory.status === "draft" ? 0 : 4) : 4;
    setActor();
    render();
    await status();
  }
  function setActor() {
    const own = pkg.inventory.assignments.filter((a) => a.user_id === user.id);
    actor = own.some((a) => a.actor === actor) ? actor : own[0]?.actor || "";
    selected = null;
    index = SucaneitorSearch.createSearchIndex(
      pkg.inventory.items.map((i) => ({
        ...i,
        nombre: i.name,
        codigo: i.code,
        barras: i.barcode,
      })),
    );
  }
  const names = () =>
    Object.fromEntries(members.map((m) => [m.user_id, m.name]));
  function collect() {
    const f = $("wizard-form");
    if (!f) return;
    const values = new FormData(f),
      i = pkg.inventory;
    if (step === 0) {
      Object.assign(i, {
        title: values.get("title"),
        warehouse: values.has("warehouse")
          ? values.get("warehouse").toUpperCase().trim()
          : i.warehouse,
        procedure: values.get("procedure") || i.procedure,
        scheduled_date: values.get("scheduled_date") || i.scheduled_date,
      });
      if (C.MAIN.includes(i.warehouse)) i.procedure = "principal";
    }
    if (step === 1 && !pkg.counts.length && i.status !== "closed") {
      i.mb52_date = values.get("mb52_date");
      i.sap_blocked = values.get("sap_blocked") === "on";
      i.sap_blocked_at = values.get("sap_blocked_at");
    }
    if (step === 2 && !pkg.counts.length && i.status !== "closed") {
      i.assignments = [];
      for (const role of ["responsable", "auditor"])
        if (values.get(role))
          i.assignments.push({
            actor: role,
            user_id: values.get(role),
            see_stock: values.get(role + "_stock") === "on",
          });
    }
    if (step === 3) {
      i.management_notes = values.get("management_notes");
    }
  }
  async function save(statusValue) {
    collect();
    if (!pkg.manager) return;
    if (!navigator.onLine)
      throw Error("La configuración del inventario se guarda con conexión");
    if (statusValue) pkg.inventory.status = statusValue;
    pkg = await rpc("save_inventory", {
      inventory: pkg.inventory,
      reference: pkg.reference,
      version: pkg.inventory.version || 0,
    });
    await S.savePackage(user.id, pkg);
    setActor();
  }
  function render() {
    view = "inventory";
    const inv = pkg.inventory;
    const allowed = pkg.manager ? C.STEPS.map((_, i) => i) : [4];
    $("app").innerHTML =
      `<div class="heading"><div><p class="eyebrow">${h(inv.warehouse)} · ${h(inv.scheduled_date)} <span class="pill">${h(inv.status)}</span></p><h1>${h(inv.title || "Nuevo inventario")}</h1><small>${pkg.downloaded_at ? "Descargado: " + date(pkg.downloaded_at) : inv.id ? "Configuración guardada" : "Completá los datos para guardar el borrador."}</small></div>${pkg.manager ? button("activity", "Actividad y ubicación") : ""}</div><nav class="steps" aria-label="Pasos del inventario">${allowed.map((s) => button("step", `${s + 1}. ${C.STEPS[s]}`, s === step ? "active" : "", `data-step="${s}"`)).join("")}</nav><div id="step-content"></div>${pkg.manager ? `<div class="footer"><div>${step > 0 ? button("back", "← Atrás") : ""}</div><div class="inline">${button("save-exit", "Guardar y salir")}${step < 7 ? button("next", "Siguiente →", "") : ""}</div></div>` : ""}`;
    renderStep();
  }
  function renderStep() {
    const inv = pkg.inventory,
      locked = pkg.counts.length || inv.status === "closed",
      off = locked ? "disabled" : "";
    let content = "";
    if (step === 0)
      content = `<section class="card"><h2>1. Datos del inventario</h2><p class="muted">Programá primero la tarea. La base MB52 definitiva se incorpora el día del inventario principal.</p><form id="wizard-form"><div class="grid">${field("Nombre del inventario", "title", inv.title, "text", "required")}${field("Almacén", "warehouse", inv.warehouse, "text", `required ${off}`)}${field("Fecha de conteo", "scheduled_date", inv.scheduled_date, "date", `required ${off}`)}<label>Procedimiento<select name="procedure" ${off}>${option("principal", "Principal · circuito SAP completo", inv.procedure)}${option("otro", "Otro · configurable", inv.procedure)}</select></label></div></form><small>AL04, AL05, AL02 y AL12 usan el procedimiento principal.</small></section>`;
    if (step === 1)
      content = `<section class="card"><h2>2. Mercadería de MB52</h2><p class="muted">Se conserva cada material, lote, centro y unidad. Los productos con stock teórico cero no se incluyen.</p><form id="wizard-form"><div class="grid"><label class="file">Importar Excel MB52<input id="mb52-file" type="file" accept=".xlsx,.xls" ${off}></label>${field("Fecha de extracción de MB52", "mb52_date", inv.mb52_date, "date", off)}${field("Fecha y hora de bloqueo en SAP", "sap_blocked_at", inv.sap_blocked_at, "datetime-local", off)}</div><label class="check"><input type="checkbox" name="sap_blocked" ${inv.sap_blocked ? "checked" : ""} ${off}>Confirmo que SAP bloqueó los movimientos del almacén</label></form><small>La aplicación registra la confirmación. El bloqueo se realiza en SAP al generar sus documentos.</small><div class="kpis"><div class="kpi"><strong>${inv.items.length}</strong><span>Materiales y lotes</span></div><div class="kpi"><strong>${Object.keys(pkg.reference).filter((k) => pkg.reference[k].stock != null).length}</strong><span>Con stock de referencia</span></div></div>${merchTable(locked)}</section>`;
    if (step === 2) {
      const eligible = members.filter(
        (m) =>
          m.approved &&
          (m.warehouses.includes(inv.warehouse) || m.role === "finanzas"),
      );
      content = `<section class="card"><h2>3. Participantes y visibilidad</h2><p class="muted">Asigná responsable, auditor o ambos. Cada uno registra su propio conteo. Finanzas administra los usuarios y sus almacenes.</p><form id="wizard-form"><div class="grid">${[
        "responsable",
        "auditor",
      ]
        .map((role) => {
          const a = inv.assignments.find((x) => x.actor === role);
          return `<div><label>${role === "responsable" ? "Responsable del almacén" : "Auditor"}<select name="${role}" ${off}>${option("", "Sin asignar", a?.user_id || "")}${eligible.map((m) => option(m.user_id, m.name + " · " + m.role, a?.user_id)).join("")}</select></label><label class="check"><input type="checkbox" name="${role}_stock" ${a?.see_stock ? "checked" : ""} ${off}>Puede ver stock y valor MB52</label></div>`;
        })
        .join(
          "",
        )}</div></form><div class="warning">El conteo ciego descarga los productos sin stock, valores, diferencias ni archivos de referencia.</div></section>`;
    }
    if (step === 3)
      content = `<section class="card"><h2>4. Programación y publicación</h2><p>${h(inv.items.length)} productos · ${h(inv.assignments.length)} participantes · ${h(inv.scheduled_date)}</p><form id="wizard-form"><label>Observaciones de gestión<textarea name="management_notes">${h(inv.management_notes)}</textarea></label></form><div class="actions">${button("schedule", "Programar tarea")}${button("publish", "Habilitar conteo", "")}</div><small>La tarea aparece en la fecha asignada. Para habilitar un principal se requiere MB52 de ese día y confirmación del bloqueo en SAP.</small></section>`;
    if (step === 4) {
      $("step-content").innerHTML = countHTML();
      bindCount();
      return;
    }
    if (step === 5) content = reviewHTML();
    if (step === 6) content = sapHTML();
    if (step === 7) content = closeHTML();
    $("step-content").innerHTML = content;
    const file = $("mb52-file");
    if (file) file.onchange = () => guarded(() => importMb52(file.files[0]));
    $("wizard-form")?.addEventListener("submit", (e) => e.preventDefault());
    $("sap-file")?.addEventListener("change", (e) =>
      guarded(() => importSap(e.target.files[0], $("sap-kind").value)),
    );
    $("report-file")?.addEventListener("change", (e) =>
      guarded(() => importReport(e.target.files[0])),
    );
  }
  function merchTable(locked) {
    return `<details><summary>Ver productos y asociar códigos de barras</summary><div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Descripción</th><th>Unidad</th><th>Stock</th><th>Código de barras</th></tr></thead><tbody>${pkg.inventory.items.map((i, k) => `<tr><td>${h(i.code)}<small>${h(i.lot || "Sin lote")}</small></td><td>${h(i.name)}</td><td>${h(i.unit)}</td><td>${n(pkg.reference[i.id]?.stock)}</td><td><input data-barcode="${k}" aria-label="Código de barras ${h(i.code)}" value="${h(i.barcode)}" ${locked ? "disabled" : ""}></td></tr>`).join("")}</tbody></table></div></details>`;
  }
  async function readWorkbook(file) {
    if (!file) throw Error("Elegí un archivo");
    if (file.size > 20971520) throw Error("El archivo supera 20 MB");
    const book = XLSX.read(await file.arrayBuffer(), {
      type: "array",
      cellDates: false,
    });
    return book.SheetNames.map((name) => ({
      name,
      rows: XLSX.utils.sheet_to_json(book.Sheets[name], {
        header: 1,
        defval: "",
        raw: true,
      }),
    }));
  }
  async function importMb52(file) {
    collect();
    const sheets = await readWorkbook(file);
    let parsed;
    for (const s of sheets) {
      try {
        parsed = C.parseMb52(s.rows);
        break;
      } catch (e) {
        if (s === sheets.at(-1)) throw e;
      }
    }
    const wh = pkg.inventory.warehouse;
    const items = parsed.items.filter((i) => i.warehouse === wh);
    if (!items.length) throw Error("El archivo no contiene el almacén " + wh);
    pkg.inventory.items = items;
    pkg.reference = Object.fromEntries(
      items.map((i) => [i.id, parsed.reference[i.id]]),
    );
    pkg.inventory.source_name = file.name;
    await save();
    pkg = await uploadDocument(file, "mb52", {});
    renderStep();
    toast(
      `${items.length} materiales importados en ${wh}. ${parsed.excludedZero} filas con stock cero excluidas.`,
    );
  }
  function ownRows() {
    return pkg.counts.filter((c) => c.user_id === user.id && c.actor === actor);
  }
  function countHTML() {
    const inv = pkg.inventory,
      own = inv.assignments.filter((a) => a.user_id === user.id),
      rows = ownRows(),
      submitted = pkg.submissions[user.id + ":" + actor]?.submitted,
      can =
        inv.status === "ready" &&
        !submitted &&
        (inv.scheduled_date === C.today() || inv.allow_late_sync);
    return `<section class="card"><div class="countbar"><div><h2>5. Conteo ${actor ? "· " + h(actor) : ""}</h2><small>${own.length > 1 ? `<select id="actor-select" aria-label="Función de conteo">${own.map((a) => option(a.actor, a.actor, actor)).join("")}</select>` : ""}${rows.length} / ${inv.items.length} productos registrados · ${pkg.see_stock ? "Stock visible" : "Conteo ciego"}</small></div>${actor && can ? button(active ? "pause" : "start", active ? "Pausar conteo" : "Iniciar conteo", active ? "secondary" : "") : ""}</div><progress value="${rows.length}" max="${inv.items.length || 1}"></progress>${!actor ? '<div class="warning">No estás asignado para contar. Podés revisar y gestionar este inventario desde los siguientes pasos.</div>' : submitted ? '<div class="warning">Conteo entregado. El supervisor puede reabrirlo si hace falta corregirlo.</div>' : !can ? '<div class="warning">El conteo todavía no está habilitado para esta fecha. La configuración corresponde al supervisor.</div>' : ""}${actor && can ? `<div class="grid" style="margin-top:16px"><div><label>Sector (opcional)<input id="sector" value="${h(sessionStorage.getItem("enjoy_sector_" + inv.id) || "")}" placeholder="Ej. cámara de frío"></label></div><div><p class="muted subtle" id="gps-status">Ubicación: ${h(EnjoyGPS.get().state)}. Se registra automáticamente durante el conteo activo.</p></div></div><label class="searchbox">Buscar producto<input id="search" type="search" placeholder="Nombre, código o código de barras" autocomplete="off" enterkeyhint="next" ${!active ? "disabled" : ""} role="combobox" aria-autocomplete="list" aria-controls="results" aria-expanded="false"></label><ul id="results" class="results" role="listbox"></ul><div id="quantity-area"></div><small>Enter selecciona el producto. La siguiente cantidad se suma y el cursor vuelve al buscador.</small>` : ""}<div class="actions">${actor && can ? button("finish", "Entregar mi conteo") : ""}${button("count-xlsx", "Descargar mi planilla")}</div><div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Producto</th>${pkg.see_stock ? "<th>Stock</th>" : ""}<th>Mi conteo</th><th>Corregir</th></tr></thead><tbody id="count-table">${countRows()}</tbody></table></div></section><details class="card"><summary>Movimientos pendientes de sincronizar</summary><div id="pending-events"></div></details>`;
  }
  function countRows() {
    return pkg.inventory.items
      .map((i) => {
        const c = ownRows().find((c) => c.item_id === i.id);
        return `<tr id="row-${pkg.inventory.items.indexOf(i)}"><td>${h(i.code)}<small>${h(i.lot || "Sin lote")} · ${h(i.unit)}</small></td><td>${h(i.name)}</td>${pkg.see_stock ? `<td>${n(pkg.reference[i.id]?.stock)}</td>` : ""}<td class="tabular">${c ? n(c.quantity) : "<small>Sin contar</small>"}</td><td>${actor && pkg.inventory.status === "ready" && !pkg.submissions[user.id + ":" + actor]?.submitted ? button("correct", "Corregir", "quiet", `data-id="${h(i.id)}"`) : ""}</td></tr>`;
      })
      .join("");
  }
  function bindCount() {
    const search = $("search");
    search?.addEventListener("input", () => showResults(search.value));
    search?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        highlight = Math.max(
          0,
          Math.min(
            results.length - 1,
            highlight + (e.key === "ArrowDown" ? 1 : -1),
          ),
        );
        drawResults();
      }
      if (e.key === "Enter") {
        e.preventDefault();
        chooseResult();
      }
    });
    $("actor-select")?.addEventListener("change", (e) => {
      if (active) {
        toast("Pausá el conteo antes de cambiar de función");
        e.target.value = actor;
        return;
      }
      actor = e.target.value;
      renderStep();
    });
    $("sector")?.addEventListener("change", (e) =>
      sessionStorage.setItem(
        "enjoy_sector_" + pkg.inventory.id,
        e.target.value,
      ),
    );
    pendingHTML();
    if (active) search?.focus();
  }
  function showResults(query) {
    highlight = 0;
    selected = null;
    $("quantity-area").innerHTML = "";
    const q = query.trim(),
      numeric = /^\d+$/.test(q),
      normalized = numeric ? C.code(q) : q;
    const exact = index
      .filter((e) => e.product.barcode === q || e.product.code === normalized)
      .map((e) => e.product);
    const partial = index
      .filter((e) => e.product.barcode && e.product.barcode.includes(q))
      .map((e) => e.product);
    const ranked = [
      ...SucaneitorSearch.searchByCode(index, normalized, 30),
      ...SucaneitorSearch.rankProducts(index, q, {}, 30),
    ].map((e) => e.product);
    results = q
      ? [
          ...new Map(
            [...exact, ...partial, ...ranked].map((i) => [i.id, i]),
          ).values(),
        ].slice(0, 30)
      : [];
    drawResults();
  }
  function drawResults() {
    const el = $("results");
    el.innerHTML = results
      .map(
        (i, k) =>
          `<li role="option" aria-selected="${k === highlight}"><button data-result="${k}" class="${k === highlight ? "selected" : ""}"><strong>${h(i.name)}</strong><small style="display:block">${h(i.code)} · Lote ${h(i.lot || "sin lote")} · ${h(i.unit)}</small></button></li>`,
      )
      .join("");
    $("search").setAttribute("aria-expanded", String(results.length > 0));
  }
  function chooseResult(k = highlight, explicit = false) {
    if (!results[k]) {
      toast("No hay un producto seleccionado");
      return;
    }
    const candidate = results[k],
      exact = results.filter(
        (i) =>
          i.code === C.code($("search").value.trim()) ||
          (i.barcode && i.barcode === $("search").value.trim()),
      );
    if (!explicit && exact.length > 1) {
      toast("Este código tiene varios lotes. Elegí el lote en los resultados.");
      return;
    }
    selected = candidate;
    const current = ownRows().find((c) => c.item_id === selected.id);
    $("results").innerHTML = "";
    $("search").setAttribute("aria-expanded", "false");
    $("quantity-area").innerHTML =
      `<div class="selected-item"><strong>${h(selected.name)}</strong><small style="display:block">${h(selected.code)} · Lote ${h(selected.lot || "sin lote")} · ${h(selected.unit)} · Total contado: ${current ? n(current.quantity) : "sin contar"}</small><form id="quantity-form" class="count-entry"><label>Cantidad a sumar<input id="quantity" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" required></label><button>Sumar ↵</button></form></div>`;
    $("quantity-form").onsubmit = (e) => {
      e.preventDefault();
      guarded(() => addQuantity("add", $("quantity").value, selected.id));
    };
    $("quantity").focus();
  }
  async function record(action, item, value, extra = {}) {
    if (!actor) throw Error("No tenés una función asignada");
    const gps = EnjoyGPS.get(),
      event = {
        id: crypto.randomUUID(),
        device_id: device,
        occurred_at: new Date().toISOString(),
        actor,
        action,
        sector:
          $("sector")?.value ||
          sessionStorage.getItem("enjoy_sector_" + pkg.inventory.id) ||
          "",
        gps: gps.fix,
        gps_status: gps.state,
        gps_age_ms: gps.age_ms,
        ...extra,
      };
    if (item) event.item_id = item;
    if (value != null) event.value = C.number(value);
    pkg = await Y.record(user.id, pkg, event);
    await status();
    sync();
  }
  async function addQuantity(action, value, id) {
    if (!active) throw Error("Iniciá el conteo para registrar cantidades");
    C.quantity(
      ownRows().find((c) => c.item_id === id)?.quantity,
      action,
      value,
    );
    await record(action, id, value);
    selected = null;
    if ($("quantity-area")) $("quantity-area").innerHTML = "";
    if ($("count-table")) $("count-table").innerHTML = countRows();
    await pendingHTML();
    toast("Cantidad guardada en este dispositivo");
    if ($("search")) {
      $("search").value = "";
      $("search").focus();
    }
  }
  function stopGPS() {
    EnjoyGPS.stop();
    active = false;
  }
  async function start() {
    if (!actor) throw Error("No estás asignado para contar");
    await record("start");
    active = true;
    EnjoyGPS.start(() => {
      if (active && pkg) record("gps").catch((e) => toast(e.message));
    });
    renderStep();
  }
  async function pause() {
    if (active) await record("pause");
    stopGPS();
    renderStep();
  }
  async function pendingHTML() {
    if (!$("pending-events")) return;
    const rows = await S.events(user.id, pkg.inventory.id);
    $("pending-events").innerHTML = rows.length
      ? rows
          .map(
            (e) =>
              `<p><strong>${h(e.action)}</strong> · ${date(e.occurred_at)} ${e.item_id ? "· " + h(e.item_id) : ""}<small style="display:block">${h(e.error || "Guardado localmente. Pendiente de recibir en el servidor.")}</small>${e.status === "conflict" ? button("review-conflict", "Revisar movimiento", "secondary", `data-id="${e.id}"`) : ""}</p>`,
          )
          .join("")
      : '<p class="good">Todos los movimientos recibidos por el servidor.</p>';
  }
  async function sync() {
    if (!user) return;
    await Y.run(user.id, rpc, async () => {
      if (pkg && view === "inventory" && step === 4) {
        const fresh = await S.get("packages", user.id + "|" + pkg.inventory.id);
        if (fresh) pkg = fresh;
        await pendingHTML();
        if (view === "inventory" && step === 4 && $("count-table"))
          $("count-table").innerHTML = countRows();
      }
      await status();
    });
  }
  function reviewHTML() {
    const rows = C.comparison(pkg),
      m = C.metrics(rows),
      name = names();
    return `<section class="card"><h2>6. Comparar y autorizar cantidades</h2><p class="muted">Los conteos permanecen separados. Autorizá la cantidad que se trasladará al CSV y registrá el criterio.</p><div class="kpis"><div class="kpi"><strong>${m.approved}/${m.total}</strong><span>Autorizados</span></div><div class="kpi"><strong>${m.exactRate == null ? "—" : n(m.exactRate * 100) + "%"}</strong><span>Exactitud estricta</span></div><div class="kpi"><strong>${m.within1000}</strong><span>Diferencia menor a $1.000</span></div></div><div class="actions">${button("xlsx", "Descargar comparativo Excel")}${pkg.inventory.status !== "closed" ? button("approve-batch", "Autorizar desde un conteo") : ""}</div><div id="batch-area"></div>${pkg.inventory.assignments.map((a) => `<p><strong>${h(a.actor)}: ${h(name[a.user_id] || a.user_id)}</strong> · ${pkg.submissions[a.user_id + ":" + a.actor]?.submitted ? "Entregado" : "Pendiente"} ${pkg.submissions[a.user_id + ":" + a.actor]?.submitted && pkg.inventory.status !== "closed" ? button("reopen", "Reabrir", "quiet", `data-assignment="${a.user_id}:${a.actor}"`) : ""}</p>`).join("")}<div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Stock</th><th>Responsable</th><th>Auditor</th><th>Autorizado</th><th>Diferencia</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${h(r.name)}<small>${h(r.code)} · ${h(r.lot || "Sin lote")} · ${h(r.unit)}</small></td><td>${n(r.stock)}</td><td>${n(r.entries.find((c) => c.actor === "responsable")?.quantity)}</td><td>${n(r.entries.find((c) => c.actor === "auditor")?.quantity)}</td><td>${n(r.approved)}</td><td>${n(r.diff)}</td><td>${pkg.inventory.status !== "closed" ? button("approve", "Autorizar", "secondary", `data-id="${h(r.id)}"`) : ""}</td></tr>`).join("")}</tbody></table></div><div id="approve-area"></div></section>`;
  }
  function sapHTML() {
    return `<section class="card"><h2>7. Circuito SAP</h2><p class="muted">Vinculá el CSV inicial y luego CSV_2. Los documentos SAP pueden ser distintos entre etapas. Se mantienen materiales, lotes y posiciones.</p><div class="grid"><label>Etapa del archivo<select id="sap-kind"><option value="csv">CSV inicial · MI04</option><option value="csv_2">CSV_2 · MI08</option></select></label><label class="file">Vincular plantilla SAP<input id="sap-file" type="file" accept=".csv" ${pkg.inventory.status === "closed" ? "disabled" : ""}></label><label class="file">Incorporar Reporte SAP final<input id="report-file" type="file" accept=".xlsx,.xls" ${pkg.inventory.status === "closed" ? "disabled" : ""}></label></div><div class="grid">${field("Fecha de conteo para CSV", "count-date", pkg.inventory.scheduled_date, "date")}${field("Fecha de ingreso en SAP", "entry-date", C.today(), "date")}</div><div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Etapa</th><th>Documento</th><th>Acciones</th></tr></thead><tbody>${pkg.documents.map((d, k) => `<tr><td>${h(d.name)}<small>${date(d.at)}</small></td><td>${h(d.kind)}${d.generated ? " · generado" : ""}</td><td>${h((d.documents || []).join(", "))}</td><td>${d.path ? button("download-original", "Original", "quiet", `data-index="${k}"`) : ""}${d.sap ? button("export-csv", "Completar y descargar", "", `data-index="${k}"`) : ""}</td></tr>`).join("")}</tbody></table></div>${pkg.report ? `<p class="good">Reporte incorporado: ${pkg.report.items.length} posiciones · Documento ${h(pkg.report.documents.join(", "))}.</p>` : ""}<div class="warning">Descargar un CSV no confirma su carga en SAP. Generá y verificá el documento en SAP y vinculá después su reporte.</div></section>`;
  }
  function closeHTML() {
    const rows = C.comparison(pkg),
      m = C.metrics(rows);
    return `<section class="card"><h2>8. Cierre, ajustes y acta</h2><div class="kpis"><div class="kpi"><strong>${m.approved}/${m.total}</strong><span>Autorizados</span></div><div class="kpi"><strong>${n(m.net)}</strong><span>Diferencia neta estimada UYU</span></div><div class="kpi"><strong>${pkg.report ? n(pkg.report.totals.differenceValue) : "—"}</strong><span>Diferencia Reporte SAP</span></div></div><p class="muted">El acta incluye participantes, indicadores, diferencias, justificaciones y ajustes. Se emite como borrador hasta cerrar el inventario.</p><div class="actions">${button("acta", "Descargar acta Word", "")}${button("xlsx", "Excel completo")}${pkg.inventory.warehouse === "AL05" ? button("consolidate", "Consolidar AL05") : ""}</div><h3>Ajustes posteriores</h3><p class="muted">Una propuesta no equivale a un ajuste ejecutado en SAP. Registrá su evidencia y fecha cuando se complete.</p><div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Cantidad</th><th>Estado</th><th>Fecha y evidencia</th></tr></thead><tbody>${pkg.adjustments.map((a) => `<tr><td>${h(a.code)} · ${h(a.lot)}</td><td>${n(a.quantity)}</td><td>${a.executed ? "Ejecutado" : "Propuesto"}</td><td>${h(a.date)} ${h(a.evidence)}</td></tr>`).join("")}</tbody></table></div>${`<form id="adjust-form" class="card"><div class="grid"><label>Material / lote<select name="item">${pkg.inventory.items.map((i) => option(i.id, i.code + " · " + i.lot + " · " + i.name, "")).join("")}</select></label>${field("Cantidad final propuesta", "quantity", "", "text", 'inputmode="decimal" required')}${field("Fecha", "date", C.today(), "date")}${field("Documento SAP o evidencia", "evidence", "")}</div><label class="check"><input name="executed" type="checkbox">Ajuste ejecutado y verificado en SAP</label><button>Registrar ajuste</button></form>`}${pkg.inventory.status !== "closed" ? `<label class="check"><input id="close-confirm" type="checkbox">Revisé las cantidades, las entregas, las justificaciones y el Reporte SAP</label>${button("close", "Cerrar inventario", "")}` : `<p class="good">Inventario cerrado el ${date(pkg.inventory.closed_at)}. Los movimientos y documentos quedan conservados.</p>`}</section>`;
  }
  async function uploadDocument(file, kind, extra, report) {
    if (!pkg.inventory.id) await save();
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
      path = `${pkg.inventory.id}/${user.id}/${crypto.randomUUID()}_${safe}`,
      { error } = await db.storage
        .from("enjoy-inventarios")
        .upload(path, file, {
          upsert: false,
          contentType: file.type || "application/octet-stream",
        });
    if (error)
      throw Error("No se pudo conservar el archivo original: " + error.message);
    const next = await rpc("document", {
      inventory_id: pkg.inventory.id,
      document: { kind, name: file.name, path, ...extra },
      ...(report ? { report } : {}),
    });
    await S.savePackage(user.id, next);
    return next;
  }
  async function importSap(file, kind) {
    if (!file) return;
    const sap = C.parseSap(
        new TextDecoder("windows-1252").decode(await file.arrayBuffer()),
      ),
      expected = kind === "csv_2" ? "confirmacion" : "conteo";
    if (sap.kind !== expected)
      throw Error(
        "La transacción del CSV no corresponde a la etapa seleccionada",
      );
    const wh = sap.meta["alm."] || sap.meta["almacen"];
    if (wh !== pkg.inventory.warehouse)
      throw Error("El CSV corresponde a otro almacén");
    const matched = C.matchSap(sap, pkg.inventory.items, wh);
    if (
      matched.some((p) => p.error) ||
      matched.length !== pkg.inventory.items.length ||
      new Set(matched.map((p) => p.itemId)).size !== pkg.inventory.items.length
    )
      throw Error(
        "El CSV no coincide con todos los materiales y lotes del inventario",
      );
    pkg = await uploadDocument(file, kind, { documents: sap.documents, sap });
    renderStep();
    toast("Plantilla SAP vinculada");
  }
  async function importReport(file) {
    const sheets = await readWorkbook(file),
      sheet = sheets.find((s) =>
        s.rows.some((r) => r.some((v) => C.norm(v) === "documento inventario")),
      );
    if (!sheet) throw Error("No se encontró la hoja Reporte");
    const report = C.parseReport(sheet.rows);
    const docs = pkg.documents.flatMap((d) => d.documents || []);
    if (
      !report.documents.some((d) => docs.some((x) => C.code(x) === C.code(d)))
    )
      throw Error("Primero vinculá el CSV_2 o CSV del documento del Reporte");
    if (
      report.warehouses.length !== 1 ||
      report.warehouses[0] !== pkg.inventory.warehouse
    )
      throw Error("El reporte contiene otro almacén");
    pkg = await uploadDocument(
      file,
      "reporte",
      { documents: report.documents },
      report,
    );
    renderStep();
    toast("Reporte incorporado conservando las etapas de conteo y recuento");
  }
  async function update(action, payload) {
    pkg = await rpc(action, { inventory_id: pkg.inventory.id, ...payload });
    await S.savePackage(user.id, pkg);
    renderStep();
  }
  async function memberScreen() {
    view = "members";
    members = await rpc("members");
    $("app").innerHTML =
      `<div class="heading"><div><p class="eyebrow">Finanzas</p><h1>Usuarios y permisos</h1><p class="muted">Aprobá solicitudes y asigná los almacenes autorizados. La clave de empresa no otorga permisos.</p></div>${button("dashboard", "Volver")}</div>${members.map((m, k) => `<form class="card member-form" data-index="${k}"><h3>${h(m.name)} ${!m.approved ? '<span class="pill">Pendiente</span>' : ""}</h3><div class="grid"><label>Rol<select name="role">${["responsable", "auditor", "supervisor", "finanzas"].map((r) => option(r, r, m.role)).join("")}</select></label>${field("Almacenes, separados por coma", "warehouses", m.warehouses.join(", "))}</div><label class="check"><input name="approved" type="checkbox" ${m.approved ? "checked" : ""}>Acceso aprobado</label><label class="check"><input name="can_manage" type="checkbox" ${m.can_manage ? "checked" : ""}>Puede gestionar inventarios de sus almacenes</label><button>Guardar permisos</button></form>`).join("")}`;
    document.querySelectorAll(".member-form").forEach(
      (f) =>
        (f.onsubmit = (e) => {
          e.preventDefault();
          guarded(async () => {
            const v = new FormData(f);
            await rpc("save_member", {
              user_id: members[+f.dataset.index].user_id,
              role: v.get("role"),
              approved: v.get("approved") === "on",
              can_manage: v.get("can_manage") === "on",
              warehouses: v
                .get("warehouses")
                .split(",")
                .map((x) => x.trim().toUpperCase())
                .filter(Boolean),
            });
            toast("Permisos guardados");
            await memberScreen();
          });
        }),
    );
  }
  async function activity() {
    const rows = await rpc("activity", { inventory_id: pkg.inventory.id });
    $("step-content").innerHTML =
      `<section class="card"><div class="heading"><div><h2>Actividad recibida</h2><p class="muted">Últimos 1.000 eventos. La actividad sin conexión aparece cuando el dispositivo sincroniza. La ubicación es la informada por el dispositivo.</p></div>${button("return-step", "Volver al paso")}</div><label class="check"><input id="late-sync" type="checkbox" ${pkg.inventory.allow_late_sync ? "checked" : ""}>Permitir recibir cargas de otro día (revisión del supervisor)</label><div class="table-wrap"><table class="activity"><thead><tr><th>Usuario / función</th><th>Acción y cantidad</th><th>Dispositivo / secuencia</th><th>Hora dispositivo</th><th>Recibido</th><th>Ubicación y sector</th></tr></thead><tbody>${rows
        .map((e) => {
          const gps = e.payload.gps;
          return `<tr><td>${h(e.name)}<small>${h(e.actor)}</small></td><td>${h(e.action)}<small>${h(e.item_id || "")} ${e.after_quantity != null ? n(e.before_quantity) + " → " + n(e.after_quantity) : ""}</small></td><td>${h(e.device_id.slice(0, 8))}<small>#${h(e.client_sequence)}</small></td><td>${date(e.occurred_at)}</td><td>${date(e.received_at)}</td><td>${gps ? `${n(gps.latitude)}, ${n(gps.longitude)}<small>Precisión ±${n(gps.accuracy)} m · ${date(gps.acquired_at)}</small>` : h(e.payload.gps_status || "Sin ubicación")}<small>Sector: ${h(e.payload.sector || "Sin especificar")}</small></td></tr>`;
        })
        .join("")}</tbody></table></div></section>`;
    $("late-sync").onchange = (e) =>
      guarded(() => update("late_sync", { enabled: e.target.checked }));
  }
  async function handle(action, b) {
    if (action === "change-company") {
      sessionStorage.removeItem("empresa_nombre");
      sessionStorage.removeItem("empresa_validada");
      location.assign("/");
      return;
    }
    if (action === "login") return auth();
    if (action === "register") return auth(true);
    if (action === "refresh-profile") return enter(user);
    if (action === "dashboard") return dashboard();
    if (action === "members") return memberScreen();
    if (action === "new") {
      pkg = emptyPackage();
      step = 0;
      setActor();
      return render();
    }
    if (action === "open") return openInventory(b.dataset.id);
    if (action === "return-step") return renderStep();
    if (action === "activity") return activity();
    if (action === "step" || action === "back" || action === "next") {
      if (active) await pause();
      if (step < 4 && pkg.manager && pkg.inventory.status !== "closed")
        await save();
      step =
        action === "step"
          ? +b.dataset.step
          : step + (action === "next" ? 1 : -1);
      return render();
    }
    if (action === "save-exit") {
      if (active) await pause();
      if (step < 4 && pkg.inventory.status !== "closed") await save();
      return dashboard();
    }
    if (action === "schedule" || action === "publish") {
      await save(action === "schedule" ? "scheduled" : "ready");
      toast(
        action === "publish" ? "Conteo habilitado" : "Inventario programado",
      );
      return render();
    }
    if (action === "start") return start();
    if (action === "pause") return pause();
    if (action === "finish") {
      if (ownRows().length !== pkg.inventory.items.length)
        throw Error(
          "Hay productos sin contar. Ingresá cero cuando corresponda",
        );
      if (active) await pause();
      await record("finish");
      stopGPS();
      renderStep();
      return toast(
        "Conteo entregado. Las cargas locales se enviarán al recuperar conexión.",
      );
    }
    if (action === "correct") {
      if (!active) throw Error("Iniciá el conteo para corregir");
      const i = pkg.inventory.items.find((i) => i.id === b.dataset.id),
        row = ownRows().find((c) => c.item_id === i.id);
      $("quantity-area").innerHTML =
        `<form id="correction-form" class="correction"><strong>Corregir ${h(i.name)} · ${h(i.lot)}</strong><p>Total actual: ${row ? n(row.quantity) : "sin contar"}</p><div class="inline"><label>Acción<select name="mode"><option value="subtract">Restar cantidad</option><option value="set">Establecer total</option></select></label><label>Cantidad<input name="value" inputmode="decimal" required></label><button>Guardar corrección</button>${button("cancel-correction", "Cancelar")}</div></form>`;
      $("correction-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(async () => {
          const f = new FormData(e.target);
          await addQuantity(f.get("mode"), f.get("value"), i.id);
        });
      };
      $("quantity-area").scrollIntoView({ block: "center" });
      $("correction-form").elements.namedItem("value").focus();
      return;
    }
    if (action === "cancel-correction") {
      $("quantity-area").innerHTML = "";
      return $("search").focus();
    }
    if (action === "approve-batch") {
      $("batch-area").innerHTML =
        `<form id="batch-form" class="card"><h3>Autorizar cantidades desde un conteo entregado</h3><p>Revisá el comparativo antes de confirmar. Las diferencias quedan marcadas «Para revisar» y podés ajustar cada autorización después.</p><label>Conteo de origen<select name="source">${pkg.inventory.assignments.map((a) => option(a.user_id + ":" + a.actor, a.actor + " · " + (names()[a.user_id] || a.user_id), "")).join("")}</select></label>${field("Criterio de autorización", "comment", "", "text", "required")}<button>Autorizar cantidades del conteo seleccionado</button></form>`;
      $("batch-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(async () => {
          const f = new FormData(e.target),
            [uid, role] = f.get("source").split(":"),
            approvals = pkg.inventory.items.map((i) => {
              const row = pkg.counts.find(
                (c) =>
                  c.user_id === uid && c.actor === role && c.item_id === i.id,
              );
              if (!row) throw Error("El conteo de origen está incompleto");
              return {
                item_id: i.id,
                quantity: row.quantity,
                reason:
                  pkg.reference[i.id]?.stock === row.quantity
                    ? "Cuadra"
                    : "Para revisar",
                comment: role + ": " + f.get("comment"),
              };
            });
          await update("approve_many", { approvals });
          toast("Cantidades autorizadas con el criterio registrado");
        });
      };
      return;
    }
    if (action === "review-conflict") {
      const event = await S.get("events", b.dataset.id),
        fresh = await rpc("open", { inventory_id: pkg.inventory.id }),
        row = fresh.counts.find(
          (c) =>
            c.user_id === user.id &&
            c.actor === event.actor &&
            c.item_id === event.item_id,
        );
      $("pending-events").innerHTML =
        `<form id="conflict-form" class="card"><h3>Movimiento pendiente de revisión</h3><p>${h(event.action)} ${n(event.value)} · ${h(event.item_id || "")}<br>Total recibido por el servidor: ${row ? n(row.quantity) : "Sin contar"}<br>${h(event.error)}</p><p>Podés reintentar después de que el supervisor reabra el inventario o habilite la recepción tardía. Si descartás este movimiento, se conserva en el historial y luego podés ingresar una corrección nueva.</p>${field("Motivo del descarte", "reason", "", "text", 'required minlength="3"')}<button>Registrar descarte en el historial</button>${button("retry-event", "Reintentar sincronización")}</form>`;
      $("conflict-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(async () => {
          const { owner, status, error, ...original } = event;
          await rpc("discard_event", {
            inventory_id: pkg.inventory.id,
            event: original,
            reason: new FormData(e.target).get("reason"),
          });
          await Y.serial(() => S.acknowledge(event.id));
          pkg = await Y.refresh(user.id, rpc, pkg.inventory.id);
          renderStep();
          toast(
            "Descarte registrado. Revisá el total antes de ingresar la corrección.",
          );
        });
      };
      return;
    }
    if (action === "retry-event") {
      await sync();
      return renderStep();
    }
    if (action === "approve") {
      const r = C.comparison(pkg).find((r) => r.id === b.dataset.id);
      $("approve-area").innerHTML =
        `<form id="approve-form" class="card"><h3>${h(r.name)} · ${h(r.lot || "Sin lote")}</h3><div class="grid">${field("Cantidad autorizada", "quantity", r.approved ?? "", "text", 'required inputmode="decimal"')}<label>Motivo<select name="reason">${C.REASONS.map((reason) => option(reason, reason, r.reason)).join("")}</select></label>${field("Criterio / descargo de autorización", "comment", r.comment, "text", "required")}</div><button>Autorizar cantidad</button></form>`;
      $("approve-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(async () => {
          const f = new FormData(e.target);
          await update("approve", {
            item_id: r.id,
            quantity: C.number(f.get("quantity")),
            reason: f.get("reason"),
            comment: f.get("comment"),
          });
          toast("Cantidad autorizada");
        });
      };
      $("approve-area").scrollIntoView({ block: "center" });
      return;
    }
    if (action === "reopen")
      return update("reopen", { assignment: b.dataset.assignment });
    if (action === "xlsx") return E.workbook(pkg);
    if (action === "acta") {
      const blob = await E.acta(pkg, names());
      if (navigator.onLine) {
        const file = new File(
          [blob],
          `Acta_Enjoy_${pkg.inventory.warehouse}_${pkg.inventory.scheduled_date}.docx`,
          { type: blob.type },
        );
        pkg = await uploadDocument(file, "acta", {});
        renderStep();
      }
      return;
    }
    if (action === "count-xlsx") {
      const wb = XLSX.utils.book_new();
      const rows = pkg.inventory.items.map((i) => ({
        Material: i.rawCode,
        Descripción: i.name,
        Almacén: i.warehouse,
        Lote: i.lot,
        Unidad: i.unit,
        Conteo: ownRows().find((c) => c.item_id === i.id)?.quantity ?? null,
        ...(pkg.see_stock ? { Stock: pkg.reference[i.id]?.stock ?? null } : {}),
      }));
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(rows),
        "Mi conteo",
      );
      return E.download(
        XLSX.write(wb, { bookType: "xlsx", type: "array" }),
        "Enjoy_mi_conteo.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    }
    if (action === "download-original") {
      const d = pkg.documents[+b.dataset.index],
        { data, error } = await db.storage
          .from("enjoy-inventarios")
          .download(d.path);
      if (error) throw error;
      return E.download(data, d.name, data.type);
    }
    if (action === "export-csv") {
      if (
        pkg.inventory.assignments.some(
          (a) => !pkg.submissions[a.user_id + ":" + a.actor]?.submitted,
        )
      )
        throw Error("Primero deben entregarse todos los conteos");
      const d = pkg.documents[+b.dataset.index],
        format = (s) => s.split("-").reverse().join("."),
        text = C.exportSap(d.sap, pkg.inventory.items, pkg.approvals, {
          countDate: format(
            document.querySelector('[name="count-date"]').value,
          ),
          entryDate: format(
            document.querySelector('[name="entry-date"]').value,
          ),
        }),
        file = new File(
          [C.encode1252(text)],
          d.name.replace(/\.csv$/i, "_completo.csv"),
          { type: "text/csv" },
        );
      pkg = await uploadDocument(file, d.kind, {
        documents: d.documents,
        generated: true,
      });
      E.download(file, file.name, file.type);
      return renderStep();
    }
    if (action === "consolidate") {
      const all = await rpc("list");
      $("step-content").innerHTML =
        `<section class="card"><h2>Consolidar AL05</h2><p>Seleccioná inventarios de la misma fecha con bases de mercadería diferentes. El archivo conserva el origen de cada lote.</p><form id="consolidate-form">${all
          .filter(
            (i) =>
              i.warehouse === "AL05" &&
              i.scheduled_date === pkg.inventory.scheduled_date,
          )
          .map(
            (i) =>
              `<label class="check"><input type="checkbox" name="inventory" value="${i.id}">${h(i.title)} · ${h(i.status)}</label>`,
          )
          .join("")}<button>Descargar consolidado</button></form></section>`;
      $("consolidate-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(async () => {
          const ids = new FormData(e.target).getAll("inventory");
          if (ids.length < 2)
            throw Error("Seleccioná al menos dos inventarios");
          const packages = [];
          for (const id of ids)
            packages.push(await rpc("open", { inventory_id: id }));
          const seen = new Set();
          for (const p of packages)
            for (const i of p.inventory.items) {
              if (seen.has(i.id))
                throw Error(
                  "Hay materiales y lotes presentes en más de un inventario. Revisá la base para evitar duplicar cantidades.",
                );
              seen.add(i.id);
            }
          E.consolidated(packages);
        });
      };
      return;
    }
    if (action === "close") {
      if (!$("close-confirm").checked)
        throw Error("Confirmá la revisión final");
      await update("close", { confirmed: true });
      toast("Inventario cerrado");
    }
  }
  document.addEventListener("click", (e) => {
    const result = e.target.closest("[data-result]");
    if (result) {
      chooseResult(+result.dataset.result, true);
      return;
    }
    const b = e.target.closest("[data-action]");
    if (b) guarded(() => handle(b.dataset.action, b));
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-barcode]"))
      pkg.inventory.items[+e.target.dataset.barcode].barcode =
        e.target.value.trim();
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id === "adjust-form") {
      e.preventDefault();
      guarded(async () => {
        const f = new FormData(e.target),
          item = pkg.inventory.items.find((i) => i.id === f.get("item")),
          executed = f.get("executed") === "on";
        if (executed && !f.get("evidence").trim())
          throw Error("Indicá el documento o evidencia del ajuste ejecutado");
        await update("adjustments", {
          adjustments: [
            ...pkg.adjustments,
            {
              id: crypto.randomUUID(),
              code: item.code,
              lot: item.lot,
              item_id: item.id,
              quantity: C.number(f.get("quantity")),
              executed,
              date: f.get("date"),
              evidence: f.get("evidence"),
              recorded_at: new Date().toISOString(),
            },
          ],
        });
      });
    }
  });
  $("home").onclick = () =>
    guarded(async () => {
      if (active) await pause();
      await dashboard();
    });
  $("sync").onclick = () =>
    guarded(async () => {
      await sync();
      if (view === "dashboard") await dashboard();
      toast("Sincronización revisada");
    });
  $("logout").onclick = () =>
    guarded(async () => {
      if (active) await pause();
      await sync();
      await S.clearOwner(user.id);
      await db.auth.signOut();
      localStorage.removeItem(identityKey);
      user = null;
      profile = null;
      pkg = null;
      await status();
      auth();
    });
  window.addEventListener("online", () => {
    status();
    sync();
  });
  window.addEventListener("offline", status);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && active) {
      record("pause").catch(() => {});
      stopGPS();
    } else if (!document.hidden && view === "inventory" && step === 4)
      renderStep();
  });
  window.addEventListener("pagehide", () => EnjoyGPS.stop());
  setInterval(() => {
    if (
      user &&
      view === "dashboard" &&
      navigator.onLine &&
      !document.hidden &&
      !busy
    )
      dashboard().catch((e) => toast(e.message));
    if (user) sync().catch(() => {});
    if ($("gps-status"))
      $("gps-status").textContent =
        "Ubicación: " +
        EnjoyGPS.get().state +
        ". Registro automático durante el conteo activo.";
  }, 30000);
  if ("serviceWorker" in navigator)
    navigator.serviceWorker
      .register("/enjoy/sw.js", { scope: "/enjoy/" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        if ($("offline-ready"))
          $("offline-ready").textContent =
            "Aplicación preparada · Verificá que tu inventario figure como disponible.";
      })
      .catch(() =>
        toast(
          "No se pudo preparar el inicio sin conexión. Mantené esta pantalla abierta y reintentá con conexión.",
        ),
      );
  if (
    window.EnjoyDemo ||
    sessionStorage.getItem("empresa_nombre") === "ENJOY" ||
    localStorage.getItem(identityKey)
  )
    bootAuth().catch((e) => toast(e.message));
  else gate();
})();
