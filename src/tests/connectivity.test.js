import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OFFLINE MONEY GUARD.
 *
 * The property under test is narrow and deliberate: with a real backend
 * configured, an offline device must be refused BEFORE any work is staged, and
 * in demo/offline mode nothing may change.
 */
const fb = { configured: true }
vi.mock('@/firebase', () => ({
  get isFirebaseConfigured() {
    return fb.configured
  },
  db: null,
}))

const { OfflineError, assertOnline, isOffline } = await import('@/services/connectivity')

const setOnLine = (value) => {
  Object.defineProperty(globalThis.navigator, 'onLine', { value, configurable: true })
}

beforeEach(() => {
  fb.configured = true
  if (typeof globalThis.navigator !== 'undefined') setOnLine(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isOffline', () => {
  it('is true only when a backend is configured and the browser reports offline', () => {
    setOnLine(false)
    expect(isOffline()).toBe(true)
  })

  it('stays false when the browser reports online', () => {
    setOnLine(true)
    expect(isOffline()).toBe(false)
  })

  it('stays false in demo/offline mode, which is meant to work without a network', () => {
    fb.configured = false
    setOnLine(false)
    expect(isOffline()).toBe(false)
    expect(() => assertOnline('Recording a payment')).not.toThrow()
  })
})

describe('assertOnline', () => {
  it('throws a typed OfflineError naming the action', () => {
    setOnLine(false)
    let thrown = null
    try {
      assertOnline('Recording a payment')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(OfflineError)
    expect(thrown.name).toBe('OfflineError')
    expect(thrown.code).toBe('offline')
    expect(thrown.message).toBe(
      'Recording a payment needs an internet connection. Nothing was saved — reconnect and try again.'
    )
  })

  it('does nothing while online', () => {
    setOnLine(true)
    expect(() => assertOnline('Recording a payment')).not.toThrow()
  })
})

describe('money services refuse to write offline', () => {
  it('recordPayment rejects with OfflineError before staging anything', async () => {
    vi.resetModules()
    const { recordPayment } = await import('@/services/payments')
    setOnLine(false)

    // Matched on shape, not class identity: `vi.resetModules()` gives the
    // service its own copy of the module, so `instanceof` would compare two
    // distinct (but identical) classes.
    const failure = await recordPayment({
      values: { memberId: 'm1', amount: 100, method: 'Cash', date: '2026-01-01' },
    }).catch((err) => err)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe('OfflineError')
    expect(failure.code).toBe('offline')
    expect(failure.message).toContain('Recording a payment needs an internet connection')
  })
})
