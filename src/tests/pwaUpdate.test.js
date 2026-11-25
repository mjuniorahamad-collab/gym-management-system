/**
 * The update prompt is the difference between a phone picking up a new deploy
 * and a phone serving last week's shell forever. These tests drive the exact
 * event order the browser produces, with fakes instead of a real worker:
 *
 *   updatefound -> installing "statechange" (installed) -> prompt
 *   user taps Reload -> postMessage(SKIP_WAITING) -> controllerchange -> reload
 *
 * The important negative cases are here too: a FIRST install has no controller
 * and must not nag the user, and the page must not reload before the new worker
 * actually takes control (that would just re-open the old cached shell).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPwaUpdates, UPDATE_CHECK_INTERVAL_MS } from '@/utils/pwaUpdates'

function fakeWorker(state = 'installing') {
  const handlers = {}
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: (type, fn) => {
      handlers[type] = fn
    },
    fire: (type) => handlers[type]?.(),
  }
}

function fakeRegistration({ waiting = null, installing = null } = {}) {
  const handlers = {}
  const registration = {
    waiting,
    installing,
    update: vi.fn(() => Promise.resolve()),
    addEventListener: (type, fn) => {
      handlers[type] = fn
    },
    fire: (type) => handlers[type]?.(),
  }
  return registration
}

function fakeContainer(controlled = true) {
  const handlers = {}
  return {
    controller: controlled ? {} : null,
    addEventListener: (type, fn) => {
      handlers[type] = fn
    },
    fire: (type) => handlers[type]?.(),
  }
}

const instances = []

afterEach(() => {
  while (instances.length) instances.pop().stop()
  setVisibility('visible')
})

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

function setup({ controlled = true, waiting = null } = {}) {
  const container = fakeContainer(controlled)
  const reload = vi.fn()
  const updates = createPwaUpdates({ reload, serviceWorker: container })
  instances.push(updates)
  const seen = []
  updates.subscribe((available) => seen.push(available))
  const registration = fakeRegistration({ waiting })
  updates.register(registration)
  return { updates, container, registration, reload, seen }
}

describe('PWA update prompt', () => {
  it('stays quiet on a first install, when there is no controller to replace', () => {
    const { seen } = setup({ controlled: false, waiting: fakeWorker('installed') })
    expect(seen).toEqual([false])
  })

  it('prompts when a worker is already waiting for an existing page', () => {
    const { seen } = setup({ waiting: fakeWorker('installed') })
    expect(seen).toEqual([false, true])
  })

  it('prompts when a newly installing worker finishes installing', () => {
    const { seen, registration } = setup()
    const installing = fakeWorker('installing')
    registration.installing = installing
    registration.fire('updatefound')

    expect(seen).toEqual([false])

    installing.state = 'installed'
    installing.fire('statechange')

    expect(seen).toEqual([false, true])
  })

  it('ignores a worker that is still installing', () => {
    const { seen, registration } = setup()
    const installing = fakeWorker('installing')
    registration.installing = installing
    registration.fire('updatefound')
    installing.fire('statechange')
    expect(seen).toEqual([false])
  })

  it('asks the waiting worker to take over and reloads only once it controls the page', () => {
    const { updates, container, reload } = setup({ waiting: fakeWorker('installed') })

    expect(updates.apply()).toBe(true)
    expect(reload).not.toHaveBeenCalled()

    container.fire('controllerchange')
    container.fire('controllerchange')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no waiting worker', () => {
    const { updates, reload } = setup()
    expect(updates.apply()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('hides the prompt after the user accepts it', () => {
    const { updates, seen } = setup({ waiting: fakeWorker('installed') })
    updates.apply()
    expect(seen).toEqual([false, true, false])
  })
})

describe('periodic update checks for a long-lived app', () => {
  it('checks every 30 minutes while the app is visible', () => {
    vi.useFakeTimers()
    try {
      const { registration } = setup()
      expect(registration.update).not.toHaveBeenCalled()

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1000)
      expect(registration.update).not.toHaveBeenCalled()

      vi.advanceTimersByTime(2000)
      expect(registration.update).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
      expect(registration.update).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls nothing while hidden and checks immediately when it returns', () => {
    vi.useFakeTimers()
    try {
      setVisibility('hidden')
      const { registration } = setup()

      vi.advanceTimersByTime(2 * 60 * 60 * 1000)
      expect(registration.update).not.toHaveBeenCalled()

      setVisibility('visible')
      expect(registration.update).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
      expect(registration.update).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling when the watcher is stopped', () => {
    vi.useFakeTimers()
    try {
      const { updates, registration } = setup()
      updates.stop()

      vi.advanceTimersByTime(3 * UPDATE_CHECK_INTERVAL_MS)
      expect(registration.update).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a background check that finds a new worker still raises the prompt', () => {
    vi.useFakeTimers()
    try {
      const { registration, seen } = setup()

      // The browser only fires updatefound once update() finds new bytes.
      const installing = fakeWorker('installing')
      registration.update.mockImplementation(() => {
        registration.installing = installing
        registration.fire('updatefound')
        return Promise.resolve()
      })

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
      installing.state = 'installed'
      installing.fire('statechange')

      expect(seen).toEqual([false, true])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('service worker update contract', () => {
  const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')

  it('does not skipWaiting on install, so a waiting version can be announced', () => {
    const install = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('message'"))
    expect(install).not.toContain('skipWaiting')
  })

  it('activates on the SKIP_WAITING message sent by the prompt', () => {
    expect(sw).toContain("event.data.type === 'SKIP_WAITING'")
    expect(sw).toContain('self.skipWaiting()')
  })
})
