/**
 * Bounded date-range queries for reporting — PREPARED, NOT ENABLED.
 *
 * Enabling these requires a `gymId + date` composite index on every collection
 * being ranged, and Firestore enforces that at query time, not at deploy time:
 * until the index is published to the project, each of these queries fails with
 * `failed-precondition`. That would take Reports down for every gym, so
 * `src/pages/Reports.jsx` still filters the loaded tenant-scoped subscription
 * and this module is unused until the index deploy succeeds.
 *
 * To enable, after `firebase deploy --only firestore:indexes` has completed and
 * been verified in the Firebase console:
 *   1. Replace the Reports `useCollection` calls with the fetchers below.
 *   2. Keep the in-browser range filter in reportRange.js. A bounded query
 *      bounds reads; it does not remove the need to reconcile records whose
 *      stored `date` and gym-local day disagree (legacy rows written before the
 *      timezone field existed).
 *
 * The bounds come from gymRangeBoundsUtc, so a range ending 2026-01-31 covers
 * the whole 31st in the gym's own timezone rather than truncating at the device's
 * midnight.
 */

import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { getGymId } from './ownerContext'
import { isReady } from './firestore'
import { gymRangeBoundsUtc } from '@/utils/gymTime'

/** Collections ranged by the report, and the field their date lives in. */
export const RANGE_FIELDS = {
  payments: 'date',
  expenses: 'date',
  attendance: 'date',
}

const NO_GYM = Symbol('unbound-gym')

function boundGymId() {
  return getGymId() || NO_GYM
}

/**
 * Firestore query constraints for one collection over an inclusive gym-local
 * range, always tenant-scoped.
 *
 * The `__unbound__` escape mirrors services/firestore.js: before tenancy is
 * established the query must match nothing rather than read across gyms.
 */
export function rangeConstraints(range, timezone, field = 'date') {
  const gymId = getGymId()
  if (!gymId) return [where('__unbound__', '==', '__impossible__')]
  const { start, end } = gymRangeBoundsUtc(range.from, range.to, timezone)
  return [
    where('gymId', '==', gymId),
    where(field, '>=', start),
    where(field, '<=', end),
    orderBy(field, 'asc'),
  ]
}

/**
 * Fetch one collection over the range.
 *
 * `maxRows` is a deliberate safety valve: the Firestore SDK rejects a
 * `limit()` combined with a range on a different field in some configurations,
 * and an unbounded date range over a growing collection is the exact read
 * pattern that gets a tenant throttled. Callers must treat a truncated result as
 * "this is a sample", never as a complete total.
 */
export async function fetchRange(name, range, timezone, { field, maxRows = 5000 } = {}) {
  const resolvedField = field || RANGE_FIELDS[name]
  if (!resolvedField) throw new Error(`No date field is mapped for collection "${name}"`)
  if (!range || !range.from || !range.to) return []

  if (!isReady()) {
    // Demo mode has no Firestore index to satisfy. Report the same shape the
    // page already handles so switching read paths does not change the UI.
    const { mockList } = await import('./mockStore')
    return mockList(name)
  }

  const q = query(
    collection(db, name),
    ...rangeConstraints(range, timezone, resolvedField),
    limit(maxRows)
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

export { isReady as rangeQueriesReady, boundGymId, NO_GYM, isFirebaseConfigured }