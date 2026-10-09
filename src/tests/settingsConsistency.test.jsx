import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SettingsProvider, useSettings } from '@/context/SettingsContext'

const { mocks, state, authValue, toastValue } = vi.hoisted(() => ({
  mocks: {
    doc: vi.fn(),
    getDoc: vi.fn(),
    onSnapshot: vi.fn(),
    runTransaction: vi.fn(),
    updateDoc: vi.fn(),
    setDoc: vi.fn(),
  },
  // Stable identities: SettingsProvider's effect depends on `user`, so a fresh
  // object per call would re-run it forever.
  authValue: { user: { uid: 'owner-1' }, gymId: 'gym-a' },
  toastValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  state: {
    gym: { name: 'Crystal gym', receiptPrefix: 'CRY' },
    gymReadable: true,
    settings: {
      gymId: 'gym-a',
      gymName: 'Crystal gym',
      currency: 'INR',
      dateFormat: 'MMM D, YYYY',
      timezone: 'Asia/Kolkata',
      receiptPrefix: 'HWG',
    },
    settingsExists: true,
  },
}))

vi.mock('firebase/firestore', () => ({
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  onSnapshot: mocks.onSnapshot,
  runTransaction: mocks.runTransaction,
  updateDoc: mocks.updateDoc,
  setDoc: mocks.setDoc,
}))

vi.mock('@/firebase', () => ({
  isFirebaseConfigured: true,
  db: { __handle: 'db' },
  app: null,
  auth: null,
  storage: null,
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))
vi.mock('@/context/ToastContext', () => ({ useToast: () => toastValue }))

function Probe() {
  const { error, loading, pendingProvisioning, needsConfiguration } = useSettings()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error || ''}</span>
      <span data-testid="pending">{String(pendingProvisioning)}</span>
      <span data-testid="needs-configuration">{String(needsConfiguration)}</span>
    </div>
  )
}

async function renderProvider() {
  render(
    <SettingsProvider>
      <Probe />
    </SettingsProvider>
  )
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
  return screen.getByTestId('error').textContent
}

const settingsDoc = (receiptPrefix) => ({
  gymId: 'gym-a',
  gymName: 'Crystal gym',
  currency: 'INR',
  dateFormat: 'MMM D, YYYY',
  timezone: 'Asia/Kolkata',
  receiptPrefix,
})

beforeEach(() => {
  vi.clearAllMocks()
  state.gym = { name: 'Crystal gym', receiptPrefix: 'CRY' }
  state.gymReadable = true
  state.settings = settingsDoc('HWG')
  state.settingsExists = true

  mocks.doc.mockImplementation((...args) => ({
    __path: args.filter((a) => typeof a === 'string').join('/'),
  }))

  mocks.getDoc.mockImplementation(async () => {
    if (!state.gymReadable) throw new Error('network')
    return { exists: () => true, data: () => state.gym }
  })

  mocks.runTransaction.mockImplementation(async (_db, updateFunction) => {
    const pending = []
    const tx = {
      get: async (ref) => {
        if (ref.__path.includes('/settings/')) {
          if (state.settingsExists) return { exists: () => true, data: () => state.settings }
          const err = new Error('Missing or insufficient permissions.')
          err.code = 'permission-denied'
          throw err
        }
        return { exists: () => true, data: () => state.gym }
      },
      set: (ref, payload) => pending.push({ path: ref.__path, payload }),
    }
    const result = await updateFunction(tx)
    for (const write of pending) {
      state.settingsExists = true
      state.settings = write.payload
    }
    return result
  })

  mocks.onSnapshot.mockImplementation((_ref, next) => {
    next({
      exists: () => state.settingsExists,
      data: () => state.settings,
    })
    return () => {}
  })
})

/**
 * CF-3 detection point. The Settings screen already holds both documents, so
 * the inconsistency is classified from memory rather than repaired — no extra
 * read, no write, and the error is rendered through the page's existing error
 * slot, so nothing about the layout changes.
 */
describe('SettingsContext — authority/mirror consistency', () => {
  it('reports a mismatch as an actionable failure naming both paths and values', async () => {
    state.gym.receiptPrefix = 'CRY'
    state.settings = settingsDoc('HWG')

    const error = await renderProvider()

    expect(error).toContain('gyms/gym-a/settings/app')
    expect(error).toContain('gyms/gym-a')
    expect(error).toContain('"HWG"')
    expect(error).toContain('"CRY"')
    expect(error).toMatch(/does not match/)
    expect(error).toMatch(/Neither value is changed automatically/)
    expect(mocks.updateDoc).not.toHaveBeenCalled()
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  it('refuses to promote a settings mirror into a missing authority (state D)', async () => {
    state.gym = { name: 'Crystal gym' }
    state.settings = settingsDoc('HWG')

    const error = await renderProvider()

    expect(error).toContain('gyms/gym-a/settings/app')
    expect(error).toMatch(/never promoted to authority/)
    expect(error).toMatch(/declares the prefix on gyms\/gym-a/)
    expect(mocks.updateDoc).not.toHaveBeenCalled()
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  it('stays quiet when both sides agree', async () => {
    state.gym.receiptPrefix = 'CRY'
    state.settings = settingsDoc('CRY')

    const error = await renderProvider()

    expect(error).toBe('')
    expect(screen.getByTestId('needs-configuration').textContent).toBe('false')
  })

  it('does not blame the tenant when the owner-of-record read simply failed', async () => {
    state.gymReadable = false
    state.settings = settingsDoc('HWG')

    const error = await renderProvider()

    expect(error).toBe('')
    expect(mocks.updateDoc).not.toHaveBeenCalled()
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  it('reports the provisioning refusal instead of an inconsistency when nothing exists yet', async () => {
    state.gym = { name: 'Crystal gym' }
    state.settingsExists = false

    const error = await renderProvider()

    expect(error).toMatch(/1-8 letters or digits/)
    expect(error).not.toMatch(/never promoted to authority|does not match/)
    expect(mocks.updateDoc).not.toHaveBeenCalled()
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })
})
