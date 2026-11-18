import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const { mocks } = vi.hoisted(() => ({
  mocks: {
    doc: vi.fn(),
    runTransaction: vi.fn(),
    updateDoc: vi.fn(),
    setDoc: vi.fn(),
    getDoc: vi.fn(),
  },
}))

vi.mock('firebase/firestore', () => ({
  doc: mocks.doc,
  runTransaction: mocks.runTransaction,
  updateDoc: mocks.updateDoc,
  setDoc: mocks.setDoc,
  getDoc: mocks.getDoc,
}))

vi.mock('@/firebase', () => ({
  isFirebaseConfigured: true,
  db: { __handle: 'db' },
  app: null,
  auth: null,
  storage: null,
}))

import {
  persistSettingsUpdate,
  provisionTenantSettings,
  settingsUpdatePayload,
} from '@/services/tenantSettingsDoc'
import { buildTenantSettingsSeed } from '@/services/tenantSettings'

const GYM_PATH = 'gyms/gym-a'
const SETTINGS_PATH = 'gyms/gym-a/settings/app'

const GYM = { name: 'Crystal gym', tagline: '', receiptPrefix: 'CRY' }

beforeEach(() => {
  mocks.doc.mockReset()
  mocks.doc.mockImplementation((...args) => ({
    __path: args.filter((a) => typeof a === 'string').join('/'),
  }))
  mocks.runTransaction.mockReset()
  mocks.updateDoc.mockReset()
  mocks.updateDoc.mockResolvedValue(undefined)
  mocks.setDoc.mockReset()
  mocks.setDoc.mockResolvedValue(undefined)
  mocks.getDoc.mockReset()
})

/**
 * A transaction double with the behaviour that makes CF-5 a real risk:
 * reading a document that does NOT exist is reported as permission-denied
 * (firestore.rules gates `read` on `resource != null`), reads are resolved
 * against the document map at the moment they happen, and `set` only lands
 * when the update function returns.
 */
function fakeFirestore(initial = {}, { afterFirstRead = null } = {}) {
  const documents = { ...initial }
  const writes = []
  let reads = 0

  mocks.runTransaction.mockImplementation(async (_db, updateFunction) => {
    const pending = []
    const tx = {
      get: async (ref) => {
        const path = ref.__path
        const found = Object.prototype.hasOwnProperty.call(documents, path)
        if (!found) {
          const err = new Error('Missing or insufficient permissions.')
          err.code = 'permission-denied'
          throw err
        }
        const snapshot = { exists: () => true, data: () => documents[path] }
        reads += 1
        if (reads === 1 && afterFirstRead) afterFirstRead(documents)
        return snapshot
      },
      set: (ref, payload) => pending.push({ path: ref.__path, payload }),
    }
    const result = await updateFunction(tx)
    for (const write of pending) {
      documents[write.path] = write.payload
      writes.push(write)
    }
    return result
  })

  return { documents, writes }
}

describe('provisionTenantSettings — CF-5 transactional create', () => {
  it('creates the settings document when it does not exist', async () => {
    const firestore = fakeFirestore({ [GYM_PATH]: GYM })

    const payload = await provisionTenantSettings({
      gymId: 'gym-a',
      gym: GYM,
      receiptPrefix: 'CRY',
    })

    expect(payload.receiptPrefix).toBe('CRY')
    expect(firestore.documents[SETTINGS_PATH]).toEqual(payload)
    expect(firestore.writes).toHaveLength(1)
    expect(mocks.setDoc).not.toHaveBeenCalled()
    expect(mocks.updateDoc).not.toHaveBeenCalled()
  })

  it('refuses to provision a settings document that already exists', async () => {
    const existing = { gymId: 'gym-a', gymName: 'Crystal gym', currency: 'EUR' }
    const firestore = fakeFirestore({
      [GYM_PATH]: GYM,
      [SETTINGS_PATH]: existing,
    })

    await expect(
      provisionTenantSettings({ gymId: 'gym-a', gym: GYM, receiptPrefix: 'CRY' })
    ).rejects.toMatchObject({ code: 'settings-exists' })

    expect(firestore.writes).toHaveLength(0)
  })

  it('does not overwrite a document created while the transaction was opening', async () => {
    // A concurrent writer (a second tab, the CLI bootstrap) creates the
    // document AFTER our first read and BEFORE our write — the exact window a
    // plain read-then-setDoc has, and the reason it cannot be used here.
    const concurrent = { gymId: 'gym-a', gymName: 'Other tab', receiptPrefix: 'CRY' }
    const firestore = fakeFirestore(
      { [GYM_PATH]: GYM },
      {
        afterFirstRead: (documents) => {
          if (!documents[SETTINGS_PATH]) documents[SETTINGS_PATH] = concurrent
        },
      }
    )

    await expect(
      provisionTenantSettings({ gymId: 'gym-a', gym: GYM, receiptPrefix: 'CRY' })
    ).rejects.toMatchObject({ code: 'settings-exists' })

    expect(firestore.documents[SETTINGS_PATH]).toEqual(concurrent)
    expect(firestore.writes).toHaveLength(0)
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  it('writes the owner-of-record prefix, and nothing it invented', async () => {
    fakeFirestore({ [GYM_PATH]: GYM })

    const payload = await provisionTenantSettings({
      gymId: 'gym-a',
      gym: GYM,
      receiptPrefix: GYM.receiptPrefix,
    })

    expect(payload.receiptPrefix).toBe('CRY')
    expect(payload.gymName).toBe('Crystal gym')
    expect(payload.gymId).toBe('gym-a')
    expect(JSON.stringify(payload)).not.toMatch(/HWG|Himalye/)
    // Exactly the seed plus the owner-declared prefix: no logo, no extras.
    expect(payload).toEqual({
      ...buildTenantSettingsSeed({ gymId: 'gym-a', gym: GYM, existing: null }).write,
      receiptPrefix: 'CRY',
    })
    expect(payload).not.toHaveProperty('logoUrl')
    expect(payload).not.toHaveProperty('logoPath')
  })

  it('refuses without an owner-declared prefix rather than choosing one', async () => {
    for (const receiptPrefix of [undefined, null, '', 'has spaces', 'toolongprefix']) {
      const firestore = fakeFirestore({ [GYM_PATH]: GYM })
      await expect(
        provisionTenantSettings({ gymId: 'gym-a', gym: GYM, receiptPrefix })
      ).rejects.toThrow(/1-8 letters or digits/)
      expect(mocks.runTransaction).not.toHaveBeenCalled()
      expect(firestore.writes).toHaveLength(0)
    }
  })

  it('leaves every unrelated settings field untouched by writing nothing at all', async () => {
    const existing = {
      gymId: 'gym-a',
      gymName: 'Crystal gym',
      currency: 'INR',
      logoUrl: 'https://example.test/logo.png',
      timezone: 'Asia/Kolkata',
      receiptPrefix: 'CRY',
    }
    const firestore = fakeFirestore({
      [GYM_PATH]: GYM,
      [SETTINGS_PATH]: existing,
    })

    await expect(
      provisionTenantSettings({ gymId: 'gym-a', gym: GYM, receiptPrefix: 'CRY' })
    ).rejects.toMatchObject({ code: 'settings-exists' })

    expect(firestore.documents[SETTINGS_PATH]).toEqual(existing)
    expect(firestore.writes).toHaveLength(0)
  })

  it('never falls back to the shared global settings singleton', async () => {
    const firestore = fakeFirestore({ [GYM_PATH]: GYM })
    await provisionTenantSettings({ gymId: 'gym-a', gym: GYM, receiptPrefix: 'CRY' })
    expect(firestore.documents['settings/app']).toBeUndefined()
    expect(mocks.doc).not.toHaveBeenCalledWith(expect.anything(), 'settings', 'app')
  })
})

describe('updateSettings payload — CF-3 update-only contract', () => {
  it('strips receiptPrefix from anything an update would write', () => {
    expect(settingsUpdatePayload({ receiptPrefix: 'FORGED', gymName: 'Crystal gym' })).toEqual({
      gymName: 'Crystal gym',
    })
    expect(settingsUpdatePayload({ receiptPrefix: 'FORGED' })).not.toHaveProperty('receiptPrefix')
    expect(settingsUpdatePayload(undefined)).toEqual({})
  })

  it('is field-scoped to the tenant document and stamps the caller gymId', async () => {
    await persistSettingsUpdate({
      gymId: 'gym-a',
      data: { gymName: 'Crystal gym', currency: 'INR', receiptPrefix: 'FORGED' },
    })

    expect(mocks.updateDoc).toHaveBeenCalledTimes(1)
    expect(mocks.updateDoc.mock.calls[0][0]).toMatchObject({ __path: SETTINGS_PATH })
    expect(mocks.updateDoc.mock.calls[0][1]).toEqual({
      gymName: 'Crystal gym',
      currency: 'INR',
      gymId: 'gym-a',
    })
  })

  it('does not create a missing settings document', async () => {
    const notFound = new Error('No document to update')
    notFound.code = 'not-found'
    mocks.updateDoc.mockRejectedValue(notFound)

    await expect(
      persistSettingsUpdate({ gymId: 'gym-a', data: { gymName: 'Crystal gym' } })
    ).rejects.toMatchObject({ code: 'not-found' })

    expect(mocks.setDoc).not.toHaveBeenCalled()
    expect(mocks.runTransaction).not.toHaveBeenCalled()
  })

  it('never resolves through setDoc anywhere in the settings write path', async () => {
    const source = read('../services/tenantSettingsDoc.js')
    expect(source).not.toMatch(/[^a-zA-Z]setDoc\(/)
    expect(source).toMatch(/updateDoc\(settingsRef\(gymId\)/)
    expect(source).toMatch(/tx\.set\(ref, payload\)/)
  })

  it('routes Settings saves through the update-only helper', () => {
    const source = read('../context/SettingsContext.jsx')
    expect(source).not.toMatch(/[^a-zA-Z]setDoc\(/)
    expect(source).toMatch(/persistSettingsUpdate\(\{ gymId, data \}\)/)
    expect(source).toMatch(/settingsUpdatePayload\(data\)/)
    expect(source).toMatch(/classifyPrefixConsistency/)
  })
})
