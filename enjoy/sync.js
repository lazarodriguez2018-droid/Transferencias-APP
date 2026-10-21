(function (root) {
  "use strict";
  const C = root.EnjoyCore,
    S = root.EnjoyStore;
  let chain = Promise.resolve(),
    syncing = false;
  const networkLock = (owner, fn) =>
    navigator.locks
      ? navigator.locks.request(
          "enjoy-sync-" + owner,
          { mode: "exclusive" },
          fn,
        )
      : fn();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  function apply(pkg, e) {
    const out = structuredClone(pkg);
    if (["add", "subtract", "set"].includes(e.action)) {
      let row = out.counts.find(
        (c) =>
          c.user_id === e.user_id &&
          c.actor === e.actor &&
          c.item_id === e.item_id,
      );
      if (!row) {
        row = {
          user_id: e.user_id,
          actor: e.actor,
          item_id: e.item_id,
          quantity: 0,
          version: 0,
        };
        out.counts.push(row);
      }
      row.quantity = C.quantity(row.quantity, e.action, e.value);
      row.version++;
      row.updated_at = e.occurred_at;
    }
    if (e.action === "finish")
      out.submissions[e.user_id + ":" + e.actor] = {
        submitted: true,
        pending: true,
        at: e.occurred_at,
      };
    return out;
  }
  function clean(e) {
    const { owner, status, error, ...value } = e;
    return value;
  }
  root.EnjoySync = {
    apply,
    serial,
    async merge(owner, pkg) {
      return serial(async () => {
        const received = new Set(pkg.receipts || []);
        for (const e of await S.events(owner, pkg.inventory.id)) {
          if (received.has(e.id)) await S.acknowledge(e.id);
          else pkg = apply(pkg, e);
        }
        pkg.downloaded_at = new Date().toISOString();
        await S.savePackage(owner, pkg);
        return pkg;
      });
    },
    async refresh(owner, rpc, id) {
      return networkLock(owner, async () => {
        const pending = await S.events(owner, id);
        return this.merge(
          owner,
          await rpc("open", {
            inventory_id: id,
            pending_ids: pending.map((e) => e.id),
          }),
        );
      });
    },
    async record(owner, pkg, e) {
      return serial(async () => {
        const saved =
          (await S.get("packages", owner + "|" + pkg.inventory.id)) || pkg;
        const row = saved.counts.find(
          (c) =>
            c.user_id === owner &&
            c.actor === e.actor &&
            c.item_id === e.item_id,
        );
        const event = {
          ...e,
          user_id: owner,
          inventory_id: pkg.inventory.id,
          base_version: row?.version || 0,
        };
        const next = apply(saved, event);
        await S.record(owner, next, event);
        return next;
      });
    },
    async run(owner, rpc, onChange) {
      if (syncing || !navigator.onLine) return;
      syncing = true;
      try {
        await networkLock(owner, async () => {
          const blocked = new Set();
          for (const e of await S.events(owner)) {
            if (blocked.has(e.inventory_id)) continue;
            try {
              const result = await rpc("event", {
                inventory_id: e.inventory_id,
                event: clean(e),
              });
              if (!result?.ok)
                throw Error("Respuesta de sincronización incompleta");
              await serial(() => S.acknowledge(e.id));
            } catch (err) {
              if (
                !navigator.onLine ||
                /fetch|network|conexión/i.test(err.message)
              )
                break;
              await serial(() => S.flag(e.id, err.message));
              blocked.add(e.inventory_id);
            }
          }
          for (const p of await S.packages(owner)) {
            try {
              const pending = await S.events(owner, p.inventory.id);
              const fresh = await rpc("open", {
                inventory_id: p.inventory.id,
                pending_ids: pending.map((e) => e.id),
              });
              await this.merge(owner, fresh);
            } catch (err) {
              /* Preserve pending work when assignment is revoked or server is unavailable. */
            }
          }
        });
        await onChange?.();
      } finally {
        syncing = false;
      }
    },
  };
})(window);
