// Service worker de "Sala" — solo cachea el cascarón de la app (HTML/CSS/JS/íconos).
// Los videos de Google Drive NUNCA se cachean: siempre se piden en vivo a Drive.

const CACHE_NAME = "sala-app-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Nunca interceptar peticiones a Google Drive ni a la API de Drive:
  // deben ir siempre en vivo (streaming de video y listados de carpetas).
  if (
    url.hostname.includes("drive.google.com") ||
    url.hostname.includes("googleusercontent.com") ||
    url.hostname.includes("googleapis.com")
  ) {
    return;
  }

  // Cascarón de la app: cache-first con actualización en segundo plano.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && event.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
