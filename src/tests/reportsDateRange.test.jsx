import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Reports from '@/pages/Reports'

const { mocks, settingsValue } = vi.hoisted(() => ({
  mocks: { subscribeCollection: vi.fn(), fetchPage: vi.fn() },
  settingsValue: {
    settings: { currency: 'INR', gymName: 'Test Gym' },
    timezone: 'Asia/Kolkata',
  },
}))

vi.mock('@/services/firestore', () => ({
  subscribeCollection: mocks.subscribeCollection,
  fetchPage: mocks.fetchPage,
  isReady: vi.fn(() => true),
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    profile: { uid: 'u1', role: 'owner', name: 'Owner' },
    loading: false,
    error: null,
    can: () => true,
    hasRole: () => true,
  }),
}))
vi.mock('@/context/SettingsContext', () => ({ useSettings: () => settingsValue }))

const listeners = {}
let collections = {}

mocks.subscribeCollection.mockImplementation((name, onData) => {
  listeners[name] = onData
  onData(collections[name] || [])
  return () => {}
})

const PLANS = [
  { id: 'pl1', name: 'Gold Monthly', price: 3000 },
  { id: 'pl2', name: 'Silver Monthly', price: 1500 },
]

function seed() {
  collections = {
    members: [
      { id: 'm1', name: 'Javed', joinDate: '2026-01-05', status: 'active' },
      { id: 'm2', name: 'Asha', joinDate: '2026-01-06', status: 'active' },
    ],
    // One payment inside January, one far outside it.
    payments: [
      { id: 'p1', memberId: 'm1', planId: 'pl1', type: 'membership', amount: 3000, date: '2026-01-10' },
      { id: 'p2', memberId: 'm2', planId: 'pl2', type: 'membership', amount: 1500, date: '2026-06-10' },
    ],
    expenses: [{ id: 'e1', amount: 500, category: 'Rent', date: '2026-01-12' }],
    attendance: [{ id: 'a1', memberId: 'm1', date: '2026-01-10' }],
    membershipPlans: PLANS,
  }
}

const fromInput = () => screen.getByLabelText('From')
const toInput = () => screen.getByLabelText('To')

async function setRange(from, to) {
  await userEvent.clear(fromInput())
  await userEvent.type(fromInput(), from)
  await userEvent.clear(toInput())
  await userEvent.type(toInput(), to)
  await userEvent.click(screen.getByRole('button', { name: /Apply range/i }))
}

describe('Reports date range', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('excludes payments outside the selected range from the revenue tile', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText('Date range')).toBeInTheDocument())

    await setRange('2026-01-01', '2026-01-31')

    // Only p1 (3000) is in January; p2 (1500) in June must not be counted.
    await waitFor(() => {
      const tile = screen.getByText('Revenue').closest('div')
      expect(tile).toHaveTextContent(/₹\s?3,000/)
      expect(tile).not.toHaveTextContent(/₹\s?4,500/)
    })
  })

  it('includes both payments once the range covers both dates', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText('Date range')).toBeInTheDocument())

    await setRange('2026-01-01', '2026-06-30')

    await waitFor(() => {
      const tile = screen.getByText('Revenue').closest('div')
      expect(tile).toHaveTextContent(/₹\s?4,500/)
    })
  })

  it('shows the inclusive calendar-day count for the range', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText(/calendar days/)).toBeInTheDocument())

    await setRange('2026-01-01', '2026-01-31')
    await waitFor(() => expect(screen.getByText(/31 calendar days/)).toBeInTheDocument())
  })

  /**
   * 62 check-ins on two January days over a 31-day January is 2/day, not 31/day.
   * Dividing by "days that had attendance" invited owners to staff a gym that was
   * closed for 29 of those days.
   */
  it('averages check-ins over calendar days, not days with attendance', async () => {
    collections.attendance = [
      ...Array.from({ length: 31 }, (_, i) => ({ id: `a${i}`, date: '2026-01-05' })),
      ...Array.from({ length: 31 }, (_, i) => ({ id: `b${i}`, date: '2026-01-06' })),
    ]
    render(<Reports />)
    await waitFor(() => expect(screen.getByText(/calendar days/)).toBeInTheDocument())

    await setRange('2026-01-01', '2026-01-31')

    await waitFor(() => expect(screen.getByText(/Avg 2 check-ins\/day/)).toBeInTheDocument())
  })

  it('reports an empty state rather than a stale figure for an empty range', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText('Date range')).toBeInTheDocument())

    await setRange('2026-01-01', '2026-01-02')

    await waitFor(() => expect(screen.getByText('No expense data in this range')).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByText('No payment data in this range')).toBeInTheDocument()
    )
  })

  it('rejects a reversed range and keeps the previous figures', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText('Date range')).toBeInTheDocument())

    await setRange('2026-01-01', '2026-01-31')
    await waitFor(() => expect(screen.getByText(/31 calendar days/)).toBeInTheDocument())

    // Swap the ends: end before start.
    await userEvent.clear(fromInput())
    await userEvent.type(fromInput(), '2026-06-01')
    await userEvent.clear(toInput())
    await userEvent.type(toInput(), '2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Apply range/i }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/end is on or after its start/i)
    )
    // The applied range is untouched, so the day count still reads 31.
    expect(screen.getByText(/31 calendar days/)).toBeInTheDocument()
  })

  it('applies the Year to date preset', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText('Date range')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /Year to date/i }))

    await waitFor(() => {
      const year = new Date().getFullYear()
      expect(fromInput().value).toBe(`${year}-01-01`)
    })
  })

  it('applies the Last 30 days preset as an inclusive 30-day window', async () => {
    render(<Reports />)
    await waitFor(() => expect(screen.getByText('Date range')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /Last 30 days/i }))

    await waitFor(() => expect(screen.getByText(/30 calendar days/)).toBeInTheDocument())
  })
})