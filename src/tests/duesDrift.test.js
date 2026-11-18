import { describe, expect, it } from 'vitest'
import { DRIFT_FIELDS, duesDriftForMember, findDuesDrift } from '@/utils/duesDrift'

/**
 * DUES DRIFT DETECTOR.
 *
 * The decision this file pins: a deliberate price change is NOT drift. The
 * detector compares only the three derived fields (`amountPaid`, `amountDue`,
 * `paymentStatus`) against the ledger computed from the same documents, so an
 * owner who re-prices a period and gets consistent snapshots is never reported.
 */

const PLAN = { id: 'plan-1', name: 'Monthly', price: 2500, durationDays: 30 }

const member = (over = {}) => ({
  id: 'm1',
  name: 'Test Member',
  membershipPlanId: 'plan-1',
  joinDate: '2026-01-01',
  ...over,
})

const period = (over = {}) => ({
  id: 'p1',
  memberId: 'm1',
  planId: 'plan-1',
  planName: 'Monthly',
  price: 2500,
  startDate: '2026-01-01',
  expiryDate: '2026-01-31',
  amountPaid: 0,
  amountDue: 2500,
  paymentStatus: 'due',
  ...over,
})

const payment = (over = {}) => ({
  id: 'pay1',
  memberId: 'm1',
  membershipId: 'p1',
  amount: 1000,
  date: '2026-01-05',
  method: 'Cash',
  ...over,
})

const driftFor = (over = {}) =>
  duesDriftForMember({
    member: member(),
    plans: [PLAN],
    payments: [],
    memberships: [period()],
    ...over,
  })

describe('the compared fields', () => {
  it('are the three derived figures, never the price', () => {
    expect(DRIFT_FIELDS).toEqual(['amountPaid', 'amountDue', 'paymentStatus'])
  })
})

describe('consistent snapshots', () => {
  it('report nothing for an unpaid period', () => {
    expect(driftFor()).toEqual([])
  })

  it('report nothing for a partially paid period', () => {
    expect(
      driftFor({
        payments: [payment()],
        memberships: [period({ amountPaid: 1000, amountDue: 1500, paymentStatus: 'partial' })],
      })
    ).toEqual([])
  })

  it('report nothing for a fully paid period', () => {
    expect(
      driftFor({
        payments: [payment({ amount: 2500 })],
        memberships: [period({ amountPaid: 2500, amountDue: 0, paymentStatus: 'paid' })],
      })
    ).toEqual([])
  })
})

describe('a deliberate price change is legitimate, not drift', () => {
  it('accepts a re-priced period whose snapshots follow the new price', () => {
    // What editMembershipPeriod / applyPTInclusivePriceToPeriod write: the new
    // price AND the recomputed figures, in one transaction.
    const rows = driftFor({
      memberships: [period({ price: 3000, amountPaid: 0, amountDue: 3000, paymentStatus: 'due' })],
    })
    expect(rows).toEqual([])
  })

  it('accepts a discounted period the owner chose', () => {
    const rows = driftFor({
      memberships: [period({ price: 1800, amountPaid: 0, amountDue: 1800, paymentStatus: 'due' })],
    })
    expect(rows).toEqual([])
  })
})

describe('drift is a cached figure disagreeing with the ledger', () => {
  it('reports a stale amountDue and names the field', () => {
    const rows = driftFor({ memberships: [period({ amountDue: 0, paymentStatus: 'paid' })] })
    expect(rows).toHaveLength(1)
    expect(rows[0].periodId).toBe('p1')
    expect(rows[0].fields).toEqual(['amountDue', 'paymentStatus'])
    expect(rows[0].stored).toEqual({ amountPaid: 0, amountDue: 0, paymentStatus: 'paid' })
    expect(rows[0].expected).toEqual({ amountPaid: 0, amountDue: 2500, paymentStatus: 'due' })
  })

  it('reports a payment the period never absorbed', () => {
    const rows = driftFor({ payments: [payment()] })
    expect(rows[0].fields).toEqual(['amountPaid', 'amountDue', 'paymentStatus'])
    expect(rows[0].expected).toEqual({ amountPaid: 1000, amountDue: 1500, paymentStatus: 'partial' })
  })

  it('reports a legacy period that carries no snapshots at all', () => {
    const legacy = period()
    delete legacy.amountPaid
    delete legacy.amountDue
    delete legacy.paymentStatus
    const rows = driftFor({ memberships: [legacy] })
    // A missing `amountPaid` reads as 0 and the ledger also says 0, so that field
    // is NOT drift — only the two that genuinely disagree are named.
    expect(rows[0].fields).toEqual(['amountDue', 'paymentStatus'])
    expect(rows[0].stored).toEqual({ amountPaid: 0, amountDue: 0, paymentStatus: null })
  })

  it('ignores the reconstructed implicit period, which has no document', () => {
    // A member with no recorded periods gets an implicit origin period from the
    // ledger. There is nothing stored to disagree with, so nothing to report.
    const rows = duesDriftForMember({
      member: member({ joinDate: '2025-12-01' }),
      plans: [PLAN],
      payments: [],
      memberships: [],
    })
    expect(rows).toEqual([])
  })

  it('does not report a period belonging to another member', () => {
    const rows = driftFor({
      memberships: [period(), period({ id: 'p2', memberId: 'm2', amountDue: 0 })],
    })
    expect(rows).toEqual([])
  })
})

describe('findDuesDrift', () => {
  const members = [member(), member({ id: 'm2', name: 'Second' })]
  const memberships = [
    period(),
    period({ id: 'p2', memberId: 'm2', amountDue: 0, paymentStatus: 'paid' }),
  ]

  it('counts scanned members and periods and groups drift by member', () => {
    const result = findDuesDrift({ members, plans: [PLAN], payments: [], memberships })
    expect(result.membersScanned).toBe(2)
    expect(result.periodsScanned).toBe(2)
    expect(result.driftedMembers).toHaveLength(1)
    expect(result.driftedMembers[0].memberId).toBe('m2')
    expect(result.driftedMembers[0].memberName).toBe('Second')
    expect(result.driftedPeriods).toBe(1)
  })

  it('reports a clean gym as clean', () => {
    const result = findDuesDrift({
      members: [member()],
      plans: [PLAN],
      payments: [],
      memberships: [period()],
    })
    expect(result.driftedMembers).toEqual([])
    expect(result.driftedPeriods).toBe(0)
  })

  it('does not let one member’s payments affect another member’s period', () => {
    const result = findDuesDrift({
      members,
      plans: [PLAN],
      payments: [payment({ memberId: 'm2', membershipId: 'p2' })],
      memberships: [period(), period({ id: 'p2', memberId: 'm2' })],
    })
    // m1 is untouched; m2's period never absorbed its own payment.
    expect(result.driftedMembers.map((m) => m.memberId)).toEqual(['m2'])
  })
})
