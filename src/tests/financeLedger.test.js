import { describe, expect, it } from 'vitest'
import { computeMemberLedger, computeOutstandingDues } from '@/utils/dues'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'

/**
 * SYSTEM-WIDE REGRESSION SUITE — the exact business scenarios.
 *
 * Core rule under test: each membership period keeps its own financial
 * state. A payment for a NEW period must never absorb an outstanding
 * balance from a PREVIOUS period; old balances survive until a payment is
 * EXPLICITLY recorded against them.
 */

const MONTHLY = { id: 'plan-monthly', name: 'Monthly', price: 1500, durationDays: 30 }
const QUARTERLY = { id: 'plan-quarterly', name: 'Quarterly', price: 3500, durationDays: 90 }
const OLD_PLAN = { id: 'plan-old', name: 'Old Monthly', price: 3000, durationDays: 30 }
const PLANS = [MONTHLY, QUARTERLY, OLD_PLAN]

const today = () => startOfDay(new Date())
const iso = (d) => toDateInputValue(d)
const daysAgo = (n) => iso(addDays(today(), -n))

function member(overrides = {}) {
  return {
    id: 'm1',
    name: 'Test Member',
    membershipPlanId: QUARTERLY.id,
    joinDate: daysAgo(60),
    status: 'active',
    ...overrides,
  }
}

function period(id, plan, overrides = {}) {
  return {
    id,
    memberId: 'm1',
    planId: plan.id,
    planName: plan.name,
    price: plan.price,
    startDate: overrides.startDate || daysAgo(30),
    expiryDate: overrides.expiryDate || iso(addDays(today(), 60)),
    ...overrides,
  }
}

function payment(membershipId, amount, date = daysAgo(20), extra = {}) {
  return { memberId: 'm1', membershipId, amount, date, method: 'Cash', type: 'membership', ...extra }
}

/** Old period with `due` outstanding (fee 3000). */
function scenarioWithOldDue(oldDue) {
  const msOld = period('ms-old', OLD_PLAN, { startDate: daysAgo(60), expiryDate: daysAgo(30) })
  const msNew = period('ms-new', QUARTERLY)
  return {
    member: member(),
    memberships: [msOld, msNew],
    payments:
      oldDue > 0 ? [payment(msOld.id, OLD_PLAN.price - oldDue, daysAgo(50))] : [],
  }
}

describe('REGRESSION — payment allocation across membership periods', () => {
  it('TEST A: full payment on new period leaves the old ₹700 outstanding', () => {
    const s = scenarioWithOldDue(700)
    s.payments.push(payment('ms-new', 3500))

    const ledger = computeMemberLedger({ member: s.member, plans: PLANS, payments: s.payments, memberships: s.memberships })
    const oldPeriod = ledger.periods.find((p) => p.id === 'ms-old')
    const newPeriod = ledger.periods.find((p) => p.id === 'ms-new')

    expect(oldPeriod.due).toBe(700)
    expect(newPeriod.due).toBe(0)
    expect(ledger.totals.due).toBe(700)

    const dues = computeOutstandingDues({ members: [s.member], plans: PLANS, payments: s.payments, memberships: s.memberships })
    expect(dues.totalDue).toBe(700)
    expect(dues.rows[0].targetMembershipId).toBe('ms-old')
  })

  it('TEST B: partial renewal payment → old ₹500 + new ₹500 = ₹1,000 total', () => {
    const s = scenarioWithOldDue(500)
    // New Monthly fee 1500, paid 1000
    s.member = member({ membershipPlanId: MONTHLY.id })
    s.memberships[1] = period('ms-new', MONTHLY)
    s.payments.push(payment('ms-new', 1000))

    const ledger = computeMemberLedger({ member: s.member, plans: PLANS, payments: s.payments, memberships: s.memberships })
    expect(ledger.periods.find((p) => p.id === 'ms-old').due).toBe(500)
    expect(ledger.periods.find((p) => p.id === 'ms-new').due).toBe(500)
    expect(ledger.totals.due).toBe(1000)
  })

  it('TEST C: full renewal payment → old ₹500 survives, new due ₹0', () => {
    const s = scenarioWithOldDue(500)
    // New Monthly fee 1500
    s.member = member({ membershipPlanId: MONTHLY.id })
    s.memberships[1] = period('ms-new', MONTHLY)
    s.payments.push(payment('ms-new', 1500))

    const ledger = computeMemberLedger({ member: s.member, plans: PLANS, payments: s.payments, memberships: s.memberships })
    expect(ledger.periods.find((p) => p.id === 'ms-old').due).toBe(500)
    expect(ledger.periods.find((p) => p.id === 'ms-new').due).toBe(0)
    expect(ledger.totals.due).toBe(500)
  })

  it('TEST D: explicit separate payment against the OLD period clears only that period', () => {
    const s = scenarioWithOldDue(500)
    // New Monthly fee 1500
    s.member = member({ membershipPlanId: MONTHLY.id })
    s.memberships[1] = period('ms-new', MONTHLY)
    s.payments.push(payment('ms-new', 1500))
    s.payments.push(payment('ms-old', 500))

    const ledger = computeMemberLedger({ member: s.member, plans: PLANS, payments: s.payments, memberships: s.memberships })
    expect(ledger.periods.find((p) => p.id === 'ms-old').due).toBe(0)
    expect(ledger.periods.find((p) => p.id === 'ms-new').due).toBe(0)
    expect(ledger.totals.due).toBe(0)

    const dues = computeOutstandingDues({ members: [s.member], plans: PLANS, payments: s.payments, memberships: s.memberships })
    expect(dues.count).toBe(0)
    expect(dues.totalDue).toBe(0)
  })

  it('TEST E: later explicit payment of ₹500 against OLD clears old, new stays ₹500', () => {
    const s = scenarioWithOldDue(500)
    // New Monthly fee 1500
    s.member = member({ membershipPlanId: MONTHLY.id })
    s.memberships[1] = period('ms-new', MONTHLY)
    s.payments.push(payment('ms-new', 1000))
    s.payments.push(payment('ms-old', 500, daysAgo(5)))

    const ledger = computeMemberLedger({ member: s.member, plans: PLANS, payments: s.payments, memberships: s.memberships })
    expect(ledger.periods.find((p) => p.id === 'ms-old').due).toBe(0)
    expect(ledger.periods.find((p) => p.id === 'ms-new').due).toBe(500)
    expect(ledger.totals.due).toBe(500)
  })

  it('TEST F: brand-new membership, no old dues, partial payment → only its own due', () => {
    const msNew = period('ms-new', QUARTERLY)
    const m = member()
    const payments = [payment('ms-new', 2000)]

    const ledger = computeMemberLedger({ member: m, plans: PLANS, payments, memberships: [msNew] })
    expect(ledger.periods).toHaveLength(1)
    expect(ledger.periods[0].due).toBe(1500)
    expect(ledger.totals.due).toBe(1500)
    // No phantom "earlier" period may be fabricated for an allocated payment.
    expect(ledger.periods.some((p) => p.implicit)).toBe(false)
  })

  it('TEST G (ledger view): deleting the only payment returns the full due', () => {
    const msNew = period('ms-new', QUARTERLY)
    const m = member()
    const withPayment = [payment('ms-new', 3500)]
    const afterDelete = []

    const before = computeMemberLedger({ member: m, plans: PLANS, payments: withPayment, memberships: [msNew] })
    const after = computeMemberLedger({ member: m, plans: PLANS, payments: afterDelete, memberships: [msNew] })

    expect(before.totals.due).toBe(0)
    expect(after.totals.due).toBe(3500)
    expect(after.periods[0].status).toBe('due')
  })

  it('TEST H (ledger view): deleting the renewal payment restores new due AND keeps old ₹700', () => {
    const s = scenarioWithOldDue(700)
    const withRenewal = [...s.payments, payment('ms-new', 3500)]

    const before = computeMemberLedger({ member: s.member, plans: PLANS, payments: withRenewal, memberships: s.memberships })
    const after = computeMemberLedger({ member: s.member, plans: PLANS, payments: s.payments, memberships: s.memberships })

    expect(before.totals.due).toBe(700)
    expect(after.periods.find((p) => p.id === 'ms-old').due).toBe(700)
    expect(after.periods.find((p) => p.id === 'ms-new').due).toBe(3500)
    expect(after.totals.due).toBe(4200)
  })
})

describe('implicit origin periods (pre-records history)', () => {
  it('reconstructs an earlier period when unallocated cash predates the oldest record', () => {
    const msNew = period('ms-new', QUARTERLY, { startDate: daysAgo(10), expiryDate: iso(addDays(today(), 80)) })
    const m = member()
    // Legacy manual payment made BEFORE the first recorded period existed.
    const payments = [{ memberId: 'm1', amount: 2300, date: daysAgo(40), method: 'Cash' }]

    const ledger = computeMemberLedger({ member: m, plans: PLANS, payments, memberships: [msNew] })
    const implicit = ledger.periods.find((p) => p.implicit)

    expect(implicit).toBeTruthy()
    expect(implicit.price).toBe(QUARTERLY.price) // current-plan price fallback
    expect(implicit.paid).toBe(2300)
    expect(implicit.due).toBe(1200)
    expect(msNew && ledger.periods.find((p) => p.id === 'ms-new').paid).toBe(0)
  })

  it('fabricates NOTHING when every payment is allocated to a recorded period', () => {
    const msNew = period('ms-new', QUARTERLY, { startDate: iso(addDays(today(), 1)) })
    const m = member()
    // Renewal paid today for a period starting tomorrow — must NOT create a
    // phantom unpaid origin period.
    const payments = [payment('ms-new', 3500, daysAgo(0))]

    const ledger = computeMemberLedger({ member: m, plans: PLANS, payments, memberships: [msNew] })
    expect(ledger.periods.some((p) => p.implicit)).toBe(false)
    expect(ledger.totals.due).toBe(0)
  })

  it('members without any records keep the legacy single-period calculation', () => {
    const m = member({ joinDate: daysAgo(30), membershipPlanId: MONTHLY.id })
    const payments = [{ memberId: 'm1', amount: 1000, date: daysAgo(25), method: 'Cash' }]

    const ledger = computeMemberLedger({ member: m, plans: PLANS, payments, memberships: [] })
    expect(ledger.periods).toHaveLength(1)
    expect(ledger.periods[0].implicit).toBe(true)
    expect(ledger.periods[0].price).toBe(MONTHLY.price)
    expect(ledger.totals.due).toBe(500)
  })

  it('overpayments never make a due negative and stray cash cannot create dues', () => {
    const msNew = period('ms-new', MONTHLY)
    const m = member()
    const payments = [
      payment('ms-new', 2000), // overpays the 1500 period
    ]

    const ledger = computeMemberLedger({ member: m, plans: PLANS, payments, memberships: [msNew] })
    // The overpayment is reported honestly (₹2,000 collected) but the due is
    // never negative and the excess never leaks onto other periods.
    expect(ledger.periods[0].paid).toBe(2000)
    expect(ledger.periods[0].due).toBe(0)
    expect(ledger.totals.due).toBe(0)
  })

  it('undated or zero-amount payments are ignored safely', () => {
    const msNew = period('ms-new', MONTHLY)
    const ledger = computeMemberLedger({
      member: member(),
      plans: PLANS,
      payments: [
        { memberId: 'm1', amount: '', date: undefined },
        { memberId: 'm1', amount: 0, date: iso(today()) },
        { memberId: 'm1', amount: -50, date: iso(today()) },
      ],
      memberships: [msNew],
    })
    expect(ledger.periods[0].paid).toBe(0)
    expect(ledger.totals.due).toBe(MONTHLY.price)
  })
})

describe('allocation invariants', () => {
  it('a payment can never leak onto another period via explicit targeting', () => {
    const msOld = period('ms-old', OLD_PLAN, { startDate: daysAgo(60), expiryDate: daysAgo(30) })
    const msNew = period('ms-new', QUARTERLY)
    const payments = [
      payment('ms-old', 1000),
      payment('ms-new', 100),
    ]
    const ledger = computeMemberLedger({
      member: member(),
      plans: PLANS,
      payments,
      memberships: [msOld, msNew],
    })
    expect(ledger.periods.find((p) => p.id === 'ms-old')).toMatchObject({ paid: 1000, due: 2000 })
    expect(ledger.periods.find((p) => p.id === 'ms-new')).toMatchObject({ paid: 100, due: 3400 })
    expect(ledger.totals.due).toBe(5400)
  })

  it('payments referencing unknown/deleted periods fall back to FIFO pool, oldest first', () => {
    const msOld = period('ms-old', OLD_PLAN, { startDate: daysAgo(60), expiryDate: daysAgo(30) })
    const msNew = period('ms-new', QUARTERLY)
    const payments = [
      payment('ms-deleted', 3200), // target vanished — behaves as unallocated
    ]
    const ledger = computeMemberLedger({
      member: member(),
      plans: PLANS,
      payments,
      memberships: [msOld, msNew],
    })
    // Pool fills ms-old (3000) then spills 200 into ms-new.
    expect(ledger.periods.find((p) => p.id === 'ms-old')).toMatchObject({ paid: 3000, due: 0 })
    expect(ledger.periods.find((p) => p.id === 'ms-new')).toMatchObject({ paid: 200, due: 3300 })
    expect(ledger.targetMembershipId).toBe('ms-new')
  })
})
