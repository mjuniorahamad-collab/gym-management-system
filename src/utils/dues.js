import { addDays, parseDate, toDateInputValue } from './dateHelpers'
import { safePaymentAmount } from './payments'
import { getMembershipCharge } from './pt'
import { freezeTailCharge, pricingBasisForPeriod } from './freezeTails'
import { freezeTailDays } from './membershipFreezes'

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

/**
 * Price for an implicit/reconstructed origin period (no recorded document).
 * Uses the canonical PT pricing when the member is PT so a legacy member's
 * reconstructed charge matches what a recorded PT period would carry.
 */
function implicitPeriodPrice({ plan, member, ptSurcharge, ptSurchargeOverride }) {
  return getMembershipCharge({
    plan,
    isPT: Boolean(member?.isPT),
    ptSurcharge,
    ptSurchargeOverride,
  }).total
}

function periodStatus({ dueAmount, totalPaid }) {
  if (dueAmount === 0) return 'paid'
  return totalPaid > 0 ? 'partial' : 'due'
}

/**
 * A period document's immutable financial snapshots, carried onto the computed
 * ledger row.
 *
 * These are deliberately NOT derived from the live plan. `basePrice`,
 * `ptSurcharge` and `isPT` record what the member actually committed to on the day
 * they bought the period, and `freezeTailSettledFor` records which earlier period's
 * extension this renewal already paid for. Anything recomputed from a plan document
 * can change when an owner edits that plan, which would silently rewrite history
 * that has already been charged.
 */
function periodSnapshots(doc) {
  return {
    basePrice: Number(doc?.basePrice) || undefined,
    ptSurcharge: Number(doc?.ptSurcharge) || undefined,
    isPT: doc?.isPT,
    freezeTailDays: doc?.freezeTailDays,
    freezeTailAmount: doc?.freezeTailAmount,
    freezeTailSettledFor: doc?.freezeTailSettledFor || null,
  }
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
export function computeMemberLedger({
  member,
  plans = [],
  payments = [],
  memberships = [],
  freezes = [],
  ptSurcharge = 0,
  ptSurchargeOverride,
} = {}) {
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
      price: implicitPeriodPrice({
        plan,
        member,
        ptSurcharge,
        ptSurchargeOverride: ptSurchargeOverride ?? member?.ptSurchargeOverride,
      }),
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
        price: implicitPeriodPrice({
          plan,
          member,
          ptSurcharge,
          ptSurchargeOverride: ptSurchargeOverride ?? member?.ptSurchargeOverride,
        }),
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
        // The document's own immutable financial snapshots, carried through so
        // downstream pricing never has to reach back to a live plan. `price` above
        // is the derived, payable figure; these are what the member committed to.
        ...periodSnapshots(doc),
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
    freezeTails: summariseFreezeTails({ periods, freezes, plans, member, ptSurcharge, ptSurchargeOverride }),
  }
}

/**
 * Freeze tails owed on this member's periods - INFORMATIONAL ONLY.
 *
 * A tail is the post-expiry portion of a freeze: the member already holds those
 * days as entitlement, so they are NOT an unpaid period and must never be added
 * to `openPeriods` or `totals.due`. Doing so would create a phantom balance that
 * no payment could ever settle, because the tail is invoiced as its own line
 * inside the next renewal transaction rather than settled by period allocation.
 *
 * Surfacing it here is what stops it being invisible: the member can see what the
 * next renewal will charge before they renew, and a tail that could not be priced
 * is reported rather than silently waived.
 */
function summariseFreezeTails({ periods, freezes, plans, member, ptSurcharge, ptSurchargeOverride }) {
  if (!Array.isArray(freezes) || freezes.length === 0) return []

  // Tails already paid. A renewal records `freezeTailSettledFor` naming the period
  // whose extension it charged, so the charge is attributable AND not re-offered.
  // Reading it back from the renewal history means this stays correct even if the
  // renewal that settled the tail is not the newest period.
  const settledTailKeys = new Map()
  for (const p of periods) {
    const settledFor = p?.freezeTailSettledFor
    if (!settledFor) continue
    const prev = settledTailKeys.get(settledFor)
    const stamp = toDateInputValue(parseDate(p.startDate))
    if (!prev || stamp < prev) settledTailKeys.set(settledFor, stamp)
  }

  const out = []
  for (const period of periods) {
    if (!period?.id) continue
    // The ledger's period rows carry the member id separately from the period, so
    // it is supplied here to scope the freeze lookup to this member.
    const days = freezeTailDays({ ...period, memberId: member?.id }, freezes)
    if (days <= 0) continue

    // Priced from the period the tail belongs to - never the member's current
    // plan. The period's own immutable price snapshot wins over the live plan
    // document, so editing a plan's price cannot silently reprice a freeze that
    // was already granted.
    const plan = plans.find((p) => String(p.id) === String(period.planId)) || null
    const isPT = period.isPT ?? member?.isPT ?? false
    const basis = pricingBasisForPeriod(period, plan)
    const charge = freezeTailCharge({
      tailDays: days,
      basis,
      plan,
      isPT,
      ptSurcharge,
      ptSurchargeOverride: ptSurchargeOverride ?? period.ptSurcharge ?? member?.ptSurchargeOverride,
    })

    out.push({
      membershipId: period.id,
      // Carried so a renewal can settle the tail on the same terms the ledger
      // showed, instead of re-deriving them and risking a different number.
      planId: period.planId,
      isPT: period.isPT,
      basis,
      label: 'Freeze extension',
      days: charge.days,
      amount: charge.amount,
      priceable: charge.priceable,
      reason: charge.reason,
      // Set once a later renewal has settled this tail. A period's tail is a
      // one-off charge against that period; after it is billed, reporting it again
      // would show the member owing money already taken.
      settledAt: settledTailKeys.get(period.id) || null,
    })
  }
  return out
}

/**
 * ONE pass over the members producing every all-members finance figure the
 * dashboard needs, so no member's ledger is computed twice for two different
 * roll-ups.
 *
 * The dashboard previously called computeOutstandingDues() and then looped over
 * every member AGAIN calling computeMemberLedger() with byte-identical
 * arguments, purely to count undocumented origin periods. Since
 * computeMemberLedger filters the full payments array once per member, that
 * duplicated the dominant cost on every change to payments, memberships,
 * members, plans or the PT surcharge.
 *
 * The two figures are derived from the same per-member ledger but are NOT the
 * same set of rows: dues keeps only members with a plan and a remaining due,
 * while the origin-period count keeps every member carrying an implicit period.
 * Both original behaviours are preserved exactly, including the plan-bearing
 * requirement of an implicit period (see below).
 *
 * Note an implicit origin period always requires a plan (computeMemberLedger
 * only reconstructs one when a plan resolves, and returns no periods at all for
 * a member with neither a plan nor recorded documents), so a planless member
 * contributes to neither figure. That is unchanged here - it is recorded
 * because it is the reason the two figures cannot be collapsed into each other.
 *
 * Returns { dues: { rows, totalDue, count }, pendingOriginPeriods }.
 */
export function computeMemberFinanceRollups({
  members = [],
  plans = [],
  payments = [],
  memberships = [],
  ptSurcharge = 0,
} = {}) {
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p]))

  const rows = []
  let pendingOriginPeriods = 0

  for (const member of members) {
    const ledger = computeMemberLedger({
      member,
      plans,
      payments,
      memberships,
      ptSurcharge,
    })

    // Counted for every member, independent of whether a plan is assigned.
    if (ledger.periods.some((p) => p.implicit)) pendingOriginPeriods += 1

    const plan = planMap[member?.membershipPlanId]
    if (!plan) continue
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
  return { dues: { rows, totalDue, count: rows.length }, pendingOriginPeriods }
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
 *
 * Thin wrapper over computeMemberFinanceRollups so this figure and the
 * dashboard's origin-period count share a single ledger pass.
 */
export function computeOutstandingDues({
  members = [],
  plans = [],
  payments = [],
  memberships = [],
  ptSurcharge = 0,
  _ptSurchargeOverride,
} = {}) {
  return computeMemberFinanceRollups({
    members,
    plans,
    payments,
    memberships,
    ptSurcharge,
  }).dues
}
