/**
 * THE FRESHNESS SEQUENCE.
 *
 * Two invariants, both of which are easy to break by accident and invisible in
 * the happy path:
 *
 * 1. The projection request NEVER fails the authoritative write that preceded it.
 *    A renewal is not a refund.
 * 2. The request carries ONLY `{ memberId }`. A client that sent a gymId would be
 *    asserting which tenant it belongs to, and the whole authorization chain
 *    exists so that claim never has to be trusted.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    httpsCallable: vi.fn(),
    getFunctions: vi.fn(() => ({ __functions: true })),
  },
}))

vi.mock('firebase/functions', () => ({
  httpsCallable: mocks.httpsCallable,
  getFunctions: mocks.getFunctions,
}))

const firebaseState = { configured: true }
vi.mock('@/firebase', () => ({
  get isFirebaseConfigured() {
    return firebaseState.configured
  },
}))

/**
 * Install the callable mock for one test.
 *
 * Uses `mockImplementation` rather than `mockReturnValue`, and is called AFTER
 * the module under test has been loaded. Order matters here: `vi.resetModules()`
 * re-evaluates the `vi.mock` factories, so a return value installed before a
 * later `load()` can be discarded — which showed up as
 * `reason: 'unknown'` (a TypeError from calling `undefined`, not a real error).
 */
function callableReturning(impl) {
  mocks.httpsCallable.mockImplementation(() => impl)
  return impl
}

async function load() {
  vi.resetModules()
  return import('@/services/projection')
}

beforeEach(() => {
  firebaseState.configured = true
  // Re-establish BOTH mocks every test, so no test can inherit another's.
  mocks.httpsCallable.mockReset()
  mocks.getFunctions.mockReset()
  mocks.getFunctions.mockImplementation(() => ({ __functions: true }))
  // Sensible default: a callable that succeeds.
  mocks.httpsCallable.mockImplementation(() => async () => ({ data: { ok: true } }))
})

describe('the request shape', () => {
  it('sends only the member id', async () => {
    const call = vi.fn(async () => ({ data: { ok: true } }))
    callableReturning(call)
    const { requestReprojection } = await load()

    await requestReprojection('member-7')

    expect(call).toHaveBeenCalledWith({ memberId: 'member-7' })
  })

  it('never sends a gymId, planId or any other claim', async () => {
    const call = vi.fn(async () => ({ data: { ok: true } }))
    callableReturning(call)
    const { requestReprojection } = await load()

    await requestReprojection('member-7')

    // An extra field here would be a client assertion about authority. The
    // server rejects unknown fields outright, so this is defence in depth.
    const payload = call.mock.calls[0][0]
    expect(Object.keys(payload)).toEqual(['memberId'])
  })

  it('calls the reprojectMember function', async () => {
    callableReturning(async () => ({ data: { ok: true } }))
    const { requestReprojection } = await load()

    await requestReprojection('member-7')

    expect(mocks.httpsCallable).toHaveBeenCalledWith(
      expect.anything(),
      'reprojectMember'
    )
  })
})

describe('never failing the authoritative write', () => {
  it('returns ok on success', async () => {
    callableReturning(async () => ({ data: { ok: true, status: 'ok' } }))
    const { requestReprojection } = await load()

    await expect(requestReprojection('m1')).resolves.toMatchObject({ ok: true, status: 'ok' })
  })

  it('does not throw when the callable rejects', async () => {
    callableReturning(async () => {
      throw Object.assign(new Error('unavailable'), { code: 'functions/unavailable' })
    })
    const { requestReprojection } = await load()

    // The critical assertion: a stale cache must never become a lost payment.
    await expect(requestReprojection('m1')).resolves.toMatchObject({
      ok: false,
      reason: 'functions/unavailable',
    })
  })

  it('does not throw when the callable is not deployed at all', async () => {
    callableReturning(async () => {
      throw Object.assign(new Error('not found'), { code: 'functions/not-found' })
    })
    const { requestReprojection } = await load()

    await expect(requestReprojection('m1')).resolves.toMatchObject({ ok: false })
  })

  it('does not throw when getFunctions itself fails', async () => {
    mocks.getFunctions.mockImplementation(() => {
      throw new Error('no app')
    })
    const { requestReprojection } = await load()

    await expect(requestReprojection('m1')).resolves.toMatchObject({ ok: false })
  })

  it('does not throw for a missing member id', async () => {
    const { requestReprojection } = await load()

    await expect(requestReprojection('')).resolves.toMatchObject({
      ok: false,
      reason: 'no-member-id',
    })
    await expect(requestReprojection(undefined)).resolves.toMatchObject({ ok: false })
  })
})

describe('offline / demo mode', () => {
  it('does not attempt a call when Firebase is not configured', async () => {
    firebaseState.configured = false
    const { requestReprojection } = await load()

    await expect(requestReprojection('m1')).resolves.toMatchObject({
      ok: false,
      reason: 'offline-mode',
    })
    expect(mocks.httpsCallable).not.toHaveBeenCalled()
  })
})

describe('warning hygiene', () => {
  it('warns once per distinct reason, not once per member', async () => {
    callableReturning(async () => {
      throw Object.assign(new Error('unavailable'), { code: 'functions/unavailable' })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { requestReprojection, _resetReprojectionWarnings } = await load()
    _resetReprojectionWarnings()

    await requestReprojection('m1')
    await requestReprojection('m2')
    await requestReprojection('m3')

    // Every one still reports its own failure; only the console is deduplicated.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('requestReprojectionAndConfirm', () => {
  it('marks a confirmed reprojection as trusted', async () => {
    callableReturning(async () => ({ data: { ok: true } }))
    const { requestReprojectionAndConfirm } = await load()

    await expect(requestReprojectionAndConfirm('m1')).resolves.toMatchObject({
      ok: true,
      trusted: true,
    })
  })

  it('does NOT mark a failed reprojection as trusted', async () => {
    // This is the flag a caller uses to decide whether `status` can be believed.
    // Reporting `trusted: true` after a failure would make a stale value look
    // authoritative — worse than not having the flag at all.
    callableReturning(async () => {
      throw Object.assign(new Error('down'), { code: 'functions/unavailable' })
    })
    const { requestReprojectionAndConfirm } = await load()

    await expect(requestReprojectionAndConfirm('m1')).resolves.toMatchObject({
      ok: false,
      trusted: false,
    })
  })
})