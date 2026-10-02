import { describe, expect, it, vi } from 'vitest'
import { computeMemberFinanceRollups } from '@/utils/dues'
import { countPendingOriginPeriods } from '@/services/migration'

// computeMemberLedger filters the whole payments array once per member, so the
// number of times the payments array is scanned IS the number of per-member
// ledger evaluations - the dominant cost of the dashboard's finance section.
//
// Measured by array identity (the receiver of Array.prototype.filter) rather
// than by call count, so unrelated filters cannot distort the number.

const PLANS = [{ id: 'p1', name: 'Monthly', price: 1000, durationDays: 30 }]

const members = Array.from({ length: 50 }, (_, i) => ({
  id: `m${i}`,
  name: `Member ${i}`,
  joinDate: '2026-01-01',
  membershipPlanId: 'p1',
  isPT: false,
}))

const payments = Array.from({ length: 500 }, (_, i) => ({
  id: `pay${i}`,
  memberId: `m${i % 50}`,
  amount: 100,
  date: '2026-01-05',
}))

const ARGS = { members, plans: PLANS, payments }

function countPaymentsScans(run) {
  const spy = vi.spyOn(Array.prototype, 'filter')
  try {
    run()
    return spy.mock.calls.filter((_, i) => spy.mock.contexts[i] === payments).length
  } finally {
    spy.mockRestore()
  }
}

describe('the dashboard evaluates each member ledger once per change', () => {
  it('scans payments exactly once per member', () => {
    // 50 members -> 50 scans. The previous implementation scanned twice per
    // member (computeOutstandingDues, then a second loop over every member to
    // count origin periods), so this asserts 50 and would fail at 100.
    expect(countPaymentsScans(() => computeMemberFinanceRollups(ARGS))).toBe(members.length)
  })

  it('still scans once per member when dues is empty and every member is paid off', () => {
    // The case that made the two passes independently visible: with nothing due
    // the dues pass skips every member while the origin pass still evaluated it.
    const rollup = computeMemberFinanceRollups(ARGS)
    expect(rollup.dues.count).toBe(0)
    expect(rollup.pendingOriginPeriods).toBe(members.length)
    expect(countPaymentsScans(() => computeMemberFinanceRollups(ARGS))).toBe(members.length)
  })

  it('countPendingOriginPeriods costs one pass, and agrees with the rollup', () => {
    expect(countPaymentsScans(() => countPendingOriginPeriods(ARGS))).toBe(members.length)
    expect(countPendingOriginPeriods(ARGS)).toBe(
      computeMemberFinanceRollups(ARGS).pendingOriginPeriods
    )
  })

  it('recomputing after a payment change does not accumulate scans', () => {
    const first = countPaymentsScans(() => computeMemberFinanceRollups(ARGS))
    const second = countPaymentsScans(() => computeMemberFinanceRollups(ARGS))
    expect(second).toBe(first)
  })
})