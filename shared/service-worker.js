"use strict";

const SHELL_CACHE = "hub-shell-v1";
const SHELL_FILES = [
  "/manifest.webmanifest",
  "/shared/pwa.js",
  "/shared/pwa.css",
  "/shared/pwa-icon.svg",
];
const APP_PAGES = [
  "/",
  "/roam/",
  "/roam/static/flights.html",
  "/runs/",
  "/runs/activities/",
  "/fitness/",
  "/fuad/",
  "/trading/",
];

async function cachePageAndAssets(cache, path) {
  try {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok || !response.headers.get("Content-Type")?.includes("text/html")) return;
    await cache.put(path, response.clone());
    const html = await response.text();
    const references = [...html.matchAll(/(?:src|href)=["']([^"'#]+)["']/gi)].map((match) => match[1]);
    await Promise.all(references.map(async (reference) => {
      const asset = new URL(reference, response.url);
      if (asset.origin !== self.location.origin || asset.pathname.includes("/api/")) return;
      try {
        const assetResponse = await fetch(asset.href, { credentials: "same-origin" });
        if (assetResponse.ok && assetResponse.type === "basic") {
          await cache.put(asset.href, assetResponse);
        }
      } catch (error) {
        console.warn(`Could not pre-cache ${asset.pathname}:`, error);
      }
    }));
  } catch (error) {
    console.warn(`Could not pre-cache ${path}:`, error);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_FILES);
    await Promise.all(APP_PAGES.map((path) => cachePageAndAssets(cache, path)));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith("hub-shell-") && key !== SHELL_CACHE)
        .map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        const home = await caches.match("/");
        if (home) return home;
        throw error;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});
