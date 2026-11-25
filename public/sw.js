/*
 * App-shell service worker for the installable PWA.
 *
 * What it does, and deliberately does not do:
 *
 * - It caches only the SHELL (HTML, manifest, icons). Firestore, Auth and
 *   Storage requests are cross-origin and are never touched, so data still
 *   comes from Firebase's own offline cache and rules — this worker cannot
 *   serve a stale payment or a stale member list.
 * - Navigation is NETWORK-FIRST with the cached shell as an offline fallback.
 *   A cache-first shell would keep serving last week's HTML after a deploy,
 *   which is the classic PWA way to ship a broken app to every phone.
 * - Hashed build assets under /assets/ are cache-first, because their file
 *   name changes with their contents.
 *
 * Bump CACHE when the shell list changes; `activate` deletes older caches.
 */
const CACHE = 'gym-shell-v1'

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // A missing shell file must not block activation; the network still works.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Refresh the offline shell with whatever the network just served.
          const copy = response.clone()
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => undefined)
          )
          return response
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || Response.error()))
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              event.waitUntil(
                caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined)
              )
            }
            return response
          })
      )
    )
  }
})
