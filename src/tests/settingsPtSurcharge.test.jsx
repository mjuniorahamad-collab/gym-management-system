import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from '@/pages/Settings'

const { mocks, settingsValue, toastValue } = vi.hoisted(() => ({
  mocks: {
    getPtSurcharge: vi.fn(),
    setPtSurcharge: vi.fn(),
    getWhatsAppLink: vi.fn(),
    setWhatsAppLink: vi.fn(),
    isStorageReady: vi.fn(),
    uploadFile: vi.fn(),
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
  logoPath: (p) => p,
  isStorageReady: () => false,
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

const saveButton = () => screen.getByRole('button', { name: /Save PT surcharge/i })

describe('Settings PT surcharge read failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWhatsAppLink.mockResolvedValue('')
    mocks.setPtSurcharge.mockResolvedValue(undefined)
  })

  it('shows the configured surcharge and allows saving it', async () => {
    mocks.getPtSurcharge.mockResolvedValue(1000)

    render(<Settings />)

    await waitFor(() => expect(screen.getByDisplayValue('1000')).toBeInTheDocument())
    expect(saveButton()).toBeEnabled()

    await userEvent.click(saveButton())
    await waitFor(() => expect(mocks.setPtSurcharge).toHaveBeenCalledWith(1000))
  })

  it('treats a genuinely unset surcharge (0) as a blank, savable field', async () => {
    mocks.getPtSurcharge.mockResolvedValue(0)

    render(<Settings />)

    await waitFor(() => expect(mocks.getPtSurcharge).toHaveBeenCalled())
    expect(saveButton()).toBeEnabled()
  })

  // ptSurchargeSchema coerces '' to 0, so saving an unread surcharge silently
  // disabled PT pricing for the gym and reported success.
  it('blocks saving when the surcharge cannot be read', async () => {
    mocks.getPtSurcharge.mockRejectedValue(new Error('permission-denied'))

    render(<Settings />)

    await waitFor(() =>
      expect(screen.getByText(/Could not read the current PT surcharge|permission-denied/)).toBeInTheDocument()
    )
    expect(saveButton()).toBeDisabled()
  })

  it('cannot zero out a configured surcharge through a read failure', async () => {
    mocks.getPtSurcharge.mockRejectedValue(new Error('permission-denied'))

    render(<Settings />)

    await waitFor(() => expect(saveButton()).toBeDisabled())
    // Even a programmatic click must not reach the write.
    await userEvent.click(saveButton(), { pointerEventsCheck: 0 })
    expect(mocks.setPtSurcharge).not.toHaveBeenCalled()
  })

  it('disables the field so the unread value cannot be retyped over', async () => {
    mocks.getPtSurcharge.mockRejectedValue(new Error('permission-denied'))

    const { container } = render(<Settings />)

    await waitFor(() => expect(container.querySelector('input[type="number"]')).toBeDisabled())
  })
})