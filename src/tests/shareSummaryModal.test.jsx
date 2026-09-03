import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShareSummaryModal } from '@/components/common/ShareSummaryModal'

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

const member = {
  id: 'm1',
  name: 'Umar',
  phone: '9801234567',
  joinDate: '2026-07-01',
  isPT: false,
  ptSurchargeOverride: null,
}

const plan = { id: 'p1', name: 'Monthly', price: 1500, durationDays: 30 }

const ptCharge = { base: 1500, addon: 0, total: 1500 }

const ledger = { totals: { billed: 1500, paid: 1000, due: 500 } }

const settings = { gymName: 'ABC Fitness', currency: 'INR' }

function renderModal(props = {}) {
  return render(
    <ShareSummaryModal
      open
      onClose={() => {}}
      member={member}
      plan={plan}
      expiry={new Date(2026, 8, 30)}
      ptCharge={ptCharge}
      ledger={ledger}
      settings={settings}
      whatsAppLink=""
      {...props}
    />
  )
}

describe('ShareSummaryModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.open = vi.fn()
  })

  it('shows the customer-facing summary in the preview', () => {
    renderModal()
    expect(screen.getAllByText(/Hi Umar,/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/ABC Fitness/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Total: ₹1,500/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Paid: ₹1,000/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Due: ₹500/).length).toBeGreaterThan(0)
  })

  it('does not expose internal fields in the preview', () => {
    renderModal({ member: { ...member, notes: 'private note', gymId: 'gym-a' } })
    expect(screen.queryByText(/private note/)).toBeNull()
    expect(screen.queryByText(/gym-a/)).toBeNull()
  })

  it('shows WhatsApp, Copy Summary, and Print actions', () => {
    renderModal()
    expect(screen.getByRole('button', { name: /WhatsApp/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy Summary/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Print \/ PDF/i })).toBeInTheDocument()
  })

  it('opens WhatsApp with the member phone and pre-filled summary', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }))
    // 10-digit Indian mobile "9801234567" normalizes to E.164 "919801234567"
    const expected = 'https://wa.me/919801234567?text=' + encodeURIComponent(
      'Hi Umar,\n\nHere is your membership summary:\n\nGym: ABC Fitness\nMembership: Monthly\nStarted: Jul 1, 2026\nValid until: Sep 30, 2026\nPlan: ₹1,500\nTotal: ₹1,500\nPaid: ₹1,000\nDue: ₹500\n\nThank you.'
    )
    expect(window.open).toHaveBeenCalledWith(expected, '_blank', 'noopener,noreferrer')
  })

  it('uses the member-specific phone from the member record', () => {
    renderModal({ member: { ...member, phone: '9876543210' } })
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }))
    const url = window.open.mock.calls[0][0]
    expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true)
  })

  it('does not open WhatsApp with an invalid phone', () => {
    renderModal({ member: { ...member, phone: '123' } })
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }))
    expect(window.open).not.toHaveBeenCalled()
  })

  it('pre-fills the summary but never auto-sends', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }))
    const url = window.open.mock.calls[0][0]
    expect(url).toContain('text=')
    // window.open with a wa.me link + encoded text is a pre-filled draft only
  })

  it('copies the same customer-facing content via Copy Summary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    global.navigator = { clipboard: { writeText } }
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Copy Summary/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('Hi Umar,')
    expect(copied).toContain('Total: ₹1,500')
    expect(copied).not.toContain('m1')
    // Copy matches the same message WhatsApp would send
    const waUrl = 'https://wa.me/919801234567?text=' + encodeURIComponent(copied)
    expect(waUrl).toBe(
      'https://wa.me/919801234567?text=' +
        encodeURIComponent(
          'Hi Umar,\n\nHere is your membership summary:\n\nGym: ABC Fitness\nMembership: Monthly\nStarted: Jul 1, 2026\nValid until: Sep 30, 2026\nPlan: ₹1,500\nTotal: ₹1,500\nPaid: ₹1,000\nDue: ₹500\n\nThank you.'
        )
    )
  })

  it('appends the group link to the WhatsApp message when configured', () => {
    renderModal({ whatsAppLink: 'https://chat.whatsapp.com/abc' })
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }))
    const url = window.open.mock.calls[0][0]
    expect(decodeURIComponent(url)).toContain('Join our WhatsApp group: https://chat.whatsapp.com/abc')
  })

  it('triggers print when the Print button is clicked', () => {
    const spy = vi.spyOn(window, 'print').mockImplementation(() => {})
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Print \/ PDF/i }))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('renders a PT member with the PT amount in the message', () => {
    renderModal({
      member: { ...member, isPT: true },
      ptCharge: { base: 1500, addon: 1000, total: 2500 },
      ledger: { totals: { billed: 2500, paid: 1500, due: 1000 } },
    })
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }))
    const url = window.open.mock.calls[0][0]
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('Personal Training: ₹1,000')
    expect(decoded).toContain('Total: ₹2,500')
  })
})
