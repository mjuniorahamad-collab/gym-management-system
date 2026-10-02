/**
 * Canonical gym-local calendar arithmetic.
 *
 * Every "what day is this?" question in a gym is asked in the GYM's timezone,
 * never in the browser's. Before this module, every day boundary came from
 * `Date.setHours(0,0,0,0)`, `getTimezoneOffset()` or `toDateString()` — all of
 * which resolve against the staff member's own device. A traveller or a
 * laptop with a wrong clock therefore saw different attendance, dues and
 * revenue totals from the front desk, while Cloud Functions computed days in
 * UTC. The stored `attendance.date` / `payments.date` values are instants and
 * ISO strings, so the only correct fix is to convert them here, once.
 *
 * Implemented on `Intl.DateTimeFormat`, which every supported browser already
 * provides, so no date library is introduced.
 */

export const DEFAULT_GYM_TIMEZONE = 'Asia/Kolkata'

/** Timezones offered in Settings. Keeps the list short and unambiguous. */
export const COMMON_GYM_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Colombo',
  'Asia/Karachi',
  'Asia/Dhaka',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

const formatterCache = new Map()

function partsFormatter(timeZone) {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

/**
 * Falls back to the gym default when a stored timezone is missing, blank or not
 * a zone this runtime recognises. A gym must never crash on bad config, and a
 * silently-undefined zone would reintroduce exactly the bug this module exists
 * to remove — so it is resolved to one canonical value up front.
 */
export function resolveGymTimezone(timezone) {
  const tz = typeof timezone === 'string' ? timezone.trim() : ''
  if (!tz) return DEFAULT_GYM_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_GYM_TIMEZONE
  }
}

export function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** Wall-clock parts of `date` as observed in `timeZone`. */
function zonedParts(date, timeZone) {
  const out = {}
  for (const { type, value } of partsFormatter(timeZone).formatToParts(date)) {
    if (type !== 'literal') out[type] = value
  }
  return out
}

/** Offset in ms such that `utcMs + offset` renders as `date`'s wall clock. */
function zoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  )
  // Drop sub-second precision so the offset is stable for the whole second.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * The UTC instant of `YYYY-MM-DD 00:00:00` in `timeZone`.
 *
 * Resolved iteratively because a zone offset can itself depend on the instant
 * being converted (DST transitions); two passes converge for every real zone.
 */
function zonedMidnightUtc(dateOnly, timeZone) {
  const [y, m, d] = dateOnly.split('-').map(Number)
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0)
  let guess = naiveUtc - zoneOffsetMs(new Date(naiveUtc), timeZone)
  guess = naiveUtc - zoneOffsetMs(new Date(guess), timeZone)
  return guess
}

/** Accepts a Date, Timestamp-like, ISO string or `YYYY-MM-DD`; returns a Date. */
export function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value.toDate === 'function') {
    try {
      const d = value.toDate()
      return Number.isNaN(d.getTime()) ? null : d
    } catch {
      return null
    }
  }
  const s = String(value)
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The `YYYY-MM-DD` calendar day that `value` falls on in the gym's timezone.
 * This is the replacement for `parseDate(x)?.toDateString()`.
 *
 * A date-only input (membership `expiryDate`, `joinDate`, a payment `date`) is
 * already a calendar day with no timezone of its own, so it is normalised and
 * returned as-is. Converting it through an instant would silently shift it: the
 * stored string '2026-03-01' read in Pacific/Auckland (+13) would otherwise
 * become the 2nd and move an expiry date by a day.
 */
export function gymDayKey(value, timezone = DEFAULT_GYM_TIMEZONE) {
  if (typeof value === 'string') {
    const s = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  }
  const d = toDate(value)
  if (!d) return ''
  const p = zonedParts(d, resolveGymTimezone(timezone))
  return `${p.year}-${p.month}-${p.day}`
}

/** Today in the gym's timezone — the replacement for `new Date().toDateString()`. */
export function gymTodayKey(timezone = DEFAULT_GYM_TIMEZONE) {
  return gymDayKey(new Date(), timezone)
}

/**
 * Inclusive UTC bounds covering one whole gym-local calendar day, as ISO
 * strings suitable for a Firestore range query on an ISO-string timestamp.
 */
export function gymDayBoundsUtc(dateOnly, timezone = DEFAULT_GYM_TIMEZONE) {
  const start = new Date(zonedMidnightUtc(dateOnly, resolveGymTimezone(timezone)))
  const next = new Date(zonedMidnightUtc(nextDateOnlyKey(dateOnly), resolveGymTimezone(timezone)))
  // `next` is exclusive; the caller wants the last millisecond of the day.
  return { start: start.toISOString(), end: new Date(next.getTime() - 1).toISOString() }
}

/**
 * Inclusive UTC bounds for a whole gym-local date range, so a report from
 * 2026-01-01 to 2026-01-31 includes all of the 31st in the gym's own timezone.
 */
export function gymRangeBoundsUtc(startDateOnly, endDateOnly, timezone = DEFAULT_GYM_TIMEZONE) {
  const tz = resolveGymTimezone(timezone)
  const start = new Date(zonedMidnightUtc(startDateOnly, tz))
  const afterEnd = new Date(zonedMidnightUtc(nextDateOnlyKey(endDateOnly), tz))
  return { start: start.toISOString(), end: new Date(afterEnd.getTime() - 1).toISOString() }
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` key, DST-proof and locale-free. */
export function addDaysToKey(dateOnly, days) {
  const [y, m, d] = dateOnly.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate()
  ).padStart(2, '0')}`
}

function nextDateOnlyKey(dateOnly) {
  return addDaysToKey(dateOnly, 1)
}

/**
 * Whole calendar days from `fromDateOnly` to `toDateOnly`, counted in the gym's
 * timezone and inclusive of both ends. This is the approved denominator for
 * "average check-ins per day" — `daysBetween('2026-01-01','2026-01-31') === 31`.
 *
 * Deliberately counts calendar days rather than dividing an elapsed
 * millisecond span by 86400000, which is wrong by a day across any DST change.
 */
export function daysBetween(fromDateOnly, toDateOnly) {
  const toUtcDay = (key) => {
    const [y, m, d] = key.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((toUtcDay(toDateOnly) - toUtcDay(fromDateOnly)) / 86400000) + 1
}

/**
 * Days remaining until `expiryDateOnly`, measured in gym-local calendar days
 * relative to today in the gym's timezone.
 *
 * This is "how many days from now", so today is 0, tomorrow 1 and yesterday
 * -1 — which is `daysBetween` (an inclusive range length, as Reports needs)
 * minus one. Keeping the inclusive count as its own function matters: the
 * Reports denominator must include both ends, and reusing one number for both
 * purposes is how the previous off-by-one crept in.
 */
export function gymDaysUntil(expiryDateOnly, timezone = DEFAULT_GYM_TIMEZONE, now = new Date()) {
  if (!expiryDateOnly) return null
  const today = gymDayKey(now, timezone)
  // Normalise through gymDayKey rather than slicing the string: callers pass a
  // Date (getMembershipExpiry returns one), a Firestore Timestamp or an instant
  // string, and `String(date).slice(0, 10)` would silently yield "Mon Jan 05".
  const expiry = gymDayKey(expiryDateOnly, timezone)
  if (!today || !expiry) return null
  return daysBetween(today, expiry) - 1
}

/**
 * The billing month `value` falls in, as `YYYY-MM`, in the gym's timezone.
 *
 * This replaces `monthKey()`, which read `getFullYear()`/`getMonth()` from the
 * device. That made "this month's income" depend on the viewer: a payment at
 * 00:30 IST on 1 April is March revenue to a phone set to UTC, and the monthly
 * total on the dashboard did not match the receipt.
 */
export function gymMonthKey(value, timezone = DEFAULT_GYM_TIMEZONE) {
  const day = gymDayKey(value, timezone)
  return day ? day.slice(0, 7) : ''
}

/** The last `count` billing months in the gym's timezone, oldest first. */
export function gymLastNMonthKeys(count, timezone = DEFAULT_GYM_TIMEZONE, now = new Date()) {
  const current = gymMonthKey(now, timezone)
  if (!current) return []
  const [y, m] = current.split('-').map(Number)
  const keys = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const shifted = new Date(Date.UTC(y, m - 1 - i, 1))
    keys.push(`${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return keys
}