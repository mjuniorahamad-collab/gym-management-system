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
 * The browser only looks for a service worker update on a navigation (or once
 * a day), and an installed gym app can sit open on one screen all day. So while
 * the page is VISIBLE this polls registration.update() every 30 minutes; a
 * hidden tab, a backgrounded phone or a closed app polls nothing. Coming back
 * to the foreground checks immediately and restarts the interval.
 *
 * Everything is injectable so the flow can be tested without a browser.
 */

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

export function createPwaUpdates({
  reload,
  serviceWorker,
  checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  timers,
} = {}) {
  const sw = () => serviceWorker ?? (typeof navigator === 'undefined' ? null : navigator.serviceWorker)
  const reloadPage = reload || (() => window.location.reload())
  const setIntervalFn = timers?.setInterval || ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = timers?.clearInterval || ((id) => clearInterval(id))

  let activeRegistration = null
  let waiting = null
  let reloading = false
  let timer = null
  let visibilityHandler = null
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

  const checkForUpdate = () => {
    activeRegistration?.update?.().catch(() => undefined)
  }

  const startPolling = () => {
    if (timer !== null || !activeRegistration || checkIntervalMs <= 0) return
    timer = setIntervalFn(checkForUpdate, checkIntervalMs)
  }

  const stopPolling = () => {
    if (timer === null) return
    clearIntervalFn(timer)
    timer = null
  }

  const subscribe = (listener) => {
    listeners.add(listener)
    listener(Boolean(waiting))
    return () => listeners.delete(listener)
  }

  const register = (registration) => {
    if (!registration) return

    activeRegistration = registration
    adopt(registration.waiting)

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') adopt(registration.waiting || installing)
      })
    })

    if (typeof document === 'undefined') {
      startPolling()
      return
    }

    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        checkForUpdate()
        startPolling()
      } else {
        stopPolling()
      }
    }
    document.addEventListener('visibilitychange', visibilityHandler)
    if (document.visibilityState === 'visible') startPolling()
  }

  const stop = () => {
    stopPolling()
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler)
    }
    visibilityHandler = null
    activeRegistration = null
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

  return { subscribe, register, apply, stop }
}

export const pwaUpdates = createPwaUpdates()
