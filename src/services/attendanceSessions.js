/**
 * Attendance check-in / check-out as serialisable transactions.
 *
 * ## Why a session pointer
 *
 * Duplicate suppression used to be a `useRef` Set of in-flight member ids in
 * `pages/Attendance.jsx`. That only closes the double-click on ONE device. Two
 * tablets at the same front desk, or the same tablet whose realtime snapshot has
 * not yet echoed the previous write back, both see "not checked in" and both
 * write. The result is two open attendance records for one member, which
 * double-counts the member in Reports and shows them as present twice.
 *
 * A `useRef` cannot fix this because the race is between devices, not between
 * handlers. Fixing it needs a single document that concurrent writers must
 * contend on, so Firestore's transaction retries serialise them. That document
 * is `attendanceSessions/{gymId}__{memberId}` — one open session per member per
 * gym.
 *
 * ## Why the pointer and not a query
 *
 * "Reject if this member has no open attendance record today" is a collection
 * query, and Firestore forbids queries inside a transaction callback. Reading
 * the pointer instead turns that check into a point read of a known path, which
 * is exactly what a transaction can do safely.
 *
 * ## Checkout releases the pointer in the same transaction
 *
 * Writing `checkOut` and deleting the pointer as two separate operations left a
 * window where a crash between them stranded the pointer, and the member could
 * never check in again without manual database surgery. Both writes happen in
 * one transaction, so the session is either fully closed or still open.
 *
 * ## Legacy rows
 *
 * Records written before this module have no `attendanceSessions` pointer, so a
 * member already sitting in the gym could be checked in a second time. The UI
 * still derives `checkedInToday` from the loaded collection and blocks that, and
 * `seedAttendanceSessions` (migration, dry-run by default) backfills pointers for
 * genuinely open legacy sessions.
 */

import { collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { mockAdd, mockUpdate } from './mockStore'
import { getGymId, DEMO_GYM_ID } from './ownerContext'
import { logAudit } from './audit'
import { gymDayKey, resolveGymTimezone } from '@/utils/gymTime'

export const ATTENDANCE_SESSION_COLLECTION = 'attendanceSessions'

/** Thrown when the member already has an open session. */
export class AlreadyCheckedInError extends Error {
  constructor(checkInDay) {
    super('This member is already checked in')
    this.name = 'AlreadyCheckedInError'
    this.code = 'already-checked-in'
    this.checkInDay = checkInDay
  }
}

/** Thrown when checkout is attempted with no open session. */
export class NotCheckedInError extends Error {
  constructor() {
    super('This member is not currently checked in')
    this.name = 'NotCheckedInError'
    this.code = 'not-checked-in'
  }
}

export function sessionId(gymId, memberId) {
  return `${gymId}__${memberId}`
}

/**
 * The gym-local day an attendance record belongs to.
 *
 * Prefers the stored `checkInDay`, falling back to deriving it from the instant
 * so records written before the timezone field existed are still bucketed by the
 * gym's calendar rather than the reader's device.
 */
export function attendanceDay(entry, timezone) {
  if (!entry) return ''
  if (entry.checkInDay) return String(entry.checkInDay).slice(0, 10)
  return gymDayKey(entry.checkIn || entry.date, resolveGymTimezone(timezone))
}

/** True when the record is still open. An empty/whitespace checkOut counts as open. */
export function isOpenSession(entry) {
  return Boolean(entry) && !String(entry.checkOut || '').trim()
}

/**
 * Record a check-in.
 *
 * `now` is taken by the caller so a transaction retry cannot stamp a second,
 * different check-in time — the instant that money-free but report-visible
 * history depends on must be decided once, outside the retried callback.
 */
export async function checkInMember({ memberId, memberName, source = 'manual', timezone, now = new Date() }) {
  if (!memberId) throw new Error('A member is required to check in')
  const gymId = getGymId()
  const checkIn = now.toISOString()
  const checkInDay = gymDayKey(checkIn, resolveGymTimezone(timezone))

  if (!isFirebaseConfigured || !db) {
    // Demo mode has no transaction and no cross-device contention to guard
    // against; mirror the mock store's behaviour so the UI is unchanged.
    const id = await mockAdd('attendance', {
      memberId,
      gymId: gymId || DEMO_GYM_ID,
      date: checkIn,
      checkIn,
      checkOut: '',
      checkInDay,
      source,
    })
    return { attendanceId: id, checkIn, checkInDay }
  }

  if (!gymId) throw new Error('No gym selected — check-in blocked before tenancy is established')

  const sessionRef = doc(db, ATTENDANCE_SESSION_COLLECTION, sessionId(gymId, memberId))

  const attendanceId = await runTransaction(db, async (tx) => {
    // Read before any write: Firestore requires all reads to precede all writes
    // in a transaction, and this read is what makes the duplicate check atomic.
    const snap = await tx.get(sessionRef)
    if (snap.exists()) {
      const existing = snap.data() || {}
      throw new AlreadyCheckedInError(existing.checkInDay || checkInDay)
    }

    const attRef = doc(collection(db, 'attendance'))
    // Firestore assigns `id` synchronously on a collection reference. If it were
    // ever absent, the pointer below would be written without an
    // `attendanceId`, and checkout could never release it — permanently locking
    // the member out of check-in. Fail loudly instead of stranding them.
    if (!attRef?.id) {
      throw new Error('Attendance record id could not be determined — check-in aborted')
    }
    tx.set(attRef, {
      gymId,
      memberId,
      date: checkIn,
      checkIn,
      checkOut: '',
      // Gym-local calendar day of the check-in, so Reports bucketing does not
      // depend on which device recorded it.
      checkInDay,
      source,
    })
    tx.set(sessionRef, {
      gymId,
      memberId,
      attendanceId: attRef.id,
      checkIn,
      checkInDay,
      source,
      createdAt: serverTimestamp(),
    })
    return attRef.id
  })

  await logAudit({
    action: 'create',
    entity: 'attendance',
    entityId: memberId,
    details: { checkIn: true, attendanceId, checkInDay, source, memberName },
  })

  return { attendanceId, checkIn, checkInDay }
}

/**
 * Record a check-out and release the session pointer atomically.
 *
 * `checkOutDay` is stored separately from `checkInDay` because a session that
 * spans midnight — 23:50 in, 00:10 out — belongs to two different calendar days
 * and both must remain derivable for reporting.
 */
export async function checkOutMember({ memberId, timezone, now = new Date() }) {
  if (!memberId) throw new Error('A member is required to check out')
  const gymId = getGymId()
  const checkOut = now.toISOString()
  const checkOutDay = gymDayKey(checkOut, resolveGymTimezone(timezone))

  if (!isFirebaseConfigured || !db) {
    const { listAll } = await import('./firestore')
    const all = await listAll('attendance')
    const open = [...all].reverse().find((a) => a.memberId === memberId && isOpenSession(a))
    if (!open) throw new NotCheckedInError()
    mockUpdate('attendance', open.id, { checkOut, checkOutDay })
    return { attendanceId: open.id, checkOut, checkOutDay }
  }

  if (!gymId) throw new Error('No gym selected — check-out blocked before tenancy is established')

  const sessionRef = doc(db, ATTENDANCE_SESSION_COLLECTION, sessionId(gymId, memberId))

  const attendanceId = await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef)
    if (!snap.exists()) throw new NotCheckedInError()
    const { attendanceId: id } = snap.data() || {}
    if (!id) throw new NotCheckedInError()

    tx.update(doc(db, 'attendance', id), { checkOut, checkOutDay })
    // Releasing the pointer in the same transaction is what allows a legitimate
    // second session the same day, and what stops a half-applied checkout from
    // blocking the member permanently.
    tx.delete(sessionRef)
    return id
  })

  await logAudit({
    action: 'update',
    entity: 'attendance',
    entityId: memberId,
    details: { checkOut: true, attendanceId, checkOutDay },
  })

  return { attendanceId, checkOut, checkOutDay }
}