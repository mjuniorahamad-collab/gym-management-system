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
import { describe, expect, it, vi } from 'vitest'
import { createPwaUpdates } from '@/utils/pwaUpdates'

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

function setup({ controlled = true, waiting = null } = {}) {
  const container = fakeContainer(controlled)
  const reload = vi.fn()
  const updates = createPwaUpdates({ reload, serviceWorker: container })
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
