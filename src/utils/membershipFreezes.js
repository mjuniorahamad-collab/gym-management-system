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
 * ## Counting frozen days - anchored, never truncated
 *
 * A freeze SUSPENDS the countdown for its whole duration. It is not capped at the
 * original expiry: the days after the original expiry are carried forward as the
 * "tail", and are billed at the next renewal rather than written off.
 *
 * A freeze is ANCHORED: it counts in full only if it BEGAN while the member still
 * held entitlement, i.e. on or before the original expiry. A freeze that starts
 * after the expiry suspended nothing and counts zero.
 *
 *     period 2026-07-01 .. 2026-07-31
 *
 *     freeze 2026-07-10..2026-07-20   (11 days, wholly inside)
 *       -> 11 frozen days, tail 0  -> effective expiry 2026-08-11
 *
 *     freeze 2026-07-20..2026-08-14   (26 days, begins while active)
 *       -> 26 frozen days, tail 14  -> effective expiry 2026-08-26
 *
 *     freeze 2026-07-31..2026-08-10   (11 days, begins ON the expiry)
 *       -> 11 frozen days, tail 10  -> effective expiry 2026-08-11
 *
 *     freeze 2026-08-05..2026-08-15   (begins AFTER the expiry)
 *       -> 0 frozen days, tail 0     -> effective expiry unchanged
 *
 * The anchoring rule is what keeps the last case at zero without capping the
 * others: the freeze never granted entitlement the member did not hold, so
 * extending past the expiry can never manufacture time.
 *
 * Why the tail is not written off: capping at the original expiry discards the
 * post-expiry days of a freeze the gym recorded. In the 26-day example above that
 * silently voids 14 granted days. The tail is preserved as entitlement AND
 * invoiced - see `utils/freezeTails` for the charge and `services/renewals` for
 * settlement.
 *
 * Overlapping freezes are counted ONCE, by taking the union of the intervals.
 * Two staff members recording overlapping suspensions must not produce 40 frozen
 * days out of two 20-day freezes.
 *
 * ## Both ends of the window are enforced
 *
 * The lower bound is a WRITE-TIME invariant: `validateFreezeInput` rejects a
 * freeze that starts before its period, so entitlement can never be created
 * before the membership was bought. Reads DEFENSIVELY clip at the period start as
 * well, so a malformed or legacy record that predates the membership cannot grant
 * days that were never purchased. Reads never REPAIR such a record - the stored
 * freeze keeps its original dates and the discrepancy stays visible for the audit
 * trail rather than being quietly normalised away on every read.
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
 *
 * `periodStartDate` enforces the write-time invariant that a freeze may never
 * begin before its membership period. Without it, a freeze recorded against the
 * wrong period would extend an expiry using days that predate the purchase.
 * Callers that cannot supply the period start are still safe - the calculation
 * layer clips defensively - but the record itself would be accepted.
 */
export function validateFreezeInput({
  memberId,
  periodId,
  startDate,
  expiryDate,
  periodStartDate,
  freezes = [],
  excludeId = '',
} = {}) {
  if (!memberId) return { ok: false, error: 'A member is required' }
  if (!periodId) return { ok: false, error: 'A membership period is required' }

  const start = periodDayKey(startDate)
  const end = periodDayKey(expiryDate)
  if (!start) return { ok: false, error: 'A valid freeze start date is required' }
  if (!end) return { ok: false, error: 'A valid freeze end date is required' }
  const span = daysBetweenKeys(start, end)
  if (span === null) return { ok: false, error: 'Freeze dates are not usable' }
  if (span < 0) return { ok: false, error: 'The freeze cannot end before it starts' }

  // A freeze begins on the period's first day at the earliest: the member held
  // entitlement from that day, and not before it.
  if (periodStartDate) {
    const periodStart = periodDayKey(periodStartDate)
    if (!periodStart) {
      return { ok: false, error: 'This membership period has no usable start date, so the freeze cannot be validated' }
    }
    if (start < periodStart) {
      return {
        ok: false,
        error: `The freeze cannot start before the membership period begins (${periodStart})`,
      }
    }
  }

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
 * Clip one interval to `[floorKey, ceilingKey]` and return it as a
 * `[startKey, endKey]` tuple, or null when nothing survives the clip.
 *
 * Accepts either a stored freeze object or an already-normalised tuple, because
 * both shapes flow through the merging below.
 */
function toRange(raw, { floorKey = '', ceilingKey = '' } = {}) {
  const rawStart = Array.isArray(raw) ? raw[0] : raw?.startDate
  const rawEnd = Array.isArray(raw) ? raw[1] : raw?.expiryDate
  const start = periodDayKey(rawStart)
  const end = periodDayKey(rawEnd)
  if (!start || !end) return null
  const floor = floorKey ? periodDayKey(floorKey) : ''
  const ceiling = ceilingKey ? periodDayKey(ceilingKey) : ''
  const lo = floor && start < floor ? floor : start
  const hi = ceiling && end > ceiling ? ceiling : end
  if ((daysBetweenKeys(lo, hi) ?? -1) < 0) return null
  return [lo, hi]
}

/**
 * Merge closed, inclusive `[start, end]` ranges into the fewest non-overlapping
 * ranges, sorted ascending.
 *
 * Overlapping AND adjacent ranges are merged, so "up to the 15th" and "from the
 * 16th" become one continuous stretch rather than leaving a phantom gap.
 */
function mergeRanges(ranges) {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const merged = [sorted[0]]
  for (const [start, end] of sorted.slice(1)) {
    const current = merged[merged.length - 1]
    // `start <= currentEnd + 1 day` merges adjacency as well as overlap.
    if (start <= addDaysToKey(current[1], 1)) {
      if (end > current[1]) current[1] = end
      continue
    }
    merged.push([start, end])
  }
  return merged
}

/** Total inclusive days across already-merged, non-overlapping ranges. */
function rangesDays(ranges) {
  let days = 0
  for (const [start, end] of ranges) {
    days += (daysBetweenKeys(start, end) ?? 0) + 1
  }
  return days
}

/**
 * The number of calendar days covered by the union of the given intervals.
 *
 * Intervals are INCLUSIVE of both endpoints, matching how a membership period
 * treats its own dates: a period running to 2026-07-31 grants access on the 31st,
 * so a freeze covering 10-20 July suspends 11 days of access, not 10.
 *
 * `ceilingKey` clips every interval's END. It exists for measuring a bounded
 * slice (such as the tail), NOT for capping entitlement - the freeze days that
 * actually move an expiry are counted by `countFrozenDays`, which applies no
 * upper bound.
 */
export function unionFrozenDays(intervals, ceilingKey = '') {
  if (!Array.isArray(intervals)) return 0
  const ranges = intervals.map((raw) => toRange(raw, { ceilingKey })).filter(Boolean)
  return rangesDays(mergeRanges(ranges))
}

/**
 * The live freeze ranges that may extend one period's expiry: merged, clipped to
 * the period's start, and anchored so that only stretches beginning while the
 * member still held entitlement are kept.
 *
 * Two steps, and the order matters.
 *
 * 1. FLOOR CLIP - defensively, no day before the period's own start is counted.
 *    `validateFreezeInput` rejects such a freeze at write time, but a legacy or
 *    malformed record may predate that rule; clipping stops it granting
 *    entitlement the member never bought. The stored record is NOT modified.
 *
 * 2. MERGE, THEN ANCHOR - a continuous absence is ONE absence. Staff routinely
 *    record a suspension and later extend it as a second adjacent record; if
 *    anchoring were applied per freeze, that continuation would be judged by its
 *    own start date and - beginning after the original expiry - contribute
 *    nothing, so extending a freeze would silently do nothing. Merging first
 *    means an adjacent continuation belongs to the same stretch and is credited
 *    with it.
 *
 * Anchoring the MERGED range is also what keeps a post-expiry freeze from
 * manufacturing time. A freeze is only dropped when its whole continuous stretch
 * begins after the expiry; a separate stretch stranded beyond a genuine gap in
 * which entitlement had already run out is still dropped.
 *
 * @returns {Array<[string, string]>} sorted ascending, non-overlapping.
 */
export function anchoredFreezeRanges(period, freezes) {
  const original = periodDayKey(period?.expiryDate)
  const periodStart = periodDayKey(period?.startDate)
  const live = activeFreezesForPeriod(freezes, { memberId: period?.memberId, periodId: period?.id })
  if (live.length === 0) return []

  const clipped = live.map((f) => toRange(f, { floorKey: periodStart })).filter(Boolean)
  const merged = mergeRanges(clipped)
  if (!original) return merged
  return merged.filter(([start]) => start <= original)
}

/**
 * How many days this period's freezes actually added to its expiry.
 *
 * The FULL anchored duration, never truncated at the original expiry.
 */
export function countFrozenDays(period, freezes) {
  return rangesDays(anchoredFreezeRanges(period, freezes))
}

/**
 * The days of this period's freezes that fall AFTER the original expiry - the
 * preserved tail, invoiced at the next renewal instead of being written off.
 *
 * Always `<= countFrozenDays`: the tail is a subset of the frozen days, and the
 * pre-expiry portion is already covered by the money the member paid.
 */
export function freezeTailDays(period, freezes) {
  const original = periodDayKey(period?.expiryDate)
  if (!original) return 0
  const anchored = anchoredFreezeRanges(period, freezes)
  if (anchored.length === 0) return 0
  const beyond = anchored
    .map(([start, end]) => toRange([start, end], { floorKey: addDaysToKey(original, 1) }))
    .filter(Boolean)
  return rangesDays(mergeRanges(beyond))
}

/**
 * The last day this period is actually frozen - the maximum end of its live
 * anchored freezes, or '' when it has none.
 *
 * This is NOT the effective expiry and deliberately differs from it: a member
 * frozen to 14 August whose entitlement runs to 26 August is still holding paid
 * time after the freeze lifts. Callers that answer "is this member frozen
 * today?" need this, not the expiry.
 */
export function freezeUntilKey(period, freezes) {
  const anchored = anchoredFreezeRanges(period, freezes)
  if (anchored.length === 0) return ''
  return anchored[anchored.length - 1][1]
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
  const frozenDays = countFrozenDays(period, freezes)
  if (frozenDays <= 0) return original
  return addDaysToKey(original, frozenDays)
}

/**
 * How many days the freezes actually added to this period's expiry.
 *
 * @deprecated Use `countFrozenDays` - same value, clearer name. Retained so
 * existing callers and tests keep working.
 */
export function frozenDaysForPeriod(period, freezes) {
  return countFrozenDays(period, freezes)
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