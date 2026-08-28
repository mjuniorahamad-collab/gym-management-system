import { describe, beforeEach, expect, it, vi } from 'vitest'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'
import { recordPayment, deletePayment } from '@/services/payments'
import { computeOutstandingDues } from '@/utils/dues'
import { __store } from '@/services/firestore'

vi.mock('@/services/firestore', () => {
  const store = { memberships: [], payments: [], members: [], membershipPlans: [], auditLog: [] }
  return {
    __store: store,
    isReady: () => true,
    listAll: async (name) => [...store[name]],
    getById: async (name, id) => store[name].find((d) => d.id === id) || null,
    createDoc: async (name, data) => {
      const id = `mock-${name}-${store[name].length + 1}`
      store[name].push({ id, ...data })
      return id
    },
    updateDocById: async (name, id, data) => {
      const doc = store[name].find((d) => d.id === id)
      if (doc) Object.assign(doc, data)
    },
    removeDoc: async (name, id) => {
      store[name] = store[name].filter((d) => d.id !== id)
    },
  }
})

const today = () => startOfDay(new Date())
const iso = (d) => toDateInputValue(d)

const PLAN = { id: 'plan-q', name: 'Quarterly', price: 3500, durationDays: 90 }
const OLD_PLAN = { id: 'plan-old', name: 'Old Monthly', price: 3000, durationDays: 30 }
const MEMBER = {
  id: 'm1',
  name: 'Javed Ahmad',
  membershipPlanId: PLAN.id,
  joinDate: iso(addDays(today(), -60)),
  status: 'active',
}

function seedPeriod(id, plan, overrides = {}) {
  __store.membershipPlans.push(plan)
  __store.memberships.push({
    id,
    memberId: MEMBER.id,
    planId: plan.id,
    planName: plan.name,
    price: plan.price,
    startDate: overrides.startDate || iso(addDays(today(), -30)),
    expiryDate: overrides.expiryDate || iso(addDays(today(), 60)),
    amountPaid: 0,
    amountDue: plan.price,
    paymentStatus: 'due',
  })
  return __store.memberships.find((m) => m.id === id)
}

beforeEach(() => {
  __store.members = [MEMBER]
  __store.memberships = []
  __store.payments = []
  __store.membershipPlans = []
  __store.auditLog = []
})

describe('deletePayment — same source of truth as creation (TEST G / TEST H)', () => {
  it('TEST G: deleting the ₹3,500 payment reverts the period to full due — no stale "Paid in full"', async () => {
    const period = seedPeriod('ms-new', PLAN)
    expect(period.amountDue).toBe(PLAN.price)

    // Pay in full
    const created = await recordPayment({
      values: { memberId: MEMBER.id, membershipId: 'ms-new', amount: 3500, method: 'Cash', date: iso(today()) },
      memberName: MEMBER.name,
      receiptPrefix: 'HWG',
    })

    let stored = __store.memberships.find((m) => m.id === 'ms-new')
    expect(stored).toMatchObject({ amountPaid: 3500, amountDue: 0, paymentStatus: 'paid' })
    expect(__store.payments.length).toBe(1)

    // Delete that exact payment
    const paymentDoc = __store.payments.find((p) => p.id === created.id)
    await deletePayment({ payment: paymentDoc })

    // The payment is really gone from Firestore
    expect(__store.payments.find((p) => p.id === created.id)).toBeUndefined()
    expect(__store.payments.length).toBe(0)

    // The membership snapshot recalculated — cannot remain "Paid in full"
    stored = __store.memberships.find((m) => m.id === 'ms-new')
    expect(stored).toMatchObject({ amountPaid: 0, amountDue: 3500, paymentStatus: 'due' })

    // Dashboard totals agree
    const dues = computeOutstandingDues({
      members: __store.members,
      plans: __store.membershipPlans,
      payments: __store.payments,
      memberships: __store.memberships,
    })
    expect(dues.totalDue).toBe(3500)
  })

  it('TEST H: deleting the renewal payment keeps old ₹700 AND restores new ₹3,500 (total ₹4,200)', async () => {
    const oldPeriod = seedPeriod('ms-old', OLD_PLAN, {
      startDate: iso(addDays(today(), -60)),
      expiryDate: iso(addDays(today(), -30)),
    })
    // Historic partial collection on the old period
    await recordPayment({
      values: { memberId: MEMBER.id, membershipId: 'ms-old', amount: 2300, method: 'Cash', date: iso(addDays(today(), -50)) },
      memberName: MEMBER.name,
      receiptPrefix: 'HWG',
    })
    expect(oldPeriod.amountDue).toBe(700)

    // Renewal period paid in full
    seedPeriod('ms-new', PLAN)
    const renewal = await recordPayment({
      values: { memberId: MEMBER.id, membershipId: 'ms-new', amount: 3500, method: 'Card', date: iso(today()) },
      memberName: MEMBER.name,
      receiptPrefix: 'HWG',
      type: 'renewal',
    })

    let dues = computeOutstandingDues({
      members: __store.members,
      plans: __store.membershipPlans,
      payments: __store.payments,
      memberships: __store.memberships,
    })
    expect(dues.totalDue).toBe(700) // renewal did NOT absorb the old balance

    // Delete ONLY the renewal payment
    const paymentDoc = __store.payments.find((p) => p.id === renewal.id)
    await deletePayment({ payment: paymentDoc })

    expect(__store.payments.length).toBe(1) // the historic ₹2,300 survives
    expect(__store.memberships.find((m) => m.id === 'ms-old')).toMatchObject({
      amountPaid: 2300,
      amountDue: 700,
      paymentStatus: 'partial',
    })
    expect(__store.memberships.find((m) => m.id === 'ms-new')).toMatchObject({
      amountPaid: 0,
      amountDue: 3500,
      paymentStatus: 'due',
    })

    dues = computeOutstandingDues({
      members: __store.members,
      plans: __store.membershipPlans,
      payments: __store.payments,
      memberships: __store.memberships,
    })
    expect(dues.totalDue).toBe(4200)
    expect(dues.rows[0].targetMembershipId).toBe('ms-old')
  })

  it('deleting an audit entry is written for every deletion', async () => {
    seedPeriod('ms-new', PLAN)
    const created = await recordPayment({
      values: { memberId: MEMBER.id, membershipId: 'ms-new', amount: 1000, method: 'Cash', date: iso(today()) },
      memberName: MEMBER.name,
      receiptPrefix: 'HWG',
    })
    const beforeAudit = __store.auditLog.length
    await deletePayment({ payment: __store.payments.find((p) => p.id === created.id) })
    expect(__store.auditLog.length).toBe(beforeAudit + 1)
    expect(__store.auditLog.at(-1)).toMatchObject({ action: 'delete', entity: 'payments' })
  })
})

describe('refreshMembershipSnapshots — unallocated cash also updates stored figures (R3)', () => {
  it('an unallocated payment FIFO-fills the oldest open period and refreshes its snapshot', async () => {
    const period = seedPeriod('ms-open', PLAN)

    // No membershipId — e.g. a legacy/manual payment
    await recordPayment({
      values: { memberId: MEMBER.id, amount: 400, method: 'Cash', date: iso(today()) },
      memberName: MEMBER.name,
      receiptPrefix: 'HWG',
    })

    expect(period.amountPaid).toBe(400)
    expect(period.amountDue).toBe(3100)
    expect(period.paymentStatus).toBe('partial')
  })

  it('recordPayment refuses to attribute cash to another member’s period', async () => {
    __store.memberships.push({
      id: 'ms-other',
      memberId: 'someone-else',
      price: 3000,
      startDate: iso(today()),
      expiryDate: iso(addDays(today(), 30)),
    })
    const result = await recordPayment({
      values: { memberId: MEMBER.id, membershipId: 'ms-other', amount: 700, method: 'Cash', date: iso(today()) },
      memberName: 'Wrong Target',
      receiptPrefix: 'HWG',
    })
    expect(result.membership).toBeNull()
    const storedPayment = __store.payments.find((p) => p.id === result.id)
    expect(storedPayment.membershipId).toBe('')
  })
})
