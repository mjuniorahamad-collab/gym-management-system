import { describe, expect, it } from 'vitest'
import {
  expenseSchema,
  loginSchema,
  memberSchema,
  paymentSchema,
  planSchema,
  trainerSchema,
} from '@/schemas/validationSchemas'

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
