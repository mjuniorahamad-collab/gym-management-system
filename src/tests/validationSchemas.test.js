import { describe, expect, it } from 'vitest'
import {
  expenseSchema,
  gymOnboardingSchema,
  loginSchema,
  memberSchema,
  paymentSchema,
  planSchema,
  ptSurchargeSchema,
  renewalSchema,
  trainerSchema,
} from '@/schemas/validationSchemas'
import { RECEIPT_PREFIX_RULES } from '@/utils/receiptPrefix'

describe('loginSchema', () => {
  it('accepts a valid login', () => {
    expect(loginSchema.parse({ email: 'a@b.com', password: 'secret1' })).toBeTruthy()
  })

  it('rejects bad email and short password', () => {
    const result = loginSchema.safeParse({ email: 'nope', password: '123' })
    expect(result.success).toBe(false)
  })
})

describe('memberSchema', () => {
  const valid = {
    name: 'Aarav Shrestha',
    phone: '9801234567',
    gender: 'Male',
    status: 'active',
  }

  it('accepts a valid member', () => {
    expect(memberSchema.parse(valid).name).toBe('Aarav Shrestha')
  })

  it('accepts a member with an optional father name', () => {
    const result = memberSchema.parse({ ...valid, fatherName: 'Ramesh Shrestha' })
    expect(result.fatherName).toBe('Ramesh Shrestha')
  })

  it('accepts a member with a blank father name', () => {
    expect(memberSchema.safeParse({ ...valid, fatherName: '' }).success).toBe(true)
  })

  it('accepts an existing member without a father name field', () => {
    expect(memberSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts a father name with surrounding whitespace', () => {
    const result = memberSchema.parse({ ...valid, fatherName: '  Ramesh Shrestha  ' })
    expect(result.fatherName).toBe('  Ramesh Shrestha  ')
  })

  it('rejects a missing name', () => {
    expect(memberSchema.safeParse({ ...valid, name: 'A' }).success).toBe(false)
  })

  it('rejects an invalid phone', () => {
    expect(memberSchema.safeParse({ ...valid, phone: 'abc' }).success).toBe(false)
  })
})

describe('paymentSchema', () => {
  it('requires a member and positive amount', () => {
    expect(paymentSchema.safeParse({ memberId: '', amount: 0 }).success).toBe(false)
    expect(paymentSchema.safeParse({ memberId: 'm1', amount: 100, method: 'Cash', date: '2026-05-05' }).success).toBe(true)
  })
})

describe('expenseSchema', () => {
  it('requires title, category and amount', () => {
    expect(expenseSchema.safeParse({ title: '', amount: 1 }).success).toBe(false)
    expect(
      expenseSchema.safeParse({ title: 'Rent', category: 'Rent', amount: 100, date: '2026-05-05' }).success
    ).toBe(true)
  })
})

describe('planSchema', () => {
  it('validates duration and price', () => {
    expect(planSchema.safeParse({ name: 'Annual', durationDays: 0, price: 10 }).success).toBe(false)
    expect(planSchema.safeParse({ name: 'Annual', durationDays: 365, price: 20000 }).success).toBe(true)
  })
})

describe('trainerSchema', () => {
  it('validates rate and specialization', () => {
    expect(trainerSchema.safeParse({ name: 'Arjun', specialization: 'PT', hourlyRate: -5, phone: '9800000000' }).success).toBe(false)
    expect(trainerSchema.safeParse({ name: 'Arjun', specialization: 'PT', hourlyRate: 1500, phone: '9800000000' }).success).toBe(true)
  })
})

// zod 4 regression guard.
//
// `required_error`, `invalid_type_error` and `errorMap` are accepted but
// SILENTLY IGNORED by zod 4, so after the upgrade every one of these fields
// rendered zod's raw "Invalid input: expected string, received undefined" in the
// form instead of the product copy. The unit suite stayed green because no test
// asserted the message. These assertions pin the user-facing string, not just
// the failure.
describe('zod 4 custom error messages', () => {
  it('receipt prefix keeps its policy message for missing and wrong-typed values', () => {
    const missing = gymOnboardingSchema.safeParse({ gymName: 'Powerhouse', receiptPrefix: undefined })
    expect(missing.success).toBe(false)
    expect(missing.error.issues[0].message).toBe(RECEIPT_PREFIX_RULES)

    const wrongType = gymOnboardingSchema.safeParse({ gymName: 'Powerhouse', receiptPrefix: 42 })
    expect(wrongType.success).toBe(false)
    expect(wrongType.error.issues[0].message).toBe(RECEIPT_PREFIX_RULES)
  })

  it('pt surcharge keeps its numeric message', () => {
    const r = ptSurchargeSchema.safeParse('not-a-number')
    expect(r.success).toBe(false)
    expect(r.error.issues[0].message).toBe('PT surcharge must be a number')
  })

  it('renewal effective mode keeps its message', () => {
    const r = renewalSchema.safeParse({
      planId: 'p1',
      effectiveMode: 'someday',
      amount: 100,
      method: 'Cash',
      date: '2026-05-05',
    })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].message).toBe('Select a renewal start')
  })
})
