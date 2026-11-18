import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const { mocks, created } = vi.hoisted(() => ({
  mocks: {
    doc: vi.fn(),
    getDoc: vi.fn(),
    getGymId: vi.fn(() => 'gym-a'),
  },
  created: [],
}))

vi.mock('firebase/firestore', () => ({ doc: mocks.doc, getDoc: mocks.getDoc }))
vi.mock('@/firebase', () => ({
  isFirebaseConfigured: true,
  db: { __handle: 'db' },
  app: null,
  auth: null,
  storage: null,
}))
vi.mock('@/services/ownerContext', () => ({ getGymId: mocks.getGymId, DEMO_GYM_ID: 'demo' }))

// The seed's entire Firestore surface, so the suite never builds a client.
vi.mock('@/services/firestore', () => ({
  isReady: () => true,
  listAll: async () => [],
  getById: async () => null,
  createDoc: async (name, data) => {
    created.push({ name, data })
    return `id-${created.length}`
  },
  updateDocById: async () => {},
}))
vi.mock('@/services/projection', () => ({ requestReprojection: async () => {} }))
vi.mock('@/services/pt', () => ({ getPtSurcharge: () => 0 }))

const { loadSampleData } = await import('@/services/seedService')

const gymDoc = (prefix) => ({
  exists: () => true,
  data: () => (prefix === undefined ? {} : { receiptPrefix: prefix }),
})

const settingsAppDoc = () => ({
  exists: () => true,
  data: () => ({ gymId: 'gym-a', receiptPrefix: 'HWG' }),
})

const settingsReadDenied = () => {
  const err = new Error('Missing or insufficient permissions.')
  err.code = 'permission-denied'
  throw err
}

function mockPair({ authority, settings }) {
  mocks.getDoc.mockImplementation(async (ref) => {
    if (ref.__path.includes('/settings/')) {
      return settings ? settingsAppDoc() : settingsReadDenied()
    }
    return gymDoc(authority)
  })
}

const payments = () => created.filter((c) => c.name === 'payments')

beforeEach(() => {
  created.length = 0
  mocks.getGymId.mockReturnValue('gym-a')
  mocks.doc.mockReset()
  mocks.doc.mockImplementation((...args) => ({
    __path: args.filter((a) => typeof a === 'string').join('/'),
  }))
  mocks.getDoc.mockReset()
  mockPair({ authority: 'CRY', settings: false })
})

describe('seedService — receipts are never numbered under an invented prefix', () => {
  it('refuses to seed when the gym carries no receipt prefix', async () => {
    mockPair({ authority: undefined, settings: false })

    await expect(loadSampleData()).rejects.toMatchObject({
      name: 'TenantReceiptPrefixError',
      code: 'invalid',
    })

    expect(created).toHaveLength(0)
  })

  it('refuses to seed when only a settings mirror exists (state D)', async () => {
    mockPair({ authority: undefined, settings: true })

    const err = await loadSampleData().catch((e) => e)
    expect(err).toMatchObject({ name: 'TenantReceiptPrefixError', code: 'inconsistent' })
    expect(err.message).toMatch(/never promoted to authority/)
    expect(err.message).toContain('gyms/gym-a')
    expect(err.message).not.toMatch(/"HWG"/)

    expect(created).toHaveLength(0)
  })

  it('numbers sample receipts under the tenant prefix', async () => {
    mockPair({ authority: 'CRY', settings: false })

    await loadSampleData()

    expect(payments().length).toBeGreaterThan(0)
    for (const { data } of payments()) {
      expect(data.receiptNo).toMatch(/^CRY-\d+$/)
    }
    expect(JSON.stringify(created)).not.toMatch(/HWG/)
  })

  it('ignores a settings mirror that disagrees with the authority', async () => {
    mockPair({ authority: 'CRY', settings: true })

    await loadSampleData()

    for (const { data } of payments()) {
      expect(data.receiptNo).toMatch(/^CRY-/)
      expect(data.receiptNo).not.toMatch(/^HWG-/)
    }
    expect(JSON.stringify(created)).not.toMatch(/HWG/)
  })

  it('has no hardcoded prefix anywhere in the seeding source', () => {
    const source = read('../services/seedService.js')
    expect(source).not.toMatch(/'HWG'|"HWG"/)
    expect(source).toMatch(/requireReceiptPrefix\(undefined, 'seedService'\)/)
  })
})
