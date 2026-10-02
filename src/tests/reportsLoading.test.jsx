import { describe, beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import Reports from '@/pages/Reports'

const { mocks, authValue } = vi.hoisted(() => ({
  mocks: { subscribeCollection: vi.fn(), fetchPage: vi.fn() },
  authValue: {
    user: { uid: 'u1' },
    profile: { uid: 'u1', role: 'owner', name: 'Owner' },
    loading: false,
    error: null,
    can: () => true,
    hasRole: () => true,
  },
}))

vi.mock('@/services/firestore', () => ({
  subscribeCollection: mocks.subscribeCollection,
  fetchPage: mocks.fetchPage,
  isReady: vi.fn(() => true),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))

vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({ settings: { currency: 'INR', gymName: 'Test Gym' } }),
}))

const listeners = {}
let collections = {}

/** Collections that never deliver data, so the page stays in its loading state. */
let pending = new Set()

mocks.subscribeCollection.mockImplementation((name, onData) => {
  listeners[name] = onData
  if (!pending.has(name)) onData(collections[name] || [])
  return () => {}
})

function pushSnapshot(name, items) {
  act(() => listeners[name]?.(items))
}

describe('Reports loading gate', () => {
  const PAYMENTS = [
    { id: 'p1', memberId: 'm1', planId: 'pl1', type: 'membership', amount: 3000, date: '2026-01-10' },
    { id: 'p2', memberId: 'm2', planId: 'pl2', type: 'membership', amount: 1500, date: '2026-01-11' },
  ]

  const PLANS = [
    { id: 'pl1', name: 'Gold Monthly', price: 3000, gymId: 'g1' },
    { id: 'pl2', name: 'Silver Monthly', price: 1500, gymId: 'g1' },
  ]

  beforeEach(() => {
    collections = {
      members: [{ id: 'm1', name: 'Javed', joinDate: '2026-01-01', status: 'active' }],
      payments: PAYMENTS,
      expenses: [],
      attendance: [],
      membershipPlans: PLANS,
    }
    pending = new Set()
    Object.keys(listeners).forEach((k) => delete listeners[k])
    vi.clearAllMocks()
  })

  // The page gated on members/payments/expenses/attendance but not
  // membershipPlans, so it rendered "Revenue by plan" while the plan list was
  // still empty. planRevenue then falls back to the literal "Membership" for
  // every payment, collapsing the breakdown into one wrong bucket that silently
  // re-bucketed into real plan names a moment later.
  it('waits for membership plans before rendering the revenue breakdown', async () => {
    pending = new Set(['membershipPlans'])
    render(<Reports />)

    expect(await screen.findByText('Preparing reports…')).toBeInTheDocument()
    expect(screen.queryByText('Gold Monthly')).not.toBeInTheDocument()
    expect(screen.queryByText('Membership')).not.toBeInTheDocument()
  })

  it('does not show a collapsed single-bucket breakdown while plans are pending', async () => {
    pending = new Set(['membershipPlans'])
    render(<Reports />)

    await screen.findByText('Preparing reports…')
    expect(screen.queryByText('Revenue by plan')).not.toBeInTheDocument()
    expect(screen.queryByText('Total revenue')).not.toBeInTheDocument()
  })

  it('renders the real plan breakdown once plans arrive', async () => {
    pending = new Set(['membershipPlans'])
    render(<Reports />)

    await screen.findByText('Preparing reports…')

    pushSnapshot('membershipPlans', PLANS)

    await waitFor(() => expect(screen.getByText('Gold Monthly')).toBeInTheDocument())
    expect(screen.getByText('Silver Monthly')).toBeInTheDocument()
    expect(screen.queryByText('Membership')).not.toBeInTheDocument()
  })

  it('still renders when every collection has loaded', async () => {
    render(<Reports />)

    await waitFor(() => expect(screen.getByText('Revenue by plan')).toBeInTheDocument())
    expect(screen.getByText('Gold Monthly')).toBeInTheDocument()
    expect(screen.getByText('Silver Monthly')).toBeInTheDocument()
  })

  it('stays in the loading state while any other collection is pending', async () => {
    pending = new Set(['payments'])
    render(<Reports />)

    expect(await screen.findByText('Preparing reports…')).toBeInTheDocument()
  })
})