const cacheName = "reactivecore-inventory-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const page = await fetch("/inventory", { cache: "reload" });
    if (!page.ok) throw new Error("Inventory shell unavailable");
    const html = await page.clone().text();
    const assets = [...new Set(Array.from(
      html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g),
      (match) => match[1],
    ))];
    await cache.addAll(assets);
    await cache.put("/inventory", page);
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
  if (request.mode === "navigate" && url.pathname === "/inventory") {
    event.respondWith(fetch(request).catch(async () =>
      (await caches.match("/inventory", { cacheName })) ?? Response.error(),
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
