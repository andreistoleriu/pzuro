// sw.js -- service worker minimal, fara dependinte, pentru instalabilitate
// PWA si o experienta offline de baza:
//   - shell-ul aplicatiei (pagina, js/calc.js, manifest, iconite): stale-while-revalidate,
//     ca sa se incarce instant din cache DAR sa se actualizeze mereu in fundal --
//     spre deosebire de cache-first, aici prospetimea nu mai depinde de o
//     reinstalare a service worker-ului (care nu se declanseaza decat cand
//     sw.js insusi se schimba); fiecare vizita reimprospateaza cache-ul
//   - data/prices.json + data/history.json: network-first cu fallback pe
//     ultima versiune cunoscuta din cache -- daca esti offline, vezi ultimele
//     preturi stiute, iar bannerul de prospetime din index.html (renderFreshness)
//     arata deja corect ca sunt vechi
// Restul cererilor (fonturi Google, CDN Chart.js, alte pagini) NU sunt
// interceptate -- trec direct la retea, consistent cu degradarea graduala
// deja prezenta in index.html pentru Chart.js (daca CDN-ul pica, restul merge).

const CACHE_VERSION = "pzuro-v3";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const SHELL_FILES = ["/", "/js/calc.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
const DATA_PATHS = ["/data/prices.json", "/data/history.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const networkFetch = fetch(event.request)
    .then((response) => {
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null);
  // event.waitUntil tine service worker-ul in viata cat timp networkFetch e
  // pending, chiar daca raspundem imediat din cache mai jos -- altfel browserul
  // poate opri worker-ul de indata ce trimite raspunsul si anula fetch-ul de
  // fundal, iar cache-ul nu s-ar mai reimprospata niciodata pentru vizita viitoare
  event.waitUntil(networkFetch);
  return cached || (await networkFetch) || fetch(event.request);
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (DATA_PATHS.includes(url.pathname)) {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
    return;
  }
  if (url.pathname === "/" || SHELL_FILES.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
  }
});
