import { describe, expect, it } from 'vitest'
import { getMembershipCharge } from '@/utils/pt'
import { renewMembership } from '@/services/renewals'
import { computeMemberLedger } from '@/utils/dues'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'
import { ptSurchargeSchema } from '@/schemas/validationSchemas'
import { __store } from '@/services/firestore'
import { vi, beforeEach } from 'vitest'

vi.mock('@/services/firestore', () => {
  const store = { memberships: [], payments: [], members: [], auditLog: [] }
  return {
    __store: store,
    isReady: () => true,
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
  return { id: 'plan-30', name: 'Monthly', durationDays: 30, price: 1000, active: true, ...overrides }
}

function makeMember(overrides = {}) {
  return { id: 'm1', name: 'Zaid', status: 'expired', membershipPlanId: 'plan-30', joinDate: iso(addDays(today(), -40)), ...overrides }
}

beforeEach(() => {
  __store.memberships = []
  __store.payments = []
  __store.members = []
  __store.auditLog = []
})

describe('getMembershipCharge — canonical PT pricing', () => {
  it('regular member is charged only the base plan price', () => {
    const charge = getMembershipCharge({ plan: makePlan(), isPT: false, ptSurcharge: 1000 })
    expect(charge).toEqual({ base: 1000, addon: 0, total: 1000 })
  })

  it('PT member is charged base + surcharge', () => {
    const charge = getMembershipCharge({ plan: makePlan({ price: 1000 }), isPT: true, ptSurcharge: 1000 })
    expect(charge).toEqual({ base: 1000, addon: 1000, total: 2000 })
  })

  it('PT surcharge is ignored for a regular member even when configured', () => {
    const charge = getMembershipCharge({ plan: makePlan({ price: 1000 }), isPT: false, ptSurcharge: 5000 })
    expect(charge.total).toBe(1000)
  })

  it('handles a zero surcharge for a PT member', () => {
    const charge = getMembershipCharge({ plan: makePlan({ price: 800 }), isPT: true, ptSurcharge: 0 })
    expect(charge).toEqual({ base: 800, addon: 0, total: 800 })
  })

  it('clamps invalid and negative surcharges to 0', () => {
    expect(getMembershipCharge({ plan: makePlan({ price: 1000 }), isPT: true, ptSurcharge: -500 }).total).toBe(1000)
    expect(getMembershipCharge({ plan: makePlan({ price: 1000 }), isPT: true, ptSurcharge: 'abc' }).total).toBe(1000)
    expect(getMembershipCharge({ plan: makePlan({ price: 1000 }), isPT: true, ptSurcharge: undefined }).total).toBe(1000)
  })

  it('clamps invalid plan prices to 0', () => {
    expect(getMembershipCharge({ plan: { price: 'bad' }, isPT: true, ptSurcharge: 1000 }).total).toBe(1000)
    expect(getMembershipCharge({ plan: null, isPT: true, ptSurcharge: 1000 }).total).toBe(1000)
  })
})

describe('renewMembership — PT pricing', () => {
  function seed(member) {
    __store.members.push({ ...member })
  }

  it('new regular membership charges only the plan price', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: false })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 1000,
      effectivePrice: 1000,
      isPT: false,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.price).toBe(1000)
    expect(membership.ptSurcharge).toBe(0)
    expect(membership.isPT).toBe(false)
  })

  it('new PT membership charges plan price + surcharge and snapshots why', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: true })
    seed(member)
    const result = await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.price).toBe(2000)
    expect(membership.ptSurcharge).toBe(1000)
    expect(membership.isPT).toBe(true)
    expect(membership.amountDue).toBe(0)

    const payment = __store.payments.find((p) => p.memberId === member.id)
    expect(payment.amount).toBe(2000)
    expect(payment.ptSurcharge).toBe(1000)
    expect(payment.isPT).toBe(true)
    expect(result.membership.price).toBe(2000)
  })

  it('defaults to the plan price when no effectivePrice is passed', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: true })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const membership = __store.memberships.find((m) => m.memberId === member.id)
    expect(membership.price).toBe(1000)
    expect(membership.ptSurcharge).toBe(0)
  })
})

describe('renewMembership — PT does NOT rewrite historical records', () => {
  function seed(member) {
    __store.members.push({ ...member })
  }

  it('changing the PT surcharge does not rewrite an existing payment', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: true })
    seed(member)
    // Existing PT payment at 2000 (1000 base + 1000 surcharge)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const before = JSON.parse(JSON.stringify(__store.payments[0]))

    // Later surcharge changes — historical payment must be untouched
    const oldPeriod = __store.memberships[0]
    await renewMembership({
      member: { ...member, isPT: true },
      plan,
      currentExpiry: addDays(today(), 29),
      paidAmount: 1500,
      effectivePrice: 1500,
      isPT: true,
      ptSurcharge: 500,
      method: 'Cash',
      date: iso(today()),
    })
    expect(__store.payments[0]).toEqual(before)
    expect(__store.payments.length).toBe(2)
    expect(__store.memberships[0].price).toBe(2000)
    expect(__store.memberships[1].price).toBe(1500)
    expect(oldPeriod.ptSurcharge).toBe(1000)
  })

  it('switching a member from Regular to PT does not rewrite earlier payments', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: false })
    seed(member)
    // regular period
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 1000,
      effectivePrice: 1000,
      isPT: false,
      ptSurcharge: 0,
      method: 'Cash',
      date: iso(today()),
    })
    const before = JSON.parse(JSON.stringify(__store.payments[0]))

    // now switch to PT for the next period
    await renewMembership({
      member: { ...member, isPT: true },
      plan,
      currentExpiry: addDays(today(), 29),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    expect(__store.payments[0]).toEqual(before)
    expect(__store.payments[0].amount).toBe(1000)
    expect(__store.memberships[0].price).toBe(1000)
    expect(__store.memberships[1].price).toBe(2000)
  })

  it('switching PT off does not corrupt historical payments', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: true })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const before = JSON.parse(JSON.stringify(__store.payments[0]))

    await renewMembership({
      member: { ...member, isPT: false },
      plan,
      currentExpiry: addDays(today(), 29),
      paidAmount: 1000,
      effectivePrice: 1000,
      isPT: false,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    expect(__store.payments[0]).toEqual(before)
    expect(__store.memberships[0].ptSurcharge).toBe(1000)
    expect(__store.memberships[1].price).toBe(1000)
    expect(__store.memberships[1].ptSurcharge).toBe(0)
  })

  it('the finance ledger reflects PT-inclusive period prices without rewriting snapshots', async () => {
    const plan = makePlan({ price: 1000 })
    const member = makeMember({ isPT: true })
    seed(member)
    await renewMembership({
      member,
      plan,
      currentExpiry: addDays(today(), -1),
      paidAmount: 2000,
      effectivePrice: 2000,
      isPT: true,
      ptSurcharge: 1000,
      method: 'Cash',
      date: iso(today()),
    })
    const ledger = computeMemberLedger({
      member: __store.members[0],
      plans: [plan],
      payments: __store.payments,
      memberships: __store.memberships,
    })
    // The period carries the PT-inclusive price snapshot; because it is fully
    // paid it is not an OPEN period, so billed/due are 0 but the stored period
    // price reflects the PT total.
    expect(__store.memberships[0].price).toBe(2000)
    expect(ledger.totals.due).toBe(0)
    expect(ledger.totals.paid).toBe(0)
  })
})

describe('ptSurchargeSchema validation', () => {
  it('accepts a normal non-negative value', () => {
    expect(ptSurchargeSchema.safeParse('1000').success).toBe(true)
    expect(ptSurchargeSchema.safeParse(1000).success).toBe(true)
  })

  it('accepts zero', () => {
    expect(ptSurchargeSchema.safeParse(0).success).toBe(true)
  })

  it('rejects a negative surcharge', () => {
    expect(ptSurchargeSchema.safeParse('-10').success).toBe(false)
  })

  it('rejects non-numeric input', () => {
    expect(ptSurchargeSchema.safeParse('abc').success).toBe(false)
  })

  it('rejects an excessively large value', () => {
    expect(ptSurchargeSchema.safeParse(100000001).success).toBe(false)
  })
})
