(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EnjoyFinder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const norm = (s) =>
    String(s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  function find(index, query, engine, limit = 12) {
    const q = query.trim();
    if (!q) return [];
    const code = /^\d+$/.test(q) ? q.replace(/^0+(?=\d)/, "") : q;
    const exact = index
        .filter((e) => e.product.code === code || e.product.barcode === q)
        .map((e) => e.product),
      prefix = index
        .filter((e) => e.product.barcode?.startsWith(q))
        .map((e) => e.product),
      ranked = [
        ...engine.searchByCode(index, code, limit),
        ...engine.rankProducts(index, q, null, limit),
      ].map((e) => e.product);
    return [
      ...new Map(
        [...exact, ...prefix, ...ranked].map((i) => [i.id, i]),
      ).values(),
    ].slice(0, limit);
  }
  function completion(query, item) {
    if (!item || !query || query !== query.trim()) return "";
    const candidates = /^\d+$/.test(query)
      ? [item.barcode, item.code]
      : [item.name];
    return (
      candidates.find(
        (v) => v && v.length > query.length && norm(v).startsWith(norm(query)),
      ) || ""
    );
  }
  // Ranges use original-string offsets, so accents remain unchanged in labels.
  function segments(text, query) {
    text = String(text ?? "");
    const mask = Array(text.length).fill(false),
      value = norm(text);
    if (value.length === text.length)
      for (const token of norm(query).trim().split(/\s+/).filter(Boolean)) {
        let start = 0;
        while ((start = value.indexOf(token, start)) !== -1) {
          for (let k = start; k < start + token.length; k++) mask[k] = true;
          start += token.length;
        }
      }
    const out = [];
    for (let k = 0; k < text.length; k++) {
      if (!out.length || out.at(-1).match !== mask[k])
        out.push({ text: "", match: mask[k] });
      out.at(-1).text += text[k];
    }
    return out;
  }
  return { find, completion, segments };
});
