import { describe, expect, it } from 'vitest'
import { currencyMinorUnits, roundCurrency, DEFAULT_MINOR_UNITS } from '@/utils/currency'
import { freezeTailCharge, planDailyRate, tailRequiresAttention, TAIL_UNPRICEABLE } from '@/utils/freezeTails'
import { freezeTailDays, countFrozenDays, effectiveExpiryKey } from '@/utils/membershipFreezes'
import { computeMemberLedger } from '@/utils/dues'

describe('currency minor units', () => {
  it('reports the precision each currency actually uses', () => {
    expect(currencyMinorUnits('INR')).toBe(2)
    expect(currencyMinorUnits('USD')).toBe(2)
    expect(currencyMinorUnits('NPR')).toBe(0)
  })

  it('is case and whitespace insensitive', () => {
    expect(currencyMinorUnits('inr')).toBe(2)
    expect(currencyMinorUnits('  Inr ')).toBe(2)
  })

  it('falls back for an unknown or missing currency rather than throwing', () => {
    expect(currencyMinorUnits('ZZZ')).toBe(DEFAULT_MINOR_UNITS)
    expect(currencyMinorUnits('')).toBe(DEFAULT_MINOR_UNITS)
    expect(currencyMinorUnits(null)).toBe(DEFAULT_MINOR_UNITS)
    expect(currencyMinorUnits(undefined)).toBe(DEFAULT_MINOR_UNITS)
  })

  it('rounds INR to two places', () => {
    expect(roundCurrency(123.456, 'INR')).toBe(123.46)
    expect(roundCurrency(0.1 + 0.2, 'INR')).toBe(0.3)
  })

  it('does not drop a value that is already exactly on a minor unit', () => {
    // The classic binary-representation trap: 1.005 is below 1.005 as a double,
    // so naive rounding yields 1.00 and silently loses half a paisa.
    expect(roundCurrency(1.005, 'INR')).toBe(1.01)
    expect(roundCurrency(2.675, 'INR')).toBe(2.68)
  })

  it('honours a zero-minor-unit currency', () => {
    expect(roundCurrency(123.456, 'NPR')).toBe(123)
    expect(roundCurrency(123.5, 'NPR')).toBe(124)
  })

  it('is idempotent, which is what makes "round exactly once" checkable', () => {
    for (const amount of [123.456, 1.005, 0.1 + 0.2, 999.999]) {
      const once = roundCurrency(amount, 'INR')
      expect(roundCurrency(once, 'INR')).toBe(once)
    }
  })

  it('never returns NaN', () => {
    expect(roundCurrency(NaN, 'INR')).toBe(0)
    expect(roundCurrency(undefined, 'INR')).toBe(0)
    expect(roundCurrency('abc', 'INR')).toBe(0)
  })
})

const MONTHLY = { id: 'p1', name: 'Monthly', price: 1000, durationDays: 30 }

describe('planDailyRate', () => {
  it('divides the plan price by its duration', () => {
    const r = planDailyRate({ plan: MONTHLY })
    expect(r.priceable).toBe(true)
    expect(r.rate).toBeCloseTo(1000 / 30, 10)
  })

  it('includes the PT surcharge in a PT member rate', () => {
    const r = planDailyRate({ plan: MONTHLY, isPT: true, ptSurcharge: 300 })
    expect(r.rate).toBeCloseTo(1300 / 30, 10)
  })

  it('ignores a surcharge for a non-PT member so a stale value cannot leak', () => {
    const r = planDailyRate({ plan: MONTHLY, isPT: false, ptSurcharge: 300 })
    expect(r.rate).toBeCloseTo(1000 / 30, 10)
  })

  it('reports a missing plan instead of pricing at zero', () => {
    const r = planDailyRate({ plan: null })
    expect(r.priceable).toBe(false)
    expect(r.reason).toBe(TAIL_UNPRICEABLE.NO_PLAN)
  })

  it('reports a plan with no usable duration', () => {
    for (const durationDays of [0, -5, 'abc', undefined]) {
      const r = planDailyRate({ plan: { ...MONTHLY, durationDays } })
      expect(r.priceable).toBe(false)
      expect(r.reason).toBe(TAIL_UNPRICEABLE.NO_DURATION)
    }
  })

  it('reports a free plan as unpriceable rather than charging nothing', () => {
    const r = planDailyRate({ plan: { ...MONTHLY, price: 0 } })
    expect(r.priceable).toBe(false)
    expect(r.reason).toBe(TAIL_UNPRICEABLE.NO_PRICE)
  })
})

describe('freezeTailCharge', () => {
  it('prices tail days pro rata', () => {
    const c = freezeTailCharge({ tailDays: 14, plan: MONTHLY })
    expect(c.days).toBe(14)
    expect(c.amount).toBe(roundCurrency((1000 / 30) * 14, 'INR'))
    expect(c.priceable).toBe(true)
  })

  it('rounds the amount exactly once', () => {
    // 1000/30 * 7 = 233.333..., which must land on 233.33 and stay there.
    const c = freezeTailCharge({ tailDays: 7, plan: MONTHLY })
    expect(c.amount).toBe(233.33)
    expect(roundCurrency(c.amount, 'INR')).toBe(c.amount)
  })

  it('charges nothing but stays healthy when there are no tail days', () => {
    const c = freezeTailCharge({ tailDays: 0, plan: MONTHLY })
    expect(c.amount).toBe(0)
    expect(c.priceable).toBe(true)
    expect(c.reason).toBe('')
  })

  it('never silently charges zero for an unpriceable tail', () => {
    const c = freezeTailCharge({ tailDays: 14, plan: null })
    expect(c.amount).toBe(0)
    expect(c.priceable).toBe(false)
    expect(c.reason).toBe(TAIL_UNPRICEABLE.NO_PLAN)
  })

  it('treats a negative or fractional day count as zero', () => {
    expect(freezeTailCharge({ tailDays: -5, plan: MONTHLY }).days).toBe(0)
    expect(freezeTailCharge({ tailDays: 3.7, plan: MONTHLY }).days).toBe(3)
  })

  it('prices a PT tail with the surcharge included', () => {
    const c = freezeTailCharge({ tailDays: 30, plan: MONTHLY, isPT: true, ptSurcharge: 300 })
    expect(c.amount).toBe(1300)
  })

  it('prices in the gym currency rather than assuming two decimals', () => {
    const c = freezeTailCharge({ tailDays: 7, plan: MONTHLY, currency: 'NPR' })
    expect(c.amount).toBe(233)
  })

  it('distinguishes "nothing to charge" from "cannot price this"', () => {
    expect(tailRequiresAttention(freezeTailCharge({ tailDays: 0, plan: MONTHLY }))).toBe(false)
    expect(tailRequiresAttention(freezeTailCharge({ tailDays: 14, plan: null }))).toBe(true)
    expect(tailRequiresAttention(freezeTailCharge({ tailDays: 14, plan: MONTHLY }))).toBe(false)
  })
})

/**
 * The tail is derived from the period + freezes and priced from the GRANTING
 * plan. These tests tie the money back to the entitlement it pays for.
 */
describe('tail entitlement and pricing agree', () => {
  const PERIOD = {
    id: 'ms-1',
    memberId: 'm1',
    planId: 'p1',
    startDate: '2026-07-01',
    expiryDate: '2026-07-31',
  }
  const crossing = [{ id: 'f1', kind: 'freeze', memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-20', expiryDate: '2026-08-14' }]

  it('derives 26 granted days of which 14 are the tail', () => {
    expect(countFrozenDays(PERIOD, crossing)).toBe(26)
    expect(freezeTailDays(PERIOD, crossing)).toBe(14)
    expect(effectiveExpiryKey(PERIOD, crossing)).toBe('2026-08-26')
  })

  it('charges only for the tail, never for the whole freeze', () => {
    const charge = freezeTailCharge({ tailDays: freezeTailDays(PERIOD, crossing), plan: MONTHLY })
    const wholeFreeze = freezeTailCharge({ tailDays: countFrozenDays(PERIOD, crossing), plan: MONTHLY })
    expect(charge.amount).toBeLessThan(wholeFreeze.amount)
    // 12 pre-expiry days are already covered by the money the member paid.
    expect(charge.amount).toBe(roundCurrency((1000 / 30) * 14, 'INR'))
  })

  it('bills the granting plan even after the member switches plans', () => {
    // The period was bought on the monthly plan (1000/30 per day). The annual
    // plan works out CHEAPER per day (12000/365), so this asserts on the value
    // rather than on which is larger: charging at the annual rate would reprice
    // a historical fact and produce a different, wrong amount.
    const annual = { id: 'p2', name: 'Annual', price: 12000, durationDays: 365 }
    const atGrant = freezeTailCharge({ tailDays: 14, plan: MONTHLY })
    const atCurrent = freezeTailCharge({ tailDays: 14, plan: annual })
    expect(atGrant.amount).toBe(roundCurrency((1000 / 30) * 14, 'INR'))
    expect(atCurrent.amount).toBe(roundCurrency((12000 / 365) * 14, 'INR'))
    expect(atGrant.amount).not.toBe(atCurrent.amount)
  })
})

describe('ledger freezeTails are informational, never a due', () => {
  const member = { id: 'm1', name: 'Zaid', membershipPlanId: 'p1', joinDate: '2026-07-01' }
  const plans = [MONTHLY]
  const memberships = [
    {
      id: 'ms-1',
      memberId: 'm1',
      planId: 'p1',
      startDate: '2026-07-01',
      expiryDate: '2026-07-31',
      price: 1000,
    },
  ]
  const freezes = [{ id: 'f1', kind: 'freeze', memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-20', expiryDate: '2026-08-14' }]

  it('reports the tail on the ledger', () => {
    const ledger = computeMemberLedger({ member, plans, memberships, freezes })
    expect(ledger.freezeTails).toHaveLength(1)
    expect(ledger.freezeTails[0]).toMatchObject({ membershipId: 'ms-1', days: 14, priceable: true })
  })

  /**
   * The critical one. If a tail ever leaked into openPeriods or totals it would
   * create a balance that no payment can settle, because the tail is invoiced
   * inside the renewal transaction rather than allocated to a period.
   *
   * The member is fully paid here, so the period contributes nothing to the
   * totals on its own: every non-zero figure below could only have come from the
   * tail.
   */
  it('keeps the tail out of openPeriods and totals when the period is settled', () => {
    const paid = [
      {
        id: 'pay-1',
        memberId: 'm1',
        membershipId: 'ms-1',
        amount: 1000,
        date: '2026-07-01',
      },
    ]
    const ledger = computeMemberLedger({ member, plans, memberships, freezes, payments: paid })
    expect(ledger.freezeTails).toHaveLength(1)
    expect(ledger.freezeTails[0].days).toBe(14)
    expect(ledger.openPeriods).toEqual([])
    expect(ledger.totals).toEqual({ billed: 0, paid: 0, due: 0 })
  })

  /**
   * The tail must not inflate a genuine outstanding balance either: a partly-paid
   * period owes exactly what it owes, with the tail reported alongside.
   */
  it('does not inflate a real outstanding balance', () => {
    const partPaid = [{ id: 'pay-1', memberId: 'm1', membershipId: 'ms-1', amount: 400, date: '2026-07-01' }]
    const ledger = computeMemberLedger({ member, plans, memberships, freezes, payments: partPaid })
    expect(ledger.totals.due).toBe(600)
    expect(ledger.totals.billed).toBe(1000)
    expect(ledger.freezeTails[0].amount).toBeGreaterThan(0)
  })

  it('produces identical totals with and without freezes', () => {
    const withFreeze = computeMemberLedger({ member, plans, memberships, freezes })
    const without = computeMemberLedger({ member, plans, memberships })
    expect(withFreeze.totals).toEqual(without.totals)
    expect(withFreeze.periods.map((p) => p.price)).toEqual(without.periods.map((p) => p.price))
  })

  it('does not add a second period for the tail', () => {
    const ledger = computeMemberLedger({ member, plans, memberships, freezes })
    expect(ledger.periods).toHaveLength(1)
  })

  it('reports no tails when the member has none', () => {
    const ledger = computeMemberLedger({ member, plans, memberships })
    expect(ledger.freezeTails).toEqual([])
  })

  /**
   * The granting plan comes from the PERIOD, not from the member's current plan.
   *
   * The two can legitimately differ: the member bought the monthly period, then
   * switched to an annual plan before renewing. The tail belongs to the monthly
   * period and must be priced on the monthly plan's daily rate.
   */
  it('prices the tail from the granting period plan after the member switches', () => {
    const annual = { id: 'p2', name: 'Annual', price: 12000, durationDays: 365 }
    const switched = { ...member, membershipPlanId: 'p2' }
    const ledger = computeMemberLedger({
      member: switched,
      plans: [...plans, annual],
      memberships,
      freezes,
    })
    expect(ledger.freezeTails).toHaveLength(1)
    // Monthly rate (1000/30), not annual (12000/365).
    expect(ledger.freezeTails[0].amount).toBe(roundCurrency((1000 / 30) * 14, 'INR'))
  })

  it('reports an unpriceable tail instead of silently waiving it', () => {
    const orphanPlan = { ...memberships[0], planId: 'p-gone' }
    const ledger = computeMemberLedger({
      member,
      plans, // monthly plan still exists, but the PERIOD references a missing one
      memberships: [orphanPlan],
      freezes,
    })
    expect(ledger.freezeTails).toHaveLength(1)
    expect(ledger.freezeTails[0]).toMatchObject({ days: 14, priceable: false, amount: 0 })
    expect(ledger.freezeTails[0].reason).toBe(TAIL_UNPRICEABLE.NO_PLAN)
  })
})