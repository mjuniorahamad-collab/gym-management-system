import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Minimal in-memory Firestore transaction emulator.
 *
 * `runTransaction` here serialises callbacks per document path and re-runs the
 * loser against the winner's committed state, which is the property the
 * attendance session pointer depends on. Two concurrent `checkInMember` calls
 * for one member must therefore produce exactly one attendance record.
 */
const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    collection: vi.fn((db, name) => ({ __collection: name })),
    doc: vi.fn((...args) => {
      // doc(collection(db, name)) -> auto-id reference. Firestore assigns the
      // id synchronously; the mock must too, or the session pointer would be
      // written without an attendanceId.
      if (args.length === 1) {
        const id = `att${state.autoCounter++}`
        return { __collection: args[0].__collection, __autoId: true, id }
      }
      // doc(db, name, id) -> fixed path reference
      return { __collection: args[1], __path: `${args[1]}/${args[2]}`, id: args[2] }
    }),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => '__NOW__'),
    set: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    logAudit: vi.fn(),
    getGymId: vi.fn(() => 'gym-1'),
  },
  state: { docs: new Map(), autoCounter: 0, collections: new Map() },
}))

vi.mock('firebase/firestore', () => ({
  collection: mocks.collection,
  doc: mocks.doc,
  runTransaction: mocks.runTransaction,
  serverTimestamp: mocks.serverTimestamp,
}))

vi.mock('@/firebase', () => ({ db: {}, isFirebaseConfigured: true }))
vi.mock('@/services/ownerContext', () => ({ getGymId: mocks.getGymId, DEMO_GYM_ID: 'demo' }))
vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))

const load = async () => import('@/services/attendanceSessions')

// Firestore resolves an auto-id reference to the same `collection/id` path that
// `doc(db, collection, id)` produces, so checkout can find the row check-in wrote.
const pathOf = (ref) => (ref.__autoId ? `${ref.__collection}/${ref.id}` : ref.__path)

function installTransactionalFirestore() {
  // Firestore serialises conflicting transactions on a contended document. A
  // plain mutex over the whole store is a stronger guarantee than needed, and
  // models the property under test: the second writer sees the first's commit.
  let chain = Promise.resolve()

  mocks.runTransaction.mockImplementation((db, callback) => {
    const run = async () => {
      const snapshot = new Map(state.docs)
      const staged = new Map()

      const tx = {
        get: async (ref) => {
          const key = pathOf(ref)
          const value = staged.has(key) ? staged.get(key) : snapshot.get(key)
          return { exists: () => value !== undefined && value !== null, data: () => value }
        },
        set: (ref, value) => {
          staged.set(pathOf(ref), value)
          return ref
        },
        update: (ref, value) => {
          const key = pathOf(ref)
          const current = staged.get(key) ?? snapshot.get(key)
          staged.set(key, { ...(current || {}), ...value })
          return ref
        },
        delete: (ref) => {
          staged.set(pathOf(ref), null)
          return ref
        },
      }

      const result = await callback(tx)

      // Commit atomically; a throw above skips this entirely.
      for (const [key, value] of staged) {
        if (value === null) state.docs.delete(key)
        else state.docs.set(key, value)
      }
      return result
    }

    const next = chain.then(run, run)
    chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  })
}

const attendanceRows = () =>
  [...state.docs.entries()]
    .filter(([k]) => k.startsWith('attendance/'))
    .map(([, v]) => v)

const sessionDocs = () =>
  [...state.docs.entries()].filter(([k]) => k.startsWith('attendanceSessions/'))

describe('attendance check-in/check-out transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.docs = new Map()
    state.autoCounter = 0
    mocks.getGymId.mockReturnValue('gym-1')
    mocks.logAudit.mockResolvedValue(undefined)
    installTransactionalFirestore()
  })

  it('writes an attendance record and a session pointer atomically', async () => {
    const { checkInMember } = await load()
    const now = new Date('2026-03-10T10:00:00.000Z')

    const result = await checkInMember({ memberId: 'm1', timezone: 'Asia/Kolkata', now })

    expect(result.checkIn).toBe('2026-03-10T10:00:00.000Z')
    // 10:00Z is 15:30 IST, so the gym-local day is the 10th.
    expect(result.checkInDay).toBe('2026-03-10')
    expect(attendanceRows()).toHaveLength(1)
    expect(attendanceRows()[0]).toMatchObject({
      gymId: 'gym-1',
      memberId: 'm1',
      checkOut: '',
      checkInDay: '2026-03-10',
    })
    expect(sessionDocs()).toHaveLength(1)
  })

  /**
   * The defect the pointer exists to fix: two tablets at the same desk, both
   * with a snapshot that has not yet echoed the other's write.
   */
  it('rejects a concurrent second check-in for the same member', async () => {
    const { checkInMember, AlreadyCheckedInError } = await load()
    const now = new Date('2026-03-10T10:00:00.000Z')

    const [first, second] = await Promise.allSettled([
      checkInMember({ memberId: 'm1', timezone: 'Asia/Kolkata', now }),
      checkInMember({ memberId: 'm1', timezone: 'Asia/Kolkata', now }),
    ])

    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled')
    const rejected = [first, second].filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(AlreadyCheckedInError)
    expect(rejected[0].reason.code).toBe('already-checked-in')
    // Exactly one open record, not two.
    expect(attendanceRows()).toHaveLength(1)
  })

  it('reports the original check-in day on rejection', async () => {
    const { checkInMember, AlreadyCheckedInError } = await load()
    await checkInMember({
      memberId: 'm1',
      timezone: 'Asia/Kolkata',
      now: new Date('2026-03-10T10:00:00.000Z'),
    })

    await expect(
      checkInMember({
        memberId: 'm1',
        timezone: 'Asia/Kolkata',
        now: new Date('2026-03-12T10:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'already-checked-in', checkInDay: '2026-03-10' })
    expect(AlreadyCheckedInError).toBeDefined()
  })

  it('still allows a second check-in for a different member', async () => {
    const { checkInMember } = await load()
    const now = new Date('2026-03-10T10:00:00.000Z')
    await checkInMember({ memberId: 'm1', timezone: 'Asia/Kolkata', now })
    await checkInMember({ memberId: 'm2', timezone: 'Asia/Kolkata', now })
    expect(attendanceRows()).toHaveLength(2)
    expect(sessionDocs()).toHaveLength(2)
  })

  it('allows a legitimate second session the same day after checkout', async () => {
    const { checkInMember, checkOutMember } = await load()
    const tz = 'Asia/Kolkata'
    const morning = new Date('2026-03-10T06:00:00.000Z') // 11:30 IST
    const afternoon = new Date('2026-03-10T10:00:00.000Z') // 15:30 IST

    await checkInMember({ memberId: 'm1', timezone: tz, now: morning })
    await checkOutMember({ memberId: 'm1', timezone: tz, now: afternoon })
    // The pointer is gone, so a second session is allowed.
    await checkInMember({ memberId: 'm1', timezone: tz, now: afternoon })

    expect(sessionDocs()).toHaveLength(1)
    expect(attendanceRows()).toHaveLength(2)
  })

  it('writes checkOut and releases the pointer in one transaction', async () => {
    const { checkInMember, checkOutMember } = await load()
    const tz = 'Asia/Kolkata'
    const { attendanceId } = await checkInMember({
      memberId: 'm1',
      timezone: tz,
      now: new Date('2026-03-10T06:00:00.000Z'),
    })

    const result = await checkOutMember({
      memberId: 'm1',
      timezone: tz,
      now: new Date('2026-03-10T07:00:00.000Z'),
    })

    expect(result.attendanceId).toBe(attendanceId)
    expect(sessionDocs()).toHaveLength(0)
    expect(attendanceRows()[0].checkOut).toBe('2026-03-10T07:00:00.000Z')
  })

  /**
   * 23:50 in, 00:10 out. Both days must stay derivable or the session either
   * disappears from one day's report or is counted twice.
   */
  it('stamps separate checkIn and checkOut days across midnight', async () => {
    const { checkInMember, checkOutMember } = await load()
    const tz = 'Asia/Kolkata'
    await checkInMember({ memberId: 'm1', timezone: tz, now: new Date('2026-03-10T18:20:00.000Z') }) // 23:50
    await checkOutMember({ memberId: 'm1', timezone: tz, now: new Date('2026-03-10T18:40:00.000Z') }) // 00:10 next day

    const row = attendanceRows()[0]
    expect(row.checkInDay).toBe('2026-03-10')
    expect(row.checkOutDay).toBe('2026-03-11')
  })

  it('refuses checkout when there is no open session', async () => {
    const { checkOutMember, NotCheckedInError } = await load()
    await expect(
      checkOutMember({ memberId: 'nobody', timezone: 'Asia/Kolkata', now: new Date() })
    ).rejects.toBeInstanceOf(NotCheckedInError)
  })

  it('never writes anything when the duplicate check fails', async () => {
    const { checkInMember } = await load()
    const tz = 'Asia/Kolkata'
    await checkInMember({ memberId: 'm1', timezone: tz, now: new Date('2026-03-10T06:00:00.000Z') })
    const before = attendanceRows().length

    await expect(
      checkInMember({ memberId: 'm1', timezone: tz, now: new Date('2026-03-10T09:00:00.000Z') })
    ).rejects.toThrow()
    expect(attendanceRows()).toHaveLength(before)
  })

  it('records an audit entry for both check-in and check-out', async () => {
    const { checkInMember, checkOutMember } = await load()
    const tz = 'Asia/Kolkata'
    const now = new Date('2026-03-10T06:00:00.000Z')
    await checkInMember({ memberId: 'm1', memberName: 'Javed', timezone: tz, now })
    await checkOutMember({ memberId: 'm1', timezone: tz, now })

    expect(mocks.logAudit).toHaveBeenCalledTimes(2)
    expect(mocks.logAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ entity: 'attendance', details: expect.objectContaining({ checkIn: true }) })
    )
    expect(mocks.logAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ entity: 'attendance', details: expect.objectContaining({ checkOut: true }) })
    )
  })

  it('blocks check-in before tenancy is established', async () => {
    mocks.getGymId.mockReturnValue(null)
    const { checkInMember } = await load()
    await expect(
      checkInMember({ memberId: 'm1', timezone: 'Asia/Kolkata', now: new Date() })
    ).rejects.toThrow(/No gym selected/)
  })
})


describe('sessionId', () => {
  it('is deterministic per gym and member', async () => {
    const { sessionId } = await load()
    expect(sessionId('gym-1', 'm1')).toBe('gym-1__m1')
    expect(sessionId('gym-1', 'm1')).toBe(sessionId('gym-1', 'm1'))
    // Different gyms must not collide, or one gym's session would block another's.
    expect(sessionId('gym-1', 'm1')).not.toBe(sessionId('gym-2', 'm1'))
  })
})
