/**
 * Pure attendance helpers.
 *
 * Kept out of `services/attendanceSessions.js` so UI code can use them without
 * importing anything that touches Firebase, and so they can be unit-tested
 * without mocking the SDK.
 */

import { gymDayKey, resolveGymTimezone } from './gymTime'

/**
 * The gym-local day an attendance record belongs to.
 *
 * Prefers the stored `checkInDay`, falling back to deriving it from the instant
 * so records written before the timezone field existed are still bucketed by the
 * gym's calendar rather than the reader's device.
 *
 * Deriving is also what keeps a legacy row honest: its `date` was stamped by
 * whichever device checked the member in, so bucketing by that instant in the
 * gym's zone is the only reading available.
 */
export function attendanceDay(entry, timezone) {
  if (!entry) return ''
  if (entry.checkInDay) return String(entry.checkInDay).slice(0, 10)
  return gymDayKey(entry.checkIn || entry.date, resolveGymTimezone(timezone))
}

/**
 * True when the record is still open.
 *
 * An empty or whitespace-only `checkOut` counts as open. That is not a stylistic
 * choice: these records are written by the app, but the mock/demo store and any
 * manual console edit can leave `checkOut` as `''`, and treating that as closed
 * would hide a member who is physically still in the gym from the duplicate
 * guard and from the "currently checked in" count.
 */
export function isOpenSession(entry) {
  return Boolean(entry) && !String(entry.checkOut || '').trim()
}