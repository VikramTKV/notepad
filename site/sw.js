// Offline support. Same-origin files are served network-first (so updates appear on the next visit)
// and fall back to the cache when offline. Requests to Supabase are never intercepted.
const CACHE = "notelume-v3";
const SHELL = [
  "./", "index.html", "features.html", "privacy.html", "terms.html", "config.js", "manifest.webmanifest",
  "assets/styles.css", "assets/app.js", "assets/theme.js", "assets/legal.js", "assets/favicon.svg",
  "assets/icon-192.png", "assets/icon-512.png",
  "assets/fonts/inter-latin-wght-normal.woff2", "assets/fonts/inter-latin-ext-wght-normal.woff2",
  "vendor/supabase.min.js", "vendor/marked.min.js", "vendor/purify.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase and anything else go straight to the network

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
        if (cached) return cached;
        if (req.mode === "navigate") return caches.match("index.html");
        return Response.error();
      })
  );
});
