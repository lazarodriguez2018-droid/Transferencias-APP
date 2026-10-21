/* Enjoy company boundary. All authorization and blind-data filtering live in enjoy_api. */
(function () {
  "use strict";
  const C = EnjoyCore,
    P = EnjoyParticipants,
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
    mode = "count",
    dashboardArea = "counts",
    highlightExplicit = false,
    completion = "",
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
    $("app").setAttribute("aria-busy", "true");
    for (const id of ["home", "logout", "sync"]) $(id).disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
      $("app").setAttribute("aria-busy", "false");
      for (const id of ["home", "logout", "sync"]) $(id).disabled = false;
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
            options: {
              data: { company: "ENJOY", name: f.get("name") },
              emailRedirectTo:
                location.origin +
                location.pathname +
                (location.hash.startsWith("#unirse/")
                  ? "?unirse=" + encodeURIComponent(location.hash.slice(8))
                  : ""),
            },
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
    await routeFromLocation();
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
          await routeFromLocation();
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
          await routeFromLocation();
          return;
        }
      }
      toast(e.message);
      auth();
    }
  }
  function route(name, id, replace = false) {
    const hash = "#" + name + (id ? "/" + id : "");
    if (location.hash !== hash)
      history[replace ? "replaceState" : "pushState"](null, "", hash);
  }
  const assigned = (i) =>
    i.assigned_to_me ??
    (Array.isArray(i.assignments)
      ? i.assignments.some((a) => a.user_id === user.id)
      : !manager());
  async function routeFromLocation() {
    const callback = new URL(location.href),
      invitation = callback.searchParams.get("unirse");
    if (invitation) {
      callback.searchParams.delete("unirse");
      callback.hash = "#unirse/" + encodeURIComponent(invitation);
      history.replaceState(null, "", callback);
    }
    const [name, id] = location.hash.slice(1).split("/");
    if (name === "unirse" && id) return joinScreen(id);
    if (name === "configuracion" && id === "nuevo" && manager()) {
      pkg = emptyPackage();
      mode = "configure";
      step = 0;
      setActor();
      return render();
    }
    if (id && ["conteo", "configuracion", "resultados"].includes(name))
      return openInventory(
        id,
        { conteo: "count", configuracion: "configure", resultados: "results" }[
          name
        ],
      );
    dashboardArea = name === "administracion" && manager() ? "admin" : "counts";
    return dashboard();
  }
  async function dashboard() {
    stopGPS();
    pkg = null;
    view = "dashboard";
    mode = "count";
    if (!manager()) dashboardArea = "counts";
    route(dashboardArea === "admin" ? "administracion" : "conteos");
    if (navigator.onLine) {
      list = await rpc("list");
      members = await rpc("members");
    } else list = (await S.packages(user.id)).map((p) => p.inventory);
    const cache = await S.packages(user.id),
      ids = new Set(cache.map((p) => p.inventory.id)),
      admin = dashboardArea === "admin",
      visible = admin ? list : list.filter(assigned);
    $("home").textContent = "Mis inventarios";
    $("app").className = "";
    $("app").innerHTML =
      `<div class="heading"><div><p class="eyebrow">Enjoy · ${h(profile.name)}</p><h1>${admin ? "Preparar y revisar inventarios" : "Mis conteos"}</h1><p class="muted">${admin ? "Creá el inventario, asigná a las personas y revisá los resultados cuando entreguen su conteo." : "Abrí una tarea asignada y dedicá la pantalla a contar."}</p></div>${admin ? `<div class="actions">${button("new", "+ Crear inventario", "")}${profile.role === "finanzas" ? button("members", "Usuarios y permisos") : ""}</div>` : ""}</div>${manager() ? `<nav class="workspace-tabs" aria-label="Áreas de trabajo">${button("dashboard-counts", "Mis conteos", !admin ? "active" : "secondary")}${button("dashboard-admin", "Preparación y resultados", admin ? "active" : "secondary")}</nav>` : ""}<div class="grid">${visible.map((i) => `<article class="card inventory-card"><div class="row-open"><span class="pill">${h(i.status === "ready" ? "Listo para contar" : i.status === "scheduled" ? "Programado" : i.status === "closed" ? "Finalizado" : "En preparación")}</span><small>${h(i.warehouse)}</small></div><h2 style="margin-top:16px">${h(i.title)}</h2><p class="muted">${h(i.scheduled_date)} · ${i.procedure === "principal" ? "Inventario principal" : "Inventario de almacén"}</p><div class="actions">${admin ? `${button("open-configure", "Configuración", "secondary", `data-id="${i.id}"`)}${button("open-results", "Resultados y SAP", "", `data-id="${i.id}"`)}` : button("open", i.status === "closed" ? "Ver mi conteo" : "Abrir conteo", "", `data-id="${i.id}"`)}</div>${!admin ? `<small>${ids.has(i.id) ? "Disponible en este dispositivo" : "Se descarga al abrir con conexión"}</small>` : ""}</article>`).join("") || `<div class="card empty">${admin ? "Todavía no hay inventarios. Creá el primero para preparar las tareas." : "No tenés conteos disponibles. Los programados aparecerán en la fecha asignada."}</div>`}</div>${!admin ? `<div class="card offline-info"><h3>Continuá también sin conexión</h3><p class="muted">Abrí tu conteo con conexión antes de ir al almacén. Cada cantidad se guarda en este dispositivo y se envía al recuperar la señal.</p><div id="offline-ready"></div></div>` : ""}`;
    await status();
    const registration =
      await navigator.serviceWorker?.getRegistration("/enjoy/");
    if ($("offline-ready"))
      $("offline-ready").textContent = registration?.active
        ? "Aplicación preparada para abrir sin conexión."
        : "Preparando la aplicación. Mantené esta pantalla abierta con conexión.";
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
  async function openInventory(id, target = "count") {
    stopGPS();
    const cached = await S.get("packages", user.id + "|" + id);
    if (navigator.onLine) pkg = await Y.refresh(user.id, rpc, id);
    else {
      if (!cached)
        throw Error("Descargá este inventario antes de trabajar sin conexión");
      pkg = cached;
    }
    navigator.storage?.persist?.().catch(() => {});
    if (target !== "count" && !pkg.manager)
      throw Error("No tenés acceso a la gestión de este inventario");
    if (
      target === "count" &&
      !pkg.inventory.assignments.some((a) => a.user_id === user.id)
    )
      throw Error("Este inventario no tiene un conteo asignado a tu usuario");
    mode = target;
    step = mode === "configure" ? 0 : mode === "results" ? 5 : 4;
    route(
      { count: "conteo", configure: "configuracion", results: "resultados" }[
        mode
      ],
      id,
    );
    setActor();
    render();
    await status();
  }
  function setActor() {
    const own = pkg.inventory.assignments.filter((a) => a.user_id === user.id);
    actor = own.some((a) => a.actor === actor) ? actor : own[0]?.actor || "";
    selected = null;
    results = [];
    completion = "";
    highlightExplicit = false;
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
    Object.fromEntries(
      [...(pkg?.inventory.assignments || []), ...members].map((m) => [
        m.user_id,
        m.name,
      ]),
    );
  function myParticipation() {
    return pkg?.inventory.assignments.find((a) => a.user_id === user.id);
  }
  async function joinScreen(token) {
    stopGPS();
    view = "join";
    pkg = null;
    $("app").className = "";
    $("app").innerHTML =
      `<section class="card auth"><p class="eyebrow">Enjoy · Invitación</p><h1>Unirme al inventario</h1><div id="join-info"><p>Comprobando el enlace…</p></div>${button("dashboard-counts", "Mis inventarios", "quiet")}</section>`;
    try {
      const inv = await rpc("join", { token });
      $("join-info").innerHTML =
        `<h2>${h(inv.title)}</h2><p>${h(inv.warehouse)} · ${h(inv.scheduled_date)}</p><p>Entrás como ${h(profile.name)}. Tu conteo se guarda por separado.</p>${button("confirm-join", "Unirme y abrir inventario", "", `data-token="${h(token)}"`)}`;
    } catch (e) {
      $("join-info").innerHTML =
        `<p class="warning">${h(e.message)}</p>${button("retry-join", "Volver a comprobar", "secondary", `data-token="${h(token)}"`)}`;
    }
  }
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
    if (
      step === 1 &&
      !pkg.started &&
      !pkg.counts.length &&
      i.status !== "closed"
    ) {
      i.mb52_date = values.get("mb52_date");
      i.sap_blocked = values.get("sap_blocked") === "on";
      i.sap_blocked_at = values.get("sap_blocked_at");
    }
    if (step === 2 && i.status !== "closed") {
      i.assignments = [...f.querySelectorAll("[data-participant]")].map(
        (row) => {
          const prev =
            i.assignments.find((a) => a.user_id === row.dataset.participant) ||
            {};
          const participation = row.querySelector(
            '[data-field="participation"]',
          ).value;
          return {
            ...prev,
            user_id: row.dataset.participant,
            actor: row.querySelector('[data-field="actor"]').value,
            counts_enabled: participation === "count",
            absent: participation === "absent",
            see_stock: row.querySelector('[data-field="stock"]').checked,
          };
        },
      );
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
      participant_change_reason: $("participant-change-reason")?.value || "",
    });
    await S.savePackage(user.id, pkg);
    if (mode === "configure") route("configuracion", pkg.inventory.id, true);
    setActor();
  }
  function areaSteps() {
    return mode === "configure"
      ? [0, 1, 2, 3]
      : mode === "results"
        ? [5, 6, 7]
        : [4];
  }
  function render() {
    view = "inventory";
    const inv = pkg.inventory,
      allowed = areaSteps();
    if (!allowed.includes(step)) step = allowed[0];
    $("home").textContent = mode === "count" ? "Mis conteos" : "Inventarios";
    $("app").className =
      mode === "count" ? "count-workspace" : "management-workspace";
    const title =
      mode === "count"
        ? "Conteo"
        : mode === "configure"
          ? "Configuración del inventario"
          : "Resultados y SAP";
    $("app").innerHTML =
      `<div class="heading"><div><p class="eyebrow">${title} · ${h(inv.warehouse)} · ${h(inv.scheduled_date)}</p><h1>${h(inv.title || "Nuevo inventario")}</h1><small>${mode === "count" ? "Buscá, seleccioná y sumá cantidades." : mode === "configure" ? "Prepará la base y las asignaciones antes de comenzar a contar." : "Compará las planillas y generá los archivos de cierre."}</small></div>${mode === "results" ? button("activity", "Actividad y ubicación") : ""}</div>${mode !== "count" ? `<nav class="steps" aria-label="${mode === "configure" ? "Pasos de configuración" : "Pasos de resultados"}">${allowed.map((n, k) => button("step", `${k + 1}. ${C.STEPS[n]}`, n === step ? "active" : "", `data-step="${n}"`)).join("")}</nav>` : ""}<div id="step-content"></div>${mode !== "count" ? `<div class="footer"><div>${step > allowed[0] ? button("back", "← Atrás") : ""}</div><div class="inline">${button("save-exit", mode === "configure" ? "Guardar y salir" : "Volver a inventarios")}${step < allowed.at(-1) ? button("next", "Siguiente →", "") : ""}</div></div>` : ""}`;
    renderStep();
  }
  function renderStep() {
    const inv = pkg.inventory,
      locked = pkg.started || pkg.counts.length || inv.status === "closed",
      off = locked ? "disabled" : "";
    let content = "";
    if (step === 0)
      content = `<section class="card"><h2>1. Datos del inventario</h2><p class="muted">Programá primero la tarea. La base MB52 definitiva se incorpora el día del inventario principal.</p><form id="wizard-form"><div class="grid">${field("Nombre del inventario", "title", inv.title, "text", "required")}${field("Almacén", "warehouse", inv.warehouse, "text", `required ${off}`)}${field("Fecha de conteo", "scheduled_date", inv.scheduled_date, "date", `required ${off}`)}<label>Procedimiento<select name="procedure" ${off}>${option("principal", "Principal · circuito SAP completo", inv.procedure)}${option("otro", "Otro · configurable", inv.procedure)}</select></label></div></form><small>AL04, AL05, AL02 y AL12 usan el procedimiento principal.</small></section>`;
    if (step === 1)
      content = `<section class="card"><h2>2. Mercadería de MB52</h2><p class="muted">Se conserva cada material, lote, centro y unidad. Los productos con stock teórico cero no se incluyen.</p><form id="wizard-form"><div class="grid"><label class="file">Importar Excel MB52<input id="mb52-file" type="file" accept=".xlsx,.xls" ${off}></label>${field("Fecha de extracción de MB52", "mb52_date", inv.mb52_date, "date", off)}${field("Fecha y hora de bloqueo en SAP", "sap_blocked_at", inv.sap_blocked_at, "datetime-local", off)}</div><label class="check"><input type="checkbox" name="sap_blocked" ${inv.sap_blocked ? "checked" : ""} ${off}>Confirmo que SAP bloqueó los movimientos del almacén</label></form><small>La aplicación registra la confirmación. El bloqueo se realiza en SAP al generar sus documentos.</small><div class="kpis"><div class="kpi"><strong>${inv.items.length}</strong><span>Materiales y lotes</span></div><div class="kpi"><strong>${Object.keys(pkg.reference).filter((k) => pkg.reference[k].stock != null).length}</strong><span>Con stock de referencia</span></div></div>${merchTable(locked)}</section>`;
    if (step === 2) content = participantsHTML();
    if (step === 3)
      content = `<section class="card"><h2>4. Programación y publicación</h2><p>${h(inv.items.length)} productos · ${h(inv.assignments.length)} participantes · ${h(inv.assignments.filter(P.counts).length)} cuentan · ${h(inv.scheduled_date)}</p><form id="wizard-form"><label>Observaciones de gestión<textarea name="management_notes">${h(inv.management_notes)}</textarea></label></form><div class="actions">${button("schedule", "Programar tarea")}${button("publish", "Habilitar conteo", "")}</div><small>Cada usuario tendrá su propia pantalla y su propio conteo. La tarea aparece en la fecha asignada. Para habilitar un principal se requiere MB52 de ese día y confirmación del bloqueo en SAP.</small></section>`;
    if (step === 4) {
      $("step-content").innerHTML = countHTML();
      bindCount();
      return;
    }
    if (step === 5) content = reviewHTML();
    if (step === 6) content = sapHTML();
    if (step === 7) content = closeHTML();
    $("step-content").innerHTML = content;
    if ($("invitation-qr")) drawInvitation();
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
  function participantsHTML() {
    const inv = pkg.inventory,
      closed = inv.status === "closed",
      off = closed ? "disabled" : "",
      eligible = members.filter(
        (m) =>
          m.approved &&
          (m.warehouses.includes(inv.warehouse) || m.role === "finanzas") &&
          !inv.assignments.some((a) => a.user_id === m.user_id),
      );
    return `<section class="card"><h2>3. Personas que participan</h2><p class="muted">Agregá tantas personas como necesites. El rol y la participación se eligen por separado: ser responsable o auditor no obliga a contar.</p><form id="wizard-form"><div class="participant-list">${
      inv.assignments
        .map((a, k) => {
          const hasWork = pkg.counts.some((c) => c.user_id === a.user_id),
            participation = a.absent
              ? "absent"
              : P.counts(a)
                ? "count"
                : "observe";
          return `<div class="participant-row" data-participant="${h(a.user_id)}"><strong>${h(a.name || names()[a.user_id] || a.user_id)}</strong><div class="grid"><label>Rol en este inventario<select data-field="actor" ${closed || hasWork ? "disabled" : ""}>${Object.entries(
            P.roles,
          )
            .map(([v, l]) => option(v, l, a.actor))
            .join(
              "",
            )}</select></label><label>Participación<select data-field="participation" ${off}>${option("count", "Cuenta productos", participation)}${option("observe", "Participa sin contar", participation)}${option("absent", "No participa / Ausente", participation)}</select></label></div><label class="check"><input type="checkbox" data-field="stock" ${a.see_stock ? "checked" : ""} ${off}>Puede ver stock y valor MB52</label>${!closed && !pkg.started && !pkg.counts.length ? button("remove-participant", "Quitar persona", "quiet", `data-index="${k}"`) : ""}</div>`;
        })
        .join("") ||
      '<p class="empty">Todavía no agregaste personas. Podés asignarlas aquí o permitir que se unan por enlace/QR.</p>'
    }</div>${pkg.started || pkg.counts.length ? field("Motivo si cambiás participantes o su participación", "participant_change_reason", "", "text", 'id="participant-change-reason" placeholder="Ej. el auditor no asistió"') : ""}</form>${!closed ? `<div class="inline add-participant"><label>Agregar usuario<select id="participant-user">${option("", "Seleccionar una persona", "")}${eligible.map((m) => option(m.user_id, m.name, "")).join("")}</select></label>${button("add-participant", "Agregar participante")}</div>` : ""}<p class="muted">Solo se solicita entregar el conteo a quienes figuran como «Cuenta productos». Los conteos se comparan por persona y no se suman automáticamente.</p><div class="warning">Quien tenga conteo ciego recibe productos sin stock ni valores. Finanzas conserva su acceso de gestión.</div></section>${invitationHTML()}`;
  }
  function invitationHTML() {
    const invite = pkg.invitation,
      closed = pkg.inventory.status === "closed";
    return `<section class="card"><h2>Unirse por enlace o QR</h2>${window.EnjoyDemo ? '<p class="warning">En esta demostración, probá el enlace en este mismo navegador. Compartir entre dispositivos requiere la versión conectada.</p>' : ""}<p class="muted">Cada persona entra con su propio usuario aprobado y habilitado para este almacén. Al unirse, puede contar sin ver el stock. Después podés ajustar su rol y participación.</p>${!closed ? button("toggle-invitation", invite?.enabled ? "Desactivar enlace" : "Habilitar enlace y QR", "secondary") : ""}${invite?.enabled ? `<label>Enlace de este inventario<input id="invitation-link" readonly value="${h(EnjoyInvitations.url(invite.token))}"></label><div class="invite-layout"><div id="invitation-qr" class="invitation-qr" role="img" aria-label="QR para unirse a este inventario"></div><div class="actions">${button("copy-invitation", "Copiar enlace")}${button("download-qr", "Descargar QR")}${button("rotate-invitation", "Renovar enlace", "quiet")}</div></div><small>Renovar invalida el enlace anterior. Los participantes ya unidos conservan su acceso. Los nuevos ingresos se cierran al comenzar a autorizar cantidades.</small>` : ""}</section>`;
  }
  function drawInvitation() {
    $("invitation-qr").innerHTML = EnjoyInvitations.svg(
      EnjoyInvitations.url(pkg.invitation.token),
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
      participation = myParticipation(),
      rows = ownRows(),
      submitted = pkg.submissions[user.id + ":" + actor]?.submitted,
      can =
        P.counts(participation) &&
        inv.status === "ready" &&
        !submitted &&
        (inv.scheduled_date === C.today() || inv.allow_late_sync);
    return `<section class="card count-card"><div class="countbar"><div><h2>${P.counts(participation) ? "Mi conteo" : "Mi participación"}</h2><p class="muted participant-caption">${h(profile.name)} · ${h(P.roles[actor] || "Participante")}</p><small><span id="count-progress-text">${rows.length} de ${inv.items.length} productos contados</span> · ${pkg.see_stock ? "Stock visible" : "Conteo ciego"}</small></div>${actor && can ? button(active ? "pause" : "start", active ? "Pausar" : "Iniciar conteo", active ? "secondary" : "") : ""}</div><progress id="count-progress" value="${rows.length}" max="${inv.items.length || 1}"></progress>${!P.counts(participation) ? `<div class="warning">${participation?.absent ? "Figurás como ausente en este inventario." : "Participás sin obligación de contar. Si también vas a contar, el encargado puede habilitarlo en la configuración."}</div>` : submitted ? '<div class="warning">Conteo entregado. El supervisor puede reabrirlo si hace falta corregirlo.</div>' : !can ? '<div class="warning">El supervisor todavía no habilitó el conteo para esta fecha.</div>' : ""}${actor && can ? `<div class="lookup"><label for="search">¿Qué producto estás contando?</label><div class="autocomplete"><div id="search-ghost" class="search-ghost" aria-hidden="true"></div><input id="search" type="search" placeholder="Nombre, código o código de barras" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" ${!active ? "disabled" : ""} role="combobox" aria-autocomplete="both" aria-controls="results" aria-expanded="false"><button id="clear-search" type="button" aria-label="Borrar búsqueda" hidden>×</button></div><div id="search-popup" class="search-popup" hidden><p id="search-caption" class="search-caption"></p><ul id="results" class="results" role="listbox" aria-label="Productos sugeridos"></ul></div><p id="search-status" class="search-help" role="status">${active ? "Escribí para ver sugerencias. Enter elige el producto." : "Iniciá el conteo para buscar y sumar cantidades."}</p></div><div id="quantity-area"></div><p id="count-feedback" class="count-feedback" role="status"></p><details class="count-options"><summary>Ubicación y sector</summary><div class="grid"><label>Sector (opcional)<input id="sector" value="${h(sessionStorage.getItem("enjoy_sector_" + inv.id) || "")}" placeholder="Ej. cámara de frío"></label><p class="muted subtle" id="gps-status">Ubicación: ${h(EnjoyGPS.get().state)}. Se registra durante el conteo activo.</p></div></details>` : ""}<details class="count-history" open><summary>Productos y correcciones</summary><div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Producto</th>${pkg.see_stock ? "<th>Stock</th>" : ""}<th>Mi conteo</th><th>Corregir</th></tr></thead><tbody id="count-table">${countRows()}</tbody></table></div></details><div class="actions count-actions">${actor && can ? button("finish", "Entregar mi conteo", "") : ""}${button("count-xlsx", "Descargar mi conteo", "quiet")}</div></section><details class="card"><summary>Guardado y sincronización</summary><div id="pending-events"></div></details>`;
  }
  function updateProgress() {
    const rows = ownRows();
    if ($("count-progress")) $("count-progress").value = rows.length;
    if ($("count-progress-text"))
      $("count-progress-text").textContent =
        `${rows.length} de ${pkg.inventory.items.length} productos contados`;
  }
  function countRows() {
    return pkg.inventory.items
      .map((i) => {
        const c = ownRows().find((c) => c.item_id === i.id);
        return `<tr id="row-${pkg.inventory.items.indexOf(i)}"><td>${h(i.code)}<small>${h(i.lot || "Sin lote")} · ${h(i.unit)}</small></td><td>${h(i.name)}</td>${pkg.see_stock ? `<td>${n(pkg.reference[i.id]?.stock)}</td>` : ""}<td class="tabular">${c ? n(c.quantity) : "<small>Sin contar</small>"}</td><td>${P.counts(myParticipation()) && actor && pkg.inventory.status === "ready" && !pkg.submissions[user.id + ":" + actor]?.submitted ? button("correct", "Corregir", "quiet", `data-id="${h(i.id)}"`) : ""}</td></tr>`;
      })
      .join("");
  }
  function bindCount() {
    const search = $("search");
    search?.addEventListener("input", () => showResults(search.value));
    search?.addEventListener("focus", () => {
      if (active && !selected) showResults(search.value);
    });
    search?.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!results.length) showResults(search.value);
        highlight = Math.max(
          0,
          Math.min(
            results.length - 1,
            highlight + (e.key === "ArrowDown" ? 1 : -1),
          ),
        );
        highlightExplicit = true;
        drawResults();
        document
          .getElementById("suggestion-" + highlight)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        chooseResult(highlight, highlightExplicit);
      } else if (
        (e.key === "Tab" || e.key === "ArrowRight") &&
        completion &&
        search.selectionStart === search.value.length &&
        search.selectionEnd === search.value.length
      ) {
        e.preventDefault();
        search.value = completion;
        showResults(search.value);
        search.setSelectionRange(search.value.length, search.value.length);
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearLookup();
      }
    });
    $("clear-search")?.addEventListener("click", clearLookup);
    $("sector")?.addEventListener("change", (e) =>
      sessionStorage.setItem(
        "enjoy_sector_" + pkg.inventory.id,
        e.target.value,
      ),
    );
    pendingHTML();
    if (active) search?.focus();
  }
  function clearLookup() {
    selected = null;
    results = [];
    completion = "";
    highlightExplicit = false;
    if ($("quantity-area")) $("quantity-area").innerHTML = "";
    const search = $("search");
    if (search) {
      search.value = "";
      search.focus();
      showResults("");
    }
  }
  function closeSuggestions() {
    if ($("search-popup")) $("search-popup").hidden = true;
    if ($("search-ghost")) $("search-ghost").innerHTML = "";
    $("search")?.setAttribute("aria-expanded", "false");
    $("search")?.removeAttribute("aria-activedescendant");
    completion = "";
  }
  function showResults(query) {
    highlight = 0;
    highlightExplicit = false;
    selected = null;
    $("quantity-area").innerHTML = "";
    if (query.trim())
      results = EnjoyFinder.find(index, query, SucaneitorSearch);
    else {
      const recent = ownRows()
        .slice()
        .sort((a, b) =>
          String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
        )
        .map((c) => pkg.inventory.items.find((i) => i.id === c.item_id))
        .filter(Boolean);
      results = recent.slice(0, 5);
    }
    drawResults();
  }
  function marked(text, query) {
    return EnjoyFinder.segments(text, query)
      .map((p) => (p.match ? `<mark>${h(p.text)}</mark>` : h(p.text)))
      .join("");
  }
  function drawResults() {
    const search = $("search"),
      query = search.value.trim(),
      el = $("results");
    el.innerHTML = results
      .map((i, k) => {
        const row = ownRows().find((c) => c.item_id === i.id);
        return `<li id="suggestion-${k}" role="option" aria-selected="${k === highlight}" class="${k === highlight ? "selected" : ""}"><button type="button" data-result="${k}" tabindex="-1"><span class="suggestion-main"><strong>${marked(i.name, query)}</strong><small>${marked(i.code, query)} · ${h(i.unit)}${i.barcode ? ` · Barras ${marked(i.barcode, query)}` : ""}</small></span><span class="suggestion-side"><span class="lot-tag">${h(i.lot || "Sin lote")}</span><small>${row ? "Contado: " + n(row.quantity) : "Sin contar"}</small></span></button></li>`;
      })
      .join("");
    $("search-popup").hidden = !results.length;
    search.setAttribute("aria-expanded", String(results.length > 0));
    if (results[highlight])
      search.setAttribute("aria-activedescendant", "suggestion-" + highlight);
    else search.removeAttribute("aria-activedescendant");
    $("search-caption").textContent = query
      ? "Elegí el producto y su lote"
      : "Usados recientemente";
    $("search-status").textContent = query
      ? results.length
        ? `${results.length} sugerencias · ↑ ↓ elegir · Enter cantidad · Tab completar`
        : "No encontramos ese producto. Probá con otra palabra, código o código de barras."
      : "Escribí un nombre o código. Elegí una sugerencia y presioná Enter.";
    $("clear-search").hidden = !search.value;
    completion = EnjoyFinder.completion(search.value, results[highlight]);
    $("search-ghost").innerHTML = completion
      ? `<span class="ghost-prefix">${h(search.value)}</span><span>${h(completion.slice(search.value.length))}</span>`
      : "";
  }
  function chooseResult(k = highlight, explicit = false) {
    if (!results[k] || (!$("search").value.trim() && !explicit)) {
      $("search-status").textContent =
        "Escribí para buscar o tocá un producto de la lista.";
      return;
    }
    const candidate = results[k],
      query = $("search").value.trim(),
      exact = results.filter(
        (i) => i.code === C.code(query) || (i.barcode && i.barcode === query),
      );
    if (!explicit && exact.length > 1) {
      $("search-status").textContent =
        "Este código tiene varios lotes. Elegí con ↑ ↓ y Enter, o tocá el lote correcto.";
      return;
    }
    selected = candidate;
    const current = ownRows().find((c) => c.item_id === selected.id);
    closeSuggestions();
    $("search").value = selected.name;
    $("clear-search").hidden = false;
    $("search-status").textContent =
      "Producto seleccionado. Ingresá la cantidad a sumar.";
    $("quantity-area").innerHTML =
      `<div class="selected-item"><div class="selected-product"><div><strong>${h(selected.name)}</strong><small>${h(selected.code)} · ${h(selected.lot || "Sin lote")} · ${h(selected.unit)}</small></div><div class="selected-total"><small>Total contado</small><strong>${current ? n(current.quantity) : "—"} <small>${h(selected.unit)}</small></strong></div></div><form id="quantity-form" class="count-entry"><label>Cantidad a sumar<input id="quantity" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" required></label><button>Sumar ↵</button></form><small class="quantity-help">Enter suma y vuelve al buscador · Esc cambia de producto</small></div>`;
    $("quantity-form").onsubmit = (e) => {
      e.preventDefault();
      guarded(() => addQuantity("add", $("quantity").value, selected.id));
    };
    $("quantity").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        clearLookup();
      }
    });
    $("quantity").focus();
  }
  async function record(action, item, value, extra = {}) {
    if (!actor) throw Error("No tenés una función asignada");
    if (!P.counts(myParticipation()))
      throw Error(
        "Tu participación no incluye conteo. El encargado puede habilitarlo.",
      );
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
    const item = pkg.inventory.items.find((i) => i.id === id);
    await record(action, id, value);
    selected = null;
    if ($("quantity-area")) $("quantity-area").innerHTML = "";
    if ($("count-table")) $("count-table").innerHTML = countRows();
    await pendingHTML();
    updateProgress();
    if ($("count-feedback"))
      $("count-feedback").textContent =
        `${action === "set" ? "Total actualizado" : action === "subtract" ? "Restaste " + n(C.number(value)) + " " + item.unit : "Sumaste " + n(C.number(value)) + " " + item.unit} · ${item.name}${item.lot ? " (" + item.lot + ")" : ""} · Total: ${n(ownRows().find((c) => c.item_id === id)?.quantity)} ${item.unit}`;
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
        if (fresh) {
          const before = JSON.stringify(myParticipation());
          pkg = fresh;
          if (JSON.stringify(myParticipation()) !== before) {
            stopGPS();
            setActor();
            renderStep();
          }
        }
        await pendingHTML();
        if (view === "inventory" && step === 4 && $("count-table"))
          $("count-table").innerHTML = countRows();
        updateProgress();
      }
      await status();
    });
  }
  function reviewHTML() {
    const rows = C.comparison(pkg),
      m = C.metrics(rows),
      name = names(),
      cols = P.columns(pkg);
    return `<section class="card"><h2>Comparar y autorizar cantidades</h2><p class="muted">Cada columna pertenece a una persona. «—» significa sin contar; los conteos no se suman automáticamente. Autorizá la cantidad que se trasladará al CSV y registrá el criterio.</p><div class="kpis"><div class="kpi"><strong>${m.approved}/${m.total}</strong><span>Autorizados</span></div><div class="kpi"><strong>${m.exactRate == null ? "—" : n(m.exactRate * 100) + "%"}</strong><span>Exactitud estricta</span></div><div class="kpi"><strong>${m.within1000}</strong><span>Diferencia menor a $1.000</span></div></div><div class="actions">${button("xlsx", "Descargar comparativo Excel")}${pkg.inventory.status !== "closed" ? button("approve-batch", "Autorizar desde un conteo") : ""}</div><div id="batch-area"></div>${pkg.inventory.assignments.map((a) => `<p><strong>${h(a.name || name[a.user_id] || a.user_id)} · ${h(P.roles[a.actor] || a.actor)}</strong> · ${h(P.state(pkg, a))} ${pkg.submissions[a.user_id + ":" + a.actor]?.submitted && pkg.inventory.status !== "closed" ? button("reopen", "Reabrir", "quiet", `data-assignment="${a.user_id}:${a.actor}"`) : ""}</p>`).join("")}<div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Stock</th>${cols.map((a, k) => `<th>Conteo ${k + 1} · ${h(a.name || name[a.user_id] || a.user_id)}<small>${h(P.roles[a.actor] || a.actor)}</small></th>`).join("")}<th>Autorizado</th><th>Diferencia</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${h(r.name)}<small>${h(r.code)} · ${h(r.lot || "Sin lote")} · ${h(r.unit)}</small></td><td>${n(r.stock)}</td>${cols.map((a) => `<td>${n(r.entries.find((c) => c.user_id === a.user_id && c.actor === a.actor)?.quantity)}</td>`).join("")}<td>${n(r.approved)}</td><td>${n(r.diff)}</td><td>${pkg.inventory.status !== "closed" ? button("approve", "Autorizar", "secondary", `data-id="${h(r.id)}"`) : ""}</td></tr>`).join("")}</tbody></table></div><div id="approve-area"></div></section>`;
  }
  function sapHTML() {
    return `<section class="card"><h2>Archivos y reporte SAP</h2><p class="muted">Vinculá el CSV inicial y luego CSV_2. Los documentos SAP pueden ser distintos entre etapas. Se mantienen materiales, lotes y posiciones.</p><div class="grid"><label>Etapa del archivo<select id="sap-kind"><option value="csv">CSV inicial · MI04</option><option value="csv_2">CSV_2 · MI08</option></select></label><label class="file">Vincular plantilla SAP<input id="sap-file" type="file" accept=".csv" ${pkg.inventory.status === "closed" ? "disabled" : ""}></label><label class="file">Incorporar Reporte SAP final<input id="report-file" type="file" accept=".xlsx,.xls" ${pkg.inventory.status === "closed" ? "disabled" : ""}></label></div><div class="grid">${field("Fecha de conteo para CSV", "count-date", pkg.inventory.scheduled_date, "date")}${field("Fecha de ingreso en SAP", "entry-date", C.today(), "date")}</div><div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Etapa</th><th>Documento</th><th>Acciones</th></tr></thead><tbody>${pkg.documents.map((d, k) => `<tr><td>${h(d.name)}<small>${date(d.at)}</small></td><td>${h(d.kind)}${d.generated ? " · generado" : ""}</td><td>${h((d.documents || []).join(", "))}</td><td>${d.path ? button("download-original", "Original", "quiet", `data-index="${k}"`) : ""}${d.sap ? button("export-csv", "Completar y descargar", "", `data-index="${k}"`) : ""}</td></tr>`).join("")}</tbody></table></div>${pkg.report ? `<p class="good">Reporte incorporado: ${pkg.report.items.length} posiciones · Documento ${h(pkg.report.documents.join(", "))}.</p>` : ""}<div class="warning">Descargar un CSV no confirma su carga en SAP. Generá y verificá el documento en SAP y vinculá después su reporte.</div></section>`;
  }
  function closeHTML() {
    const rows = C.comparison(pkg),
      m = C.metrics(rows);
    return `<section class="card"><h2>Cierre, ajustes y acta</h2><div class="kpis"><div class="kpi"><strong>${m.approved}/${m.total}</strong><span>Autorizados</span></div><div class="kpi"><strong>${n(m.net)}</strong><span>Diferencia neta estimada UYU</span></div><div class="kpi"><strong>${pkg.report ? n(pkg.report.totals.differenceValue) : "—"}</strong><span>Diferencia Reporte SAP</span></div></div><p class="muted">El acta incluye participantes, indicadores, diferencias, justificaciones y ajustes. Se emite como borrador hasta cerrar el inventario.</p><div class="actions">${button("acta", "Descargar acta Word", "")}${button("xlsx", "Excel completo")}${pkg.inventory.warehouse === "AL05" ? button("consolidate", "Consolidar AL05") : ""}</div><h3>Ajustes posteriores</h3><p class="muted">Una propuesta no equivale a un ajuste ejecutado en SAP. Registrá su evidencia y fecha cuando se complete.</p><div class="table-wrap"><table><thead><tr><th>Material / lote</th><th>Cantidad</th><th>Estado</th><th>Fecha y evidencia</th></tr></thead><tbody>${pkg.adjustments.map((a) => `<tr><td>${h(a.code)} · ${h(a.lot)}</td><td>${n(a.quantity)}</td><td>${a.executed ? "Ejecutado" : "Propuesto"}</td><td>${h(a.date)} ${h(a.evidence)}</td></tr>`).join("")}</tbody></table></div>${`<form id="adjust-form" class="card"><div class="grid"><label>Material / lote<select name="item">${pkg.inventory.items.map((i) => option(i.id, i.code + " · " + i.lot + " · " + i.name, "")).join("")}</select></label>${field("Cantidad final propuesta", "quantity", "", "text", 'inputmode="decimal" required')}${field("Fecha", "date", C.today(), "date")}${field("Documento SAP o evidencia", "evidence", "")}</div><label class="check"><input name="executed" type="checkbox">Ajuste ejecutado y verificado en SAP</label><button>Registrar ajuste</button></form>`}${pkg.inventory.status !== "closed" ? `<label class="check"><input id="close-confirm" type="checkbox">Revisé las cantidades, las entregas, las justificaciones y el Reporte SAP</label>${button("close", "Cerrar inventario", "")}` : `<p class="good">Inventario cerrado el ${date(pkg.inventory.closed_at)}. Los movimientos y documentos quedan conservados.</p>`}</section>`;
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
      `<div class="heading"><div><p class="eyebrow">Finanzas</p><h1>Usuarios y permisos</h1><p class="muted">Aprobá solicitudes y asigná los almacenes autorizados. La clave de empresa no otorga permisos.</p></div>${button("dashboard", "Volver")}</div>${members.map((m, k) => `<form class="card member-form" data-index="${k}"><h3>${h(m.name)} ${!m.approved ? '<span class="pill">Pendiente</span>' : ""}</h3><div class="grid"><label>Rol<select name="role">${["contador", "responsable", "auditor", "supervisor", "finanzas"].map((r) => option(r, r, m.role)).join("")}</select></label>${field("Almacenes, separados por coma", "warehouses", m.warehouses.join(", "))}</div><label class="check"><input name="approved" type="checkbox" ${m.approved ? "checked" : ""}>Acceso aprobado</label><label class="check"><input name="can_manage" type="checkbox" ${m.can_manage ? "checked" : ""}>Puede gestionar inventarios de sus almacenes</label><button>Guardar permisos</button></form>`).join("")}`;
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
    if (action === "retry-join") return joinScreen(b.dataset.token);
    if (action === "confirm-join") {
      const joined = await rpc("join", {
        token: b.dataset.token,
        confirm: true,
      });
      await S.savePackage(user.id, joined);
      members = await rpc("members");
      return openInventory(joined.inventory.id);
    }
    if (action === "add-participant" || action === "remove-participant") {
      collect();
      if (action === "remove-participant")
        pkg.inventory.assignments.splice(+b.dataset.index, 1);
      else {
        const person = members.find(
          (m) => m.user_id === $("participant-user").value,
        );
        if (!person) throw Error("Seleccioná una persona");
        if (pkg.inventory.assignments.some((a) => a.user_id === person.user_id))
          throw Error("Esta persona ya participa");
        pkg.inventory.assignments.push({
          user_id: person.user_id,
          name: person.name,
          actor: "contador",
          counts_enabled: true,
          absent: false,
          see_stock: false,
        });
      }
      return renderStep();
    }
    if (action === "toggle-invitation" || action === "rotate-invitation") {
      await save();
      pkg = await rpc("invitation", {
        inventory_id: pkg.inventory.id,
        enabled: action === "rotate-invitation" || !pkg.invitation?.enabled,
        rotate: action === "rotate-invitation",
      });
      await S.savePackage(user.id, pkg);
      return renderStep();
    }
    if (action === "copy-invitation") {
      const input = $("invitation-link");
      try {
        await navigator.clipboard.writeText(input.value);
        toast("Enlace copiado");
      } catch {
        input.focus();
        input.select();
        toast("Enlace seleccionado. Podés copiarlo desde este campo.");
      }
      return;
    }
    if (action === "download-qr")
      return E.download(
        EnjoyInvitations.svg(EnjoyInvitations.url(pkg.invitation.token)),
        `Enjoy_${pkg.inventory.warehouse}_QR.svg`,
        "image/svg+xml",
      );
    if (action === "change-company") {
      sessionStorage.removeItem("empresa_nombre");
      sessionStorage.removeItem("empresa_validada");
      location.assign("/");
      return;
    }
    if (action === "login") return auth();
    if (action === "register") return auth(true);
    if (action === "refresh-profile") return enter(user);
    if (action === "dashboard-counts" || action === "dashboard-admin") {
      dashboardArea = action === "dashboard-admin" ? "admin" : "counts";
      return dashboard();
    }
    if (action === "dashboard") return dashboard();
    if (action === "members") return memberScreen();
    if (action === "new") {
      pkg = emptyPackage();
      mode = "configure";
      step = 0;
      route("configuracion", "nuevo");
      setActor();
      return render();
    }
    if (action === "open") return openInventory(b.dataset.id, "count");
    if (action === "open-configure" || action === "open-results")
      return openInventory(
        b.dataset.id,
        action === "open-configure" ? "configure" : "results",
      );
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
      if (!areaSteps().includes(step)) step = areaSteps().at(-1);
      return render();
    }
    if (action === "save-exit") {
      if (active) await pause();
      if (step < 4 && pkg.inventory.status !== "closed") await save();
      dashboardArea = "admin";
      return dashboard();
    }
    if (action === "schedule" || action === "publish") {
      await save(action === "schedule" ? "scheduled" : "ready");
      toast(
        action === "publish"
          ? "Inventario preparado. El conteo se abre desde Mis conteos."
          : "Inventario programado",
      );
      dashboardArea = "admin";
      return dashboard();
    }
    if (action === "start") return start();
    if (action === "pause") return pause();
    if (action === "finish" || action === "confirm-finish") {
      if (!ownRows().length)
        throw Error(
          "Registrá al menos un producto. Si no vas a contar, el encargado puede cambiar tu participación.",
        );
      if (
        action === "finish" &&
        ownRows().length !== pkg.inventory.items.length
      ) {
        $("quantity-area").innerHTML =
          `<div class="card correction"><h3>Entregar lo que conté</h3><p>Contaste ${ownRows().length} de ${pkg.inventory.items.length} productos. Los demás quedarán como «Sin contar» en tu planilla. No se convertirán en cero.</p>${button("confirm-finish", "Confirmar entrega", "")}${button("cancel-correction", "Seguir contando")}</div>`;
        $("quantity-area").scrollIntoView({ block: "center" });
        return;
      }
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
    if (action === "cancel-correction") return clearLookup();
    if (action === "approve-batch") {
      $("batch-area").innerHTML =
        `<form id="batch-form" class="card"><h3>Autorizar cantidades desde un conteo entregado</h3><p>Revisá el comparativo antes de confirmar. Las diferencias quedan marcadas «Para revisar» y podés ajustar cada autorización después.</p><label>Conteo de origen<select name="source">${P.columns(
          pkg,
        )
          .filter((a) => pkg.submissions[P.key(a)]?.submitted)
          .map((a) =>
            option(
              P.key(a),
              (a.name || names()[a.user_id] || a.user_id) +
                " · " +
                (P.roles[a.actor] || a.actor),
              "",
            ),
          )
          .join(
            "",
          )}</select></label>${field("Criterio de autorización", "comment", "", "text", "required")}<button>Autorizar cantidades del conteo seleccionado</button></form>`;
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
      if (!P.delivered(pkg))
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
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".lookup")) closeSuggestions();
    if (e.target.closest("[data-result]")) e.preventDefault();
  });
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
      dashboardArea = mode === "count" ? "counts" : "admin";
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
  window.addEventListener("popstate", () => {
    if (profile?.approved)
      guarded(async () => {
        if (active) await pause();
        await routeFromLocation();
      });
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
