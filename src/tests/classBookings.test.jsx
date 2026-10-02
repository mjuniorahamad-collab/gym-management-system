import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Classes from '@/pages/Classes'

const { mocks, collections } = vi.hoisted(() => ({
  mocks: {
    upsertDoc: vi.fn(),
    createDoc: vi.fn(async () => 'cl1'),
    updateDocById: vi.fn(),
    removeDoc: vi.fn(),
    logAudit: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  },
  collections: {},
}))

vi.mock('@/services/firestore', () => ({
  createDoc: mocks.createDoc,
  updateDocById: mocks.updateDocById,
  removeDoc: mocks.removeDoc,
  upsertDoc: mocks.upsertDoc,
  listAll: vi.fn(async () => []),
  getById: vi.fn(async () => null),
}))

vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))

vi.mock('@/services/ownerContext', () => ({
  getGymId: () => 'demo-gym',
  DEMO_GYM_ID: 'demo-gym',
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => true, hasRole: () => true }),
}))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn() },
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    promise: vi.fn(),
  }),
}))

vi.mock('@/hooks/useFirestore', () => ({
  useCollection: (name) => ({ items: collections[name] || [], loading: false, error: null }),
}))

const CLASS = {
  id: 'cl1',
  name: 'Power Yoga',
  dayOfWeek: 'Monday',
  startTime: '07:00',
  endTime: '08:00',
  capacity: 2,
  active: true,
  gymId: 'demo-gym',
}

const MEMBERS = [
  { id: 'm1', name: 'Asha', gymId: 'demo-gym' },
  { id: 'm2', name: 'Bikash', gymId: 'demo-gym' },
]

async function openBookingManager() {
  render(<Classes />)
  await userEvent.click(await screen.findByText(/Manage bookings/))
  return screen.findByRole('button', { name: 'Book' })
}

describe('class booking duplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(collections).forEach((k) => delete collections[k])
    collections.classes = [CLASS]
    collections.members = MEMBERS
    collections.trainers = []
    collections.bookings = []
  })

  /**
   * A class is weekly-recurring by `dayOfWeek`, so a single booking covers
   * every occurrence and the same member can never legitimately be booked
   * into the same class twice. The booking was previously written with
   * `addDoc`, so a double submit produced two documents — and because the
   * capacity check counts booked documents, one member could then fill a
   * two-slot class alone and block everyone else.
   */
  it('writes the booking under a deterministic (class, member) key', async () => {
    await openBookingManager()

    await userEvent.selectOptions(screen.getByRole('combobox'), 'm1')
    await userEvent.click(screen.getByRole('button', { name: 'Book' }))

    await waitFor(() => expect(mocks.upsertDoc).toHaveBeenCalledTimes(1))
    const [collection, id, payload] = mocks.upsertDoc.mock.calls[0]
    expect(collection).toBe('bookings')
    expect(id).toBe('cl1__m1')
    expect(payload).toMatchObject({ classId: 'cl1', memberId: 'm1', status: 'booked' })
  })

  it('refuses to book a member who already holds a booking, without writing', async () => {
    collections.bookings = [
      { id: 'cl1__m2', classId: 'cl1', memberId: 'm2', status: 'booked', gymId: 'demo-gym' },
    ]

    await openBookingManager()

    await userEvent.selectOptions(screen.getByRole('combobox'), 'm2')
    await userEvent.click(screen.getByRole('button', { name: 'Book' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.toastError.mock.calls[0][0]).toMatch(/already booked/i)
    expect(mocks.upsertDoc).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it('allows a different member to book the same class', async () => {
    collections.bookings = [
      { id: 'cl1__m2', classId: 'cl1', memberId: 'm2', status: 'booked', gymId: 'demo-gym' },
    ]

    await openBookingManager()

    await userEvent.selectOptions(screen.getByRole('combobox'), 'm1')
    await userEvent.click(screen.getByRole('button', { name: 'Book' }))

    await waitFor(() => expect(mocks.upsertDoc).toHaveBeenCalledTimes(1))
    expect(mocks.upsertDoc.mock.calls[0][1]).toBe('cl1__m1')
  })
})