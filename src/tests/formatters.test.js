import { describe, expect, it } from 'vitest'
import { formatCurrency, formatDate, initials, slugify } from '@/utils/formatters'

describe('formatCurrency', () => {
  it('formats with INR default', () => {
    expect(formatCurrency(2500)).toBe('₹2,500')
  })

  it('formats with a symbol for USD', () => {
    expect(formatCurrency(99.5, 'USD')).toBe('$99.5')
  })

  it('handles zero and invalid input', () => {
    expect(formatCurrency(0)).toBe('₹0')
    expect(formatCurrency(null)).toBe('₹0')
    expect(formatCurrency('abc')).toBe('₹0')
  })
})

describe('formatDate', () => {
  it('returns a friendly date', () => {
    expect(formatDate('2026-05-05')).toContain('May')
  })

  it('returns a dash for missing input', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate('not-a-date')).toBe('—')
  })
})

describe('initials', () => {
  it('builds initials from first and last name', () => {
    expect(initials('Aarav Shrestha')).toBe('AS')
  })

  it('handles single names', () => {
    expect(initials('Priya')).toBe('PR')
  })

  it('falls back gracefully', () => {
    expect(initials(null)).toBe('?')
    expect(initials('')).toBe('?')
  })
})

describe('slugify', () => {
  it('lowercases and slugifies', () => {
    expect(slugify('Himalye Wonders Gym')).toBe('himalye-wonders-gym')
  })

  it('strips edge dashes', () => {
    expect(slugify('--Hello World--')).toBe('hello-world')
  })
})
