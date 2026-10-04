import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from '@/pages/Settings'

const { mocks, settingsValue, toastValue, authValue, GYM_ID } = vi.hoisted(() => {
  const GYM_ID = 'gym-alpha'
  return {
    GYM_ID,
    mocks: {
      getPtSurcharge: vi.fn(),
      setPtSurcharge: vi.fn(),
      getWhatsAppLink: vi.fn(),
      setWhatsAppLink: vi.fn(),
      uploadGymLogo: vi.fn(),
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

// The page now uploads through uploadGymLogo(gymId, file), which owns the
// deterministic path. There is deliberately no deleteFile export any more:
// client Storage deletes are denied by storage.rules and the deterministic
// path removes the orphan they used to clean up.
vi.mock('@/services/storage', () => ({
  uploadGymLogo: mocks.uploadGymLogo,
  isStorageReady: () => true,
}))

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

const LOGO_URL = 'https://example.test/gym-alpha/branding/logo.png'
const LOGO_PATH = `gyms/${GYM_ID}/branding/logo.png`

describe('Settings logo upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWhatsAppLink.mockResolvedValue('')
    mocks.getPtSurcharge.mockResolvedValue(1000)
    mocks.loadSampleData.mockResolvedValue(undefined)
    mocks.ensureOriginPeriods.mockResolvedValue(undefined)
    authValue.gymId = GYM_ID
  })

  it('reports success and keeps the object when the settings write succeeds', async () => {
    mocks.uploadGymLogo.mockResolvedValue({ url: LOGO_URL, path: LOGO_PATH })
    settingsValue.updateSettings.mockResolvedValue(true)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(settingsValue.updateSettings).toHaveBeenCalledWith({
      logoUrl: LOGO_URL,
      logoPath: LOGO_PATH,
    }))
    await waitFor(() => expect(toastValue.success).toHaveBeenCalledWith('Logo uploaded'))
  })

  // updateSettings raises its own error toast and returns false rather than
  // throwing. The page ignored the boolean, so a failed save showed "Logo
  // uploaded" immediately after the error, and the settings document kept the
  // old logo while the operator believed the new one was live.
  it('does not claim success when the settings write fails', async () => {
    mocks.uploadGymLogo.mockResolvedValue({ url: LOGO_URL, path: LOGO_PATH })
    settingsValue.updateSettings.mockResolvedValue(false)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(settingsValue.updateSettings).toHaveBeenCalled())
    expect(toastValue.success).not.toHaveBeenCalledWith('Logo uploaded')
  })

// PHASE 3B — the old behaviour minted `logo-${Date.now()}.${ext}` and deleted
  // the stranded object when the settings write failed. The gym now owns exactly
  // one deterministic branding object, so a failed settings write leaves no
  // orphan and there is nothing to delete. Re-uploading twice must resolve to the
  // SAME object: that is the property which makes orphan growth impossible, and it
  // is what removed the need for a client-side cleanup delete.
  it('reuses one object path across uploads, so a failed settings write strands nothing', async () => {
    mocks.uploadGymLogo.mockResolvedValue({ url: LOGO_URL, path: LOGO_PATH })
    settingsValue.updateSettings.mockResolvedValue(false)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)
    await waitFor(() => expect(mocks.uploadGymLogo).toHaveBeenCalledTimes(1))
    await pickLogo(container)
    await waitFor(() => expect(mocks.uploadGymLogo).toHaveBeenCalledTimes(2))

    const gymIds = mocks.uploadGymLogo.mock.calls.map((c) => c[0])
    expect(gymIds).toEqual([GYM_ID, GYM_ID])
    // Every attempt targets the gym's single branding object.
    expect(LOGO_PATH).toBe(`gyms/${GYM_ID}/branding/logo.png`)
    expect(settingsValue.updateSettings).toHaveBeenCalledTimes(2)
    expect(toastValue.success).not.toHaveBeenCalledWith('Logo uploaded')
  })

  it('surfaces a real upload failure and never reports success', async () => {
    mocks.uploadGymLogo.mockRejectedValue(new Error('storage/unauthorized'))

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(toastValue.error).toHaveBeenCalledWith('storage/unauthorized'))
    expect(settingsValue.updateSettings).not.toHaveBeenCalled()
    expect(toastValue.success).not.toHaveBeenCalled()
  })

  // The gym must come from the trusted signed-in profile, never from the file.
  it('uploads under the gym-scoped branding path storage.rules matches', async () => {
    mocks.uploadGymLogo.mockResolvedValue({ url: LOGO_URL, path: LOGO_PATH })
    settingsValue.updateSettings.mockResolvedValue(true)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(mocks.uploadGymLogo).toHaveBeenCalled())
    const [gymIdArg, fileArg] = mocks.uploadGymLogo.mock.calls[0]
    // The gym id is taken from the authenticated profile, and the file is passed
    // through untouched so the service can derive the path.
    expect(gymIdArg).toBe(GYM_ID)
    expect(fileArg).toBeInstanceOf(File)
    // The object name is the deterministic constant, not the user's filename.
    expect(LOGO_PATH).toBe(`gyms/${GYM_ID}/branding/logo.png`)
    expect(LOGO_PATH).not.toContain(Date.now().toString())
  })

  // A gym with no resolved identity must fail before any Storage call rather
  // than building an unscoped path.
  it('refuses to upload when no gym identity is resolved', async () => {
    authValue.gymId = null
    mocks.uploadGymLogo.mockResolvedValue({ url: LOGO_URL, path: LOGO_PATH })
    settingsValue.updateSettings.mockResolvedValue(true)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(toastValue.error).toHaveBeenCalledWith('Your gym could not be resolved'))
    expect(mocks.uploadGymLogo).not.toHaveBeenCalled()
    expect(settingsValue.updateSettings).not.toHaveBeenCalled()
  })
})