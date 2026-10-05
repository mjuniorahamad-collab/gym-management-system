import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Attendance from '@/pages/Attendance'
import { gymDayKey } from '@/utils/gymTime'

const { mocks, toastMocks, authValue } = vi.hoisted(() => ({
  mocks: {
    checkInMember: vi.fn(),
    checkOutMember: vi.fn(),
    removeDoc: vi.fn(),
    fetchPage: vi.fn(),
    subscribeCollection: vi.fn(),
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
  removeDoc: mocks.removeDoc,
  fetchPage: mocks.fetchPage,
  subscribeCollection: mocks.subscribeCollection,
  isReady: vi.fn(() => true),
}))

// Only the write boundary is stubbed. 'attendanceDay' and 'isOpenSession' come
// from @/utils/attendance and stay real, because the page's timezone bucketing
// and its overnight-session handling are what these tests assert.
vi.mock('@/services/attendanceSessions', () => ({
  checkInMember: mocks.checkInMember,
  checkOutMember: mocks.checkOutMember,
}))

const duplicateError = Object.assign(new Error('This member is already checked in'), {
  code: 'already-checked-in',
  checkInDay: '2026-03-10',
})
const notCheckedInError = Object.assign(new Error('This member is not currently checked in'), {
  code: 'not-checked-in',
})

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authValue,
}))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ toast: toastMocks, ...toastMocks, promise: vi.fn() }),
}))

// The gym timezone is the default; the page passes it through to the service so
// check-in day keys are stamped in the gym's calendar, not the device's.
vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({ timezone: 'Asia/Kolkata' }),
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
    mocks.checkInMember.mockResolvedValue({ attendanceId: 'mock-id' })
    mocks.checkOutMember.mockResolvedValue()
  })

  it('manual check-in shows only a success toast and writes an attendance record', async () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(mocks.checkInMember).toHaveBeenCalledTimes(1))
    expect(mocks.checkInMember).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'm1', memberName: 'Zaid', timezone: 'Asia/Kolkata' })
    )
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

    await waitFor(() => expect(mocks.checkOutMember).toHaveBeenCalledTimes(1))
    expect(mocks.checkOutMember).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'm1' }))
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

    await waitFor(() => expect(mocks.checkInMember).toHaveBeenCalledTimes(1))
    expect(mocks.checkInMember).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'm1', memberName: 'Zaid', timezone: 'Asia/Kolkata' })
    )
    expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('a real Firestore failure still shows the real error message', async () => {
    mocks.checkInMember.mockRejectedValue(new Error('Permission denied'))
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Permission denied'))
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  // handleCheckIn reports its own failures and does not rethrow, so clearing the
  // field up-front (with a try/catch around the call) silently discarded the
  // scanned ID on every failed write and staff had to re-scan.
  it('keeps the scanned ID in the field when the check-in write fails', async () => {
    mocks.checkInMember.mockRejectedValue(new Error('Permission denied'))
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
    expect(mocks.checkInMember).not.toHaveBeenCalled()
    expect(input.value).toBe('m1')
  })

  it('keeps the scanned ID when the member ID is not recognised', async () => {
    renderPage()

    const input = screen.getByPlaceholderText('Scan or paste member ID…')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Unknown member ID'))
    expect(mocks.checkInMember).not.toHaveBeenCalled()
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
      d.resolve({ attendanceId: 'att-1' })
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
  })

  it('writes one record when the check-in button is clicked twice before the first write lands', async () => {
    const d = deferred()
    mocks.checkInMember.mockReturnValue(d.promise)
    renderPage()

    const button = checkInButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })

    expect(mocks.checkInMember).toHaveBeenCalledTimes(1)

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1))
    expect(mocks.checkInMember).toHaveBeenCalledTimes(1)
  })

  it('ignores a second scan while the first check-in write is still in flight', async () => {
    const d = deferred()
    mocks.checkInMember.mockReturnValue(d.promise)
    renderPage()

    scanEnter('m1')
    act(() => {
      fireEvent.keyDown(qrField(), { key: 'Enter', code: 'Enter' })
    })

    expect(mocks.checkInMember).toHaveBeenCalledTimes(1)

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))
    expect(toastMocks.success).toHaveBeenCalledTimes(1)
    expect(mocks.checkInMember).toHaveBeenCalledTimes(1)
    expect(qrField().value).toBe('')
  })

  it('does not double-write when a scan and a button click overlap', async () => {
    const d = deferred()
    mocks.checkInMember.mockReturnValue(d.promise)
    renderPage()

    scanEnter('m1')
    act(() => {
      fireEvent.click(checkInButton())
    })

    expect(mocks.checkInMember).toHaveBeenCalledTimes(1)

    await settle(d)

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1))
    expect(mocks.checkInMember).toHaveBeenCalledTimes(1)
  })

  it('does not claim the member is already checked in for an overlapping click', async () => {
    const d = deferred()
    mocks.checkInMember.mockReturnValue(d.promise)
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
    mocks.checkInMember
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce('att-1')
    renderPage()

    scanEnter('m1')
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Permission denied'))
    expect(qrField().value).toBe('m1')

    fireEvent.keyDown(qrField(), { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in'))
    expect(mocks.checkInMember).toHaveBeenCalledTimes(2)
  })

  it('does not let one member in flight block a different member', async () => {
    collections.members = [
      { id: 'm1', name: 'Zaid', phone: '9812345678' },
      { id: 'm2', name: 'Bilal', phone: '9812345679' },
    ]
    const d = deferred()
    mocks.checkInMember.mockImplementation((args) =>
      args.memberId === 'm1' ? d.promise : Promise.resolve({ attendanceId: 'att-2' })
    )
    renderPage()

    const buttons = screen.getAllByRole('button', { name: 'Check in' })
    act(() => {
      fireEvent.click(buttons[0])
      fireEvent.click(buttons[1])
    })

    expect(mocks.checkInMember).toHaveBeenCalledTimes(2)

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
    mocks.checkInMember.mockResolvedValue({ attendanceId: 'att-2' })
    renderPage()

    fireEvent.click(checkInButton())

    await waitFor(() => expect(mocks.checkInMember).toHaveBeenCalledTimes(1))
    expect(toastMocks.success).toHaveBeenCalledWith('Zaid checked in')
  })
})


// The authoritative duplicate check now runs server-side in the transaction that
// writes the record. The client guard can only save a round trip, so these cover
// how the page reports the two rejections the service can raise.
describe('Attendance session pointer outcomes', () => {
  beforeEach(() => {
    collections = {
      attendance: [],
      members: [{ id: 'm1', name: 'Zaid', phone: '9812345678' }],
    }
    Object.keys(listeners).forEach((k) => delete listeners[k])
    vi.clearAllMocks()
mocks.checkInMember.mockResolvedValue({ attendanceId: 'att-1' })
    mocks.checkOutMember.mockResolvedValue({ attendanceId: 'att-1' })

    // Pin the clock so day-key comparisons are independent of when the suite
    // runs. 04:30 UTC is 10:00 IST, comfortably inside the local day.
    // `shouldAdvanceTime` keeps wall-clock moving, which the waitFor/act helpers
    // in this file depend on -- plain fake timers deadlock them.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-03T04:30:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A rejection from the transaction means a competing device already checked
   * this member in. Surfacing it as an error would send staff looking for a
   * fault that does not exist.
   */
  it('reports a server-side duplicate as information, not an error', async () => {
    mocks.checkInMember.mockRejectedValue(duplicateError)
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(toastMocks.info).toHaveBeenCalledWith('Already checked in today'))
    expect(toastMocks.error).not.toHaveBeenCalled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('still surfaces a genuine write failure as an error', async () => {
    mocks.checkInMember.mockRejectedValue(new Error('Permission denied'))
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Permission denied'))
    expect(toastMocks.info).not.toHaveBeenCalled()
  })

  it('reports checkout with no open session as information, not an error', async () => {
    const now = new Date().toISOString()
    collections.attendance = [{ id: 'att-1', memberId: 'm1', date: now, checkIn: now, checkOut: '' }]
    mocks.checkOutMember.mockRejectedValue(notCheckedInError)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Check out' }))

    await waitFor(() => expect(toastMocks.info).toHaveBeenCalledWith('This member is not currently checked in'))
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('passes the gym timezone through so the day key is stamped server-side', async () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0])

    await waitFor(() => expect(mocks.checkInMember).toHaveBeenCalledTimes(1))
    expect(mocks.checkInMember).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: 'Asia/Kolkata' })
    )
  })

  /**
   * A session opened at 23:50 and still open at 00:10 lives in yesterday's list.
   * Deriving "in the gym" from today's rows alone hid the member and offered a
   * second check-in that the transaction would then reject.
   */
it('counts a session opened before midnight as still in the gym', async () => {
    // Absolute times relative to the pinned clock (04:30 UTC = 10:00 IST, 3 Oct).
    // 15:20 UTC on 2 Oct is 20:50 IST on 2 Oct, so this session belongs to the
    // previous local day. `Date.now() - 20h` was not equivalent: for any run
    // between 20:00 and 24:00 local it lands on the same calendar day and the
    // fixture silently stopped exercising the overnight case.
    const yesterday = '2026-10-02T15:20:00.000Z'
    collections.attendance = [
      {
        id: 'att-y',
        memberId: 'm1',
        date: yesterday,
        checkIn: yesterday,
        checkInDay: gymDayKey(yesterday),
        checkOut: '',
      },
    ]
    renderPage()

    expect(await screen.findByText('In gym')).toBeInTheDocument()
    // "Today's check-ins" must stay 0; only the live count should see yesterday.
    const inGym = screen.getByText('Currently in the gym').closest('div')
    expect(within(inGym).getByText('1')).toBeInTheDocument()
    const todays = screen.getByText("Today's check-ins").closest('div')
    expect(within(todays).getByText('0')).toBeInTheDocument()
  })

it('does not offer a second check-in for an overnight session', async () => {
    const yesterday = '2026-10-02T15:20:00.000Z'
    collections.attendance = [
      { id: 'att-y', memberId: 'm1', date: yesterday, checkIn: yesterday, checkOut: '' },
    ]
    renderPage()

    expect(await screen.findByText('In gym')).toBeInTheDocument()
    // Scope to the member row; the QR form has its own "Check in" button.
    const row = screen.getByText('Zaid').closest('div.flex')
    expect(within(row).queryByRole('button', { name: 'Check in' })).toBeNull()
    expect(mocks.checkInMember).not.toHaveBeenCalled()
  })

it('counts a member checked out earlier today as checked out, not in the gym', async () => {
    // `attendanceDay` is compared against the gym-local day, so the fixture's
    // day key must come from gymDayKey(). Deriving it with toISOString().slice(0,10)
    // yields the UTC day instead, and the two disagree for the six hours after
    // local midnight -- which is exactly when the suite was run.
    const now = '2026-10-03T04:30:00.000Z'
    collections.attendance = [
      {
        id: 'att-1',
        memberId: 'm1',
        date: now,
        checkIn: now,
        checkInDay: gymDayKey(now),
        checkOut: now,
      },
    ]
    renderPage()

    const checkedOut = screen.getByText('Checked out').closest('div')
    expect(within(checkedOut).getByText('1')).toBeInTheDocument()
    const inGym = screen.getByText('Currently in the gym').closest('div')
    expect(within(inGym).getByText('0')).toBeInTheDocument()
  })
})