import { describe, expect, it } from 'vitest'
import { getPaymentSummary, safePaymentAmount } from '@/utils/payments'

const payment = (memberId, amount) => ({ memberId, amount })

describe('getPaymentSummary', () => {
  it('full payment leaves nothing due', () => {
    const summary = getPaymentSummary({ payments: [payment('m1', 3500)], memberId: 'm1', planAmount: 3500 })
    expect(summary.totalPaid).toBe(3500)
    expect(summary.dueAmount).toBe(0)
    expect(summary.paidInFull).toBe(true)
  })

  it('partial payment shows the remaining balance', () => {
    const summary = getPaymentSummary({ payments: [payment('m1', 2000)], memberId: 'm1', planAmount: 3500 })
    expect(summary.totalPaid).toBe(2000)
    expect(summary.dueAmount).toBe(1500)
    expect(summary.paidInFull).toBe(false)
  })

  it('multiple partial payments accumulate total paid', () => {
    const summary = getPaymentSummary({
      payments: [payment('m1', 2000), payment('m1', 1000)],
      memberId: 'm1',
      planAmount: 3500,
    })
    expect(summary.totalPaid).toBe(3000)
    expect(summary.dueAmount).toBe(500)
  })

  it('exact payment is paid in full', () => {
    const summary = getPaymentSummary({ payments: [payment('m1', 3500)], memberId: 'm1', planAmount: 3500 })
    expect(summary.dueAmount).toBe(0)
    expect(summary.paidInFull).toBe(true)
  })

  it('payment exceeding the plan amount clamps due to 0 (never negative)', () => {
    const summary = getPaymentSummary({ payments: [payment('m1', 4000)], memberId: 'm1', planAmount: 3500 })
    expect(summary.totalPaid).toBe(4000)
    expect(summary.dueAmount).toBe(0)
    expect(summary.paidInFull).toBe(true)
  })

  it('missing payment records leaves the full amount due', () => {
    const summary = getPaymentSummary({ payments: [], memberId: 'm1', planAmount: 3500 })
    expect(summary.totalPaid).toBe(0)
    expect(summary.dueAmount).toBe(3500)
    expect(summary.paidInFull).toBe(false)
  })

  it('handles missing or invalid payment amounts without breaking', () => {
    const summary = getPaymentSummary({
      payments: [
        payment('m1', null),
        payment('m1', undefined),
        payment('m1', 'abc'),
        payment('m1', -500),
        payment('m1', 1000),
      ],
      memberId: 'm1',
      planAmount: 3500,
    })
    expect(summary.totalPaid).toBe(1000)
    expect(summary.dueAmount).toBe(2500)
  })

  it('only counts payments for the same member', () => {
    const summary = getPaymentSummary({
      payments: [payment('m1', 2000), payment('m2', 1000)],
      memberId: 'm1',
      planAmount: 3500,
    })
    expect(summary.totalPaid).toBe(2000)
    expect(summary.dueAmount).toBe(1500)
  })

  it('returns zero due when there is no plan amount', () => {
    const summary = getPaymentSummary({ payments: [payment('m1', 2000)], memberId: 'm1' })
    expect(summary.planAmount).toBe(0)
    expect(summary.dueAmount).toBe(0)
    expect(summary.paidInFull).toBe(false)
  })
})

describe('safePaymentAmount', () => {
  it('returns the amount for positive numbers', () => {
    expect(safePaymentAmount(2500)).toBe(2500)
    expect(safePaymentAmount('2500')).toBe(2500)
    expect(safePaymentAmount(0.5)).toBe(0.5)
  })

  it('returns 0 for missing, invalid or negative amounts', () => {
    expect(safePaymentAmount(null)).toBe(0)
    expect(safePaymentAmount(undefined)).toBe(0)
    expect(safePaymentAmount('abc')).toBe(0)
    expect(safePaymentAmount(-500)).toBe(0)
    expect(safePaymentAmount(NaN)).toBe(0)
  })
})
