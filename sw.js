/* There's always Moh to do — offline cache */
const CACHE = "moh-todos-ghpages-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./lib/merge.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

function pathEnds(url, suffix) {
  try {
    return new URL(url).pathname.endsWith(suffix);
  } catch (e) {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  /* List and sync URL: always try the network. Never let a stale precache win. */
  if (pathEnds(event.request.url, "/todos.json") || pathEnds(event.request.url, "/sync-config.json")) {
    const cacheKey = pathEnds(event.request.url, "/sync-config.json") ? "./sync-config.json" : "./todos.json";
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(cacheKey, clone));
        }
        return response;
      }).catch(() => caches.match(cacheKey))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
