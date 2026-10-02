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

  // handleCheckIn reports its own failures and does not rethrow, so clearing the
  // field up-front (with a try/catch around the call) silently discarded the
  // scanned ID on every failed write and staff had to re-scan.
  it('keeps the scanned ID in the field when the check-in write fails', async () => {
    mocks.createDoc.mockRejectedValue(new Error('Permission denied'))
    renderPage()

    const input = screen.getByPlaceholderText('Scan or paste member ID…')
    fireEvent.change(input, { target: { value: 'm1' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Permission denied'))
    expect(input.value).toBe('m1')
  })

  it('clears the scanned ID once the check-in write is confirmed', async () => {
    renderPage()

    const input = screen.getByPlaceholderText('Scan or paste member ID…')
    fireEvent.change(input, { target: { value: 'm1' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))
    expect(input.value).toBe('')
  })

  it('keeps the scanned ID and writes nothing when the member is already checked in', async () => {
    const now = new Date().toISOString()
    collections.attendance = [
      { id: 'att-1', memberId: 'm1', date: now, checkIn: now, checkOut: '', source: 'manual' },
    ]
    renderPage()

    const input = screen.getByPlaceholderText('Scan or paste member ID…')
    fireEvent.change(input, { target: { value: 'm1' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.info).toHaveBeenCalledWith('Already checked in today'))
    expect(mocks.createDoc).not.toHaveBeenCalled()
    expect(input.value).toBe('m1')
  })

  it('keeps the scanned ID when the member ID is not recognised', async () => {
    renderPage()

    const input = screen.getByPlaceholderText('Scan or paste member ID…')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Unknown member ID'))
    expect(mocks.createDoc).not.toHaveBeenCalled()
    expect(input.value).toBe('nope')
  })
})

// The duplicate guard reads checkedInToday, which is derived from the realtime
// subscription. A check-in that has been accepted but not yet echoed back is
// therefore invisible to it, and two overlapping calls both passed the check.
//
// Button `loading` does not close this. It disables the button only on the next
// render, so two clicks dispatched in the same tick both reach the handler; and
// the QR input is never disabled at all, so Enter can be pressed again while the
// first write is still in flight. Every test below therefore dispatches its
// overlapping events inside one act(), which suppresses the re-render that
// `submitting` depends on and exposes the real overlap.
describe('Attendance concurrent check-in', () => {
  function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const qrField = () => screen.getByPlaceholderText('Scan or paste member ID…')
  const checkInButton = () => screen.getAllByRole('button', { name: 'Check in' })[0]

  // Types the ID and presses Enter, leaving the field itself untouched.
  const scanEnter = (value) => {
    const input = qrField()
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  }

  const settle = async (d) => {
    await act(async () => {
      d.resolve('att-1')
      await d.promise
    })
  }

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
    mocks.logAudit.mockResolvedValue()
  })

  it('writes one record when the check-in button is clicked twice before the first write lands', async () => {
    const d = deferred()
    mocks.createDoc.mockReturnValue(d.promise)
    renderPage()

    const button = checkInButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })

    expect(mocks.createDoc).toHaveBeenCalledTimes(1)

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1))
    expect(mocks.logAudit).toHaveBeenCalledTimes(1)
  })

  it('ignores a second scan while the first check-in write is still in flight', async () => {
    const d = deferred()
    mocks.createDoc.mockReturnValue(d.promise)
    renderPage()

    scanEnter('m1')
    act(() => {
      fireEvent.keyDown(qrField(), { key: 'Enter', code: 'Enter' })
    })

    expect(mocks.createDoc).toHaveBeenCalledTimes(1)

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))
    expect(toastMocks.success).toHaveBeenCalledTimes(1)
    expect(mocks.createDoc).toHaveBeenCalledTimes(1)
    expect(qrField().value).toBe('')
  })

  it('does not double-write when a scan and a button click overlap', async () => {
    const d = deferred()
    mocks.createDoc.mockReturnValue(d.promise)
    renderPage()

    scanEnter('m1')
    act(() => {
      fireEvent.click(checkInButton())
    })

    expect(mocks.createDoc).toHaveBeenCalledTimes(1)

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1))
    expect(mocks.createDoc).toHaveBeenCalledTimes(1)
  })

  it('does not claim the member is already checked in for an overlapping click', async () => {
    const d = deferred()
    mocks.createDoc.mockReturnValue(d.promise)
    renderPage()

    act(() => {
      fireEvent.click(checkInButton())
      fireEvent.click(checkInButton())
    })

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1))
    expect(toastMocks.info).not.toHaveBeenCalledWith('Already checked in today')
  })

  it('allows a retry after a failed check-in instead of locking the member out', async () => {
    mocks.createDoc
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce('att-1')
    renderPage()

    scanEnter('m1')
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Permission denied'))
    expect(qrField().value).toBe('m1')

    fireEvent.keyDown(qrField(), { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))
    expect(mocks.createDoc).toHaveBeenCalledTimes(2)
  })

  it('does not let one member in flight block a different member', async () => {
    collections.members = [
      { id: 'm1', name: 'Zaid', phone: '9812345678' },
      { id: 'm2', name: 'Bilal', phone: '9812345679' },
    ]
    const d = deferred()
    mocks.createDoc.mockImplementation((name, data) =>
      data.memberId === 'm1' ? d.promise : Promise.resolve('att-2')
    )
    renderPage()

    const buttons = screen.getAllByRole('button', { name: 'Check in' })
    act(() => {
      fireEvent.click(buttons[0])
      fireEvent.click(buttons[1])
    })

    expect(mocks.createDoc).toHaveBeenCalledTimes(2)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Bilal checked in'))

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))
    expect(toastMocks.success).toHaveBeenCalledTimes(2)
  })

  it('still writes when the member checked out earlier the same day', async () => {
    const now = new Date().toISOString()
    collections.attendance = [
      { id: 'att-1', memberId: 'm1', date: now, checkIn: now, checkOut: now, source: 'manual' },
    ]
    mocks.createDoc.mockResolvedValue('att-2')
    renderPage()

    fireEvent.click(checkInButton())

    await waitFor(() => expect(mocks.createDoc).toHaveBeenCalledTimes(1))
    expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in')
  })
})
