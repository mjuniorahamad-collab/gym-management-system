import { describe, beforeEach, expect, it, vi } from 'vitest'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'
import { findOverlappingPeriods } from '@/utils/memberships'
import { membershipPeriodSchema } from '@/schemas/validationSchemas'
import { editMembershipPeriod, deleteMembershipPeriod } from '@/services/memberships'
import { __store } from '@/services/firestore'

vi.mock('@/services/firestore', () => {
  const store = { memberships: [], payments: [], members: [], auditLog: [] }
  return {
    __store: store,
    isReady: () => true,
    listAll: async (name) => store[name],
    getById: async (name, id) => store[name].find((d) => d.id === id) || null,
    createDoc: async (name, data) => {
      const id = `mock-${name}-${store[name].length + 1}`
      const doc = { id, ...data }
      store[name].push(doc)
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
const daysAgo = (n) => iso(addDays(today(), -n))
const daysAhead = (n) => iso(addDays(today(), n))

function makeMembership(id, overrides = {}) {
  return {
    id,
    memberId: 'm1',
    planId: 'plan-annual',
    planName: 'Annual',
    price: 12000,
    startDate: daysAgo(365),
    expiryDate: daysAgo(0),
    ...overrides,
  }
}

function makePayment(id, membershipId, amount, overrides = {}) {
  return {
    id,
    memberId: 'm1',
    membershipId,
    amount,
    date: daysAgo(30),
    method: 'Cash',
    type: 'membership',
    ...overrides,
  }
}

beforeEach(() => {
  __store.memberships = []
  __store.payments = []
  __store.members = []
  __store.auditLog = []
})

describe('findOverlappingPeriods', () => {
  const memberships = [
    makeMembership('ms-1', { startDate: daysAgo(365), expiryDate: daysAgo(300) }),
    makeMembership('ms-2', { startDate: daysAgo(1), expiryDate: daysAhead(364) }),
  ]

  it('returns empty for non-overlapping window', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAhead(365), expiryDate: daysAhead(730) },
      memberships
    )
    expect(result).toHaveLength(0)
  })

  it('detects exact overlap', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(365), expiryDate: daysAgo(300) },
      memberships
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ms-1')
  })

  it('detects partial overlap (start within existing)', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(330), expiryDate: daysAgo(270) },
      memberships
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ms-1')
  })

  it('detects partial overlap (end within existing)', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(380), expiryDate: daysAgo(330) },
      memberships
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ms-1')
  })

  it('detects containment (new window contains existing)', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(400), expiryDate: daysAhead(400) },
      memberships
    )
    expect(result).toHaveLength(2)
  })

  it('excludes the period being edited via excludeId', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(365), expiryDate: daysAgo(300), excludeId: 'ms-1' },
      memberships
    )
    expect(result).toHaveLength(0)
  })

  it('filters by memberId', () => {
    const other = makeMembership('ms-other', { memberId: 'm2', startDate: daysAgo(365), expiryDate: daysAgo(300) })
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(365), expiryDate: daysAgo(300) },
      [...memberships, other]
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ms-1')
  })

  it('returns empty for invalid dates', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: 'not-a-date', expiryDate: daysAgo(0) },
      memberships
    )
    expect(result).toHaveLength(0)
  })

  it('returns empty for empty memberships array', () => {
    const result = findOverlappingPeriods(
      { memberId: 'm1', startDate: daysAgo(100), expiryDate: daysAgo(0) },
      []
    )
    expect(result).toHaveLength(0)
  })
})

describe('membershipPeriodSchema', () => {
  it('accepts valid period data', () => {
    const result = membershipPeriodSchema.safeParse({
      planId: 'plan-1',
      price: 5000,
      startDate: daysAgo(30),
      expiryDate: daysAgo(0),
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing planId', () => {
    const result = membershipPeriodSchema.safeParse({
      planId: '',
      price: 5000,
      startDate: daysAgo(30),
      expiryDate: daysAgo(0),
    })
    expect(result.success).toBe(false)
  })

  it('rejects expiry before start', () => {
    const result = membershipPeriodSchema.safeParse({
      planId: 'plan-1',
      price: 5000,
      startDate: daysAgo(0),
      expiryDate: daysAgo(30),
    })
    expect(result.success).toBe(false)
  })

  it('allows zero price', () => {
    const result = membershipPeriodSchema.safeParse({
      planId: 'plan-1',
      price: 0,
      startDate: daysAgo(30),
      expiryDate: daysAgo(0),
    })
    expect(result.success).toBe(true)
  })

  it('rejects negative price', () => {
    const result = membershipPeriodSchema.safeParse({
      planId: 'plan-1',
      price: -100,
      startDate: daysAgo(30),
      expiryDate: daysAgo(0),
    })
    expect(result.success).toBe(false)
  })
})

describe('editMembershipPeriod', () => {
  beforeEach(() => {
    __store.memberships = [
      makeMembership('ms-1'),
      makeMembership('ms-2', { startDate: daysAgo(0), expiryDate: daysAhead(365), price: 15000 }),
    ]
    __store.payments = [
      makePayment('pay-1', 'ms-1', 12000),
      makePayment('pay-2', 'ms-2', 5000),
    ]
    __store.members = [{ id: 'm1', name: 'Test', membershipPlanId: 'plan-annual', joinDate: daysAgo(365), status: 'active' }]
  })

  it('updates allowed fields on the membership document', async () => {
    const result = await editMembershipPeriod({
      periodId: 'ms-1',
      memberId: 'm1',
      patch: { price: 14000, startDate: daysAgo(400), expiryDate: daysAgo(35) },
    })

    expect(result.id).toBe('ms-1')
    expect(result.price).toBe(14000)

    const doc = __store.memberships.find((m) => m.id === 'ms-1')
    expect(doc.price).toBe(14000)
    expect(doc.startDate).toBe(daysAgo(400))
  })

  it('strips disallowed fields from patch', async () => {
    await editMembershipPeriod({
      periodId: 'ms-1',
      memberId: 'm1',
      patch: { id: 'hacked', memberId: 'other', price: 9999 },
    })

    const doc = __store.memberships.find((m) => m.id === 'ms-1')
    expect(doc.id).toBe('ms-1')
    expect(doc.memberId).toBe('m1')
    expect(doc.price).toBe(9999)
  })

  it('throws on missing periodId', async () => {
    await expect(
      editMembershipPeriod({ periodId: '', memberId: 'm1', patch: { price: 100 } })
    ).rejects.toThrow('A period ID is required')
  })

  it('throws on empty patch', async () => {
    await expect(
      editMembershipPeriod({ periodId: 'ms-1', memberId: 'm1', patch: {} })
    ).rejects.toThrow('No valid fields to update')
  })

  it('creates an audit log entry', async () => {
    await editMembershipPeriod({
      periodId: 'ms-1',
      memberId: 'm1',
      patch: { price: 14000 },
    })

    const auditEntry = __store.auditLog.find(
      (e) => e.entity === 'memberships' && e.entityId === 'ms-1'
    )
    expect(auditEntry).toBeDefined()
    expect(auditEntry.action).toBe('update')
    expect(auditEntry.details.price).toBe(14000)
  })
})

describe('deleteMembershipPeriod', () => {
  beforeEach(() => {
    __store.memberships = [
      makeMembership('ms-1'),
      makeMembership('ms-2', { startDate: daysAgo(0), expiryDate: daysAhead(365), price: 15000 }),
    ]
    __store.payments = [
      makePayment('pay-1', 'ms-1', 12000),
      makePayment('pay-2', 'ms-2', 5000),
      makePayment('pay-3', '', 2000),
    ]
    __store.members = [{ id: 'm1', name: 'Test', membershipPlanId: 'plan-annual', joinDate: daysAgo(365), status: 'active' }]
  })

  it('removes the membership document', async () => {
    await deleteMembershipPeriod({ periodId: 'ms-1', memberId: 'm1' })

    expect(__store.memberships.find((m) => m.id === 'ms-1')).toBeUndefined()
  })

  it('clears membershipId on linked payments', async () => {
    await deleteMembershipPeriod({ periodId: 'ms-1', memberId: 'm1' })

    const pay1 = __store.payments.find((p) => p.id === 'pay-1')
    expect(pay1.membershipId).toBe('')
  })

  it('does not touch unlinked payments', async () => {
    await deleteMembershipPeriod({ periodId: 'ms-1', memberId: 'm1' })

    const pay3 = __store.payments.find((p) => p.id === 'pay-3')
    expect(pay3.membershipId).toBe('')
  })

  it('does not touch payments linked to other periods', async () => {
    await deleteMembershipPeriod({ periodId: 'ms-1', memberId: 'm1' })

    const pay2 = __store.payments.find((p) => p.id === 'pay-2')
    expect(pay2.membershipId).toBe('ms-2')
  })

  it('returns affected payments list', async () => {
    const result = await deleteMembershipPeriod({ periodId: 'ms-1', memberId: 'm1' })

    expect(result.affectedPayments).toHaveLength(1)
    expect(result.affectedPayments[0].id).toBe('pay-1')
  })

  it('creates an audit log entry', async () => {
    await deleteMembershipPeriod({ periodId: 'ms-1', memberId: 'm1' })

    const auditEntry = __store.auditLog.find(
      (e) => e.entity === 'memberships' && e.entityId === 'ms-1'
    )
    expect(auditEntry).toBeDefined()
    expect(auditEntry.action).toBe('delete')
    expect(auditEntry.details.affectedPayments).toHaveLength(1)
  })

  it('throws on missing periodId', async () => {
    await expect(
      deleteMembershipPeriod({ periodId: '', memberId: 'm1' })
    ).rejects.toThrow('A period ID is required')
  })
})
