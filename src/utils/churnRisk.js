import { attendanceDay } from './attendance'
import { gymDaysUntil } from './gymTime'
import { getCurrentMembershipExpiry } from './membership'
import { periodDayKey } from './membershipPeriods'

/**
 * At-risk (churn) scoring for the owner dashboard.
 *
 * Built entirely from data the app already stores:
 *
 * - `attendance` → the member's last visit (gym-local day).
 * - membership periods → days until the current period expires.
 * - the canonical dues rollup (`utils/dues.js`) → what is still unpaid, and how
 *   old the oldest open period is (dues aging).
 *
 * Nothing is inferred from a stored `status` flag: that field is a projection
 * and can lag the ledger, so an at-risk list built from it would miss exactly
 * the members who need attention. Expiry comes from the same
 * `getCurrentMembershipExpiry` the dashboard and member page use.
 *
 * The score is additive and capped, not a prediction. It ranks members by how
 * many independent warning signs they carry, so an owner can work the list top
 * down instead of opening every member page.
 */

/** Consecutive days without a visit before inactivity counts as a signal. */
export const INACTIVITY_DAYS = 14
/** Days without a visit that on their own make a membership dormant. */
export const DORMANT_DAYS = 30
/** Age of an unpaid period before its dues count as aging. */
export const DUE_AGING_DAYS = 30
/** Minimum score for a member to appear in the list at all. */
export const AT_RISK_THRESHOLD = 30

export const AT_RISK_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'expiry', label: 'Expiring' },
  { key: 'dues', label: 'Dues' },
  { key: 'inactivity', label: 'Inactive' },
]

/** Signed gym-local days since a `YYYY-MM-DD` key (null when unreadable). */
export function daysSinceKey(dayKey, timezone, now) {
  if (!dayKey) return null
  const until = gymDaysUntil(dayKey, timezone, now)
  // `0 - until` rather than `-until`: negating zero yields -0, which reads as a
  // difference to Object.is and to toBe() in tests.
  return until === null ? null : 0 - until
}

/** Last gym-local visit day per member, from the attendance collection. */
export function buildLastVisitMap(attendance = [], timezone) {
  const map = new Map()
  for (const entry of attendance || []) {
    const memberId = entry?.memberId
    if (!memberId) continue
    const day = attendanceDay(entry, timezone)
    if (!day) continue
    const previous = map.get(memberId)
    if (!previous || day > previous) map.set(memberId, day)
  }
  return map
}

/** Coarse aging bucket for an unpaid period, used for the column and label. */
export function dueAgingBucket(days) {
  if (days === null || days === undefined) return null
  if (days >= 90) return '90+'
  if (days >= 60) return '61-90'
  if (days >= DUE_AGING_DAYS) return '31-60'
  return '0-30'
}

function expirySignal(daysToExpiry) {
  if (daysToExpiry === null || daysToExpiry === undefined) return null
  if (daysToExpiry < 0) {
    return {
      key: 'expiry',
      tone: 'danger',
      weight: 45,
      label: `Expired ${Math.abs(daysToExpiry)}d ago`,
    }
  }
  if (daysToExpiry <= 7) {
    return { key: 'expiry', tone: 'warning', weight: 30, label: `Expires in ${daysToExpiry}d` }
  }
  return null
}

function duesSignal({ dueAmount, dueAgeDays }) {
  if (!(dueAmount > 0)) return null
  // A fresh unpaid period is normal (it was just billed). The weight grows with
  // how long the oldest open period has been unpaid, because that is the part
  // an owner can actually act on.
  if (dueAgeDays !== null && dueAgeDays >= 90) {
    return { key: 'dues', tone: 'danger', weight: 30, label: `Dues ${dueAgeDays}d old` }
  }
  if (dueAgeDays !== null && dueAgeDays >= 60) {
    return { key: 'dues', tone: 'danger', weight: 25, label: `Dues ${dueAgeDays}d old` }
  }
  if (dueAgeDays !== null && dueAgeDays >= DUE_AGING_DAYS) {
    return { key: 'dues', tone: 'warning', weight: 20, label: `Dues ${dueAgeDays}d old` }
  }
  return { key: 'dues', tone: 'warning', weight: 10, label: 'Unpaid balance' }
}

function inactivitySignal({ daysSinceVisit, membershipAgeDays }) {
  if (daysSinceVisit === null) {
    // No visit has ever been recorded. That is only a signal once the member
    // has had time to come in; otherwise every new joiner would look at risk.
    if (membershipAgeDays !== null && membershipAgeDays > INACTIVITY_DAYS) {
      return { key: 'inactivity', tone: 'warning', weight: 20, label: 'No visits recorded' }
    }
    return null
  }
  if (daysSinceVisit >= DORMANT_DAYS) {
    return {
      key: 'inactivity',
      tone: 'danger',
      weight: 30,
      label: `No visit for ${daysSinceVisit}d`,
    }
  }
  if (daysSinceVisit >= INACTIVITY_DAYS) {
    return {
      key: 'inactivity',
      tone: 'warning',
      weight: 15,
      label: `No visit for ${daysSinceVisit}d`,
    }
  }
  return null
}

export function riskTier(score) {
  if (score >= 60) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

/**
 * Build the ranked at-risk list.
 *
 * `duesRows` is the output of `computeMemberFinanceRollups().dues.rows`, reused
 * rather than recomputed: that pass already walks every member ledger, and a
 * second walk here would cost the dashboard the exact duplication the rollup
 * was introduced to remove. Omit it (or pass []) for staff without finance
 * access — the list then ranks on expiry and attendance only.
 *
 * Returns { rows, summary } where each row carries the member, plan, the three
 * raw measurements, the score/tier and the reasons that produced the score.
 */
export function buildAtRiskMembers({
  members = [],
  plans = [],
  memberships = [],
  freezes = [],
  attendance = [],
  duesRows = [],
  timezone,
  now,
  threshold = AT_RISK_THRESHOLD,
} = {}) {
  const planMap = new Map((plans || []).map((p) => [p.id, p]))
  const duesMap = new Map((duesRows || []).map((r) => [r.member?.id, r]))
  const lastVisits = buildLastVisitMap(attendance, timezone)

  const rows = []
  for (const member of members || []) {
    if (!member?.id) continue

    const plan = planMap.get(member.membershipPlanId) || null
    const expiry = getCurrentMembershipExpiry(member, plan, memberships, {
      timezone,
      freezes,
    })
    const daysToExpiry = expiry ? gymDaysUntil(expiry, timezone, now) : null

    const due = duesMap.get(member.id) || null
    const dueAmount = due?.dueAmount || 0
    // Aging is measured from the OLDEST open period: that is the charge the
    // member has owed longest, not the most recent renewal.
    const oldestOpenStart = (due?.periods || [])
      .map((p) => periodDayKey(p.startDate))
      .filter(Boolean)
      .sort()[0]
    const dueAgeDays = oldestOpenStart ? daysSinceKey(oldestOpenStart, timezone, now) : null

    const lastVisit = lastVisits.get(member.id) || null
    const daysSinceVisit = daysSinceKey(lastVisit, timezone, now)
    const membershipAgeDays = daysSinceKey(periodDayKey(member.joinDate), timezone, now)

    // A member with neither a plan nor a resolvable period cannot be judged on
    // renewal; they are still eligible on dues or attendance.
    if (!plan && !expiry && dueAmount <= 0 && !lastVisit) continue

    const reasons = [
      expirySignal(daysToExpiry),
      duesSignal({ dueAmount, dueAgeDays }),
      inactivitySignal({ daysSinceVisit, membershipAgeDays }),
    ].filter(Boolean)

    const score = Math.min(
      100,
      reasons.reduce((sum, r) => sum + r.weight, 0)
    )
    if (score < threshold) continue

    rows.push({
      member,
      plan,
      expiry,
      daysToExpiry,
      lastVisit,
      daysSinceVisit,
      dueAmount,
      dueAgeDays,
      dueBucket: dueAmount > 0 ? dueAgingBucket(dueAgeDays) : null,
      targetMembershipId: due?.targetMembershipId,
      reasons,
      signals: reasons.map((r) => r.key),
      score,
      tier: riskTier(score),
    })
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.dueAmount !== a.dueAmount) return b.dueAmount - a.dueAmount
    return String(a.member.name || '').localeCompare(String(b.member.name || ''))
  })

  const summary = {
    total: rows.length,
    high: rows.filter((r) => r.tier === 'high').length,
    expiring: rows.filter((r) => r.signals.includes('expiry')).length,
    withDues: rows.filter((r) => r.signals.includes('dues')).length,
    inactive: rows.filter((r) => r.signals.includes('inactivity')).length,
    valueAtRisk: rows.reduce((sum, r) => sum + (Number(r.dueAmount) || 0), 0),
  }

  return { rows, summary }
}
