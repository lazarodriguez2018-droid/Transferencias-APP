const CACHE = "enjoy-static-v1";
const FILES = [
  "/enjoy/",
  "/enjoy/inventarios",
  "/enjoy/inventarios.html",
  "/enjoy/demo",
  "/enjoy/demo.html",
  "/enjoy/demo-client.js",
  "/enjoy/index.html",
  "/enjoy/style.css",
  "/enjoy/icon.svg",
  "/enjoy/manifest.webmanifest",
  "/enjoy/core.js",
  "/enjoy/store.js",
  "/enjoy/sync.js",
  "/enjoy/gps.js",
  "/enjoy/exports.js",
  "/enjoy/app.js",
  "/enjoy/vendor/supabase-2.58.0.js",
  "/enjoy/vendor/jszip-3.10.1.js",
  "/operaciones/xlsx.full.min.js",
  "/operaciones/search-engine.js",
];
self.addEventListener("install", (e) =>
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("enjoy-static-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (e) => {
  if (
    e.request.method !== "GET" ||
    new URL(e.request.url).origin !== self.location.origin
  )
    return;
  const url = new URL(e.request.url);
  if (!FILES.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        return r;
      })
      .catch(() =>
        caches
          .match(e.request)
          .then(
            (r) =>
              r ||
              (e.request.mode === "navigate"
                ? caches.match("/enjoy/inventarios")
                : Response.error()),
          ),
      ),
  );
});
