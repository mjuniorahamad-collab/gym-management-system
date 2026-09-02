import { describe, expect, it } from 'vitest'
import { PAYMENT_METHODS } from '@/utils/constants'
import { paymentMethods as demoPaymentMethods } from '@/services/sampleData'
import { paymentSchema, renewalSchema } from '@/schemas/validationSchemas'

describe('PAYMENT_METHODS (production dropdown)', () => {
  it('is exactly the India-focused list in order', () => {
    expect(PAYMENT_METHODS).toEqual(['Cash', 'UPI / Online', 'Card', 'Bank Transfer', 'Other'])
  })

  it('includes UPI / Online as the single combined online method', () => {
    expect(PAYMENT_METHODS).toContain('UPI / Online')
  })

  it('includes only one online-style method (no provider-specific options)', () => {
    const online = PAYMENT_METHODS.filter((m) => /upi|pay|phonepe|google|paytm|bhim/i.test(m))
    expect(online).toEqual(['UPI / Online'])
  })

  it('no longer exposes eSewa as a selectable new payment method', () => {
    expect(PAYMENT_METHODS).not.toContain('eSewa')
  })

  it('no longer exposes Khalti as a selectable new payment method', () => {
    expect(PAYMENT_METHODS).not.toContain('Khalti')
  })

  it('keeps Cash, Card, Bank Transfer and Other', () => {
    for (const m of ['Cash', 'Card', 'Bank Transfer', 'Other']) {
      expect(PAYMENT_METHODS).toContain(m)
    }
  })
})

describe('paymentSchema (new payment validation)', () => {
  const base = (method) => ({ memberId: 'm1', amount: 2000, method, date: '2026-05-05' })

  it('accepts UPI / Online for a new payment', () => {
    expect(paymentSchema.safeParse(base('UPI / Online')).success).toBe(true)
  })

  it('stores UPI / Online verbatim', () => {
    expect(paymentSchema.parse(base('UPI / Online')).method).toBe('UPI / Online')
  })

  it('still accepts Cash, Card, Bank Transfer and Other', () => {
    for (const m of ['Cash', 'Card', 'Bank Transfer', 'Other']) {
      expect(paymentSchema.safeParse(base(m)).success, m).toBe(true)
    }
  })

  it('still accepts historical eSewa records safely (backward compatible)', () => {
    expect(paymentSchema.safeParse(base('eSewa')).success).toBe(true)
  })

  it('still accepts historical Khalti records safely (backward compatible)', () => {
    expect(paymentSchema.safeParse(base('Khalti')).success).toBe(true)
  })

  it('rejects a blank method', () => {
    expect(paymentSchema.safeParse({ ...base(''), method: '' }).success).toBe(false)
  })
})

describe('renewalSchema (new renewal validation)', () => {
  const base = (method) => ({
    planId: 'plan-90',
    amount: 2000,
    method,
    date: '2026-05-05',
  })

  it('accepts UPI / Online and historical eSewa/Khalti', () => {
    expect(renewalSchema.safeParse(base('UPI / Online')).success).toBe(true)
    expect(renewalSchema.safeParse(base('eSewa')).success).toBe(true)
    expect(renewalSchema.safeParse(base('Khalti')).success).toBe(true)
  })
})

describe('demo/sample data', () => {
  it('matches the production dropdown list', () => {
    expect(demoPaymentMethods).toEqual(PAYMENT_METHODS)
  })

  it('does not seed new eSewa/Khalti demo methods', () => {
    expect(demoPaymentMethods).not.toContain('eSewa')
    expect(demoPaymentMethods).not.toContain('Khalti')
  })
})
