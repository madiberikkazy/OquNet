// OquNet Service Worker
// Handles caching, offline support, and PWA features

// Bumped to v2: the navigation strategy changed from cache-first to
// network-first (see cacheHtmlNetworkFirst below). Renaming the caches makes
// the activate handler drop every entry written under the old strategy,
// including any stale index.html still pointing at deleted chunk hashes.
const CACHE_NAME = 'oqunet-v2';
const ASSET_CACHE = 'oqunet-assets-v2';
const API_CACHE = 'oqunet-api-v2';
const IMAGE_CACHE = 'oqunet-images-v2';

// Assets to cache on install (app shell).
// Deliberately no JS/CSS here: their filenames are content-hashed and change
// every build, so any hardcoded list would rot. They're cached on first use
// instead — safe, because a hashed filename's contents never change.
const ASSET_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// API endpoints that should be cached
const API_PATTERNS = [
  '/api/',
];

// Image extensions to cache
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'];

// Install event - cache essential assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(ASSET_URLS).catch((err) => {
        console.warn('[SW] Some assets failed to cache:', err);
        // Don't fail install if some assets can't be cached
        return Promise.resolve();
      });
    })
  );
  
  // Force new service worker to activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (
            cacheName !== CACHE_NAME &&
            cacheName !== ASSET_CACHE &&
            cacheName !== API_CACHE &&
            cacheName !== IMAGE_CACHE
          ) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  // Claim all clients immediately
  self.clients.claim();
});

// Fetch event - implement caching strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extensions and other non-http(s)
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Determine caching strategy based on request type
  if (isImageRequest(request)) {
    event.respondWith(cacheImages(request));
  } else if (isApiRequest(request)) {
    event.respondWith(cacheApiResponse(request));
  } else if (isAssetRequest(request)) {
    event.respondWith(cacheAssets(request));
  } else {
    // HTML navigation: always try the network first so the document that names
    // the current chunk hashes is never stale. See cacheHtmlNetworkFirst.
    event.respondWith(cacheHtmlNetworkFirst(request));
  }
});

// Check if request is for an image
function isImageRequest(request) {
  const url = new URL(request.url);
  return IMAGE_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

// Check if request is for API
function isApiRequest(request) {
  const url = new URL(request.url);
  return API_PATTERNS.some((pattern) => url.pathname.includes(pattern));
}

// Check if request is for static assets
function isAssetRequest(request) {
  const url = new URL(request.url);
  return (
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.ttf') ||
    url.pathname.endsWith('.eot')
  );
}

// Cache images strategy: Cache first, fallback to network, then offline image
async function cacheImages(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    // Update cache in background
    fetch(request).then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
    }).catch(() => {}); // Silently fail if offline

    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return placeholder or cached version
    return new Response(
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23f0f0f0" width="100" height="100"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
}

// Cache API responses: Network first, fallback to cache
async function cacheApiResponse(request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    // Return offline error response
    return new Response(
      JSON.stringify({
        error: 'Offline',
        message: 'You are offline. This content may be outdated.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// Hashed JS/CSS: cache first. Safe by construction — the content hash is in the
// filename, so a given URL's bytes never change. This is what makes the lazy
// route chunks cheap on repeat visits.
async function cacheAssets(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  // Let a failure propagate as a real network error rather than resolving with
  // a synthetic text/plain body. A lazy chunk that can't load must reject its
  // dynamic import so src/utils/lazyRoute.js can recover; handing back a
  // well-formed non-JS response instead produces a much muddier failure.
  const response = await fetch(request);
  if (response && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

// HTML navigation: network first, cache only as an offline fallback.
//
// This MUST NOT be cache-first. index.html is the only file that names the
// content-hashed JS chunks, and every deploy replaces those names. A stale
// cached index.html asks for chunk hashes the server no longer has — and now
// that routes are code-split, most of those chunks were never visited and so
// were never cached either. The result is a 404 mid-navigation, a rejected
// dynamic import, and a blank screen that survives refresh. Going to the
// network first costs one conditional request (304s are cheap) and keeps the
// document and its chunks in lockstep.
async function cacheHtmlNetworkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline: fall back to the last good document, then to '/'.
    const cached = (await cache.match(request)) || (await cache.match('/'));
    return cached || new Response(
      '<!DOCTYPE html><html><body><h1>Offline</h1><p>You are offline.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// Handle messages from clients
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);

  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName))
      );
    }).then(() => {
      event.ports[0].postMessage({ success: true });
    });
  }

  if (event.data && event.data.type === 'GET_CACHE_SIZE') {
    getCacheSize().then((size) => {
      event.ports[0].postMessage({ size });
    });
  }
});

// Calculate total cache size
async function getCacheSize() {
  let totalSize = 0;
  const cacheNames = await caches.keys();

  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const keys = await cache.keys();

    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        totalSize += blob.size;
      }
    }
  }

  return totalSize;
}

// Handle sync events for offline actions
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync event:', event.tag);

  if (event.tag === 'sync-notifications') {
    event.waitUntil(syncNotifications());
  }

  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncNotifications() {
  try {
    console.log('[SW] Syncing notifications...');
    // Sync logic would go here
  } catch (err) {
    console.error('[SW] Sync failed:', err);
  }
}

async function syncData() {
  try {
    console.log('[SW] Syncing data...');
    // Sync logic would go here
  } catch (err) {
    console.error('[SW] Sync failed:', err);
  }
}

// Handle push notifications
self.addEventListener('push', (event) => {
  console.log('[SW] Push event received');

  let notificationData = {
    title: 'OquNet',
    body: 'You have a new notification',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect fill="%232853AF" width="192" height="192" rx="45"/><text x="50%" y="50%" font-size="96" font-weight="700" fill="white" text-anchor="middle" dy=".35em">O</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect fill="%232853AF" width="96" height="96"/><circle cx="48" cy="48" r="40" fill="white"/></svg>',
    tag: 'oqunet-notification',
    requireInteraction: false,
  };

  if (event.data) {
    try {
      notificationData = event.data.json();
    } catch {
      notificationData.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, notificationData)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked');
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Check if app is already open
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // If not, open a new window
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Handle notification close
self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed');
});

console.log('[SW] Service Worker loaded');
