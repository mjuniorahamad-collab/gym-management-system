/**
 * Membership period authority.
 *
 * ## The problem this solves
 *
 * A membership period is a document in the `memberships` collection. Over time
 * a member accumulates several: an origin period, renewals, a correction, and
 * sometimes a period someone prepaid for a future start. Nothing in the data
 * model says which of them is "the" current one, so every reader invented its
 * own rule.
 *
 * `utils/membership.js#getCurrentMembershipExpiry` took the newest period by
 * `startDate`. That is wrong the moment a future-dated period exists. A member
 * whose current period ends in 5 days and who has also prepaid a period
 * starting in 60 days was reported as expiring in roughly 240 days, so
 * `matchesExpiryFilter(days, 'all')` was false and the member vanished from
 * the dashboard's expiring list entirely - the one screen whose job is to
 * prompt that renewal.
 *
 * ## The rule
 *
 * Exactly one period is current: the latest period whose `startDate` is on or
 * before today and whose `expiryDate` is on or after today. A period is
 * evaluated as a half-open-both-ends-closed interval [startDate, expiryDate] on
 * the gym's calendar, so a period that ends on the 31st and one that starts on
 * the 1st are adjacent, not overlapping - that is what makes a renewal
 * starting "the day after the previous expiry" seamless.
 *
 * A future-dated period is NOT current and does not become current by existing;
 * it becomes current on its own start date. This is the deliberate reading of
 * "validated current-period selection": a member has not been granted access
 * for a period that has not begun. It also means a prepaid future period cannot
 * suppress a renewal reminder for the period that is actually running.
 *
 * A period that has already ended is not current either. When nothing covers
 * today the member is expired, and the expiry shown to staff is the latest
 * period's end so the figure stays useful rather than blank.
 */

import { resolveGymTimezone, gymTodayKey, addDaysToKey } from './gymTime'

/**
 * Normalise a stored period date to a `YYYY-MM-DD` key.
 *
 * The four input shapes are read differently, and conflating them is how an
 * expiry ends up a day out:
 *
 * - `'YYYY-MM-DD'` string: the literal calendar date. This is how periods are
 *   stored and is the overwhelmingly common case. Passing it through an instant
 *   conversion is exactly what shifted expiries by a day.
 * - `Date`: read via LOCAL calendar components. Dates in this codebase are
 *   constructed as local calendar dates (`new Date(2026, 7, 18)`,
 *   `startOfDay()`, `addDays()`), so UTC components would report the previous
 *   day for any device east of UTC.
 * - Firestore Timestamp: an absolute instant, so its UTC day is the honest
 *   reading. Only ever a fallback for legacy rows written with a real timestamp.
 * - Full ISO instant string: likewise an instant, so UTC day.
 */
export function periodDayKey(value) {
  if (!value) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString().slice(0, 10)
    } catch {
      return ''
    }
  }
  const s = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  }
  return ''
}


const keyCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Order periods oldest-first by start date.
 *
 * Ties are broken by `createdAt` and then by document id so the order is total
 * and deterministic. Without the tiebreak, two periods sharing a start date
 * (a correction written the same day as the original, say) could swap places
 * between reads, which would make "the current period" flap between renders.
 */
export function sortPeriods(periods) {
  return [...(Array.isArray(periods) ? periods : [])]
    .filter(Boolean)
    .sort((a, b) => {
      const byStart = keyCompare(periodDayKey(a.startDate), periodDayKey(b.startDate))
      if (byStart !== 0) return byStart
      const byCreated = keyCompare(String(a.createdAt?.toDate?.() ?? a.createdAt ?? ''), String(b.createdAt?.toDate?.() ?? b.createdAt ?? ''))
      if (byCreated !== 0) return byCreated
      return keyCompare(String(a.id ?? ''), String(b.id ?? ''))
    })
}

/** Narrow a member's periods out of a collection-wide array. */
export function periodsForMember(periods, memberId) {
  if (memberId === null || memberId === undefined || memberId === '') return []
  return sortPeriods((Array.isArray(periods) ? periods : []).filter(
    (p) => p && String(p.memberId) === String(memberId)
  ))
}

/**
 * Whether `period` covers `todayKey`.
 *
 * A period with a missing or unparseable expiry is NOT current. Treating an
 * open-ended period as current would make a malformed row grant indefinite
 * access, which is the wrong way to fail: the expiry figures would still render,
 * so an owner could see and correct it.
 */
export function isPeriodCurrent(period, todayKey) {
  const start = periodDayKey(period?.startDate)
  const expiry = periodDayKey(period?.expiryDate)
  if (!start || !expiry) return false
  if (keyCompare(expiry, start) < 0) return false
  return keyCompare(start, todayKey) <= 0 && keyCompare(todayKey, expiry) <= 0
}

/**
 * Resolve the authoritative period state for a member.
 *
 * Returns:
 *   todayKey    the gym-local day the answer was computed for
 *   periods     the member's periods, oldest-first
 *   hasPeriods  whether any period document exists at all
 *   current     the period covering today, or null
 *   past        the newest already-ended period, or null
 *   future      the earliest not-yet-started period, or null
 *   expired     true when a period has ended and none covers today
 *   notStarted  true when no period has begun yet
 *
 * `expired` and `notStarted` are mutually exclusive, and `expired` wins when
 * both could apply. A member with a lapsed period AND a prepaid future period
 * is reported as expired, because that is the fact about today; the future
 * period is still surfaced separately in `future` so a caller can distinguish
 * "lapsed for good" from "lapsed but already prepaid".
 *
 * Pass the member's OWN periods. Narrowing a collection down to one member is
 * `periodsForMember`'s job; this function has no member id to filter by and
 * deliberately does not guess one, so passing a whole collection would silently
 * answer for whichever member happens to sort last.
 */
export function resolvePeriodState(periods, { today, timezone } = {}) {
  const tz = resolveGymTimezone(timezone)
  const todayKey = today || gymTodayKey(tz)
  const own = sortPeriods(periods)

  const usable = own.filter((p) => periodDayKey(p.startDate) && periodDayKey(p.expiryDate))
  const current = usable.filter((p) => isPeriodCurrent(p, todayKey)).pop() || null
  const past =
    [...usable].reverse().find((p) => keyCompare(periodDayKey(p.expiryDate), todayKey) < 0) || null
  const future = own.find((p) => keyCompare(periodDayKey(p.startDate), todayKey) > 0) || null

  const lapsed = !current && Boolean(past)

  return {
    todayKey,
    periods: own,
    hasPeriods: own.length > 0,
    current,
    past,
    future,
    expired: lapsed,
    notStarted: !current && !past && Boolean(future),
  }
}

/**
 * True when the member holds a period covering today.
 *
 * This is the derived replacement for `member.status`. It is a pure function of
 * the authoritative period documents, so it cannot drift from them the way a
 * stored status field does after a period is edited or deleted.
 */
export function isCurrentMember(periods, memberId, options = {}) {
  const state = resolvePeriodState(periodsForMember(periods, memberId), options)
  return Boolean(state.current)
}

/**
 * The expiry date a member's UI should display.
 *
 * Prefers the current period so a prepaid future period cannot mask an imminent
 * renewal, and falls back to the most relevant ended or upcoming period
 * otherwise, so a lapsed or not-yet-started member still sees a real date
 * instead of nothing.
 *
 * When a member has BOTH a lapsed period and a prepaid future period, `future`
 * wins. Their paid membership is what they are waiting on, and the lapsed
 * period is already reflected in the dues ledger as an unpaid balance. This is
 * a display choice only; it does not affect `isCurrentMember`.
 */
export function displayExpiry(periodState) {
  const s = periodState || {}
  const p = s.current || s.future || s.past
  const key = periodDayKey(p?.expiryDate)
  return key ? key : null
}

/**
 * Signed days from today to a period's expiry, on the gym's calendar.
 *
 * Deliberately NOT `gymTime.daysBetween`, which counts inclusively (+1) because
 * it is used for averaging over a billing range where a single-day range must
 * count as one day. An expiry countdown needs the other convention: 0 on the
 * expiry day, 1 the day after, negative once lapsed - matching `gymDaysUntil`,
 * which is what every caller compares against.
 */
export function daysToExpiry(period, todayKey) {
  const expiry = periodDayKey(period?.expiryDate)
  if (!expiry || !todayKey) return null
  const dayNum = (key) => {
    const [y, m, d] = key.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((dayNum(expiry) - dayNum(todayKey)) / 86400000)
}

/**
 * Reject a proposed period that would overlap an existing one.
 *
 * Renewal deliberately allows adjacency: a new period may start the day after
 * the previous one ends. Anything more is an overlap, which would make "the
 * current period" ambiguous - two periods both covering today - and is the
 * condition `findOverlappingPeriods` already rejects in the UI. Surfacing it
 * from the shared module keeps one definition instead of two.
 */
export function findOverlappingPeriods(periods, memberId, candidate) {
  const start = periodDayKey(candidate?.startDate)
  const end = periodDayKey(candidate?.expiryDate)
  if (!start || !end) return []
  return periodsForMember(periods, memberId).filter((p) => {
    if (candidate?.id && String(p.id) === String(candidate.id)) return false
    const ps = periodDayKey(p.startDate)
    const pe = periodDayKey(p.expiryDate)
    if (!ps || !pe) return false
    return keyCompare(start, pe) <= 0 && keyCompare(ps, end) <= 0
  })
}

export { addDaysToKey }