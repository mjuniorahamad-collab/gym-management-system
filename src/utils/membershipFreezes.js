import { addDaysToKey } from './gymTime'
import { periodDayKey } from './membershipPeriods'

/**
 * Membership freezes: immutable, dated intervals during which a membership's
 * countdown is suspended.
 *
 * ## The rule this module exists to enforce
 *
 * A freeze never edits a membership period. `period.expiryDate` is the money
 * the member bought and stays exactly as written. Everything a freeze changes is
 * DERIVED, by `effectiveExpiryKey`, from the period's original expiry plus the
 * frozen days.
 *
 * That separation is the point. The previous behaviour for a paused membership
 * was to push its `expiryDate` forward, which meant the original purchase
 * stopped existing anywhere in the system: the invoice no longer matched the
 * period, a correction could not be expressed, and two staff members editing the
 * same record produced two different histories.
 *
 * ## Counting frozen days
 *
 * Only days the member actually lost count, so a freeze contributes only the
 * days at or before the original expiry:
 *
 *     original expiry 2026-08-31, freeze 2026-08-01..2026-08-30
 *       -> 30 frozen days  -> effective expiry 2026-09-30
 *
 *     original expiry 2026-08-31, freeze 2026-08-01..2026-09-15
 *       -> 31 frozen days (Aug 1..31)  -> effective expiry 2026-10-01
 *
 *     original expiry 2026-08-31, freeze 2026-09-10..2026-09-20
 *       -> 0 frozen days  -> effective expiry unchanged
 *
 * The second case is the one worth stating: the member was absent 45 days but
 * their entitlement ran out on the 31st, so they are absent for 31 of the days
 * they had paid for and resume on 1 October. Granting all 45 would hand out 14
 * days nobody bought.
 *
 * The third case is why freezing after an expiry must not extend anything: there
 * was no entitlement left to suspend.
 *
 * Overlapping freezes are counted ONCE, by taking the union of the intervals.
 * Two staff members recording overlapping suspensions must not produce 40 frozen
 * days out of two 20-day freezes.
 */

export const FREEZE_KIND = 'freeze'
export const CANCELLATION_KIND = 'cancellation'

/** Days between two `YYYY-MM-DD` keys, positive when `b` is later. */
export function daysBetweenKeys(a, b) {
  const ka = periodDayKey(a)
  const kb = periodDayKey(b)
  if (!ka || !kb) return null
  // UTC throughout: both operands are already plain calendar dates, so using
  // local time here would reintroduce the off-by-one this codebase keeps
  // eliminating.
  const ms = Date.parse(`${kb}T00:00:00Z`) - Date.parse(`${ka}T00:00:00Z`)
  if (!Number.isFinite(ms)) return null
  return Math.round(ms / 86400000)
}

/**
 * Normalise a stored freeze document.
 *
 * Returns null for anything unusable, so a malformed row can never widen an
 * expiry. `kind` distinguishes an actual freeze from an appended cancellation.
 */
export function normalizeFreeze(doc) {
  if (!doc || typeof doc !== 'object') return null
  const startDate = periodDayKey(doc.startDate)
  const expiryDate = periodDayKey(doc.expiryDate)
  const isCancellation = doc.kind === CANCELLATION_KIND
  // A cancellation references the freeze it voids; it carries no interval of its
  // own, so its dates are optional.
  if (!isCancellation && (!startDate || !expiryDate)) return null
  if (startDate && expiryDate && daysBetweenKeys(startDate, expiryDate) < 0) return null
  return {
    id: doc.id ? String(doc.id) : '',
    kind: isCancellation ? CANCELLATION_KIND : FREEZE_KIND,
    memberId: doc.memberId != null ? String(doc.memberId) : '',
    periodId: doc.periodId != null ? String(doc.periodId) : '',
    startDate,
    expiryDate,
    cancelsFreezeId: doc.cancelsFreezeId != null ? String(doc.cancelsFreezeId) : '',
    reason: typeof doc.reason === 'string' ? doc.reason : '',
  }
}

export function normalizeFreezes(list) {
  if (!Array.isArray(list)) return []
  return list.map(normalizeFreeze).filter(Boolean)
}

/**
 * Validate a proposed freeze before it is written.
 *
 * Overlap is rejected rather than merged. Merging would silently produce a
 * different interval than the one on screen, and the operator would have no way
 * to tell which record won.
 */
export function validateFreezeInput({ memberId, periodId, startDate, expiryDate, freezes = [], excludeId = '' } = {}) {
  if (!memberId) return { ok: false, error: 'A member is required' }
  if (!periodId) return { ok: false, error: 'A membership period is required' }

  const start = periodDayKey(startDate)
  const end = periodDayKey(expiryDate)
  if (!start) return { ok: false, error: 'A valid freeze start date is required' }
  if (!end) return { ok: false, error: 'A valid freeze end date is required' }
  const span = daysBetweenKeys(start, end)
  if (span === null) return { ok: false, error: 'Freeze dates are not usable' }
  if (span < 0) return { ok: false, error: 'The freeze cannot end before it starts' }

  const cancelled = cancelledFreezeIds(freezes)
  const overlap = findOverlappingFreezes(freezes, { memberId, periodId, startDate: start, expiryDate: end, excludeId })
    .find((f) => !cancelled.has(f.id))
  if (overlap) {
    return { ok: false, error: `This period already has a freeze covering ${overlap.startDate} to ${overlap.expiryDate}` }
  }
  return { ok: true, startDate: start, expiryDate: end }
}

export function findOverlappingFreezes(freezes, { memberId, periodId, startDate, expiryDate, excludeId = '' } = {}) {
  const candidateStart = periodDayKey(startDate)
  const candidateEnd = periodDayKey(expiryDate)
  if (!candidateStart || !candidateEnd) return []
  const mine = String(memberId ?? '')
  const myPeriod = String(periodId ?? '')

  return normalizeFreezes(freezes).filter((f) => {
    if (f.kind !== FREEZE_KIND) return false
    if (excludeId && f.id === String(excludeId)) return false
    if (mine && f.memberId !== mine) return false
    // Scoped to a period: a freeze suspends one membership, so a freeze on a
    // different period of the same member is not a conflict.
    if (myPeriod && f.periodId !== myPeriod) return false
    // Closed intervals: two freezes sharing a single day overlap.
    return candidateStart <= f.expiryDate && candidateEnd >= f.startDate
  })
}

/** Ids of freezes that an appended cancellation record has voided. */
export function cancelledFreezeIds(freezes) {
  const out = new Set()
  for (const f of normalizeFreezes(freezes)) {
    if (f.kind === CANCELLATION_KIND && f.cancelsFreezeId) out.add(f.cancelsFreezeId)
  }
  return out
}

/**
 * The number of calendar days covered by the union of the given intervals.
 *
 * Intervals are INCLUSIVE of both endpoints, matching how a membership period
 * treats its own dates: a period running to 2026-07-31 grants access on the 31st,
 * so a freeze covering 10-20 July suspends 11 days of access, not 10.
 *
 * Overlapping and adjacent intervals are merged before counting, so two staff
 * members recording overlapping suspensions cannot produce 40 frozen days out of
 * two 20-day freezes.
 *
 * `ceilingKey` clips every interval: days after it are not counted, because the
 * entitlement they would extend had already ended.
 */
export function unionFrozenDays(intervals, ceilingKey = '') {
  const ceiling = ceilingKey ? periodDayKey(ceilingKey) : ''
  const ranges = []
  for (const raw of intervals) {
    const start = periodDayKey(raw?.startDate)
    const end = periodDayKey(raw?.expiryDate)
    if (!start || !end) continue
    const clippedEnd = ceiling && end > ceiling ? ceiling : end
    const span = daysBetweenKeys(start, clippedEnd)
    if (span === null || span < 0) continue
    ranges.push([start, clippedEnd])
  }
  if (ranges.length === 0) return 0

  // Sort by start, then merge anything overlapping or touching. Comparing
  // against `end + 1 day` merges adjacency too, so "up to the 15th" and "from
  // the 16th" count as one continuous stretch rather than leaving a phantom gap.
  ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  let days = 0
  let [currentStart, currentEnd] = ranges[0]
  for (const [start, end] of ranges.slice(1)) {
    const adjacent = start <= addDaysToKey(currentEnd, 1)
    if (adjacent) {
      if (end > currentEnd) currentEnd = end
      continue
    }
    days += (daysBetweenKeys(currentStart, currentEnd) ?? 0) + 1
    currentStart = start
    currentEnd = end
  }
  days += (daysBetweenKeys(currentStart, currentEnd) ?? 0) + 1
  return days
}

/**
 * The live freezes for one period: same member, same period, not cancelled.
 */
export function activeFreezesForPeriod(freezes, { memberId, periodId } = {}) {
  const mine = String(memberId ?? '')
  const myPeriod = String(periodId ?? '')
  const cancelled = cancelledFreezeIds(freezes)
  return normalizeFreezes(freezes).filter(
    (f) =>
      f.kind === FREEZE_KIND &&
      f.memberId === mine &&
      (!myPeriod || f.periodId === myPeriod) &&
      !cancelled.has(f.id)
  )
}

/**
 * The expiry a member actually holds, derived from a period's original expiry
 * and its freezes. The period document is never modified.
 *
 * Returns the original expiry unchanged when there are no live freezes, or null
 * when the period has no usable expiry at all.
 */
export function effectiveExpiryKey(period, freezes) {
  const original = periodDayKey(period?.expiryDate)
  if (!original) return null
  const live = activeFreezesForPeriod(freezes, { memberId: period?.memberId, periodId: period?.id })
  if (live.length === 0) return original
  const frozenDays = unionFrozenDays(live, original)
  if (frozenDays <= 0) return original
  return addDaysToKey(original, frozenDays)
}

/** How many days the freezes actually added to this period's expiry. */
export function frozenDaysForPeriod(period, freezes) {
  const original = periodDayKey(period?.expiryDate)
  if (!original) return 0
  const live = activeFreezesForPeriod(freezes, { memberId: period?.memberId, periodId: period?.id })
  if (live.length === 0) return 0
  return unionFrozenDays(live, original)
}

/**
 * Decorate periods with their derived `effectiveExpiry`.
 *
 * `membershipPeriods.resolvePeriodState` honours `effectiveExpiry` in place of
 * `expiryDate`, so passing the result in is all a caller has to do to make every
 * expiry- and currency-aware screen freeze-aware.
 */
export function applyFreezes(periods, freezes) {
  if (!Array.isArray(periods)) return []
  return periods.map((p) => {
    if (!p) return p
    // Only annotate when a freeze actually moved the date. Setting
    // `effectiveExpiry` equal to `expiryDate` on every period would make the
    // field's presence meaningless as a signal that a freeze exists.
    if (frozenDaysForPeriod(p, freezes) <= 0) return p
    const effective = effectiveExpiryKey(p, freezes)
    return effective ? { ...p, effectiveExpiry: effective } : p
  })
}

/** Summary of a member's freeze history, for display and for tests. */
export function resolveFreezeState(freezes, memberId) {
  const mine = String(memberId ?? '')
  const all = normalizeFreezes(freezes).filter((f) => !mine || f.memberId === mine)
  const cancelled = cancelledFreezeIds(all)
  const active = all.filter((f) => f.kind === FREEZE_KIND && !cancelled.has(f.id))
  return {
    all,
    active,
    cancellations: all.filter((f) => f.kind === CANCELLATION_KIND),
    cancelledIds: [...cancelled],
  }
}