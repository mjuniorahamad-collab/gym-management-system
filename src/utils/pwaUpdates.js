/**
 * "A new version is available" wiring for the app-shell service worker.
 *
 * The worker in public/sw.js deliberately does not call skipWaiting(), so a
 * freshly deployed build installs and then WAITS. This module notices that
 * waiting worker and exposes two things: a subscription for the prompt, and
 * apply(), which tells the worker to take over and reloads once it has.
 *
 * The reload is driven by `controllerchange`, not fired immediately after the
 * message: reloading before the new worker controls the page can load the old
 * cached shell again, which is the exact "stuck on the old version" bug this
 * prompt exists to fix.
 *
 * Everything is injectable so the flow can be tested without a browser.
 */

export function createPwaUpdates({ reload, serviceWorker } = {}) {
  const sw = () => serviceWorker ?? (typeof navigator === 'undefined' ? null : navigator.serviceWorker)
  const reloadPage = reload || (() => window.location.reload())

  let waiting = null
  let reloading = false
  const listeners = new Set()

  const publish = () => {
    for (const listener of listeners) listener(Boolean(waiting))
  }

  const adopt = (worker) => {
    // On a first install there is no controller and nothing to replace: the
    // page is already running the build the worker just cached.
    if (!worker || !sw()?.controller) return
    waiting = worker
    publish()
  }

  const subscribe = (listener) => {
    listeners.add(listener)
    listener(Boolean(waiting))
    return () => listeners.delete(listener)
  }

  const register = (registration) => {
    if (!registration) return

    adopt(registration.waiting)

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') adopt(registration.waiting || installing)
      })
    })

    // An installed app can sit open for days. Look again whenever it comes back
    // to the foreground so the prompt appears without a manual reload.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update?.().catch(() => undefined)
      })
    }
  }

  const apply = () => {
    if (!waiting) return false
    const worker = waiting
    waiting = null
    publish()

    const container = sw()
    container?.addEventListener?.('controllerchange', () => {
      if (reloading) return
      reloading = true
      reloadPage()
    })
    worker.postMessage({ type: 'SKIP_WAITING' })
    return true
  }

  return { subscribe, register, apply }
}

export const pwaUpdates = createPwaUpdates()
