import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from '@/pages/Settings'
import { settingsSchema } from '@/schemas/validationSchemas'
import { DEFAULT_GYM_TIMEZONE } from '@/utils/gymTime'

const { mocks, settingsValue, toastValue } = vi.hoisted(() => ({
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
      tagline: 'Strength • Discipline • Growing',
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
  uploadGymLogo: mocks.uploadGymLogo,
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
    timezone: 'Asia/Kolkata',
  },
  useSettings: () => settingsValue,
}))
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ toast: toastValue, ...toastValue, promise: vi.fn() }),
}))

const timezoneSelect = () => screen.getByLabelText(/Gym timezone/i)
const saveButton = () => screen.getByRole('button', { name: /Save settings/i })

describe('gym timezone setting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWhatsAppLink.mockResolvedValue('')
    mocks.getPtSurcharge.mockResolvedValue(0)
    settingsValue.updateSettings.mockResolvedValue(true)
  })

  it('persists a chosen timezone to the gym settings', async () => {
    render(<Settings />)

    await waitFor(() => expect(timezoneSelect()).toBeInTheDocument())
    await userEvent.selectOptions(timezoneSelect(), 'Asia/Dubai')
    await userEvent.click(saveButton())

    await waitFor(() =>
      expect(settingsValue.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'Asia/Dubai' })
      )
    )
  })

  /**
   * Gyms created before the timezone field existed have none stored. Leaving the
   * field blank would let an owner save an empty zone and every day boundary
   * would then depend on the device — the exact bug this setting fixes.
   */
  it('shows the canonical default for a gym with no stored timezone', async () => {
    render(<Settings />)

    await waitFor(() => expect(timezoneSelect()).toBeInTheDocument())
    expect(timezoneSelect().value).toBe(DEFAULT_GYM_TIMEZONE)
    expect(DEFAULT_GYM_TIMEZONE).toBe('Asia/Kolkata')

    await userEvent.click(saveButton())
    await waitFor(() =>
      expect(settingsValue.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'Asia/Kolkata' })
      )
    )
  })

  it('reflects a stored non-default timezone', async () => {
    settingsValue.settings = { ...settingsValue.settings, timezone: 'America/New_York' }

    render(<Settings />)

    await waitFor(() => expect(timezoneSelect().value).toBe('America/New_York'))
  })

  it('offers only zones the runtime can resolve', async () => {
    render(<Settings />)

    await waitFor(() => expect(timezoneSelect()).toBeInTheDocument())
    const values = [...timezoneSelect().options].map((o) => o.value)
    expect(values).toContain('Asia/Kolkata')
    expect(values).toContain('UTC')
    // A zone string that Intl cannot resolve would silently fall back at
    // runtime and leave the gym's day boundaries ambiguous.
    expect(values).not.toContain('')
    for (const v of values) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: v })).not.toThrow()
    }
  })
})

describe('settings schema timezone validation', () => {
  const base = {
    gymName: 'Himalye Wonders Gym',
    tagline: '',
    currency: 'INR',
    dateFormat: 'dd MMM yyyy',
    receiptPrefix: 'HWG',
  }

  it('accepts a valid IANA zone', () => {
    expect(settingsSchema.safeParse({ ...base, timezone: 'Asia/Kathmandu' }).success).toBe(true)
  })

  it('rejects a zone the runtime cannot resolve', () => {
    const result = settingsSchema.safeParse({ ...base, timezone: 'Mars/Olympus' })
    expect(result.success).toBe(false)
    expect(result.error.issues[0].message).toMatch(/valid timezone/i)
  })

  it('rejects a blank timezone rather than defaulting silently', () => {
    expect(settingsSchema.safeParse({ ...base, timezone: '' }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...base, timezone: undefined }).success).toBe(false)
  })
})