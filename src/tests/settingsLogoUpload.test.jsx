/**
 * GYM LOGO UPLOAD (Firestore store)
 *
 * The logo is a 320px thumbnail in `gyms/{gymId}/settings/branding`, one
 * deterministic document per gym. The behaviours worth pinning are the ones a
 * user cannot see failing:
 *
 *   - the gym comes from the signed-in profile, never from the file
 *   - success is only claimed when the write actually resolved
 *   - a failed write claims nothing
 *   - re-uploading targets the SAME document, so nothing is stranded
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from '@/pages/Settings'

const { mocks, settingsValue, toastValue, authValue, GYM_ID, logoState } = vi.hoisted(() => {
  const GYM_ID = 'gym-alpha'
  return {
    GYM_ID,
    logoState: { dataUrl: null, loading: false, error: null, refresh: vi.fn() },
    mocks: {
      getPtSurcharge: vi.fn(),
      setPtSurcharge: vi.fn(),
      getWhatsAppLink: vi.fn(),
      setWhatsAppLink: vi.fn(),
      saveGymLogo: vi.fn(),
      readObjectUrl: vi.fn(),
      loadSampleData: vi.fn(),
      ensureOriginPeriods: vi.fn(),
    },
    settingsValue: {
      settings: {
        gymName: 'Himalye Wonders Gym',
        tagline: '',
        currency: 'INR',
        dateFormat: 'dd MMM yyyy',
        receiptPrefix: 'HWG',
        logoUrl: '',
      },
      loading: false,
      error: null,
      updateSettings: vi.fn(),
    },
    toastValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    authValue: { gymId: GYM_ID, role: 'owner', can: () => true, hasRole: () => true },
  }
})

vi.mock('@/services/pt', () => ({
  getPtSurcharge: mocks.getPtSurcharge,
  setPtSurcharge: mocks.setPtSurcharge,
}))

vi.mock('@/services/whatsappGroup', () => ({
  getWhatsAppLink: mocks.getWhatsAppLink,
  setWhatsAppLink: mocks.setWhatsAppLink,
}))

// The page writes the logo through saveGymLogo(gymId, file), which owns the
// resize and the deterministic document. There is deliberately no delete export:
// one document per gym means a failed write strands nothing.
vi.mock('@/services/photoStore', () => ({ saveGymLogo: mocks.saveGymLogo }))

vi.mock('@/hooks/usePhotoStore', () => ({
  useGymLogo: () => logoState,
}))

// useSecureImage still resolves legacy object paths for documents written
// before the Firestore store existed.
vi.mock('@/services/storage', () => ({ readObjectUrl: mocks.readObjectUrl }))

vi.mock('@/services/seedService', () => ({ loadSampleData: mocks.loadSampleData }))
vi.mock('@/services/migration', () => ({ ensureOriginPeriods: mocks.ensureOriginPeriods }))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))

vi.mock('@/context/SettingsContext', () => ({
  DEFAULT_SETTINGS: {
    gymName: '',
    tagline: '',
    currency: 'INR',
    dateFormat: 'dd MMM yyyy',
    receiptPrefix: '',
  },
  useSettings: () => settingsValue,
}))
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ toast: toastValue, ...toastValue, promise: vi.fn() }),
}))

/** The page renders the logo input without a label, so it is found directly. */
const logoInput = (container) => container.querySelector('input[type="file"]')

/** Drives the same change event a real file picker produces. */
const pickLogo = (container, name = 'logo.png') =>
  userEvent.upload(logoInput(container), new File(['x'], name, { type: 'image/png' }))

describe('Settings logo upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWhatsAppLink.mockResolvedValue('')
    mocks.getPtSurcharge.mockResolvedValue(1000)
    mocks.loadSampleData.mockResolvedValue(undefined)
    mocks.ensureOriginPeriods.mockResolvedValue(undefined)
    mocks.readObjectUrl.mockResolvedValue('blob:logo')
    logoState.dataUrl = null
    authValue.gymId = GYM_ID
  })

  it('saves under the authenticated gym and reports success', async () => {
    mocks.saveGymLogo.mockResolvedValue({ dataUrl: 'data:image/webp;base64,AAAA' })

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(mocks.saveGymLogo).toHaveBeenCalled())
    const [gymIdArg, fileArg] = mocks.saveGymLogo.mock.calls[0]
    expect(gymIdArg).toBe(GYM_ID)
    expect(fileArg).toBeInstanceOf(File)
    await waitFor(() => expect(toastValue.success).toHaveBeenCalledWith('Logo uploaded'))
    // The preview must not wait for the next settings read.
    expect(logoState.refresh).toHaveBeenCalled()
  })

  // The settings document used to carry a logoPath. That field is dead for new
  // uploads: the branding document is keyed by gym, so nothing about the logo is
  // written into settings and a failed settings save cannot point at a stale
  // object.
  it('does not write anything into the settings document', async () => {
    mocks.saveGymLogo.mockResolvedValue({ dataUrl: 'data:image/webp;base64,AAAA' })

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(toastValue.success).toHaveBeenCalledWith('Logo uploaded'))
    expect(settingsValue.updateSettings).not.toHaveBeenCalled()
  })

  it('surfaces a real upload failure and never reports success', async () => {
    mocks.saveGymLogo.mockRejectedValue(new Error('permission-denied'))

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(toastValue.error).toHaveBeenCalledWith('permission-denied'))
    expect(toastValue.success).not.toHaveBeenCalled()
  })

  // A gym with no resolved identity must fail before any write rather than
  // building a document under an unscoped id.
  it('refuses to upload when no gym identity is resolved', async () => {
    authValue.gymId = null

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() =>
      expect(toastValue.error).toHaveBeenCalledWith('Your gym could not be resolved')
    )
    expect(mocks.saveGymLogo).not.toHaveBeenCalled()
  })

  // One document per gym: the second upload targets the same place, which is what
  // makes orphan growth impossible and removes any need for a cleanup delete
  // after a failure.
  it('reuses one branding document across uploads', async () => {
    mocks.saveGymLogo.mockResolvedValue({ dataUrl: 'data:image/webp;base64,AAAA' })

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)
    await waitFor(() => expect(mocks.saveGymLogo).toHaveBeenCalledTimes(1))
    await pickLogo(container)
    await waitFor(() => expect(mocks.saveGymLogo).toHaveBeenCalledTimes(2))

    const gymIds = mocks.saveGymLogo.mock.calls.map((call) => call[0])
    expect(gymIds).toEqual([GYM_ID, GYM_ID])
  })

  // The logo is read from the branding document, so a receipt and the settings
  // preview cannot disagree about which logo is live.
  it('renders the stored branding thumbnail when one is loaded', async () => {
    logoState.dataUrl = 'data:image/webp;base64,STORED'

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    const image = container.querySelector('img[alt="Gym logo"]')
    expect(image?.getAttribute('src')).toBe('data:image/webp;base64,STORED')
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })
})
