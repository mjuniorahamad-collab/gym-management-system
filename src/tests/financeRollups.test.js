import { describe, expect, it } from 'vitest'
import {
  computeMemberFinanceRollups,
  computeMemberLedger,
  computeOutstandingDues,
} from '@/utils/dues'
import { countPendingOriginPeriods } from '@/services/migration'

const PLANS = [{ id: 'p1', name: 'Monthly', price: 1000, durationDays: 30 }]

const member = (over = {}) => ({
  id: 'm1',
  name: 'Javed',
  joinDate: '2026-01-01',
  membershipPlanId: 'p1',
  isPT: false,
  ...over,
})

// The ORIGINAL implementations, kept verbatim here so the refactor can be
// proven equivalent rather than assumed equivalent.
function originalComputeOutstandingDues({ members = [], plans = [], payments = [], memberships = [], ptSurcharge = 0 }) {
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p]))
  const rows = []
  for (const m of members) {
    const plan = planMap[m?.membershipPlanId]
    if (!plan) continue
    const ledger = computeMemberLedger({ member: m, plans, payments, memberships, ptSurcharge })
    if (ledger.totals.due <= 0) continue
    rows.push({
      member: m,
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
  const totalDue = rows.reduce((s, r) => s + r.dueAmount, 0)
  return { rows, totalDue, count: rows.length }
}

function originalPendingOriginCount({ members = [], plans = [], payments = [], memberships = [], ptSurcharge = 0 }) {
  let count = 0
  for (const m of members) {
    const ledger = computeMemberLedger({ member: m, plans, payments, memberships, ptSurcharge })
    if (ledger.periods.some((p) => p.implicit)) count += 1
  }
  return count
}

// Representative scenarios the refactor must not disturb.
const SCENARIOS = [
  {
    name: 'zero balance (fully paid)',
    args: { members: [member()], plans: PLANS, payments: [{ id: 'pay1', memberId: 'm1', amount: 1000, date: '2026-01-02' }] },
  },
  {
    name: 'nothing paid / fully overdue',
    args: { members: [member()], plans: PLANS, payments: [] },
  },
  {
    name: 'partial payment',
    args: { members: [member()], plans: PLANS, payments: [{ id: 'pay1', memberId: 'm1', amount: 400, date: '2026-01-02' }] },
  },
  {
    name: 'multiple payments',
    args: {
      members: [member()],
      plans: PLANS,
      payments: [
        { id: 'pay1', memberId: 'm1', amount: 300, date: '2026-01-02' },
        { id: 'pay2', memberId: 'm1', amount: 300, date: '2026-01-05' },
        { id: 'pay3', memberId: 'm1', amount: 900, date: '2026-02-05' },
      ],
    },
  },
  {
    name: 'overpayment',
    args: { members: [member()], plans: PLANS, payments: [{ id: 'pay1', memberId: 'm1', amount: 5000, date: '2026-01-02' }] },
  },
  {
    name: 'recorded periods, targeted payment',
    args: {
      members: [member()],
      plans: PLANS,
      memberships: [
        { id: 'ms1', memberId: 'm1', planId: 'p1', startDate: '2026-01-01', expiryDate: '2026-01-31', price: 1000 },
        { id: 'ms2', memberId: 'm1', planId: 'p1', startDate: '2026-02-01', expiryDate: '2026-03-02', price: 1000 },
      ],
      payments: [{ id: 'pay1', memberId: 'm1', membershipId: 'ms1', amount: 1000, date: '2026-01-02' }],
    },
  },
  {
    name: 'unallocated FIFO spill across two periods',
    args: {
      members: [member()],
      plans: PLANS,
      memberships: [
        { id: 'ms1', memberId: 'm1', planId: 'p1', startDate: '2026-01-01', expiryDate: '2026-01-31', price: 1000 },
        { id: 'ms2', memberId: 'm1', planId: 'p1', startDate: '2026-02-01', expiryDate: '2026-03-02', price: 1000 },
      ],
      payments: [{ id: 'pay1', memberId: 'm1', membershipId: '', amount: 1500, date: '2026-01-05' }],
    },
  },
  {
    name: 'PT member with surcharge',
    args: {
      members: [member({ isPT: true })],
      plans: PLANS,
      payments: [{ id: 'pay1', memberId: 'm1', amount: 500, date: '2026-01-02' }],
      ptSurcharge: 300,
    },
  },
  {
    name: 'PT member with own override',
    args: {
      members: [member({ isPT: true, ptSurchargeOverride: 250 })],
      plans: PLANS,
      payments: [],
      ptSurcharge: 300,
    },
  },
  {
    name: 'payment predating records -> implicit origin period',
    args: {
      members: [member()],
      plans: PLANS,
      memberships: [
        { id: 'ms1', memberId: 'm1', planId: 'p1', startDate: '2026-03-01', expiryDate: '2026-03-31', price: 1000 },
      ],
      payments: [{ id: 'pay1', memberId: 'm1', amount: 500, date: '2026-01-05' }],
    },
  },
  {
    name: 'member with NO plan assigned (planless)',
    args: {
      members: [member({ membershipPlanId: 'missing-plan' })],
      plans: PLANS,
      payments: [{ id: 'pay1', memberId: 'm1', amount: 500, date: '2026-01-02' }],
    },
  },
  {
    name: 'mixed gym: paid, unpaid, planless, implicit-origin',
    args: {
      members: [
        member({ id: 'a', name: 'Asha' }),
        member({ id: 'b', name: 'Bilal' }),
        member({ id: 'c', name: 'Cyrus', membershipPlanId: 'missing-plan' }),
        member({ id: 'd', name: 'Deepa' }),
      ],
      plans: PLANS,
      memberships: [
        { id: 'ms-d', memberId: 'd', planId: 'p1', startDate: '2026-03-01', expiryDate: '2026-03-31', price: 1000 },
      ],
      payments: [
        { id: 'pay1', memberId: 'a', amount: 1000, date: '2026-01-02' },
        { id: 'pay2', memberId: 'b', amount: 250, date: '2026-01-02' },
        { id: 'pay3', memberId: 'c', amount: 400, date: '2026-01-02' },
        { id: 'pay4', memberId: 'd', amount: 300, date: '2026-01-02' },
      ],
    },
  },
  {
    name: 'member with a falsy id (malformed record)',
    args: { members: [{ name: 'Broken', membershipPlanId: 'p1' }], plans: PLANS, payments: [] },
  },
]

describe('computeMemberFinanceRollups is equivalent to the two previous passes', () => {
  for (const { name, args } of SCENARIOS) {
    it(`matches both original computations: ${name}`, () => {
      const rollup = computeMemberFinanceRollups(args)

      expect(rollup.dues).toEqual(originalComputeOutstandingDues(args))
      expect(rollup.pendingOriginPeriods).toBe(originalPendingOriginCount(args))
    })
  }

  it('keeps computeOutstandingDues as an exact wrapper of the rollup', () => {
    for (const { args } of SCENARIOS) {
      expect(computeOutstandingDues(args)).toEqual(computeMemberFinanceRollups(args).dues)
    }
  })

  it('returns the documented empty shape with no arguments', () => {
    expect(computeMemberFinanceRollups()).toEqual({
      dues: { rows: [], totalDue: 0, count: 0 },
      pendingOriginPeriods: 0,
    })
    expect(computeOutstandingDues()).toEqual({ rows: [], totalDue: 0, count: 0 })
  })

  // A planless member reaches neither figure: computeMemberLedger returns no
  // periods for a member with no plan and no records, and only reconstructs an
  // implicit origin period when a plan resolves. Locked here because the single
  // pass must not silently start counting them.
  it('excludes a planless member from both figures', () => {
    const rollup = computeMemberFinanceRollups({
      members: [member({ membershipPlanId: 'missing-plan' })],
      plans: PLANS,
      payments: [{ id: 'pay1', memberId: 'm1', amount: 500, date: '2026-01-02' }],
    })
    expect(rollup.dues.count).toBe(0)
    expect(rollup.pendingOriginPeriods).toBe(0)
  })

  it('counts an origin period for a member whose recorded periods start after an earlier payment', () => {
    const args = {
      members: [member()],
      plans: PLANS,
      memberships: [
        { id: 'ms1', memberId: 'm1', planId: 'p1', startDate: '2026-03-01', expiryDate: '2026-03-31', price: 1000 },
      ],
      payments: [{ id: 'pay1', memberId: 'm1', amount: 500, date: '2026-01-05' }],
    }
    const rollup = computeMemberFinanceRollups(args)
    expect(rollup.pendingOriginPeriods).toBe(1)
    // ...and the same member is also absent from dues only when nothing is due.
    expect(rollup.dues.count).toBe(1)
    expect(originalPendingOriginCount(args)).toBe(rollup.pendingOriginPeriods)
  })

  it('is sorted by due descending then member name, as before', () => {
    const args = {
      members: [
        member({ id: 'x', name: 'Zoya' }),
        member({ id: 'y', name: 'Amir' }),
        member({ id: 'z', name: 'Bina' }),
      ],
      plans: PLANS,
      payments: [
        { id: 'p1', memberId: 'x', amount: 100, date: '2026-01-02' },
        { id: 'p2', memberId: 'y', amount: 100, date: '2026-01-02' },
        { id: 'p3', memberId: 'z', amount: 100, date: '2026-01-02' },
      ],
    }
    expect(computeMemberFinanceRollups(args).dues.rows.map((r) => r.member.name)).toEqual([
      'Amir',
      'Bina',
      'Zoya',
    ])
  })
})

describe('countPendingOriginPeriods stays on the canonical path', () => {
  it('agrees with the rollup count', () => {
    for (const { args } of SCENARIOS) {
      expect(countPendingOriginPeriods(args)).toBe(
        computeMemberFinanceRollups(args).pendingOriginPeriods
      )
    }
  })

  it('is unaffected by the PT surcharge, matching its previous behaviour', () => {
    const args = {
      members: [member({ isPT: true })],
      plans: PLANS,
      payments: [{ id: 'pay1', memberId: 'm1', amount: 500, date: '2026-01-02' }],
    }
    expect(countPendingOriginPeriods(args)).toBe(countPendingOriginPeriods({ ...args, ptSurcharge: 999 }))
  })

  it('returns 0 with no arguments', () => {
    expect(countPendingOriginPeriods()).toBe(0)
  })
})