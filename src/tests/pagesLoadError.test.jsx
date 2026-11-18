import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Payments from '@/pages/Payments'
import Dashboard from '@/pages/Dashboard'
import { LOAD_ERROR } from '@/utils/loadErrors'

const { state, mocks } = vi.hoisted(() => ({
  state: { errors: {}, reload: vi.fn() },
  mocks: { recordPayment: vi.fn(), deletePayment: vi.fn(), getPtSurcharge: vi.fn() },
}))

vi.mock('@/hooks/useFirestore', () => ({
  useCollection: (name) => ({
    items: [],
    loading: false,
    error: state.errors[name] || null,
    reload: state.reload,
  }),
  usePaginatedCollection: (name) => ({
    items: [],
    loading: false,
    error: state.errors[name] || null,
    hasMore: false,
    loadMore: vi.fn(),
    reload: state.reload,
  }),
}))

vi.mock('@/services/payments', () => ({ recordPayment: mocks.recordPayment, deletePayment: mocks.deletePayment }))
vi.mock('@/services/pt', () => ({ getPtSurcharge: mocks.getPtSurcharge }))
vi.mock('@/services/seedService', () => ({ loadSampleData: vi.fn() }))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => true, hasRole: () => true, user: { uid: 'u1' }, profile: { role: 'owner' } }),
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

const RAW_PERMISSION = 'Firebase: Error (permission-denied). Missing or insufficient permissions.'

describe('Payments page load failure', () => {
  beforeEach(() => {
    state.errors = {}
    vi.clearAllMocks()
    mocks.getPtSurcharge.mockResolvedValue(0)
    mocks.recordPayment.mockResolvedValue({ id: 'pay1', receiptNo: 'HWG-000001' })
    mocks.deletePayment.mockResolvedValue()
  })

  it('renders the error state instead of the empty state, without leaking the raw message', () => {
    state.errors.payments = RAW_PERMISSION

    render(<Payments />)

    expect(screen.getByText("Couldn't load payments")).toBeInTheDocument()
    expect(screen.getByText(LOAD_ERROR.PERMISSION)).toBeInTheDocument()
    expect(screen.queryByText(/Missing or insufficient/)).toBeNull()
    expect(screen.queryByText(/Firebase:/)).toBeNull()
    expect(screen.queryByText('No payments found')).toBeNull()
  })

  it('still shows the normal empty state when the load succeeded with no data', () => {
    render(<Payments />)

    expect(screen.getByText('No payments found')).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })

  it('retries the failed load when Try again is clicked', () => {
    state.errors.payments = RAW_PERMISSION

    render(<Payments />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(state.reload).toHaveBeenCalled()
  })
})

describe('Dashboard error banner', () => {
  beforeEach(() => {
    state.errors = {}
    vi.clearAllMocks()
    mocks.getPtSurcharge.mockResolvedValue(0)
    mocks.recordPayment.mockResolvedValue({ id: 'pay1', receiptNo: 'HWG-000001' })
    mocks.deletePayment.mockResolvedValue()
  })

  it('surfaces a failure from any collection with its source label and a safe message', async () => {
    state.errors.payments = { code: 'permission-denied', message: 'Missing or insufficient permissions.' }

    render(<Dashboard />)

    await waitFor(() => expect(screen.getByText('Some data could not be loaded')).toBeInTheDocument())
    expect(screen.getByText('Payments:')).toBeInTheDocument()
    expect(screen.getByText(LOAD_ERROR.PERMISSION)).toBeInTheDocument()
    expect(screen.queryByText(/Missing or insufficient/)).toBeNull()
    expect(screen.queryByText(/permission-denied/)).toBeNull()
  })

  it('shows no banner when every collection loaded cleanly', () => {
    render(<Dashboard />)

    expect(screen.queryByText('Some data could not be loaded')).toBeNull()
  })
})
