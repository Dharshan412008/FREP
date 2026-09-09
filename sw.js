const CACHE_VERSION = "v5";
const SHELL_CACHE = `frep-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `frep-assets-${CACHE_VERSION}`;
const PUBLIC_DATA_CACHE = `frep-public-data-${CACHE_VERSION}`;
const FREP_CACHE_PREFIX = "frep-";
const REACT_ASSET_PREFIX = "/assets/";

const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/copilot-worker.js",
  "/manifest.json",
  "/explanation.html",
];

const SHELL_PATHS = new Set(PRECACHE);

// Only these route payloads are public, read-only marketplace data. Everything
// else under /api stays network-only so sessions, bookings, notifications,
// copilot prompts, and future user-specific endpoints never enter CacheStorage.
const PUBLIC_DATA_PATHS = new Set([
  "/api/resources",
  "/api/dashboard",
  "/api/clusters",
  "/api/analytics",
  "/api/ai/status",
]);

const SENSITIVE_API_PREFIXES = [
  "/api/auth/",
  "/api/bookings",
  "/api/notifications",
  "/api/events",
  "/api/copilot/",
  "/api/production/",
];

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0d0f"><title>FREP offline</title>
<style>body{margin:0;background:radial-gradient(circle at 80% 12%,#342915 0,transparent 32%),#0b0d0f;color:#e9e5da;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;width:min(36rem,calc(100% - 2rem));padding:2.5rem;border:1px solid #3b3b36;border-radius:1.5rem;background:#141714;box-shadow:0 24px 80px #0008}.signal{margin:0 0 1rem;color:#f2b544;font-size:.75rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase}h1{margin:.25rem 0 1rem;font-size:clamp(2rem,8vw,3.5rem);line-height:.95}p{line-height:1.65;color:#aaa99f}</style>
<main><p class="signal">FREP / local mode</p><h1>The exchange floor is offline.</h1><p>This device has not stored the full interface yet. Reconnect once to prepare FREP for resilient offline access, then reload.</p></main>`;

function isSensitiveApi(pathname) {
  return SENSITIVE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function responseIsPublicAndCacheable(response, expectJson = false) {
  if (!response || !response.ok || response.status !== 200) return false;
  if (!["basic", "default"].includes(response.type)) return false;

  const cacheControl = (response.headers.get("Cache-Control") || "").toLowerCase();
  const vary = (response.headers.get("Vary") || "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) return false;
  if (vary.includes("cookie") || vary.includes("authorization") || vary.trim() === "*") return false;
  if (response.headers.has("WWW-Authenticate") || response.headers.has("Set-Cookie")) return false;

  if (expectJson) {
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    if (!contentType.includes("application/json")) return false;
  }
  return true;
}

async function safeCachePut(cacheName, request, response, expectJson = false) {
  if (!responseIsPublicAndCacheable(response, expectJson)) return false;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    return true;
  } catch (_error) {
    // Storage may be disabled, full, or evicted. A cache failure must never
    // break the online request that produced the response.
    return false;
  }
}

function responseIsReactAsset(request, response) {
  if (!responseIsPublicAndCacheable(response)) return false;
  let url;
  try {
    url = new URL(typeof request === "string" ? request : request.url, self.location.origin);
  } catch (_error) {
    return false;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(REACT_ASSET_PREFIX)) return false;

  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  // A missing asset must never cache an HTML app-shell fallback under a
  // JavaScript or stylesheet URL.
  return !contentType.includes("text/html") && !contentType.includes("application/json");
}

async function safeAssetCachePut(request, response) {
  if (!responseIsReactAsset(request, response)) return false;
  try {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
    return true;
  } catch (_error) {
    return false;
  }
}

function discoverReactAssets(html) {
  const assets = new Set();
  const referencePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = referencePattern.exec(html)) !== null) {
    try {
      const url = new URL(match[1], `${self.location.origin}/`);
      if (url.origin === self.location.origin && url.pathname.startsWith(REACT_ASSET_PREFIX)) {
        assets.add(`${url.pathname}${url.search}`);
      }
    } catch (_error) {
      // Ignore malformed or non-URL attribute values in the shell document.
    }
  }
  return [...assets];
}

async function precacheReactAssets(shellResponse) {
  const contentType = (shellResponse.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("text/html")) return;

  let html;
  try {
    html = await shellResponse.text();
  } catch (_error) {
    return;
  }

  await Promise.allSettled(
    discoverReactAssets(html).map(async (path) => {
      const response = await fetch(path, { cache: "reload", credentials: "same-origin" });
      await safeAssetCachePut(path, response);
    })
  );
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.allSettled(
    PRECACHE.map(async (path) => {
      try {
        const response = await fetch(path, { cache: "reload", credentials: "same-origin" });
        if (responseIsPublicAndCacheable(response)) {
          await cache.put(path, response.clone());
          if (path === "/") {
            // Vite fingerprints production bundles, so their URLs cannot live
            // in this static list. Discover and cache the current entry assets
            // while the worker installs, before it controls the next reload.
            await precacheReactAssets(response.clone());
          }
        }
      } catch (_error) {
        // One optional shell asset should not prevent the new worker installing.
      }
    })
  );
}

async function cacheFirstReactAsset(request) {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
  } catch (_cacheError) {
    // Continue to the network when CacheStorage is unavailable.
  }

  try {
    const response = await fetch(request);
    await safeAssetCachePut(request, response);
    return response;
  } catch (_error) {
    return new Response("React asset is not available offline yet.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function networkFirstNavigation(request) {
  const url = new URL(request.url);
  const isCanonicalAppEntry = url.pathname === "/" || url.pathname === "/index.html";
  try {
    const response = await fetch(request);
    if (responseIsPublicAndCacheable(response)) {
      if (isCanonicalAppEntry) {
        // Keep both canonical entry keys warm, but never let a different HTML
        // route (for example /explanation.html) replace the offline app shell.
        await Promise.all([
          safeCachePut(SHELL_CACHE, "/", response),
          safeCachePut(SHELL_CACHE, "/index.html", response),
        ]);
      } else if (SHELL_PATHS.has(url.pathname)) {
        await safeCachePut(SHELL_CACHE, request, response);
      }
    }
    return response;
  } catch (_error) {
    let cached = null;
    try {
      const cache = await caches.open(SHELL_CACHE);
      cached = await cache.match(request, { ignoreSearch: true });
      if (!cached && isCanonicalAppEntry) {
        cached = (await cache.match("/")) || (await cache.match("/index.html"));
      }
    } catch (_cacheError) {
      // Fall through to the self-contained offline page below.
    }
    return cached || new Response(OFFLINE_PAGE, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function staleWhileRevalidateShell(request, event) {
  let cached = null;
  try {
    const cache = await caches.open(SHELL_CACHE);
    cached = await cache.match(request, { ignoreSearch: true });
  } catch (_cacheError) {
    // Continue online when CacheStorage is unavailable.
  }
  const refresh = fetch(request)
    .then(async (response) => {
      await safeCachePut(SHELL_CACHE, request, response);
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return cached;
  }
  return (await refresh) || new Response("Offline", { status: 503, headers: { "Cache-Control": "no-store" } });
}

async function networkFirstPublicData(request) {
  let cache = null;
  try {
    cache = await caches.open(PUBLIC_DATA_CACHE);
  } catch (_cacheError) {
    // CacheStorage can be disabled. Public reads should still work online.
  }
  try {
    const response = await fetch(request);
    if (responseIsPublicAndCacheable(response, true)) {
      await safeCachePut(PUBLIC_DATA_CACHE, request, response, true);
      return response;
    }

    // Never substitute cached content for auth/permission failures. Cached
    // public data is only a resilience fallback for network and server outages.
    if (response.status >= 500 && cache) {
      return (await cache.match(request)) || response;
    }
    return response;
  } catch (_error) {
    let cached = null;
    if (cache) {
      try {
        cached = await cache.match(request);
      } catch (_cacheError) {
        // Return the explicit offline response below.
      }
    }
    return cached || new Response(
      JSON.stringify({ ok: false, offline: true, error: "Public marketplace data is not cached yet." }),
      {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      }
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
      await self.skipWaiting();
    })().catch(() => undefined)
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const activeCaches = new Set([SHELL_CACHE, ASSET_CACHE, PUBLIC_DATA_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(FREP_CACHE_PREFIX) && !activeCaches.has(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })().catch(() => undefined)
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    if (
      isSensitiveApi(url.pathname) ||
      !PUBLIC_DATA_PATHS.has(url.pathname) ||
      request.headers.has("Authorization")
    ) {
      return;
    }
    event.respondWith(networkFirstPublicData(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.pathname.startsWith(REACT_ASSET_PREFIX)) {
    event.respondWith(cacheFirstReactAsset(request));
    return;
  }

  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidateShell(request, event));
  }
});
