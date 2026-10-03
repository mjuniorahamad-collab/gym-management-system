import { describe, beforeEach, expect, it, vi } from 'vitest'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'
import { getDaysRemaining, getExpiryBucket, getMembershipExpiry } from '@/utils/membership'
import {
  getMembershipPeriod,
  getRenewalPaymentSummary,
  getRenewalStartDate,
  resolveEffectiveStart,
} from '@/utils/renewal'
import { renewalSchema } from '@/schemas/validationSchemas'
import { renewMembership } from '@/services/renewals'
import { recordPayment } from '@/services/payments'
import { computeOutstandingDues, computeMemberLedger } from '@/utils/dues'
import { findOverlappingPeriods } from '@/utils/memberships'
import { __store } from '@/services/firestore'

vi.mock('@/services/firestore', () => {
  const store = { memberships: [], payments: [], members: [], auditLog: [] }
  return {
    __store: store,
    isReady: () => false,
    listAll: async (name) => store[name],
    getById: async (name, id) => store[name].find((d) => d.id === id) || null,
    createDoc: async (name, data) => {
      const id = `mock-${name}-${store[name].length + 1}`
      const doc = { id, ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      store[name].push(doc)
      return id
    },
    updateDocById: async (name, id, data) => {
      const doc = store[name].find((d) => d.id === id)
      if (doc) Object.assign(doc, data, { updatedAt: new Date().toISOString() })
    },
  }
})

const today = () => startOfDay(new Date())
const iso = (d) => toDateInputValue(d)

function makePlan(overrides = {}) {
  return { id: 'plan-90', name: '3 Months', durationDays: 90, price: 3500, active: true, ...overrides }
}

function makeMember(overrides = {}) {
  return {
    id: 'm1',
    name: 'Zaid',
    status: 'expired',
    membershipPlanId: 'plan-90',
    joinDate: iso(addDays(today(), -120)),
    ...overrides,
  }
}

beforeEach(() => {
  __store.memberships = []
  __store.payments = []
  __store.members = []
  __store.auditLog = []
})

describe('getRenewalStartDate', () => {
  it('starts today when the membership is expired', () => {
    expect(iso(getRenewalStartDate(addDays(today(), -14)))).toBe(iso(today()))
  })

  it('starts the day after expiry when the membership is still active', () => {
    const expiry = addDays(today(), 5)
    expect(iso(getRenewalStartDate(expiry))).toBe(iso(addDays(expiry, 1)))
  })

  it('expiring today starts tomorrow', () => {
    expect(iso(getRenewalStartDate(today()))).toBe(iso(addDays(today(), 1)))
  })

  it('expired yesterday starts today', () => {
    expect(iso(getRenewalStartDate(addDays(today(), -1)))).toBe(iso(today()))
  })

  it('starts today when there is no current expiry', () => {
    expect(iso(getRenewalStartDate(null))).toBe(iso(today()))
    expect(iso(getRenewalStartDate(undefined))).toBe(iso(today()))
  })

  it('ignores invalid expiry dates', () => {
    expect(iso(getRenewalStartDate('not-a-date'))).toBe(iso(today()))
  })
})

describe('getMembershipPeriod', () => {
  it('computes the new expiry from the renewal start', () => {
    const period = getMembershipPeriod({ currentExpiry: addDays(today(), 5), plan: makePlan() })
    expect(iso(period.startDate)).toBe(iso(addDays(today(), 6)))
    expect(iso(period.expiryDate)).toBe(iso(addDays(period.startDate, 90)))
  })

  it('returns null for a plan without a valid duration', () => {
    expect(getMembershipPeriod({ currentExpiry: today(), plan: { durationDays: 0 } })).toBeNull()
    expect(getMembershipPeriod({ currentExpiry: today(), plan: { durationDays: NaN } })).toBeNull()
  })
})

describe('resolveEffectiveStart', () => {
  it('previous-expiry returns the previous expiry date', () => {
    const expiry = addDays(today(), -7)
    expect(iso(resolveEffectiveStart({ mode: 'previous-expiry', currentExpiry: expiry }))).toBe(iso(expiry))
  })

  it('today returns today', () => {
    expect(iso(resolveEffectiveStart({ mode: 'today' }))).toBe(iso(today()))
  })

  it('custom returns the chosen date', () => {
    const custom = addDays(today(), -3)
    expect(iso(resolveEffectiveStart({ mode: 'custom', customDate: iso(custom) }))).toBe(iso(custom))
  })

  it('falls back to today when previous expiry is invalid or missing', () => {
    expect(iso(resolveEffectiveStart({ mode: 'previous-expiry', currentExpiry: null }))).toBe(iso(today()))
    expect(iso(resolveEffectiveStart({ mode: 'previous-expiry', currentExpiry: 'bad' }))).toBe(iso(today()))
  })

  it('falls back to today for an unknown mode or missing custom date', () => {
    expect(iso(resolveEffectiveStart({ mode: 'custom', customDate: '' }))).toBe(iso(today()))
    expect(iso(resolveEffectiveStart({}))).toBe(iso(today()))
  })
})

describe('getMembershipPeriod with effectiveStartDate (backdated renewal)', () => {
  it('uses the explicit effective start and derives expiry from it', () => {
    const effective = addDays(today(), -7)
    const period = getMembershipPeriod({ currentExpiry: addDays(today(), 3), plan: makePlan(), effectiveStartDate: effective })
    expect(iso(period.startDate)).toBe(iso(effective))
    expect(iso(period.expiryDate)).toBe(iso(addDays(effective, 90)))
  })

  it('ignores currentExpiry when an explicit effective start is supplied', () => {
    const effective = addDays(today(), -10)
    const period = getMembershipPeriod({ currentExpiry: today(), plan: makePlan(), effectiveStartDate: effective })
    expect(iso(period.startDate)).toBe(iso(effective))
  })

  it('falls back to the automatic start when no explicit effective date is given', () => {
    const period = getMembershipPeriod({ currentExpiry: addDays(today(), -1), plan: makePlan() })
    expect(iso(period.startDate)).toBe(iso(today()))
  })
})

describe('getRenewalPaymentSummary', () => {
  it('full payment → paid, nothing due', () => {
    expect(getRenewalPaymentSummary({ planPrice: 3500, paidAmount: 3500 })).toEqual({
      price: 3500,
      tailAmount: 0,
      total: 3500,
      paid: 3500,
      due: 0,
      status: 'paid',
    })
  })

  it('partial payment → partial, remaining due', () => {
    expect(getRenewalPaymentSummary({ planPrice: 3500, paidAmount: 2000 })).toEqual({
      price: 3500,
      tailAmount: 0,
      total: 3500,
      paid: 2000,
      due: 1500,
      status: 'partial',
    })
  })

  it('zero payment → due, full amount due', () => {
    expect(getRenewalPaymentSummary({ planPrice: 3500, paidAmount: 0 })).toEqual({
      price: 3500,
      tailAmount: 0,
      total: 3500,
      paid: 0,
      due: 3500,
      status: 'due',
    })
  })

  /**
   * The tail is charged now but is NOT the period's price. Keeping `price` clean
   * is what stops the ledger billing the same extension days again on every
   * recompute, so this distinction is asserted rather than assumed.
   */
  it('a tail raises the total charged without entering the period price', () => {
    expect(getRenewalPaymentSummary({ planPrice: 3500, tailAmount: 200, paidAmount: 3700 })).toEqual({
      price: 3500,
      tailAmount: 200,
      total: 3700,
      paid: 3700,
      due: 0,
      status: 'paid',
    })
  })

  it('paying only the period price leaves the tail outstanding', () => {
    // Guards against a partial payment on the period silently writing the
    // extension off: the due amount has to still include it.
    const s = getRenewalPaymentSummary({ planPrice: 3500, tailAmount: 200, paidAmount: 3500 })
    expect(s.status).toBe('partial')
    expect(s.due).toBe(200)
    expect(s.price).toBe(3500)
  })

  it('negative or junk tail values are ignored rather than reducing the charge', () => {
    expect(getRenewalPaymentSummary({ planPrice: 3500, tailAmount: -500, paidAmount: 0 }).total).toBe(3500)
    expect(getRenewalPaymentSummary({ planPrice: 3500, tailAmount: 'x', paidAmount: 0 }).total).toBe(3500)
  })

  it('overpayment clamps due to 0', () => {
    const summary = getRenewalPaymentSummary({ planPrice: 3500, paidAmount: 4000 })
    expect(summary.due).toBe(0)
    expect(summary.status).toBe('paid')
  })

  it('negative paid amount is treated as 0', () => {
    const summary = getRenewalPaymentSummary({ planPrice: 3500, paidAmount: -100 })
    expect(summary.paid).toBe(0)
    expect(summary.due).toBe(3500)
  })
})

describe('renewalSchema', () => {
  const valid = { planId: 'plan-90', amount: '2000', method: 'Cash', date: iso(today()), note: '' }

  it('accepts a valid renewal', () => {
    expect(renewalSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a negative payment amount', () => {
    expect(renewalSchema.safeParse({ ...valid, amount: '-10' }).success).toBe(false)
  })

  it('allows a zero payment (deferred → Due)', () => {
    expect(renewalSchema.safeParse({ ...valid, amount: '0' }).success).toBe(true)
  })

  it('rejects a renewal without a plan', () => {
    expect(renewalSchema.safeParse({ ...valid, planId: '' }).success).toBe(false)
  })

  it('rejects a renewal without method or date', () => {
    expect(renewalSchema.safeParse({ ...valid, method: '' }).success).toBe(false)
    expect(renewalSchema.safeParse({ ...valid, date: '' }).success).toBe(false)
  })

  it('rejects non-numeric amounts', () => {
    expect(renewalSchema.safeParse({ ...valid, amount: 'abc' }).success).toBe(false)
  })
})

describe('renewMembership service', () => {
  function seed(member) {
    __store.members.push({ ...member })
  }

  it('renews an expired member from today and links payment + period', async () => {
    const plan = makePlan()
    const member = makeMember()
    seed(member)
    const result = await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -10),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })

    const memberDoc = __store.members.find((m) => m.id === member.id)
    expect(memberDoc.status).toBe('active')
    expect(memberDoc.membershipPlanId).toBe(plan.id)
    // joinDate is when the member joined the GYM, not when the current period
    // began. Rewriting it on every renewal corrupted the dashboard and Reports
    // "new members this month" counts, which both filter on it.
    expect(memberDoc.joinDate).toBe(iso(addDays(today(), -120)))

    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.startDate).toBe(iso(today()))
    expect(membership.expiryDate).toBe(iso(addDays(today(), 90)))
    expect(membership.price).toBe(3500)
    expect(membership.amountPaid).toBe(3500)
    expect(membership.amountDue).toBe(0)
    expect(membership.paymentStatus).toBe('paid')

    const payment = __store.payments.find((p) => p.memberId === member.id)
    expect(payment.membershipId).toBe(membership.id)
    expect(payment.type).toBe('renewal')
    expect(payment.amount).toBe(3500)

    expect(result.membership.paymentId).toBe(payment.id)
  })

  it('renews an active member starting the day after the current expiry', async () => {
    const plan = makePlan()
    const member = makeMember({ status: 'active' })
    seed(member)
    const currentExpiry = addDays(today(), 5)
    await renewMembership({
      member,
      plan,
      currentExpiry,
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })

    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.startDate).toBe(iso(addDays(currentExpiry, 1)))
    expect(membership.expiryDate).toBe(iso(addDays(addDays(currentExpiry, 1), 90)))
  })

  it('records a partial payment with the remaining due', async () => {
    const plan = makePlan({ price: 3500 })
    const member = makeMember()
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 2000,
      method: 'Cash',
      date: iso(today()),
    })

    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.amountPaid).toBe(2000)
    expect(membership.amountDue).toBe(1500)
    expect(membership.paymentStatus).toBe('partial')

    const payment = __store.payments.find((p) => p.memberId === member.id)
    expect(payment.amount).toBe(2000)
  })

  it('allows a zero payment → status Due', async () => {
    const plan = makePlan({ price: 3500 })
    const member = makeMember()
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 0,
      method: 'Cash',
      date: iso(today()),
    })

    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.amountPaid).toBe(0)
    expect(membership.amountDue).toBe(3500)
    expect(membership.paymentStatus).toBe('due')
  })

  it('leaves existing payment history untouched', async () => {
    const plan = makePlan()
    const member = makeMember()
    seed(member)
    const existing = {
      id: 'old-payment',
      memberId: member.id,
      planId: plan.id,
      amount: 2500,
      method: 'Card',
      date: '2026-01-05',
      receiptNo: 'HWG-0001',
    }
    __store.payments.push(existing)
    const before = JSON.parse(JSON.stringify(existing))

    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })

    expect(__store.payments.find((p) => p.id === 'old-payment')).toEqual(before)
    expect(__store.payments.length).toBe(2)
    expect(__store.memberships.length).toBe(1)
  })

  it('rejects a negative payment amount', async () => {
    const plan = makePlan()
    const member = makeMember()
    await expect(
      renewMembership({
        member,
        plan,
        currentExpiry: addDays(today(), -1),
        paidAmount: -100,
        method: 'Cash',
        date: iso(today()),
      })
    ).rejects.toThrow()
  })

  it('rejects a plan with an invalid price', async () => {
    const plan = makePlan({ price: 0 })
    const member = makeMember()
    await expect(
      renewMembership({
        member,
        plan,
        currentExpiry: addDays(today(), -1),
        paidAmount: 100,
        method: 'Cash',
        date: iso(today()),
      })
    ).rejects.toThrow(/price/i)
  })

  it('rejects a renewal without a valid member', async () => {
    const plan = makePlan()
    await expect(
      renewMembership({
        member: null,
        plan,
        currentExpiry: addDays(today(), -1),
        paidAmount: 100,
        method: 'Cash',
        date: iso(today()),
      })
    ).rejects.toThrow(/member/i)
  })
})

describe('renewMembership — backdated renewals (effective vs payment dates)', () => {
  const monthly = () => ({ id: 'plan-30', name: 'Monthly', durationDays: 30, price: 1500, active: true })
  const prevExpiry = () => addDays(today(), -7) // e.g. Aug 21
  const paidOn = () => addDays(today(), -4) // e.g. Aug 28 (money actually received)

  function seed(member) {
    __store.members.push({ ...member })
  }

  // A: normal renewal today starts today
  it('A. normal renewal today → new membership starts today', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(today()),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(today()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.startDate).toBe(iso(today()))
    expect(membership.expiryDate).toBe(iso(addDays(today(), 30)))
  })

  // B: backdate to previous expiry; payment date stays the received date
  it('B. backdated renewal → starts at previous expiry, expiry from it, payment date unchanged', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(prevExpiry()),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(paidOn()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    const payment = __store.payments.find((p) => p.memberId === member.id)
    expect(membership.startDate).toBe(iso(prevExpiry()))
    expect(membership.expiryDate).toBe(iso(addDays(prevExpiry(), 30)))
    expect(membership.amountDue).toBe(0)
    expect(membership.paymentStatus).toBe('paid')
    // payment received date is SEPARATE and untouched
    expect(payment.date).toBe(iso(paidOn()))
    expect(payment.date).not.toBe(membership.startDate)
    // the parked membership period on the payment reflects the period
    expect(payment.startDate).toBe(iso(prevExpiry()))
  })

  // C: custom backdated date
  it('C. custom backdated effective date is honoured', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    const custom = addDays(today(), -5)
    await renewMembership({
      member,
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(custom),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(paidOn()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.startDate).toBe(iso(custom))
    expect(membership.expiryDate).toBe(iso(addDays(custom, 30)))
  })

  // D: payment date independent of membership effective date
  it('D. payment date remains independent of the membership effective date', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(prevExpiry()),
      paidAmount: 1200,
      method: 'Cash',
      date: iso(paidOn()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    const payment = __store.payments.find((p) => p.memberId === member.id)
    expect(payment.date).toBe(iso(paidOn()))
    // payment date never overwritten by the effective start
    expect(payment.date).not.toBe(iso(prevExpiry()))
    // partial payment leaves the backdated period partially due
    expect(membership.amountPaid).toBe(1200)
    expect(membership.amountDue).toBe(300)
  })

  // E: old outstanding due stays separate from the new period
  it('E. existing outstanding due stays separate from the new backdated period', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    // Old period ₹500 due: pay 1000 of a 1500 period
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -37),
      effectiveStartDate: iso(addDays(today(), -30)),
      paidAmount: 1000,
      method: 'Cash',
      date: iso(addDays(today(), -28)),
    })
    // Backdated renewal of the next period
    await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(prevExpiry()),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(paidOn()),
    })

    const dues = computeOutstandingDues({
      members: __store.members,
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })
    // only the old ₹500 remains, the new backdated period is fully paid
    expect(dues.totalDue).toBe(500)
    const row = dues.rows.find((r) => r.member.id === member.id)
    expect(row.targetMembershipId).toBe(__store.memberships[0].id)
  })

  // F: old outstanding due remains after a backdated renewal (not silently absorbed)
  it('F. backdated renewal keeps the old outstanding due intact', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -37),
      effectiveStartDate: iso(addDays(today(), -30)),
      paidAmount: 1200,
      method: 'Cash',
      date: iso(addDays(today(), -28)),
    })
    await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(prevExpiry()),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(paidOn()),
    })
    // old ₹300 due preserved, new period fully paid
    const oldPeriod = __store.memberships[0]
    expect(oldPeriod.amountDue).toBe(300)
    expect(oldPeriod.paymentStatus).toBe('partial')
    const newPeriod = __store.memberships[1]
    expect(newPeriod.amountDue).toBe(0)
    // no payment was redirected to the old period automatically
    const oldContributions = __store.payments
      .filter((p) => p.membershipId === oldPeriod.id)
      .reduce((s, p) => s + Number(p.amount), 0)
    expect(oldContributions).toBe(1200)
  })

  // H: multiple (backdated + forward) renewal periods coexist in the ledger
  it('H. multiple renewal periods coexist with correct per-period finance', async () => {
    const plan = monthly()
    const member = makeMember({ membershipPlanId: plan.id })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -67),
      effectiveStartDate: iso(addDays(today(), -60)),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(addDays(today(), -58)),
    })
    await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: addDays(today(), -37),
      effectiveStartDate: iso(addDays(today(), -30)),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(addDays(today(), -28)),
    })
    await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: prevExpiry(),
      effectiveStartDate: iso(prevExpiry()),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(paidOn()),
    })

    const ledger = computeOutstandingDues({
      members: __store.members,
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })
    expect(__store.memberships.length).toBe(3)
    expect(__store.payments.length).toBe(3)
    expect(ledger.totalDue).toBe(0)
    // periods are ordered by startDate in the ledger
    const dates = __store.memberships
      .map((m) => m.startDate)
      .sort()
    expect(dates).toEqual([iso(addDays(today(), -60)), iso(addDays(today(), -30)), iso(prevExpiry())].sort())
  })
})

describe('joinDate preservation across renewals', () => {
  const monthlyPlan = () => ({ id: 'plan-30', name: 'Monthly', durationDays: 30, price: 1500, active: true })

  function seed(member) {
    __store.members.push({ ...member })
  }

  it('leaves joinDate untouched across four renewals in one month', async () => {
    const plan = monthlyPlan()
    const original = iso(addDays(today(), -400))
    const member = makeMember({ membershipPlanId: plan.id, joinDate: original })
    seed(member)

    // Four separate renewals. Every one used to reset joinDate to its own
    // effective start, so the member looked like a brand-new joiner four times
    // and appeared in the dashboard's "new members this month" tile four times.
    for (let i = 0; i < 4; i += 1) {
      const stored = __store.members.find((m) => m.id === member.id)
      await renewMembership({
        member: stored,
        plan,
        currentExpiry: addDays(today(), -10 - i * 30),
        effectiveStartDate: iso(addDays(today(), -9 - i * 30)),
        paidAmount: 1500,
        method: 'Cash',
        date: iso(addDays(today(), -9 - i * 30)),
      })
    }

    expect(__store.members.find((m) => m.id === member.id).joinDate).toBe(original)
    expect(__store.memberships.length).toBe(4)
    expect(__store.payments.length).toBe(4)
  })

  it('backfills joinDate when the member has none', async () => {
    const plan = monthlyPlan()
    const member = makeMember({ membershipPlanId: plan.id, joinDate: '' })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(today()),
    })
    // Legacy members with no period documents derive their billing start from
    // joinDate, so an absent value is still filled rather than left blank.
    expect(__store.members.find((m) => m.id === member.id).joinDate).toBe(iso(today()))
  })

  it('backfills joinDate when the stored value is unparseable', async () => {
    const plan = monthlyPlan()
    const member = makeMember({ membershipPlanId: plan.id, joinDate: 'not-a-date' })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 1500,
      method: 'Cash',
      date: iso(today()),
    })
    expect(__store.members.find((m) => m.id === member.id).joinDate).toBe(iso(today()))
  })
})

describe('renewal receipt linking', () => {
  function seed(member) {
    __store.members.push({ ...member })
  }

  it('stores the same receipt number on the period and its payment', async () => {
    const plan = makePlan()
    const member = makeMember()
    seed(member)
    const result = await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })
    const membership = __store.memberships[0]
    const payment = __store.payments[0]
    // Both documents are written in one transaction, so neither can end up with
    // a number the other does not have.
    expect(membership.receiptNo).toBe(payment.receiptNo)
    expect(membership.receiptNo).toBeTruthy()
    expect(membership.paymentId).toBe(payment.id)
    expect(payment.membershipId).toBe(membership.id)
    expect(result.membership.receiptNo).toBe(membership.receiptNo)
    expect(result.payment.membershipId).toBe(membership.id)
  })

  it('issues a distinct receipt number per renewal', async () => {
    const plan = makePlan()
    const member = makeMember()
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -10),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })
    await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })
    const numbers = __store.payments.map((p) => p.receiptNo)
    expect(new Set(numbers).size).toBe(2)
  })
})

describe('payment allocation across periods (regression)', () => {
  function seed(member) {
    __store.members.push({ ...member })
  }

  it('renewing with an exact payment keeps the previous ₹700 outstanding', async () => {
    const plan = makePlan()
    const member = makeMember({ name: 'Javed Ahmad' })
    seed(member)

    // Period 1: renews paying 2,800 of 3,500 → ₹700 carried as due
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -10),
      paidAmount: 2800,
      method: 'Cash',
      date: iso(today()),
    })
    // Period 2: renews again, this time paying the full ₹3,500
    const renewed = await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })

    expect(renewed.membership.amountDue).toBe(0)
    expect(__store.payments.length).toBe(2)
    expect(__store.memberships.length).toBe(2)

    const dues = computeOutstandingDues({
      members: __store.members,
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })

    expect(dues.count).toBe(1)
    expect(dues.totalDue).toBe(700)

    const row = dues.rows.find((r) => r.member.id === member.id)
    expect(row.dueAmount).toBe(700)
    // Target is the OLD period, so the next collection settles that balance
    const oldMembership = __store.memberships.find((m) => m.amountDue === 700)
    expect(oldMembership).toBeTruthy()
    expect(row.targetMembershipId).toBe(oldMembership.id)
  })

  it('collecting the old ₹700 via recordPayment zeroes only the old period', async () => {
    const plan = makePlan()
    const member = makeMember({ name: 'Javed Ahmad' })
    seed(member)

    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -10),
      paidAmount: 2800,
      method: 'Cash',
      date: iso(today()),
    })
    await renewMembership({
      member: __store.members.find((m) => m.id === member.id),
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 3500,
      method: 'Cash',
      date: iso(today()),
    })

    const oldPeriod = __store.memberships[0]
    const newPeriod = __store.memberships[1]

    await recordPayment({
      values: { memberId: member.id, membershipId: oldPeriod.id, amount: 700, method: 'Cash', date: iso(today()) },
      memberName: member.name,
      receiptPrefix: 'HWG',
    })

    // Old period settled, new period untouched
    expect(__store.memberships.find((m) => m.id === oldPeriod.id)).toMatchObject({
      amountPaid: 3500,
      amountDue: 0,
      paymentStatus: 'paid',
    })
    expect(__store.memberships.find((m) => m.id === newPeriod.id)).toMatchObject({
      amountPaid: 3500,
      amountDue: 0,
      paymentStatus: 'paid',
    })
    expect(__store.payments.length).toBe(3)
    expect(__store.payments.at(-1)).toMatchObject({ membershipId: oldPeriod.id, type: 'membership' })

    const dues = computeOutstandingDues({
      members: __store.members,
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })
    expect(dues.count).toBe(0)
    expect(dues.totalDue).toBe(0)
  })

  it('recordPayment refuses to attribute cash to another member’s period', async () => {
    __store.memberships.push({ id: 'ms-other', memberId: 'other-member', price: 3000 })

    const result = await recordPayment({
      values: { memberId: 'm1', membershipId: 'ms-other', amount: 700, method: 'Cash', date: iso(today()) },
      memberName: 'Wrong Target',
      receiptPrefix: 'HWG',
    })

    expect(result.membership).toBeNull()
    expect(result.id).toBeTruthy()
    const stored = __store.payments.find((p) => p.id === result.id)
    expect(stored.membershipId).toBe('')
    expect(__store.memberships.find((m) => m.id === 'ms-other').amountDue).toBeUndefined()
  })
})

describe('dashboard expiry after renewal', () => {
  it('an expired member renewed for 90 days is no longer expired', () => {
    const plan = makePlan()
    const renewed = { membershipPlanId: plan.id, joinDate: iso(getRenewalStartDate(addDays(today(), -10))) }
    const expiry = getMembershipExpiry(renewed, plan)
    expect(getDaysRemaining(expiry)).toBeGreaterThan(0)
    expect(getExpiryBucket(getDaysRemaining(expiry))).toBeNull()
  })

  it('a short renewed plan appears in an upcoming-expiry bucket', () => {
    const plan = makePlan({ id: 'plan-day', durationDays: 1 })
    const renewed = { membershipPlanId: plan.id, joinDate: iso(today()) }
    const expiry = getMembershipExpiry(renewed, plan)
    expect(getDaysRemaining(expiry)).toBe(1)
    expect(getExpiryBucket(getDaysRemaining(expiry))).toBe('tomorrow')
  })
})

describe('overlap detection for backdated renewals', () => {
  it('detects an overlap when the effective period overlaps an existing period', () => {
    const overlapping = findOverlappingPeriods(
      { memberId: 'm1', startDate: '2026-08-01', expiryDate: '2026-08-31' },
      [
        { id: 'p1', memberId: 'm1', planName: 'Monthly', startDate: '2026-08-15', expiryDate: '2026-09-14' },
        { id: 'p2', memberId: 'm1', planName: 'Quarterly', startDate: '2026-01-01', expiryDate: '2026-03-31' },
      ]
    )
    expect(overlapping.map((o) => o.id)).toEqual(['p1'])
  })

  it('reports no overlap when the new period begins the day after the previous period ends', () => {
    const overlapping = findOverlappingPeriods(
      { memberId: 'm1', startDate: '2026-08-22', expiryDate: '2026-09-21' },
      [{ id: 'p1', memberId: 'm1', planName: 'Monthly', startDate: '2026-07-22', expiryDate: '2026-08-21' }]
    )
    expect(overlapping).toEqual([])
  })

  it('flags a backdated period that starts BEFORE the previous period ends (true overlap)', () => {
    const overlapping = findOverlappingPeriods(
      { memberId: 'm1', startDate: '2026-08-20', expiryDate: '2026-09-19' },
      [{ id: 'p1', memberId: 'm1', planName: 'Monthly', startDate: '2026-08-01', expiryDate: '2026-08-31' }]
    )
    expect(overlapping.map((o) => o.id)).toEqual(['p1'])
  })
})

describe('cross-screen financial consistency (single ledger engine)', () => {
  const monthly = () => ({ id: 'plan-30', name: 'Monthly', durationDays: 30, price: 1500, active: true })

  it('Dashboard (computeOutstandingDues) and MemberDetail (computeMemberLedger) agree', () => {
    const plan = monthly()
    __store.members.push({
      id: 'm-x',
      name: 'Consistency',
      status: 'active',
      membershipPlanId: plan.id,
      joinDate: iso(addDays(today(), -30)),
    })
    // one backdated fully-paid period + one open period with ₹400 due
    __store.memberships.push(
      { id: 'ms-b', memberId: 'm-x', planId: plan.id, planName: 'Monthly', startDate: iso(addDays(today(), -30)), expiryDate: iso(today()), price: 1500 },
      { id: 'ms-a', memberId: 'm-x', planId: plan.id, planName: 'Monthly', startDate: iso(addDays(today(), 1)), expiryDate: iso(addDays(today(), 31)), price: 1500 }
    )
    // ms-b fully paid (1500). ms-a has 1100 paid → 400 due.
    __store.payments.push(
      { id: 'pay-b', memberId: 'm-x', membershipId: 'ms-b', amount: 1500, date: iso(addDays(today(), -28)) },
      { id: 'pay-a', memberId: 'm-x', membershipId: 'ms-a', amount: 1100, date: iso(today()) }
    )

    const out = computeOutstandingDues({
      members: __store.members,
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })
    const ledger = computeMemberLedger({
      member: __store.members[0],
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })

    expect(out.totalDue).toBe(400)
    expect(ledger.totals.due).toBe(400)
    expect(out.rows[0].targetMembershipId).toBe('ms-a')
    expect(ledger.targetMembershipId).toBe('ms-a')
  })
})
