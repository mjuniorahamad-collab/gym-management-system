import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    doc: vi.fn((db, ...path) => ({ __path: path.join('/'), __collection: path[0] })),
    getDoc: vi.fn(),
    getGymId: vi.fn(() => 'gym-1'),
  },
  state: { configured: true, db: {} },
}))

vi.mock('firebase/firestore', () => ({ doc: mocks.doc, getDoc: mocks.getDoc }))
vi.mock('@/firebase', () => ({
  get db() {
    return state.db
  },
  get isFirebaseConfigured() {
    return state.configured
  },
}))
vi.mock('@/services/ownerContext', () => ({ getGymId: mocks.getGymId, DEMO_GYM_ID: 'demo' }))

const { requireReceiptPrefix, resolveTenantReceiptPrefix, __resetTenantReceiptPrefixCache } =
  await import('@/services/receiptPrefixGuard')

const gymDoc = (prefix) => ({
  exists: () => true,
  data: () => (prefix === undefined ? {} : { receiptPrefix: prefix }),
})

const settingsAppDoc = () => ({
  exists: () => true,
  data: () => ({ gymId: 'gym-1', receiptPrefix: 'HWG' }),
})

/** firestore.rules gates the settings read on `resource != null`, so a missing
 *  settings document arrives as permission-denied. Throws on purpose. */
const settingsReadDenied = () => {
  const err = new Error('Missing or insufficient permissions.')
  err.code = 'permission-denied'
  throw err
}

/** A gym document plus (or minus) its settings document, read by path. */
function mockPair({ authority, settings }) {
  mocks.getDoc.mockImplementation(async (ref) => {
    if (ref.__path.includes('/settings/')) {
      return settings ? settingsAppDoc() : settingsReadDenied()
    }
    return gymDoc(authority)
  })
}

beforeEach(() => {
  state.configured = true
  state.db = {}
  mocks.getGymId.mockReturnValue('gym-1')
  mocks.doc.mockClear()
  mocks.getDoc.mockReset()
  mocks.getDoc.mockResolvedValue(gymDoc('HWG'))
  __resetTenantReceiptPrefixCache()
})

describe('requireReceiptPrefix — no tenant authority', () => {
  it('passes the supplied value through when Firebase is not configured', async () => {
    state.configured = false
    state.db = null
    await expect(requireReceiptPrefix('HWG', 'test')).resolves.toBe('HWG')
    expect(mocks.getDoc).not.toHaveBeenCalled()
  })

  it('passes the supplied value through when no gym is bound', async () => {
    mocks.getGymId.mockReturnValue(null)
    await expect(requireReceiptPrefix('SILVER', 'test')).resolves.toBe('SILVER')
    expect(mocks.getDoc).not.toHaveBeenCalled()
  })

  it('returns undefined rather than inventing a prefix when nothing was supplied', async () => {
    mocks.getGymId.mockReturnValue(null)
    await expect(requireReceiptPrefix(undefined, 'test')).resolves.toBeUndefined()
  })

  it('still rejects a malformed supplied prefix without tenancy', async () => {
    mocks.getGymId.mockReturnValue(null)
    await expect(requireReceiptPrefix('too long for the rule', 'test')).rejects.toThrow(/1-8 letters or digits/)
  })
})

describe('requireReceiptPrefix — tenant authority bound', () => {
  it('returns the authoritative prefix when the caller supplies none', async () => {
    await expect(requireReceiptPrefix(undefined, 'test')).resolves.toBe('HWG')
    expect(mocks.getDoc).toHaveBeenCalledTimes(1)
    expect(mocks.doc).toHaveBeenCalledWith(state.db, 'gyms', 'gym-1')
  })

  it('accepts a supplied prefix that matches the authoritative one', async () => {
    await expect(requireReceiptPrefix('HWG', 'test')).resolves.toBe('HWG')
  })

  it('refuses a supplied prefix that has drifted from the owner of record', async () => {
    mocks.getDoc.mockResolvedValue(gymDoc('CRY'))
    await expect(requireReceiptPrefix('HWG', 'recordPayment')).rejects.toMatchObject({
      name: 'TenantReceiptPrefixError',
      code: 'mismatch',
    })
    await expect(requireReceiptPrefix('HWG', 'recordPayment')).rejects.toThrow(/recordPayment/)
  })

  it('fails closed when the gyms document does not exist', async () => {
    mocks.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined })
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({ code: 'missing' })
  })

  it('fails closed when the stored prefix is malformed', async () => {
    mocks.getDoc.mockImplementation(async (ref) =>
      ref.__path.includes('/settings/') ? settingsReadDenied() : gymDoc('has spaces')
    )
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('fails closed when the gyms document cannot be read at all', async () => {
    mocks.getDoc.mockRejectedValue(new Error('permission-denied'))
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('does not treat an unreadable document as permission to fall back', async () => {
    mocks.getDoc.mockRejectedValue(new Error('network'))
    await expect(resolveTenantReceiptPrefix()).rejects.toMatchObject({ code: 'unreadable' })
  })
})

describe('receipt prefix caching', () => {
  it('reads the authoritative document once per bound gym', async () => {
    await requireReceiptPrefix('HWG', 'test')
    await requireReceiptPrefix('HWG', 'test')
    await requireReceiptPrefix(undefined, 'test')
    expect(mocks.getDoc).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the bound gym changes', async () => {
    await requireReceiptPrefix('HWG', 'test')
    mocks.getGymId.mockReturnValue('gym-2')
    mocks.getDoc.mockResolvedValue(gymDoc('CRY'))
    await expect(requireReceiptPrefix('CRY', 'test')).resolves.toBe('CRY')
    expect(mocks.doc).toHaveBeenCalledWith(state.db, 'gyms', 'gym-2')
    expect(mocks.getDoc).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure, so a transient error can recover', async () => {
    mocks.getDoc.mockRejectedValueOnce(new Error('network'))
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({ code: 'unreadable' })
    await expect(requireReceiptPrefix('HWG', 'test')).resolves.toBe('HWG')
  })
})

/**
 * State D: a settings document exists while the owner-of-record carries no
 * usable prefix. The mirror is the only value present, and promoting it into
 * authority is exactly what must never happen, so this is reported as an
 * inconsistency rather than as a plain "not configured yet".
 */
describe('requireReceiptPrefix — settings present, authority absent', () => {
  it('refuses with an actionable diagnosis instead of adopting the mirror', async () => {
    mockPair({ authority: undefined, settings: true })

    const err = await requireReceiptPrefix(undefined, 'test').catch((e) => e)
    expect(err).toMatchObject({ name: 'TenantReceiptPrefixError', code: 'inconsistent' })
    expect(err.message).toContain('gyms/gym-1/settings/app')
    expect(err.message).toContain('gyms/gym-1')
    expect(err.message).toMatch(/never promoted to authority/)
    expect(err.message).toMatch(/declares the prefix on gyms\/gym-1/)
    // The mirror's own value is never echoed back as the answer.
    expect(err.message).not.toMatch(/"HWG"/)
  })

  it('is still an actionable failure when the caller supplied a mirror value', async () => {
    mockPair({ authority: '', settings: true })
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({
      code: 'inconsistent',
    })
  })

  it('keeps the plain diagnosis when no settings document exists', async () => {
    mockPair({ authority: undefined, settings: false })
    await expect(requireReceiptPrefix(undefined, 'test')).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(mocks.getDoc).toHaveBeenCalledTimes(2)
  })

  it('still reports a malformed authority as malformed when no mirror exists', async () => {
    mockPair({ authority: 'has spaces', settings: false })
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({
      code: 'invalid',
    })
  })

  it('does not read the settings document on the happy path', async () => {
    mockPair({ authority: 'CRY', settings: true })
    await expect(requireReceiptPrefix('CRY', 'test')).resolves.toBe('CRY')
    expect(mocks.getDoc).toHaveBeenCalledTimes(1)
  })
})

/**
 * State C: both documents exist and disagree. The guard's whole job here is to
 * stop — it must not write either value across to the other side.
 */
describe('requireReceiptPrefix — mirror disagrees with the authority', () => {
  beforeEach(() => {
    mockPair({ authority: 'CRY', settings: true })
  })

  it('detects the mismatch and reports both paths and both values', async () => {
    const err = await requireReceiptPrefix('HWG', 'Payments').catch((e) => e)
    expect(err).toMatchObject({ name: 'TenantReceiptPrefixError', code: 'mismatch' })
    expect(err.message).toContain('Payments')
    expect(err.message).toContain('"HWG"')
    expect(err.message).toContain('"CRY"')
    expect(err.message).toContain('gyms/gym-1')
  })

  it('returns the authority, never the mirror, when the caller supplies nothing', async () => {
    await expect(requireReceiptPrefix(undefined, 'test')).resolves.toBe('CRY')
    await expect(resolveTenantReceiptPrefix()).resolves.toBe('CRY')
  })

  it('has no write surface, so neither side can be repaired here', async () => {
    await expect(requireReceiptPrefix('HWG', 'test')).rejects.toMatchObject({ code: 'mismatch' })
    const source = read('../services/receiptPrefixGuard.js')
    expect(source).not.toMatch(/[^a-zA-Z](setDoc|updateDoc|deleteDoc|writeBatch)\(/)
    expect(source).not.toMatch(/tx\.set\(/)
  })
})
