const shell = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const cacheName = `reactivecore${shell.replace("/", "-")}-v1`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const page = await fetch(shell, { cache: "reload" });
    if (!page.ok) throw new Error("Offline shell unavailable");
    const html = await page.clone().text();
    const assets = [...new Set(Array.from(
      html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g),
      (match) => match[1],
    ))];
    await cache.addAll(assets);
    await cache.put(shell, page);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  if (request.mode === "navigate" && url.pathname === shell) {
    event.respondWith(fetch(request).catch(async () =>
      (await caches.match(shell, { cacheName })) ?? Response.error(),
    ));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
