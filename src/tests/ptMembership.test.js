import { describe, expect, it, vi, beforeEach } from 'vitest'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'
import { renewMembership } from '@/services/renewals'
import { __store } from '@/services/firestore'

vi.mock('@/services/firestore', () => {
  const store = { memberships: [], payments: [], members: [], auditLog: [] }
  return {
    __store: store,
    isReady: () => false,
    // These suites drive the mock store, so no real Firestore and no
    // tenancy: renewMembership must take its sequential demo path.
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

const monthly = (overrides = {}) => ({ id: 'plan-30', name: 'Monthly', durationDays: 30, price: 1000, active: true, ...overrides })

function seed(member) {
  __store.members.push({ ...member })
}

beforeEach(() => {
  __store.memberships = []
  __store.payments = []
  __store.members = []
  __store.auditLog = []
})

describe('PT membership — date integrity', () => {
  it('a regular renewal keeps the effective start and expiry unchanged by PT logic', async () => {
    const plan = monthly()
    const member = { id: 'm1', name: 'Zaid', status: 'active', membershipPlanId: plan.id, joinDate: iso(addDays(today(), -10)), isPT: false }
    seed(member)
    const currentExpiry = addDays(today(), 20)
    await renewMembership({
      member,
      plan,
      currentExpiry,
      paidAmount: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.startDate).toBe(iso(addDays(currentExpiry, 1)))
    expect(membership.expiryDate).toBe(iso(addDays(addDays(currentExpiry, 1), 30)))
  })

  it('a backdated renewal with PT keeps the previous-expiry start and derived expiry', async () => {
    const plan = monthly()
    const member = { id: 'm1', name: 'Zaid', status: 'expired', membershipPlanId: plan.id, joinDate: iso(addDays(today(), -40)), isPT: true }
    seed(member)
    const prevExpiry = addDays(today(), -7)
    const paidOn = addDays(today(), -4)
    await renewMembership({
      member,
      plan,
      currentExpiry: prevExpiry,
      effectiveStartDate: iso(prevExpiry),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(paidOn),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    const payment = __store.payments.find((p) => p.memberId === member.id)
    // membership backdates to previous expiry
    expect(membership.startDate).toBe(iso(prevExpiry))
    expect(membership.expiryDate).toBe(iso(addDays(prevExpiry, 30)))
    // payment received date is separate and untouched
    expect(payment.date).toBe(iso(paidOn))
    expect(payment.date).not.toBe(iso(prevExpiry))
    // PT-inclusive price snapshot
    expect(membership.price).toBe(2000)
    expect(membership.amountDue).toBe(0)
    expect(membership.paymentStatus).toBe('paid')
  })

  it('a backdated PT renewal with a partial payment leaves the correct due on the backdated period', async () => {
    const plan = monthly()
    const member = { id: 'm1', name: 'Zaid', status: 'expired', membershipPlanId: plan.id, joinDate: iso(addDays(today(), -40)), isPT: true }
    seed(member)
    const prevExpiry = addDays(today(), -7)
    const paidOn = addDays(today(), -4)
    await renewMembership({
      member,
      plan,
      currentExpiry: prevExpiry,
      effectiveStartDate: iso(prevExpiry),
      paidAmount: 1200,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(paidOn),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    const payment = __store.payments.find((p) => p.memberId === member.id)
    expect(membership.amountPaid).toBe(1200)
    expect(membership.amountDue).toBe(800)
    expect(membership.paymentStatus).toBe('partial')
    expect(payment.date).toBe(iso(paidOn))
    expect(membership.startDate).toBe(iso(prevExpiry))
  })
})

describe('PT membership — per-gym configurability', () => {
  it('different effective prices charge different totals for the same plan', async () => {
    const plan = monthly()
    const a = { id: 'gymA', name: 'A', status: 'expired', membershipPlanId: plan.id, isPT: true }
    const b = { id: 'gymB', name: 'B', status: 'expired', membershipPlanId: plan.id, isPT: true }
    // seed separately so ids differ
    __store.members.push({ ...a })
    await renewMembership({
      member: a,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    __store.members.push({ ...b })
    await renewMembership({
      member: b,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 1500,
      effectivePrice: 1500,
      isPT: true,
      ptSurcharge: 500,
      method: 'Cash',
      date: iso(today()),
    })
    expect(__store.memberships.find((m) => m.memberId === 'gymA').price).toBe(2000)
    expect(__store.memberships.find((m) => m.memberId === 'gymB').price).toBe(1500)
  })
})
