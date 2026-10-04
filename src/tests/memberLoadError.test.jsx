import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MemberDetail from '@/pages/MemberDetail'

const { mocks, authValue, settingsValue, toastValue, collections, member } = vi.hoisted(() => {
  const member = {
    id: 'm1',
    memberNo: 'MEM-0042',
    name: 'Ayesha Khan',
    phone: '9812345678',
    gender: 'female',
    status: 'active',
    joinDate: '2026-07-01',
    photoUrl: '',
    membershipPlanId: 'p1',
  }
  return {
    mocks: {
      getById: vi.fn(),
      updateDocById: vi.fn(),
      createDoc: vi.fn(),
      logAudit: vi.fn(),
      uploadMemberPhoto: vi.fn(),
      readObjectUrl: vi.fn(),
    },
    authValue: {
      user: { uid: 'u1' },
      profile: { uid: 'u1', role: 'owner', name: 'Owner' },
      loading: false,
      error: null,
      can: () => true,
      hasRole: () => true,
    },
    settingsValue: {
      settings: { gymName: 'Himalye Wonders Gym', currency: 'INR', receiptPrefix: 'HWG' },
      loading: false,
      updateSettings: vi.fn(),
    },
    toastValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    collections: {
      membershipPlans: [{ id: 'p1', name: '3 Months', durationDays: 90, price: 3500, active: true }],
      payments: [],
      attendance: [],
      memberships: [],
      members: [],
      weightRecords: [],
    },
    member,
  }
})

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'm1' }),
  Link: ({ to, children }) => <a href={to}>{children}</a>,
}))

vi.mock('@/services/firestore', () => ({
  getById: mocks.getById,
  updateDocById: mocks.updateDocById,
  createDoc: mocks.createDoc,
}))

vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))
vi.mock('@/services/storage', () => ({ uploadMemberPhoto: mocks.uploadMemberPhoto, readObjectUrl: mocks.readObjectUrl }))

vi.mock('@/hooks/useFirestore', () => ({
  useCollection: (name) => ({ items: collections[name] || [], loading: false, error: null }),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))
vi.mock('@/context/SettingsContext', () => ({ useSettings: () => settingsValue }))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ toast: toastValue, ...toastValue, promise: vi.fn() }),
}))

describe('MemberDetail load failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateDocById.mockResolvedValue()
    mocks.createDoc.mockResolvedValue('new-id')
  })

  // reload() is fired from 12 call sites and none of them await it, so a
  // rejection escaped as an unhandled promise rejection while the page stayed
  // stuck on "Loading member..." forever.
  it('surfaces a read failure instead of spinning forever', async () => {
    mocks.getById.mockRejectedValue(new Error('permission-denied'))

    render(<MemberDetail />)

    await waitFor(() =>
      expect(screen.getByText('Could not load this member')).toBeInTheDocument()
    )
    expect(screen.getByText('permission-denied')).toBeInTheDocument()
    expect(screen.queryByText('Loading member…')).toBeNull()
  })

  it('does not report a read failure as a deleted member', async () => {
    mocks.getById.mockRejectedValue(new Error('permission-denied'))

    render(<MemberDetail />)

    await waitFor(() => screen.getByText('Could not load this member'))
    expect(screen.queryByText('Member not found')).toBeNull()
  })

  it('reports a missing member as not found when there is no error', async () => {
    mocks.getById.mockResolvedValue(null)

    render(<MemberDetail />)

    await waitFor(() => expect(screen.getByText('Member not found')).toBeInTheDocument())
  })

  it('recovers when the retry succeeds', async () => {
    const user = userEvent.setup()
    mocks.getById.mockRejectedValueOnce(new Error('permission-denied'))

    render(<MemberDetail />)

    await waitFor(() => screen.getByText('Could not load this member'))

    mocks.getById.mockResolvedValue(member)
    await user.click(screen.getByRole('button', { name: /Try again/i }))

    await waitFor(() => expect(screen.getByText('Ayesha Khan')).toBeInTheDocument())
    expect(screen.queryByText('Could not load this member')).toBeNull()
  })
})