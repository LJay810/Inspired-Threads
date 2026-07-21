// Minimal service worker -- exists to satisfy Chrome/Android's installability requirement (a
// registered SW with a fetch handler), not to make this site work offline. This is a live-
// inventory storefront (stock polls every 20s, checkout goes through Stripe) -- caching
// anything dynamic here would mean shoppers seeing stale prices/stock or a stale cart. Only
// truly static assets (images, the shared CSS tokens file) are ever cached; everything else
// -- every /api/* call, index.html/admin.html themselves, and any cross-origin request
// (Stripe.js, Supabase, fonts, jsdelivr) -- is left completely untouched and goes straight to
// the network.

const CACHE_NAME = 'it-static-v1';
const PRECACHE_URLS = [
    '/shared/design-tokens.css',
    '/images/icons/icon-192.png',
    '/images/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        )
    );
    self.clients.claim();
});

function isCacheableStatic(url) {
    return url.origin === self.location.origin
        && (url.pathname.startsWith('/images/') || url.pathname === '/shared/design-tokens.css');
}

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return; // never touch POST (checkout, admin writes, etc.)

    const url = new URL(event.request.url);
    if (!isCacheableStatic(url)) return; // not calling respondWith() = normal network fetch, untouched

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                // Only cache a real, successful, same-origin response.
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            });
        })
    );
});
