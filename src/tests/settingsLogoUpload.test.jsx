import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from '@/pages/Settings'

const { mocks, settingsValue, toastValue } = vi.hoisted(() => ({
  mocks: {
    getPtSurcharge: vi.fn(),
    setPtSurcharge: vi.fn(),
    getWhatsAppLink: vi.fn(),
    setWhatsAppLink: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
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
}))

vi.mock('@/services/pt', () => ({
  getPtSurcharge: mocks.getPtSurcharge,
  setPtSurcharge: mocks.setPtSurcharge,
}))

vi.mock('@/services/whatsappGroup', () => ({
  getWhatsAppLink: mocks.getWhatsAppLink,
  setWhatsAppLink: mocks.setWhatsAppLink,
}))

vi.mock('@/services/storage', () => ({
  uploadFile: mocks.uploadFile,
  deleteFile: mocks.deleteFile,
  logoPath: (name) => `logos/${name}`,
  isStorageReady: () => true,
}))

vi.mock('@/services/seedService', () => ({ loadSampleData: mocks.loadSampleData }))
vi.mock('@/services/migration', () => ({ ensureOriginPeriods: mocks.ensureOriginPeriods }))

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
  })

  it('reports success and keeps the object when the settings write succeeds', async () => {
    mocks.uploadFile.mockResolvedValue('https://example.test/logos/a.png')
    settingsValue.updateSettings.mockResolvedValue(true)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(settingsValue.updateSettings).toHaveBeenCalledWith({
      logoUrl: 'https://example.test/logos/a.png',
    }))
    await waitFor(() => expect(toastValue.success).toHaveBeenCalledWith('Logo uploaded'))
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  // updateSettings raises its own error toast and returns false rather than
  // throwing. The page ignored the boolean, so a failed save showed "Logo
  // uploaded" immediately after the error, and the settings document kept the
  // old logo while the operator believed the new one was live.
  it('does not claim success when the settings write fails', async () => {
    mocks.uploadFile.mockResolvedValue('https://example.test/logos/a.png')
    settingsValue.updateSettings.mockResolvedValue(false)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(settingsValue.updateSettings).toHaveBeenCalled())
    expect(toastValue.success).not.toHaveBeenCalledWith('Logo uploaded')
  })

  it('deletes the object it just uploaded when the settings write fails', async () => {
    mocks.uploadFile.mockResolvedValue('https://example.test/logos/a.png')
    settingsValue.updateSettings.mockResolvedValue(false)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledTimes(1))
    const uploadedPath = mocks.uploadFile.mock.calls[0][1]
    expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedPath)
  })

  it('does not report a second error when the cleanup itself fails', async () => {
    mocks.uploadFile.mockResolvedValue('https://example.test/logos/a.png')
    settingsValue.updateSettings.mockResolvedValue(false)
    mocks.deleteFile.mockRejectedValue(new Error('storage/object-not-found'))

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalled())
    // updateSettings owns the error message; a failed cleanup must not add
    // another one on top of it.
    expect(toastValue.error).not.toHaveBeenCalledWith(expect.stringContaining('storage/object-not-found'))
  })

  it('surfaces a real upload failure and never touches storage deletes', async () => {
    mocks.uploadFile.mockRejectedValue(new Error('storage/unauthorized'))

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(toastValue.error).toHaveBeenCalledWith('storage/unauthorized'))
    expect(settingsValue.updateSettings).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(toastValue.success).not.toHaveBeenCalled()
  })

  it('uploads under the logos prefix the storage rules actually match', async () => {
    mocks.uploadFile.mockResolvedValue('https://example.test/logos/a.png')
    settingsValue.updateSettings.mockResolvedValue(true)

    const { container } = render(<Settings />)
    await waitFor(() => expect(logoInput(container)).toBeTruthy())

    await pickLogo(container)

    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalled())
    // storage.rules matches /logos/{name}, a single segment. A gym-scoped path
    // such as logos/{gymId}/{file} would not match and would be denied.
    const uploadedPath = mocks.uploadFile.mock.calls[0][1]
    expect(uploadedPath).toMatch(/^logos\/[^/]+$/)
  })
})