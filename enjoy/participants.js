/* An inventory role describes participation, never an obligation to count. */
(function (root) {
  "use strict";
  const roles = {
    contador: "Participante",
    responsable: "Responsable del almacén",
    auditor: "Auditor",
    supervisor: "Supervisor",
  };
  const counts = (a) => !!a && a.counts_enabled !== false && !a.absent;
  const key = (a) => a.user_id + ":" + a.actor;
  const name = (a) => a.name || a.user_id;
  const columns = (pkg) =>
    pkg.inventory.assignments.filter(
      (a) =>
        counts(a) ||
        pkg.counts.some((c) => c.user_id === a.user_id && c.actor === a.actor),
    );
  const delivered = (pkg) =>
    pkg.inventory.assignments
      .filter(counts)
      .every((a) => pkg.submissions[key(a)]?.submitted);
  const state = (pkg, a) =>
    a.absent
      ? "Ausente"
      : !counts(a)
        ? "Participa sin contar"
        : pkg.submissions[key(a)]?.submitted
          ? "Conteo entregado"
          : "Conteo pendiente";
  const api = { roles, counts, key, name, columns, delivered, state };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EnjoyParticipants = api;
})(typeof window === "object" ? window : globalThis);
