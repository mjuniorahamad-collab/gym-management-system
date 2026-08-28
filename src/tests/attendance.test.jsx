import { describe, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Attendance from '@/pages/Attendance'

const { mocks, toastMocks, authValue } = vi.hoisted(() => ({
  mocks: {
    createDoc: vi.fn(),
    updateDocById: vi.fn(),
    removeDoc: vi.fn(),
    fetchPage: vi.fn(),
    subscribeCollection: vi.fn(),
    logAudit: vi.fn(),
  },
  toastMocks: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
  createDoc: mocks.createDoc,
  updateDocById: mocks.updateDocById,
  removeDoc: mocks.removeDoc,
  fetchPage: mocks.fetchPage,
  subscribeCollection: mocks.subscribeCollection,
  isReady: vi.fn(() => true),
}))

vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authValue,
}))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ toast: toastMocks, ...toastMocks, promise: vi.fn() }),
}))

const listeners = {}
let collections = {}

mocks.subscribeCollection.mockImplementation((name, onData) => {
  listeners[name] = onData
  onData(collections[name] || [])
  return () => {}
})

function pushSnapshot(name, items) {
  act(() => listeners[name]?.(items))
}

function renderPage() {
  return render(<Attendance />)
}

describe('Attendance check-in/check-out', () => {
  beforeEach(() => {
    collections = {
      attendance: [],
      members: [{ id: 'm1', name: 'Zaid', phone: '9812345678' }],
      trainers: [],
      classes: [],
      bookings: [],
      membershipPlans: [],
      payments: [],
      expenses: [],
    }
    Object.keys(listeners).forEach((k) => delete listeners[k])
    vi.clearAllMocks()
    mocks.createDoc.mockResolvedValue('mock-id')
    mocks.updateDocById.mockResolvedValue()
    mocks.logAudit.mockResolvedValue()
  })

  it('manual check-in shows only a success toast and writes an attendance record', async () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(mocks.createDoc).toHaveBeenCalledTimes(1))
    expect(mocks.createDoc).toHaveBeenCalledWith(
      'attendance',
      expect.objectContaining({ memberId: 'm1', checkOut: '', source: 'manual' })
    )
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entity: 'attendance' }))
    expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('attendance list refreshes from the realtime subscription after a check-in', async () => {
    renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))

    pushSnapshot('attendance', [
      {
        id: 'att-1',
        memberId: 'm1',
        date: new Date().toISOString(),
        checkIn: new Date().toISOString(),
        checkOut: '',
        source: 'manual',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])

    expect(await screen.findByText('In gym')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check out' })).toBeInTheDocument()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('manual check-out shows only a success toast and updates the record', async () => {
    const now = new Date().toISOString()
    collections.attendance = [
      { id: 'att-1', memberId: 'm1', date: now, checkIn: now, checkOut: '', source: 'manual' },
    ]
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Check out' }))

    await waitFor(() => expect(mocks.updateDocById).toHaveBeenCalledTimes(1))
    expect(mocks.updateDocById).toHaveBeenCalledWith('attendance', 'att-1', { checkOut: expect.any(String) })
    expect(toastMocks.success).toHaveBeenCalledWith('Checked out')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('attendance list refreshes from the realtime subscription after a check-out', async () => {
    const now = new Date().toISOString()
    const entry = { id: 'att-1', memberId: 'm1', date: now, checkIn: now, checkOut: '', source: 'manual' }
    collections.attendance = [entry]
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Check out' }))
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Checked out'))

    pushSnapshot('attendance', [{ ...entry, checkOut: new Date().toISOString() }])

    expect(await screen.findByText('Done')).toBeInTheDocument()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('QR check-in succeeds via the QR input without an error toast', async () => {
    renderPage()

    const input = screen.getByPlaceholderText('Scan or paste member ID…')
    fireEvent.change(input, { target: { value: 'm1' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(mocks.createDoc).toHaveBeenCalledTimes(1))
    expect(mocks.createDoc).toHaveBeenCalledWith(
      'attendance',
      expect.objectContaining({ memberId: 'm1', checkOut: '', source: 'manual' })
    )
    expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('a real Firestore failure still shows the real error message', async () => {
    mocks.createDoc.mockRejectedValue(new Error('Permission denied'))
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Permission denied'))
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})
