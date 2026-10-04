import { describe, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MemberDetail from '@/pages/MemberDetail'

const { mocks, authValue, settingsValue, toastValue, collections, member } = vi.hoisted(() => {
  const member = {
    id: 'm1',
    memberNo: 'MEM-0042',
    name: 'Ayesha Khan',
    email: 'ayesha@example.com',
    phone: '9812345678',
    gender: 'female',
    status: 'active',
    joinDate: '2026-07-01',
    photoUrl: '',
    membershipPlanId: 'p1',
    address: '',
    dob: '',
    emergencyName: '',
    emergencyPhone: '',
    notes: '',
  }
  return {
    mocks: {
      getById: vi.fn(),
      updateDocById: vi.fn(),
      createDoc: vi.fn(),
      logAudit: vi.fn(),
      uploadMemberPhoto: vi.fn(),
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

vi.mock('@/services/storage', () => ({ uploadMemberPhoto: mocks.uploadMemberPhoto }))

vi.mock('@/hooks/useFirestore', () => ({
  useCollection: (name) => ({ items: collections[name] || [], loading: false, error: null }),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))

vi.mock('@/context/SettingsContext', () => ({ useSettings: () => settingsValue }))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ toast: toastValue, ...toastValue, promise: vi.fn() }),
}))

describe('MemberDetail print portal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getById.mockResolvedValue(member)
    mocks.updateDocById.mockResolvedValue()
    mocks.createDoc.mockResolvedValue('new-id')
  })

  it('opens the print portal with the complete card for the viewed member', async () => {
    render(<MemberDetail />)

    await waitFor(() => expect(mocks.getById).toHaveBeenCalledWith('members', 'm1'))

    fireEvent.click(await screen.findByRole('button', { name: /View & print/i }))

    const print = document.getElementById('print-membership-card')
    expect(print).not.toBeNull()
    expect(within(print).getByText('Himalye Wonders Gym')).toBeInTheDocument()
    expect(within(print).getByText('Ayesha Khan')).toBeInTheDocument()
    expect(within(print).getByText('ID · MEM-0042')).toBeInTheDocument()
    expect(within(print).getByText('Active')).toBeInTheDocument()
    expect(within(print).getByText('3 Months')).toBeInTheDocument()
    expect(within(print).getByText('Jul 1, 2026')).toBeInTheDocument()
    expect(within(print).getByText('9812345678')).toBeInTheDocument()

    const qr = print.querySelector('.membership-card-qr')
    expect(qr).not.toBeNull()
    expect(qr.dataset.memberId).toBe('m1')
    expect(qr.querySelector('svg')).not.toBeNull()

    expect(within(print).queryByRole('button')).toBeNull()
  })
})
