import { describe, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RenewalModal } from '@/components/common/RenewalModal'
import { ReceiptModal } from '@/components/common/ReceiptModal'
import { renewMembership } from '@/services/renewals'
import { recordPayment } from '@/services/payments'
import { addDays, toDateInputValue } from '@/utils/dateHelpers'
import { getRenewalStartDate, getMembershipPeriod, resolveEffectiveStart } from '@/utils/renewal'
import { formatCurrency, formatDate } from '@/utils/formatters'

vi.mock('@/services/renewals', () => ({ renewMembership: vi.fn() }))
vi.mock('@/services/payments', () => ({ recordPayment: vi.fn() }))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
  }),
}))

vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({
    settings: { gymName: 'Test Gym', currency: 'INR', receiptPrefix: 'HWG' },
    loading: false,
    updateSettings: vi.fn(),
  }),
}))

const PLANS = [{ id: 'p1', name: '3 Months', durationDays: 90, price: 3500, active: true }]

function renderModal(overrides = {}) {
  return render(
    <RenewalModal
      open
      onClose={vi.fn()}
      member={{ id: 'm1', name: 'Zaid', status: 'expired' }}
      currentPlan={PLANS[0]}
      currentExpiry={new Date(2026, 0, 1)}
      plans={PLANS}
      payments={[]}
      memberships={[]}
      onRenewed={vi.fn()}
      {...overrides}
    />
  )
}

describe('RenewalModal', () => {
  beforeEach(() => {
    renewMembership.mockReset()
    recordPayment.mockReset()
  })

  it('disables the submit button while a renewal is saving (duplicate-submit guard)', async () => {
    const user = userEvent.setup()
    renewMembership.mockImplementation(() => new Promise(() => {}))

    renderModal()

    const planSelect = screen.getAllByRole('combobox')[0]
    const amountInput = screen.getByPlaceholderText('0.00')

    await user.selectOptions(planSelect, 'p1')
    await user.type(amountInput, '2000')

    const form = screen.getByRole('form', { name: 'Renewal form' })
    expect(screen.queryByText(/Select a membership plan/i)).not.toBeInTheDocument()
    fireEvent.submit(form)

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /renew & charge/i })).toBeDisabled()
  })

  it('shows the effective start and new expiry dates', () => {
    renderModal()
    // Previous expiry is 2026-01-01 and is the default effective start.
    expect(screen.getByText('Effective from')).toBeInTheDocument()
    expect(screen.getByText('New expiry')).toBeInTheDocument()
  })

  it('resolves a plan whose id is numeric (option value string) and immediately computes the summary', async () => {
    const user = userEvent.setup()
    const plans = [
      { id: 1, name: 'Monthly', durationDays: 30, price: 1000, active: true },
      { id: 2, name: 'Quarterly', durationDays: 90, price: 2600, active: true },
      { id: 3, name: '6 Months', durationDays: 180, price: 4800, active: true },
      { id: 4, name: '1 Year', durationDays: 365, price: 9000, active: true },
    ]
    renewMembership.mockResolvedValue({ membership: { id: 'ms1' }, payment: { id: 'p1' } })

    renderModal({ plans, currentPlan: null, currentExpiry: null })

    const planSelect = screen.getAllByRole('combobox')[0]
    const amountInput = screen.getByPlaceholderText('0.00')

    await user.selectOptions(planSelect, '1')

    // Once a valid plan is selected, the whole summary computes immediately.
    const start = getRenewalStartDate(null)
    const expiry = addDays(start, 30)
    expect(screen.getAllByText('₹1,000').length).toBeGreaterThan(0)
    // The effective start (today, no current membership) appears in both the
    // period summary and the "Today" radio label, so tolerate multiple matches.
    expect(screen.getAllByText(formatDate(start)).length).toBeGreaterThan(0)
    expect(screen.getByText(formatDate(expiry))).toBeInTheDocument()
    expect(screen.getByText('Due')).toBeInTheDocument()

    await user.type(amountInput, '1000')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        member: expect.objectContaining({ id: 'm1' }),
        plan: expect.objectContaining({ id: 1, name: 'Monthly', price: 1000, durationDays: 30 }),
        currentExpiry: null,
      })
    )
  })

  it('resolves every membership plan and passes its full data to the calculation', async () => {
    const plans = [
      { id: 1, name: 'Monthly', durationDays: 30, price: 1000, active: true },
      { id: 2, name: 'Quarterly', durationDays: 90, price: 2600, active: true },
      { id: 3, name: '6 Months', durationDays: 180, price: 4800, active: true },
      { id: 4, name: '1 Year', durationDays: 365, price: 9000, active: true },
    ]
    renewMembership.mockResolvedValue({ membership: { id: 'ms1' }, payment: { id: 'p1' } })

    for (const plan of plans) {
      const user = userEvent.setup()
      const { unmount } = renderModal({ plans, currentPlan: null, currentExpiry: null })

      const planSelect = screen.getAllByRole('combobox')[0]
      await user.selectOptions(planSelect, String(plan.id))

      // New plan price reflects the selected plan.
      expect(screen.getAllByText(formatCurrency(plan.price, 'INR')).length).toBeGreaterThan(0)

      fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))
      await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
      expect(renewMembership).toHaveBeenLastCalledWith(
        expect.objectContaining({ plan: expect.objectContaining(plan) })
      )

      renewMembership.mockClear()
      unmount()
    }
  })

  it('keeps the selected plan when the currentPlan reference changes (no reset clobber)', async () => {
    const user = userEvent.setup()
    const plans = [
      { id: 1, name: 'Monthly', durationDays: 30, price: 1000, active: true },
      { id: 2, name: 'Quarterly', durationDays: 90, price: 2600, active: true },
    ]
    renewMembership.mockResolvedValue({ membership: { id: 'ms1' }, payment: { id: 'p1' } })

    const view = renderModal({ plans, currentPlan: null, currentExpiry: null })

    const planSelect = screen.getAllByRole('combobox')[0]
    await user.selectOptions(planSelect, '1')
    expect(screen.getAllByText('₹1,000').length).toBeGreaterThan(0)

    // A plans snapshot re-emit re-derives currentPlan as a NEW reference (Quarterly).
    view.rerender(
      <RenewalModal
        open
        onClose={vi.fn()}
        member={{ id: 'm1', name: 'Zaid', status: 'expired' }}
        currentPlan={plans[1]}
        currentExpiry={null}
        plans={plans}
        payments={[]}
        memberships={[]}
        onRenewed={vi.fn()}
      />
    )

    // The user's selection is preserved instead of being reset to the member's plan.
    const newPlanPriceRow = screen.getByText('Membership plan — base price').closest('div')
    expect(newPlanPriceRow.textContent).toContain('₹1,000')
    expect(newPlanPriceRow.textContent).not.toContain('₹2,600')
    expect(screen.getAllByRole('combobox')[0].value).toBe('1')
  })

  it('does NOT offer previous-balance collection when the member owes nothing', () => {
    renderModal()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('hides collection UI when an old due exists but has no recorded period to target', () => {
    renderModal({
      payments: [{ memberId: 'm1', amount: 500, date: '2026-06-05', method: 'Cash' }],
      memberships: [],
    })
    // Implicit (undocumented) dues cannot be explicitly targeted — the renewal
    // must stay a pure renewal instead of silently absorbing the balance.
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('collects the previous outstanding ONLY when the checkbox is ticked (explicit split)', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-new' }, payment: { id: 'pay-new' } })

    renderModal({
      payments: [{ memberId: 'm1', membershipId: 'ms-old', amount: 1000, date: '2026-06-05', method: 'Cash' }],
      memberships: [
        {
          id: 'ms-old',
          memberId: 'm1',
          planId: 'p0',
          planName: 'Monthly',
          price: 1500,
          startDate: '2026-06-01',
          expiryDate: '2026-07-01',
        },
      ],
    })

    // Old period owes ₹500 → opt-in row appears with the amount
    const checkbox = screen.getByRole('checkbox')
    expect(screen.getByText(/Also collect previous outstanding \(₹500\)/i)).toBeInTheDocument()

    // Unticked by default → submitting records NO extra payment
    await user.type(screen.getByPlaceholderText('0.00'), '3500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))
    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(recordPayment).not.toHaveBeenCalled()

    // Tick it, enter ₹400 of the ₹500 → separate payment against ms-old
    renewMembership.mockClear()
    fireEvent.click(checkbox)
    const collectInput = screen.getByLabelText('Collect previous balance')
    expect(screen.getByText(/Max ₹500/)).toBeInTheDocument()
    await user.type(collectInput, '400')

    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))
    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(recordPayment).toHaveBeenCalledTimes(1)
    )
    expect(recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          memberId: 'm1',
          membershipId: 'ms-old',
          amount: '400',
          note: 'Previous balance collection',
        }),
      })
    )
  })

  it('backs the renewal to the previous expiry by default (effective date = previous expiry)', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-n' }, payment: { id: 'pay-n' } })

    renderModal() // currentExpiry = 2026-01-01

    // Default "Previous expiry" is selected; the new period starts at the expiry.
    const prevExpiry = new Date(2026, 0, 1)
    const effectiveStart = resolveEffectiveStart({ mode: 'previous-expiry', currentExpiry: prevExpiry })
    const period = getMembershipPeriod({ currentExpiry: prevExpiry, plan: PLANS[0], effectiveStartDate: effectiveStart })
    expect(toDateInputValue(period.startDate)).toBe(toDateInputValue(prevExpiry))

    await user.selectOptions(screen.getAllByRole('combobox')[0], 'p1')
    await user.type(screen.getByPlaceholderText('0.00'), '3500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveStartDate: toDateInputValue(prevExpiry),
      })
    )
  })

  it('switching to "Today" renews from today (forward-dated)', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-t' }, payment: { id: 'pay-t' } })

    renderModal()

    await user.click(screen.getByRole('radio', { name: /Today/i }))
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'p1')
    await user.type(screen.getByPlaceholderText('0.00'), '3500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveStartDate: toDateInputValue(new Date()) })
    )
  })

  it('a custom effective date reveals a date field and is passed through', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-c' }, payment: { id: 'pay-c' } })

    renderModal()

    await user.click(screen.getByRole('radio', { name: /Custom date/i }))
    const customInput = screen.getByLabelText('Custom effective date')
    const custom = toDateInputValue(addDays(new Date(2026, 0, 1), -3))
    await user.clear(customInput)
    await user.type(customInput, custom)
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'p1')
    await user.type(screen.getByPlaceholderText('0.00'), '3500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(expect.objectContaining({ effectiveStartDate: custom }))
  })

  it('keeps the payment received date separate from the membership effective date', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-d' }, payment: { id: 'pay-d' } })

    renderModal()

    // Default membership effective date = previous expiry 2026-01-01
    const paidOn = '2026-08-28' // distinct received date
    const dateInput = screen.getByLabelText('Payment received date')
    await user.clear(dateInput)
    await user.type(dateInput, paidOn)
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'p1')
    await user.type(screen.getByPlaceholderText('0.00'), '3500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        date: paidOn, // payment received date — NOT overwritten
        effectiveStartDate: toDateInputValue(new Date(2026, 0, 1)), // membership effective date
      })
    )
    // the two concepts stay distinct in the call args
  })

  it('shows no overlap warning when backdating exactly to the previous expiry (contiguous)', () => {
    renderModal({
      memberships: [
        { id: 'ms-curr', memberId: 'm1', planName: '3 Months', startDate: '2025-10-03', expiryDate: '2026-01-01' },
      ],
    })
    expect(screen.queryByText(/Overlapping period/i)).toBeNull()
  })

  it('for a PT member shows the surcharge breakdown and charges base + surcharge', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-pt' }, payment: { id: 'pay-pt' } })

    renderModal({ ptSurcharge: 1000, member: { id: 'm1', name: 'Zaid', status: 'expired', isPT: true } })

    await user.selectOptions(screen.getAllByRole('combobox')[0], 'p1')
    await user.type(screen.getByPlaceholderText('0.00'), '4500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    // base 3500 + surcharge 1000 = 4500 new period total
    expect(screen.getByText('Personal Training surcharge')).toBeInTheDocument()
    expect(screen.getByText('New period total')).toBeInTheDocument()
    expect(screen.getAllByText('₹4,500').length).toBeGreaterThan(0)

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePrice: 4500,
        isPT: true,
        ptSurcharge: 1000,
      })
    )
  })

  it('for a regular member shows PT None and does not add the surcharge', async () => {
    const user = userEvent.setup()
    renewMembership.mockResolvedValue({ membership: { id: 'ms-reg' }, payment: { id: 'pay-reg' } })

    renderModal({ ptSurcharge: 1000, member: { id: 'm1', name: 'Zaid', status: 'expired', isPT: false } })

    await user.selectOptions(screen.getAllByRole('combobox')[0], 'p1')
    await user.type(screen.getByPlaceholderText('0.00'), '3500')
    fireEvent.submit(screen.getByRole('form', { name: 'Renewal form' }))

    expect(screen.getByText('Personal Training')).toBeInTheDocument()
    expect(screen.queryByText('Personal Training surcharge')).toBeNull()
    // the PT row shows "None" (surcharge), distinct from the "Outstanding due: None"
    const baseRow = screen.getByText('Membership plan — base price').closest('div')
    const ptRow = baseRow.nextElementSibling
    expect(ptRow.textContent).toContain('Personal Training')
    expect(ptRow.textContent).toContain('None')

    await waitFor(() => expect(renewMembership).toHaveBeenCalledTimes(1))
    expect(renewMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        effectivePrice: 3500,
        isPT: false,
        ptSurcharge: 0,
      })
    )
  })
})

describe('ReceiptModal', () => {
  it('shows paid amount, remaining due, payment status and membership period', () => {
    const payment = {
      id: 'pay-1',
      receiptNo: 'HWG-123456',
      memberId: 'm1',
      memberName: 'Zaid',
      planName: '3 Months',
      amount: 2000,
      method: 'Cash',
      date: '2026-08-14',
      paymentStatus: 'partial',
      startDate: '2026-08-14',
      expiryDate: '2026-11-12',
    }

    render(
      <ReceiptModal
        open
        onClose={vi.fn()}
        payment={payment}
        member={{ name: 'Zaid' }}
        plan={{ name: '3 Months' }}
        settings={{ gymName: 'Test Gym', currency: 'INR', receiptPrefix: 'HWG' }}
        summary={{ planAmount: 3500, totalPaid: 2000, dueAmount: 1500, paidInFull: false }}
      />
    )

    expect(screen.getAllByText('₹2,000').length).toBeGreaterThan(0)
    expect(screen.getAllByText('₹1,500').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Partial').length).toBeGreaterThan(0)
    expect(screen.getAllByText('₹3,500').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Aug 14, 2026 – Nov 12, 2026/).length).toBeGreaterThan(0)
  })

  it('renders the receipt in a hidden print-only portal with the same data', () => {
    const payment = {
      id: 'pay-1',
      receiptNo: 'HWG-123456',
      memberId: 'm1',
      memberName: 'Zaid',
      planName: '3 Months',
      amount: 900,
      method: 'Cash',
      date: '2026-08-14',
      paymentStatus: 'partial',
      startDate: '2026-08-14',
      expiryDate: '2026-11-12',
    }
    const settings = { gymName: 'Test Gym', currency: 'INR', receiptPrefix: 'HWG', tagline: 'Train hard' }
    const summary = { planAmount: 1500, totalPaid: 900, dueAmount: 600, paidInFull: false }

    render(
      <ReceiptModal
        open
        onClose={vi.fn()}
        payment={payment}
        member={{ name: 'Zaid' }}
        plan={{ name: '3 Months' }}
        settings={settings}
        summary={summary}
      />
    )

    const print = document.getElementById('print-receipt')
    expect(print).not.toBeNull()
    expect(within(print).getByText('Test Gym')).toBeInTheDocument()
    expect(within(print).getByText('Train hard')).toBeInTheDocument()
    expect(within(print).getByText('HWG-123456')).toBeInTheDocument()
    expect(within(print).getByText('Zaid')).toBeInTheDocument()
    expect(within(print).getByText('3 Months')).toBeInTheDocument()
    expect(within(print).getByText('Cash')).toBeInTheDocument()

    expect(within(print).getByText('₹1,500')).toBeInTheDocument()
    expect(within(print).getAllByText('₹900').length).toBeGreaterThan(0)
    expect(within(print).getByText('₹600')).toBeInTheDocument()
    expect(within(print).getByText('Partial')).toBeInTheDocument()
    expect(within(print).getByText(/Thank you for training with Test Gym/)).toBeInTheDocument()

    const modal = screen.getByRole('dialog')
    expect(within(modal).getByText('HWG-123456')).toBeInTheDocument()
    expect(within(modal).getByText('₹1,500')).toBeInTheDocument()
  })

  it('prints a fully-paid receipt as paid in full', () => {
    const payment = {
      id: 'pay-2',
      receiptNo: 'HWG-654321',
      memberId: 'm2',
      memberName: 'Sara',
      planName: 'Monthly',
      amount: 1500,
      method: 'UPI',
      date: '2026-08-14',
      paymentStatus: 'paid',
    }

    render(
      <ReceiptModal
        open
        onClose={vi.fn()}
        payment={payment}
        member={{ name: 'Sara' }}
        plan={{ name: 'Monthly' }}
        settings={{ gymName: 'Test Gym', currency: 'INR', receiptPrefix: 'HWG' }}
        summary={{ planAmount: 1500, totalPaid: 1500, dueAmount: 0, paidInFull: true }}
      />
    )

    const print = document.getElementById('print-receipt')
    expect(within(print).getByText('Paid in full')).toBeInTheDocument()
    expect(within(print).getAllByText('₹1,500').length).toBeGreaterThan(0)
    expect(within(print).getByText('Paid')).toBeInTheDocument()
  })
})
