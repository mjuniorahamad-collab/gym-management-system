import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getMembershipCharge, getEffectivePtSurcharge } from '@/utils/pt'
import { computeMemberLedger, computeOutstandingDues } from '@/utils/dues'
import { applyPTInclusivePriceToPeriod } from '@/services/memberships'
import { __store } from '@/services/firestore'

vi.mock('@/services/firestore', () => {
  const store = { memberships: [], payments: [], members: [], membershipPlans: [], auditLog: [] }
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

beforeEach(() => {
  __store.memberships = []
  __store.payments = []
  __store.members = []
  __store.membershipPlans = []
  __store.auditLog = []
})

const monthly = (overrides = {}) => ({ id: 'plan-30', name: 'Monthly', durationDays: 30, price: 1500, active: true, ...overrides })

describe('getEffectivePtSurcharge', () => {
  it('uses the per-member override when set', () => {
    expect(getEffectivePtSurcharge({ ptSurcharge: 1000, ptSurchargeOverride: 400 })).toBe(400)
  })

  it('honors an explicit zero override (free PT)', () => {
    expect(getEffectivePtSurcharge({ ptSurcharge: 1000, ptSurchargeOverride: 0 })).toBe(0)
  })

  it('falls back to the gym default when the override is unset/blank', () => {
    expect(getEffectivePtSurcharge({ ptSurcharge: 1000, ptSurchargeOverride: undefined })).toBe(1000)
    expect(getEffectivePtSurcharge({ ptSurcharge: 1000, ptSurchargeOverride: null })).toBe(1000)
    expect(getEffectivePtSurcharge({ ptSurcharge: 1000, ptSurchargeOverride: '' })).toBe(1000)
  })

  it('defaults to no surcharge when neither is set', () => {
    expect(getEffectivePtSurcharge({ ptSurcharge: 0 })).toBe(0)
    expect(getEffectivePtSurcharge({})).toBe(0)
  })
})

describe('getMembershipCharge — canonical PT pricing', () => {
  it('non-PT member charges the bare plan price', () => {
    expect(getMembershipCharge({ plan: monthly(), isPT: false, ptSurcharge: 1000 }).total).toBe(1500)
  })

  it('PT member charges plan + gym default surcharge', () => {
    expect(getMembershipCharge({ plan: monthly(), isPT: true, ptSurcharge: 1000 }).total).toBe(2500)
  })

  it('PT member with a custom override charges plan + override', () => {
    expect(
      getMembershipCharge({ plan: monthly(), isPT: true, ptSurcharge: 1000, ptSurchargeOverride: 400 }).total
    ).toBe(1900)
  })

  it('PT member with an explicit zero override is free of surcharge', () => {
    expect(
      getMembershipCharge({ plan: monthly(), isPT: true, ptSurcharge: 1000, ptSurchargeOverride: 0 }).total
    ).toBe(1500)
  })
})

describe('computeMemberLedger — origin-period pricing', () => {
  it('an undocumented PT member reconstructs at the PT-inclusive price', () => {
    const plan = monthly()
    const member = { id: 'm1', name: 'Priya', membershipPlanId: plan.id, joinDate: '2026-01-01', isPT: true }
    const ledger = computeMemberLedger({ member, plans: [plan], payments: [], memberships: [], ptSurcharge: 1000 })
    expect(ledger.periods).toHaveLength(1)
    expect(ledger.periods[0].price).toBe(2500)
    expect(ledger.periods[0].implicit).toBe(true)
    expect(ledger.totals.due).toBe(2500)
  })

  it('a member with a surcharge override reconstructs at plan + override', () => {
    const plan = monthly()
    const member = {
      id: 'm1',
      name: 'Priya',
      membershipPlanId: plan.id,
      joinDate: '2026-01-01',
      isPT: true,
      ptSurchargeOverride: 400,
    }
    const ledger = computeMemberLedger({ member, plans: [plan], payments: [], memberships: [], ptSurcharge: 1000 })
    expect(ledger.periods[0].price).toBe(1900)
  })

  it('a non-PT member reconstructs at the bare plan price', () => {
    const plan = monthly()
    const member = { id: 'm1', name: 'Sam', membershipPlanId: plan.id, joinDate: '2026-01-01', isPT: false }
    const ledger = computeMemberLedger({ member, plans: [plan], payments: [], memberships: [], ptSurcharge: 1000 })
    expect(ledger.periods[0].price).toBe(1500)
  })

  it('an explicit zero override keeps PT free (no surcharge)', () => {
    const plan = monthly()
    const member = {
      id: 'm1',
      name: 'Priya',
      membershipPlanId: plan.id,
      joinDate: '2026-01-01',
      isPT: true,
      ptSurchargeOverride: 0,
    }
    const ledger = computeMemberLedger({ member, plans: [plan], payments: [], memberships: [], ptSurcharge: 1000 })
    expect(ledger.periods[0].price).toBe(1500)
  })
})

describe('computeOutstandingDues — PT-aware rows without explicit override plumbing', () => {
  it('picks up each member override automatically for a PT member', () => {
    const plan = monthly()
    const members = [
      { id: 'a', name: 'Alpha', membershipPlanId: plan.id, joinDate: '2026-01-01', isPT: true, ptSurchargeOverride: 400 },
      { id: 'b', name: 'Beta', membershipPlanId: plan.id, joinDate: '2026-01-01', isPT: false },
    ]
    const res = computeOutstandingDues({ members, plans: [plan], payments: [], memberships: [], ptSurcharge: 1000 })
    const byName = Object.fromEntries(res.rows.map((r) => [r.member.name, r.dueAmount]))
    expect(byName.Alpha).toBe(1900)
    expect(byName.Beta).toBe(1500)
  })
})

describe('applyPTInclusivePriceToPeriod', () => {
  it('re-prices ONLY the targeted open period and leaves others and payments untouched', async () => {
    const plan = monthly()
    const member = { id: 'm1', name: 'Priya', membershipPlanId: plan.id, isPT: false }
    const p1 = { id: 'per-old', memberId: 'm1', planId: plan.id, planName: 'Monthly', price: 1500, startDate: '2025-12-01', expiryDate: '2025-12-31' }
    const p2 = { id: 'per-cur', memberId: 'm1', planId: plan.id, planName: 'Monthly', price: 1500, startDate: '2026-01-01', expiryDate: '2026-01-31' }
    const pay = { id: 'pay-1', memberId: 'm1', membershipId: 'per-cur', amount: 500 }
    __store.membershipPlans.push(plan)
    __store.memberships.push(p1, p2)
    __store.payments.push(pay)
    __store.members.push(member)

    await applyPTInclusivePriceToPeriod({
      periodId: 'per-cur',
      memberId: 'm1',
      isPT: true,
      ptSurcharge: 1000,
    })

    const current = __store.memberships.find((m) => m.id === 'per-cur')
    const old = __store.memberships.find((m) => m.id === 'per-old')
    expect(current.price).toBe(2500)
    expect(current.basePrice).toBe(1500)
    expect(current.ptSurcharge).toBe(1000)
    expect(current.isPT).toBe(true)
    expect(old.price).toBe(1500)
    expect(pay.amount).toBe(500)
  })
})
