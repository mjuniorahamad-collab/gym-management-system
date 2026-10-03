import { describe, expect, it } from 'vitest'
import { addDays, toDateInputValue } from '@/utils/dateHelpers'
import {
  buildWhatsAppGroupInviteMessage,
  buildWhatsAppMessage,
  buildWhatsAppUrl,
  getDaysRemaining,
  getExpiryBucket,
  getMembershipExpiry,
  matchesExpiryFilter,
  normalizeWhatsAppNumber,
} from '@/utils/membership'

const MONTHLY = { id: 'plan-1', name: 'Monthly', durationDays: 30 }

/** Builds a member whose membership expires exactly `days` from today. */
function memberExpiringIn(days, overrides = {}) {
  return {
    name: 'Rahul Verma',
    phone: '9801234567',
    email: 'rahul@example.com',
    status: 'active',
    membershipPlanId: MONTHLY.id,
    joinDate: toDateInputValue(addDays(new Date(), days - MONTHLY.durationDays)),
    ...overrides,
  }
}

function expiryFor(member = memberExpiringIn(0)) {
  return getMembershipExpiry(member, MONTHLY)
}

describe('getMembershipExpiry', () => {
  it('returns null when joinDate is missing', () => {
    expect(getMembershipExpiry({}, MONTHLY)).toBeNull()
    expect(getMembershipExpiry({ joinDate: '' }, MONTHLY)).toBeNull()
  })

  it('returns null when the plan is missing', () => {
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, null)).toBeNull()
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, undefined)).toBeNull()
  })

  it('returns null for an invalid joinDate', () => {
    expect(getMembershipExpiry({ joinDate: 'not-a-date' }, MONTHLY)).toBeNull()
  })

  it('returns null for a plan with an invalid duration', () => {
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, { durationDays: NaN })).toBeNull()
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, { durationDays: -5 })).toBeNull()
  })

  it('adds plan duration to the join date as a date-only key', () => {
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, MONTHLY)).toBe('2026-08-31')
  })

  it('does not shift the expiry across a timezone boundary', () => {
    // The previous implementation parsed the join date into a local Date and
    // returned it. Reinterpreting that instant in an eastern gym timezone moved
    // the displayed expiry a day forward.
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, MONTHLY)).toBe('2026-08-31')
  })

  it('handles a leap day join date', () => {
    expect(getMembershipExpiry({ joinDate: '2024-02-28' }, { durationDays: 1 })).toBe('2024-02-29')
  })

  it('treats a zero-duration plan as expiring on the join date', () => {
    expect(getMembershipExpiry({ joinDate: '2026-08-01' }, { durationDays: 0 })).toBe('2026-08-01')
  })
})

describe('days remaining', () => {
  it('is 0 when membership expires today', () => {
    expect(getDaysRemaining(expiryFor(memberExpiringIn(0)))).toBe(0)
  })

  it('is 1 when membership expires tomorrow', () => {
    expect(getDaysRemaining(expiryFor(memberExpiringIn(1)))).toBe(1)
  })

  it('is 3 for a 3-day expiry', () => {
    expect(getDaysRemaining(expiryFor(memberExpiringIn(3)))).toBe(3)
  })

  it('is 7 for a 7-day expiry', () => {
    expect(getDaysRemaining(expiryFor(memberExpiringIn(7)))).toBe(7)
  })

  it('is negative for an expired membership', () => {
    expect(getDaysRemaining(expiryFor(memberExpiringIn(-1)))).toBe(-1)
    expect(getDaysRemaining(expiryFor(memberExpiringIn(-10)))).toBe(-10)
  })

  it('returns null when there is no expiry', () => {
    expect(getDaysRemaining(null)).toBeNull()
    expect(getDaysRemaining(expiryFor(memberExpiringIn(0, { joinDate: '' })))).toBeNull()
  })
})

describe('getExpiryBucket', () => {
  it('buckets expired, today, tomorrow, 3 days and 7 days', () => {
    expect(getExpiryBucket(-1)).toBe('expired')
    expect(getExpiryBucket(0)).toBe('today')
    expect(getExpiryBucket(1)).toBe('tomorrow')
    expect(getExpiryBucket(2)).toBe('3days')
    expect(getExpiryBucket(3)).toBe('3days')
    expect(getExpiryBucket(5)).toBe('7days')
    expect(getExpiryBucket(7)).toBe('7days')
  })

  it('returns null outside the tracked window or for invalid input', () => {
    expect(getExpiryBucket(8)).toBeNull()
    expect(getExpiryBucket(null)).toBeNull()
    expect(getExpiryBucket(undefined)).toBeNull()
    expect(getExpiryBucket(NaN)).toBeNull()
  })
})

describe('matchesExpiryFilter', () => {
  it('"all" includes expired and up to 7 days', () => {
    expect(matchesExpiryFilter(-5, 'all')).toBe(true)
    expect(matchesExpiryFilter(0, 'all')).toBe(true)
    expect(matchesExpiryFilter(7, 'all')).toBe(true)
    expect(matchesExpiryFilter(8, 'all')).toBe(false)
  })

  it('"expired" only matches negative days', () => {
    expect(matchesExpiryFilter(-1, 'expired')).toBe(true)
    expect(matchesExpiryFilter(0, 'expired')).toBe(false)
    expect(matchesExpiryFilter(1, 'expired')).toBe(false)
  })

  it('"today" and "tomorrow" are exact', () => {
    expect(matchesExpiryFilter(0, 'today')).toBe(true)
    expect(matchesExpiryFilter(1, 'today')).toBe(false)
    expect(matchesExpiryFilter(1, 'tomorrow')).toBe(true)
    expect(matchesExpiryFilter(0, 'tomorrow')).toBe(false)
  })

  it('"3days" and "7days" are inclusive ranges', () => {
    expect(matchesExpiryFilter(0, '3days')).toBe(true)
    expect(matchesExpiryFilter(2, '3days')).toBe(true)
    expect(matchesExpiryFilter(3, '3days')).toBe(true)
    expect(matchesExpiryFilter(4, '3days')).toBe(false)
    expect(matchesExpiryFilter(7, '7days')).toBe(true)
    expect(matchesExpiryFilter(8, '7days')).toBe(false)
  })

  it('rejects missing or invalid days', () => {
    expect(matchesExpiryFilter(null, 'all')).toBe(false)
    expect(matchesExpiryFilter(NaN, 'today')).toBe(false)
  })
})

describe('normalizeWhatsAppNumber', () => {
  it('rejects a missing phone number', () => {
    expect(normalizeWhatsAppNumber('').ok).toBe(false)
    expect(normalizeWhatsAppNumber(null).ok).toBe(false)
    expect(normalizeWhatsAppNumber(undefined).ok).toBe(false)
  })

  it('prefixes a bare 10-digit Indian mobile with 91', () => {
    expect(normalizeWhatsAppNumber('9801234567')).toEqual({
      ok: true,
      number: '919801234567',
      error: null,
    })
  })

  it('accepts +91 and strips formatting', () => {
    expect(normalizeWhatsAppNumber('+91 98123 45678')).toEqual({
      ok: true,
      number: '919812345678',
      error: null,
    })
    expect(normalizeWhatsAppNumber('+91-98123-45678')).toEqual({
      ok: true,
      number: '919812345678',
      error: null,
    })
  })

  it('keeps an already-qualified 91 number', () => {
    expect(normalizeWhatsAppNumber('919812345678').number).toBe('919812345678')
  })

  it('swaps a leading 0 for 91', () => {
    expect(normalizeWhatsAppNumber('09812345678').number).toBe('919812345678')
  })

  it('keeps other country codes such as +977', () => {
    expect(normalizeWhatsAppNumber('+9779801234567').number).toBe('9779801234567')
  })

  it('rejects invalid numbers instead of silently building links', () => {
    expect(normalizeWhatsAppNumber('12345').ok).toBe(false)
    expect(normalizeWhatsAppNumber('abcdefgh').ok).toBe(false)
    expect(normalizeWhatsAppNumber('12345678901234567890').ok).toBe(false)
  })
})

describe('buildWhatsAppMessage', () => {
  it('builds the personalized reminder', () => {
    const message = buildWhatsAppMessage({
      memberName: 'Rahul',
      gymName: 'Himalye Wonders Gym',
      planName: 'Monthly',
      expiryDate: new Date(2026, 7, 18),
    })
    expect(message).toContain('Hi Rahul,')
    expect(message).toContain(
      'Your Monthly membership at Himalye Wonders Gym expires on 18 August 2026.'
    )
    expect(message).toContain('Please renew your membership to continue your training without interruption.')
    expect(message).toContain('Thank you,')
    expect(message).toContain('Himalye Wonders Gym')
  })

  it('falls back gracefully when expiry date is missing', () => {
    const message = buildWhatsAppMessage({
      memberName: 'Rahul',
      gymName: 'Himalye Wonders Gym',
      planName: 'Monthly',
      expiryDate: null,
    })
    expect(message).toContain('is expiring soon.')
  })
})

describe('buildWhatsAppGroupInviteMessage', () => {
  it('builds the pre-filled group invite message', () => {
    const message = buildWhatsAppGroupInviteMessage({
      memberName: 'Umar',
      gymName: 'Himalye Wonders Gym',
      link: 'https://chat.whatsapp.com/abc123',
    })
    expect(message).toBe(
      'Hi Umar, welcome to Himalye Wonders Gym! Please join our gym WhatsApp group using this link:\nhttps://chat.whatsapp.com/abc123'
    )
  })

  it('falls back gracefully when the member name is missing', () => {
    const message = buildWhatsAppGroupInviteMessage({
      memberName: '',
      gymName: 'Himalye Wonders Gym',
      link: 'https://chat.whatsapp.com/abc123',
    })
    expect(message.startsWith('Welcome to Himalye Wonders Gym!')).toBe(true)
  })
})

describe('buildWhatsAppUrl', () => {
  it('builds a wa.me link with a URL-encoded message', () => {
    const message = 'Hi Rahul, please renew!'
    const result = buildWhatsAppUrl('9801234567', message)
    expect(result.ok).toBe(true)
    expect(result.url).toBe(`https://wa.me/919801234567?text=${encodeURIComponent(message)}`)
  })

  it('URL-encodes newlines and special characters', () => {
    const message = 'Hello & goodbye\nNew line + more'
    const result = buildWhatsAppUrl('+91 98765 43210', message)
    expect(result.ok).toBe(true)
    expect(result.url).toBe(`https://wa.me/919876543210?text=${encodeURIComponent(message)}`)
  })

  it('never returns a link for a missing or invalid phone', () => {
    expect(buildWhatsAppUrl('', 'msg').ok).toBe(false)
    expect(buildWhatsAppUrl('12345', 'msg').ok).toBe(false)
    expect(buildWhatsAppUrl('abc', 'msg').ok).toBe(false)
  })
})
