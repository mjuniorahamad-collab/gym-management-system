import { addDays, parseDate } from './dateHelpers'
import { safePaymentAmount } from './payments'

/**
 * SINGLE SOURCE OF TRUTH for all membership money math.
 *
 * Model:
 *   member → membership periods (documents) → payments (explicitly
 *   allocated via `payment.membershipId`) → outstanding balances → UI.
 *
 * Rules:
 * - A payment carrying a `membershipId` belongs to exactly that period and
 *   can never settle another period's balance.
 * - Payments WITHOUT a usable `membershipId` are legacy/unallocated cash.
 *   They fill the OLDEST period up to its price, then spill forward (FIFO).
 *   New payments recorded through the UI always carry an explicit target.
 * - Every period settles independently: renewing (or paying for a new
 *   period) never absorbs an earlier period's outstanding balance.
 * - When a member's payment history proves an earlier, undocumented period
 *   (an unallocated payment dated before the oldest recorded period), an
 *   `implicit` origin period is reconstructed so that legacy balance stays
 *   visible and payable instead of being silently dropped.
 */

function periodPrice(membership) {
  const price = Number(membership?.price)
  return Number.isFinite(price) && price > 0 ? price : 0
}

function periodStatus({ dueAmount, totalPaid }) {
  if (dueAmount === 0) return 'paid'
  return totalPaid > 0 ? 'partial' : 'due'
}

/**
 * Payment figures for a single membership period.
 * due = price − payments explicitly linked to that period (membershipId),
 * clamped so it is never negative. Unallocated payments (no membershipId —
 * e.g. legacy manual records) settle the oldest periods first, filling each
 * one up to its price before moving on, and never spill backwards onto
 * already-settled periods.
 */
export function getMembershipPeriodSummary({ period, directPaid = 0, unallocatedPool = 0 }) {
  const price = periodPrice(period)
  const needFromPool = Math.max(0, price - directPaid)
  const applied = Math.min(Math.max(0, unallocatedPool), needFromPool)
  const totalPaid = directPaid + applied
  const dueAmount = Math.max(0, price - totalPaid)
  return { id: period?.id, price, totalPaid, dueAmount }
}

/**
 * Aggregate a member's membership periods into one outstanding figure.
 * Only periods with a remaining due contribute to the totals; the payment
 * target is always the OLDEST open period so collected cash clears old
 * balances before the current one.
 */
export function summarizeMembershipPeriods({ periods = [], memberPayments = [] } = {}) {
  const paidByPeriod = new Map()
  let unallocatedPool = 0
  for (const payment of memberPayments) {
    if (!payment) continue
    if (payment.membershipId) {
      paidByPeriod.set(
        payment.membershipId,
        (paidByPeriod.get(payment.membershipId) || 0) + safePaymentAmount(payment.amount)
      )
    } else {
      unallocatedPool += safePaymentAmount(payment.amount)
    }
  }

  const openPeriods = []
  for (const period of periods) {
    const directPaid = paidByPeriod.get(period.id) || 0
    const summary = getMembershipPeriodSummary({ period, directPaid, unallocatedPool })
    const appliedFromPool = summary.totalPaid - directPaid
    if (appliedFromPool > 0) unallocatedPool -= appliedFromPool
    if (summary.dueAmount > 0) openPeriods.push(summary)
  }

  return {
    planAmount: openPeriods.reduce((sum, p) => sum + p.price, 0),
    totalPaid: openPeriods.reduce((sum, p) => sum + p.totalPaid, 0),
    dueAmount: openPeriods.reduce((sum, p) => sum + p.dueAmount, 0),
    targetMembershipId: openPeriods[0]?.id || undefined,
  }
}

function planLabel(plans, planId) {
  const plan = plans.find((p) => String(p.id) === String(planId))
  return plan?.name || ''
}

function sortByStartDate(list) {
  return [...list].sort((a, b) =>
    String(a.startDate || '').localeCompare(String(b.startDate || ''))
  )
}

/**
 * Reconstruct the FULL period timeline for one member, including any
 * pre-records origin period that the payment history proves existed.
 *
 * Returns:
 * {
 *   periods: [{ id, planId, label, startDate, expiryDate, price, paid, due,
 *               status, implicit }]   // oldest → newest
 *   openPeriods: […same shape, due > 0 only]
 *   totals: { billed, paid, due }      // summed over OPEN periods only
 *   targetMembershipId: id | undefined // oldest open RECORDED period
 * }
 */
export function computeMemberLedger({ member, plans = [], payments = [], memberships = [] } = {}) {
  if (!member?.id) {
    return { periods: [], openPeriods: [], totals: { billed: 0, paid: 0, due: 0 }, targetMembershipId: undefined }
  }

  const memberPayments = payments.filter((p) => p && p.memberId === member.id)
  const recordedDocs = sortByStartDate(
    memberships.filter((m) => m && m.id && m.memberId === member.id)
  )

  const plan = plans.find((p) => String(p.id) === String(member.membershipPlanId)) || null

  // ---- Build the ordered period list -------------------------------------
  const periodDefs = []

  if (recordedDocs.length === 0) {
    // Legacy-shaped member (no period documents at all): the whole history
    // collapses into one implicit origin period at the current plan price.
    if (!plan) return { periods: [], openPeriods: [], totals: { billed: 0, paid: 0, due: 0 }, targetMembershipId: undefined }
    const start =
      parseDate(member.joinDate) ||
      memberPayments
        .map((p) => parseDate(p.date))
        .filter(Boolean)
        .sort((a, b) => a - b)[0] ||
      null
    const duration = Number(plan.durationDays)
    periodDefs.push({
      id: null,
      planId: plan.id,
      label: plan.name || 'Membership',
      startDate: start,
      expiryDate: start && Number.isFinite(duration) && duration > 0 ? addDays(start, duration) : null,
      price: periodPrice(plan),
      implicit: true,
    })
  } else {
    // Safety net: unallocated cash dated before the oldest recorded period
    // proves an earlier membership existed that was never documented.
    const firstRecordedStart = parseDate(recordedDocs[0].startDate)
    const strays = memberPayments.filter((p) => {
      if (safePaymentAmount(p.amount) <= 0) return false
      const linkedToKnownPeriod = recordedDocs.some((m) => m.id === p.membershipId)
      if (linkedToKnownPeriod) return false
      const date = parseDate(p.date)
      return date && firstRecordedStart && date < firstRecordedStart
    })
    if (strays.length > 0 && plan) {
      const earliestStray = strays
        .map((p) => parseDate(p.date))
        .filter(Boolean)
        .sort((a, b) => a - b)[0]
      const duration = Number(plan.durationDays)
      periodDefs.push({
        id: null,
        planId: plan.id,
        label: `${plan.name || 'Membership'} (earlier)`,
        startDate: earliestStray,
        expiryDate:
          earliestStray && Number.isFinite(duration) && duration > 0 ? addDays(earliestStray, duration) : null,
        price: periodPrice(plan),
        implicit: true,
      })
    }

    for (const doc of recordedDocs) {
      periodDefs.push({
        id: doc.id,
        planId: doc.planId || '',
        label: doc.planName || planLabel(plans, doc.planId) || 'Membership',
        startDate: parseDate(doc.startDate),
        expiryDate: parseDate(doc.expiryDate),
        price: periodPrice(doc),
        implicit: false,
      })
    }
  }

  // ---- Allocate payments --------------------------------------------------
  const paidByPeriod = new Map()
  let unallocatedPool = 0
  const knownIds = new Set(recordedDocs.map((m) => m.id))
  for (const payment of memberPayments) {
    const amount = safePaymentAmount(payment.amount)
    if (amount <= 0) continue
    if (payment.membershipId && knownIds.has(payment.membershipId)) {
      paidByPeriod.set(
        payment.membershipId,
        (paidByPeriod.get(payment.membershipId) || 0) + amount
      )
    } else {
      unallocatedPool += amount
    }
  }

  const periods = periodDefs.map((def) => {
    const directPaid = def.id ? paidByPeriod.get(def.id) || 0 : 0
    const needFromPool = Math.max(0, def.price - directPaid)
    const applied = Math.min(unallocatedPool, needFromPool)
    unallocatedPool -= applied
    const paid = directPaid + applied
    const due = Math.max(0, def.price - paid)
    return {
      ...def,
      paid,
      due,
      status: periodStatus({ dueAmount: due, totalPaid: paid }),
    }
  })

  const openPeriods = periods.filter((p) => p.due > 0)

  return {
    periods,
    openPeriods,
    totals: {
      billed: openPeriods.reduce((s, p) => s + p.price, 0),
      paid: openPeriods.reduce((s, p) => s + p.paid, 0),
      due: openPeriods.reduce((s, p) => s + p.due, 0),
    },
    targetMembershipId: openPeriods.find((p) => !p.implicit)?.id,
  }
}

/**
 * Compute the outstanding membership dues across all members.
 *
 * Every member is evaluated through computeMemberLedger — the SAME engine
 * used by Member Detail, Renewal, Payment Form and receipts — so the
 * dashboard can never disagree with the rest of the app. Rows aggregate
 * open periods only and carry `targetMembershipId` pointing at the oldest
 * unpaid recorded period. Members with no remaining due are excluded.
 *
 * Returns { rows, totalDue, count }. Rows are sorted by due descending,
 * then by member name.
 */
export function computeOutstandingDues({
  members = [],
  plans = [],
  payments = [],
  memberships = [],
} = {}) {
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p]))

  const rows = []
  for (const member of members) {
    const plan = planMap[member?.membershipPlanId]
    if (!plan) continue

    const ledger = computeMemberLedger({ member, plans, payments, memberships })
    if (ledger.totals.due <= 0) continue

    rows.push({
      member,
      plan,
      planAmount: ledger.totals.billed,
      totalPaid: ledger.totals.paid,
      dueAmount: ledger.totals.due,
      targetMembershipId: ledger.targetMembershipId,
      periods: ledger.openPeriods,
    })
  }

  rows.sort((a, b) => {
    if (b.dueAmount !== a.dueAmount) return b.dueAmount - a.dueAmount
    return String(a.member.name || '').localeCompare(String(b.member.name || ''))
  })

  const totalDue = rows.reduce((sum, r) => sum + r.dueAmount, 0)
  return { rows, totalDue, count: rows.length }
}
