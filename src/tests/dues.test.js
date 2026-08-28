import { describe, expect, it } from 'vitest'
import { computeOutstandingDues } from '@/utils/dues'

const PLANS = [
  { id: 'p1', name: 'Monthly', price: 3000 },
  { id: 'p2', name: '3 Months', price: 8000 },
  { id: 'p3', name: 'Annual', price: 24000 },
]

describe('computeOutstandingDues', () => {
  it('computes total due, count and per-member figures from payment data', () => {
    const members = [
      { id: 'A', name: 'Alice', membershipPlanId: 'p1' },
      { id: 'C', name: 'Cara', membershipPlanId: 'p3' },
    ]
    const payments = [{ memberId: 'A', amount: 2000 }]

    const result = computeOutstandingDues({ members, plans: PLANS, payments })

    expect(result.count).toBe(2)
    expect(result.totalDue).toBe(25000)

    const byId = Object.fromEntries(result.rows.map((r) => [r.member.id, r]))
    expect(byId.A).toMatchObject({ planAmount: 3000, totalPaid: 2000, dueAmount: 1000 })
    expect(byId.A.plan).toMatchObject({ name: 'Monthly' })
    expect(byId.C).toMatchObject({ planAmount: 24000, totalPaid: 0, dueAmount: 24000 })
  })

  it('excludes members with zero (or fully paid) due', () => {
    const members = [
      { id: 'A', name: 'Alice', membershipPlanId: 'p1' },
      { id: 'B', name: 'Bob', membershipPlanId: 'p2' },
      { id: 'E', name: 'Eve', membershipPlanId: 'p1' },
    ]
    const payments = [
      { memberId: 'A', amount: 3000 },
      { memberId: 'B', amount: 8000 },
      { memberId: 'E', amount: 5000 },
    ]

    const result = computeOutstandingDues({ members, plans: PLANS, payments })

    expect(result.count).toBe(0)
    expect(result.totalDue).toBe(0)
    expect(result.rows).toEqual([])
  })

  it('excludes members without a current plan', () => {
    const members = [{ id: 'D', name: 'Dave', membershipPlanId: '' }]
    const result = computeOutstandingDues({ members, plans: PLANS, payments: [] })
    expect(result.count).toBe(0)
    expect(result.rows).toEqual([])
  })

  it('sorts by due amount descending, then member name', () => {
    const members = [
      { id: 'C', name: 'Cara', membershipPlanId: 'p3' },
      { id: 'A', name: 'Alice', membershipPlanId: 'p1' },
    ]
    const result = computeOutstandingDues({ members, plans: PLANS, payments: [] })
    expect(result.rows.map((r) => r.member.id)).toEqual(['C', 'A'])
  })

  it('ties break by name ascending', () => {
    const members = [
      { id: 'z', name: 'Zed', membershipPlanId: 'p1' },
      { id: 'a', name: 'Ann', membershipPlanId: 'p1' },
    ]
    const result = computeOutstandingDues({ members, plans: PLANS, payments: [] })
    expect(result.rows.map((r) => r.member.id)).toEqual(['a', 'z'])
  })

  it('handles empty inputs', () => {
    expect(computeOutstandingDues()).toEqual({ rows: [], totalDue: 0, count: 0 })
    expect(computeOutstandingDues({ members: [], plans: [], payments: [] })).toEqual({
      rows: [],
      totalDue: 0,
      count: 0,
    })
  })
})

describe('computeOutstandingDues with membership periods (payment allocation)', () => {
  const QUARTERLY = { id: 'pq', name: 'Quarterly', price: 3500 }
  const PLANS = [
    { id: 'p1', name: 'Monthly', price: 3000 },
    QUARTERLY,
  ]

  const javedScenario = () => ({
    members: [{ id: 'javed', name: 'Javed Ahmad', membershipPlanId: 'pq' }],
    plans: PLANS,
    payments: [
      // Previous period: paid 2,300 of its 3,000 price → ₹700 due
      { memberId: 'javed', amount: 2300, membershipId: 'ms-old' },
      // New Quarterly period paid in full at renewal
      { memberId: 'javed', amount: 3500, membershipId: 'ms-new' },
    ],
    memberships: [
      { id: 'ms-new', memberId: 'javed', planId: 'pq', startDate: '2026-08-01', price: 3500 },
      { id: 'ms-old', memberId: 'javed', planId: 'p1', startDate: '2026-05-01', price: 3000 },
    ],
  })

  it('regression: a fully-paid renewal does NOT absorb the previous ₹700 balance', () => {
    const result = computeOutstandingDues(javedScenario())

    expect(result.count).toBe(1)
    expect(result.totalDue).toBe(700)

    const row = result.rows.find((r) => r.member.id === 'javed')
    expect(row).toBeDefined()
    expect(row.dueAmount).toBe(700)
    expect(row.planAmount).toBe(3000)
    expect(row.totalPaid).toBe(2300)
    // Payment target is the oldest open period, never the renewed one
    expect(row.targetMembershipId).toBe('ms-old')
  })

  it('paying the old ₹700 later clears only that period', () => {
    const data = javedScenario()
    data.payments.push({ memberId: 'javed', amount: 700, membershipId: 'ms-old' })

    const result = computeOutstandingDues(data)
    expect(result.count).toBe(0)
    expect(result.totalDue).toBe(0)
    expect(result.rows).toEqual([])
  })

  it('partial settlement of the old balance reduces only that period', () => {
    const data = javedScenario()
    data.payments.push({ memberId: 'javed', amount: 200, membershipId: 'ms-old' })

    const row = computeOutstandingDues(data).rows[0]
    expect(row.dueAmount).toBe(500)
  })

  it('unallocated legacy payments fill the oldest period up to its price first (FIFO)', () => {
    const result = computeOutstandingDues({
      members: [{ id: 'm1', name: 'Legacy', membershipPlanId: 'pq' }],
      plans: PLANS,
      payments: [
        { memberId: 'm1', amount: 2300 }, // no membershipId → unallocated
        { memberId: 'm1', amount: 3500, membershipId: 'ms-new' },
      ],
      memberships: [
        { id: 'ms-new', memberId: 'm1', startDate: '2026-08-01', price: 3500 },
        { id: 'ms-old', memberId: 'm1', startDate: '2026-05-01', price: 3000 },
      ],
    })

    const row = result.rows[0]
    expect(row.dueAmount).toBe(700) // 3000 − 2300, not spread across periods
    expect(row.targetMembershipId).toBe('ms-old')
  })

  it('unallocated surplus beyond a settled period carries to the next one', () => {
    const result = computeOutstandingDues({
      members: [{ id: 'm1', name: 'Carry', membershipPlanId: 'pq' }],
      plans: PLANS,
      payments: [
        { memberId: 'm1', amount: 4000 }, // 3,000 covers ms-old, 1,000 spills to ms-new
        { memberId: 'm1', amount: 1000, membershipId: 'ms-new' },
      ],
      memberships: [
        { id: 'ms-new', memberId: 'm1', startDate: '2026-08-01', price: 3500 },
        { id: 'ms-old', memberId: 'm1', startDate: '2026-05-01', price: 3000 },
      ],
    })

    const row = result.rows[0]
    // ms-new: 3500 − (1000 spill + 1000 linked) = 1500 still due
    expect(row.dueAmount).toBe(1500)
    expect(row.planAmount).toBe(3500)
    expect(row.totalPaid).toBe(2000)
  })

  it('members whose periods are all settled are excluded even with surplus cash', () => {
    const result = computeOutstandingDues({
      members: [{ id: 'm1', name: 'Settled', membershipPlanId: 'pq' }],
      plans: PLANS,
      payments: [
        { memberId: 'm1', amount: 3000, membershipId: 'ms-old' },
        { memberId: 'm1', amount: 3500, membershipId: 'ms-new' },
        { memberId: 'm1', amount: 999 }, // stray overpayment
      ],
      memberships: [
        { id: 'ms-new', memberId: 'm1', startDate: '2026-08-01', price: 3500 },
        { id: 'ms-old', memberId: 'm1', startDate: '2026-05-01', price: 3000 },
      ],
    })

    expect(result.count).toBe(0)
    expect(result.rows).toEqual([])
  })

  it('members without any membership records keep the legacy calculation', () => {
    const result = computeOutstandingDues({
      members: [{ id: 'A', name: 'Alice', membershipPlanId: 'p1' }],
      plans: PLANS,
      payments: [{ memberId: 'A', amount: 2000 }],
      memberships: [],
    })

    expect(result.count).toBe(1)
    expect(result.rows[0]).toMatchObject({ planAmount: 3000, totalPaid: 2000, dueAmount: 1000 })
  })

  it('ignores membership records belonging to other members', () => {
    const result = computeOutstandingDues({
      members: [{ id: 'm1', name: 'Solo', membershipPlanId: 'p1' }],
      plans: PLANS,
      payments: [{ memberId: 'other', amount: 100, membershipId: 'ms-x' }],
      memberships: [{ id: 'ms-x', memberId: 'other', startDate: '2026-05-01', price: 3000 }],
    })

    // m1 has no periods of their own → legacy path, nothing paid → full due
    expect(result.count).toBe(1)
    expect(result.rows[0].dueAmount).toBe(3000)
  })
})
