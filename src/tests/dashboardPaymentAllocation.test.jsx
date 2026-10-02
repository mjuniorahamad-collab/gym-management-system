import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Dashboard from '@/pages/Dashboard'

const { mocks, collections } = vi.hoisted(() => ({
  mocks: { recordPayment: vi.fn(), getPtSurcharge: vi.fn() },
  collections: {},
}))

vi.mock('@/services/payments', () => ({ recordPayment: mocks.recordPayment }))

vi.mock('@/services/pt', () => ({
  getPtSurcharge: mocks.getPtSurcharge,
}))

vi.mock('@/services/seedService', () => ({ loadSampleData: vi.fn() }))

vi.mock('@/hooks/useFirestore', () => ({
  useCollection: (name) => ({
    items: collections[name] || [],
    loading: false,
    error: null,
  }),
  usePaginatedCollection: (name) => ({
    items: collections[name] || [],
    loading: false,
    error: null,
    hasMore: false,
    loadMore: vi.fn(),
  }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => true, hasRole: () => true, user: { uid: 'u1' } }),
}))

vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({
    settings: { gymName: 'Test Gym', currency: 'INR', receiptPrefix: 'HWG' },
    loading: false,
    updateSettings: vi.fn(),
  }),
}))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}))

vi.mock('@/components/charts/RevenueChart', () => ({ RevenueChart: () => null }))
vi.mock('@/components/charts/MembersTrendChart', () => ({ MembersTrendChart: () => null }))
vi.mock('@/components/charts/CategoryPie', () => ({ CategoryPie: () => null }))
vi.mock('@/components/dashboard/MigrationBanner', () => ({ MigrationBanner: () => null }))
vi.mock('@/components/common/WhatsAppReminderButton', () => ({ WhatsAppReminderButton: () => null }))

/**
 * The Dashboard opens PaymentForm from the Outstanding Dues card, passing the
 * member plus the specific period that owes (`targetMembershipId`).
 *
 * It did NOT pass the `memberships` collection, unlike every sibling call site
 * (MemberDetail and Payments both did). With `memberships` defaulting to `[]`,
 * `computeMemberLedger` saw no recorded period and synthesised an IMPLICIT one
 * from `member.joinDate + membershipPlanId`. Two consequences, both silent:
 *
 *   1. `openTargets` filters out implicit periods, so the period select offered
 *      only "Unallocated / general".
 *   2. The validity effect saw the chosen `membershipId` was not in the ledger's
 *      known ids and reset it to `''`.
 *
 * The operator clicked "Record Payment" on a specific owing period and the cash
 * was stored as unallocated FIFO credit instead of settling that period's dues.
 */
describe('Dashboard payment allocation', () => {
  const PERIOD_ID = 'mem-period-1'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPtSurcharge.mockResolvedValue(0)
    mocks.recordPayment.mockResolvedValue({ id: 'pay1', receiptNo: 'HWG-000001' })

    Object.keys(collections).forEach((k) => delete collections[k])
    collections.members = [
      {
        id: 'm1',
        name: 'Javed',
        memberNo: '001',
        status: 'active',
        membershipPlanId: 'pl1',
        joinDate: '2026-01-01',
      },
    ]
    collections.membershipPlans = [
      { id: 'pl1', name: 'Gold 3 Months', price: 3000, durationDays: 90, active: true },
    ]
    collections.memberships = [
      {
        id: PERIOD_ID,
        memberId: 'm1',
        planId: 'pl1',
        planName: 'Gold 3 Months',
        price: 3000,
        startDate: '2026-01-01',
        expiryDate: '2026-04-01',
        amountPaid: 0,
        amountDue: 3000,
        paymentStatus: 'due',
      },
    ]
    collections.payments = []
    collections.expenses = []
    collections.attendance = []
    collections.bookings = []
  })

  async function openPaymentForm() {
    render(<Dashboard />)
    const recordButtons = await screen.findAllByRole('button', { name: 'Record Payment' })
    await userEvent.click(recordButtons[0])
    return screen.findByRole('button', { name: 'Save payment' })
  }

  it('offers the owing membership period as an allocation target', async () => {
    await openPaymentForm()

    const select = screen.getByLabelText(/apply to membership period/i)
    const optionValues = Array.from(select.options).map((o) => o.value)

    expect(optionValues).toContain(PERIOD_ID)
  })

  it('tells the operator the payment is allocated only to the chosen period', async () => {
    await openPaymentForm()

    expect(
      screen.getByText(/allocated ONLY to the chosen period/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/stored as unallocated credit/i)).not.toBeInTheDocument()
  })

  it('keeps the chosen period when the payment is submitted', async () => {
    await openPaymentForm()

    const select = screen.getByLabelText(/apply to membership period/i)
    // The select must still hold the period the Dashboard opened with; if the
    // ledger never saw the real periods this would have been reset to ''.
    expect(select.value).toBe(PERIOD_ID)

    await userEvent.click(screen.getByRole('button', { name: 'Save payment' }))

    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(1))
    expect(mocks.recordPayment.mock.calls[0][0].values.membershipId).toBe(PERIOD_ID)
  })
})