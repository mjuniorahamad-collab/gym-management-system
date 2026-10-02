import { describe, expect, it } from 'vitest'
import {
  addDaysToKey,
  COMMON_GYM_TIMEZONES,
  daysBetween,
  DEFAULT_GYM_TIMEZONE,
  gymDayBoundsUtc,
  gymDayKey,
  gymDaysUntil,
  gymRangeBoundsUtc,
  gymTodayKey,
  isValidTimezone,
  resolveGymTimezone,
} from '@/utils/gymTime'

const KOLKATA = 'Asia/Kolkata' // UTC+05:30, no DST
const KATHMANDU = 'Asia/Kathmandu' // UTC+05:45
const NEW_YORK = 'America/New_York' // UTC-05:00 / -04:00, DST
const LONDON = 'Europe/London' // UTC+00:00 / +01:00, DST

describe('timezone resolution', () => {
  it('defaults to Asia/Kolkata, matching the INR currency already configured', () => {
    expect(DEFAULT_GYM_TIMEZONE).toBe('Asia/Kolkata')
    expect(resolveGymTimezone(undefined)).toBe('Asia/Kolkata')
    expect(resolveGymTimezone('')).toBe('Asia/Kolkata')
    expect(resolveGymTimezone('   ')).toBe('Asia/Kolkata')
  })

  it('keeps a valid configured zone', () => {
    expect(resolveGymTimezone(KATHMANDU)).toBe(KATHMANDU)
    expect(resolveGymTimezone(NEW_YORK)).toBe(NEW_YORK)
  })

  it('falls back rather than throwing on an unknown zone', () => {
    expect(resolveGymTimezone('Mars/Olympus_Mons')).toBe('Asia/Kolkata')
    expect(resolveGymTimezone(12345)).toBe('Asia/Kolkata')
    expect(isValidTimezone('Not/AZone')).toBe(false)
    expect(isValidTimezone(KOLKATA)).toBe(true)
  })

  it('offers only zones this runtime can actually resolve', () => {
    for (const tz of COMMON_GYM_TIMEZONES) {
      expect(isValidTimezone(tz), `${tz} should be valid`).toBe(true)
    }
  })
})

/**
 * The whole point of the module: two staff on devices in different timezones
 * must agree on the calendar day, and both must disagree with UTC where the
 * gym's day genuinely differs from UTC's.
 */
describe('gymDayKey', () => {
  it('uses the gym zone, not the device zone or UTC', () => {
    // 2026-01-15T19:00Z is 2026-01-16 00:30 in Kolkata (+05:30).
    const instant = '2026-01-15T19:00:00.000Z'
    expect(gymDayKey(instant, KOLKATA)).toBe('2026-01-16')
    // ...but still the 15th in Kathmandu? No: +05:45 pushes it to the 16th too.
    expect(gymDayKey(instant, KATHMANDU)).toBe('2026-01-16')
    // In New York (-05:00) it is still the 15th.
    expect(gymDayKey(instant, NEW_YORK)).toBe('2026-01-15')
    // And in UTC it is the 15th.
    expect(gymDayKey(instant, 'UTC')).toBe('2026-01-15')
  })

  it('maps one instant onto each zone’s own day', () => {
    // 12:00Z sits on a different calendar day in Auckland (+12) than in
    // New York (-05), which is exactly why a single global "today" is wrong.
    const noon = '2026-06-15T12:00:00.000Z'
    expect(gymDayKey(noon, KOLKATA)).toBe('2026-06-15')
    expect(gymDayKey(noon, NEW_YORK)).toBe('2026-06-15')
    expect(gymDayKey(noon, 'Pacific/Auckland')).toBe('2026-06-16')
    expect(gymDayKey(noon, 'UTC')).toBe('2026-06-15')
  })

  it('handles a date-only string as that calendar day, not a shifted instant', () => {
    // '2026-03-01' must stay the 1st everywhere — membership expiry depends on it.
    for (const tz of [KOLKATA, KATHMANDU, NEW_YORK, LONDON, 'Pacific/Auckland']) {
      expect(gymDayKey('2026-03-01', tz), tz).toBe('2026-03-01')
    }
  })

  it('accepts Date and Timestamp-like inputs', () => {
    expect(gymDayKey(new Date('2026-01-15T19:00:00.000Z'), KOLKATA)).toBe('2026-01-16')
    const ts = { toDate: () => new Date('2026-01-15T19:00:00.000Z') }
    expect(gymDayKey(ts, KOLKATA)).toBe('2026-01-16')
  })

  it('returns an empty string for unusable input instead of crashing', () => {
    expect(gymDayKey(null, KOLKATA)).toBe('')
    expect(gymDayKey(undefined, KOLKATA)).toBe('')
    expect(gymDayKey('not-a-date', KOLKATA)).toBe('')
    expect(gymDayKey(new Date('nonsense'), KOLKATA)).toBe('')
  })

  it('gives today in the gym zone', () => {
    expect(gymTodayKey(KOLKATA)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('day bounds for Firestore range queries', () => {
  it('covers a whole gym-local day inclusively', () => {
    const { start, end } = gymDayBoundsUtc('2026-01-15', KOLKATA)
    expect(start).toBe('2026-01-14T18:30:00.000Z') // 00:00 +05:30
    expect(end).toBe('2026-01-15T18:29:59.999Z') //   23:59:59.999 +05:30
  })

  it('covers a whole day in a western zone', () => {
    const { start, end } = gymDayBoundsUtc('2026-01-15', NEW_YORK)
    expect(start).toBe('2026-01-15T05:00:00.000Z') // 00:00 -05:00
    expect(end).toBe('2026-01-16T04:59:59.999Z')
  })

  it('includes the last instant of the end day of a range', () => {
    const { start, end } = gymRangeBoundsUtc('2026-01-01', '2026-01-31', KOLKATA)
    expect(start).toBe('2025-12-31T18:30:00.000Z')
    expect(end).toBe('2026-01-31T18:29:59.999Z')
    // The 31st local is inside the window...
    expect('2026-01-31T10:00:00.000Z' >= start).toBe(true)
    expect('2026-01-31T10:00:00.000Z' <= end).toBe(true)
    // ...and one millisecond past local midnight is not.
    expect('2026-01-31T18:30:00.000Z' <= end).toBe(false)
  })

  it('handles a single-day range', () => {
    const { start, end } = gymRangeBoundsUtc('2026-01-15', '2026-01-15', KOLKATA)
    expect(gymDayBoundsUtc('2026-01-15', KOLKATA)).toEqual({ start, end })
  })

  it('handles a DST change in the gym zone', () => {
    // US DST begins 2026-03-08, so that local day is only 23 hours long.
    const span = (b) => new Date(b.end).getTime() - new Date(b.start).getTime() + 1
    expect(span(gymDayBoundsUtc('2026-03-07', NEW_YORK))).toBe(24 * 3600 * 1000)
    expect(span(gymDayBoundsUtc('2026-03-08', NEW_YORK))).toBe(23 * 3600 * 1000)
    expect(span(gymDayBoundsUtc('2026-03-09', NEW_YORK))).toBe(24 * 3600 * 1000)
    // UK DST begins 2026-03-29 (last Sunday of March) and must not affect
    // a gym configured for India.
    expect(span(gymDayBoundsUtc('2026-03-29', KOLKATA))).toBe(24 * 3600 * 1000)
    expect(span(gymDayBoundsUtc('2026-03-29', LONDON))).toBe(23 * 3600 * 1000)
  })

  it('never returns a start after its end, even across a DST boundary', () => {
    for (const tz of COMMON_GYM_TIMEZONES) {
      for (const day of ['2026-03-08', '2026-11-01', '2026-01-01', '2026-12-31']) {
        const { start, end } = gymDayBoundsUtc(day, tz)
        expect(new Date(start) <= new Date(end), `${tz} ${day}`).toBe(true)
      }
    }
  })
})

describe('calendar-day arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDaysToKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysToKey('2028-03-01', -1)).toBe('2028-02-29') // leap year
    expect(addDaysToKey('2026-01-01', 0)).toBe('2026-01-01')
    expect(addDaysToKey('2026-01-01', 365)).toBe('2027-01-01')
  })

  /**
   * The approved Reports denominator: the number of calendar days in the
   * selected range, inclusive of both ends.
   */
  it('counts calendar days in a range inclusively', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(31)
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(1)
    expect(daysBetween('2026-01-01', '2026-01-06')).toBe(6)
    expect(daysBetween('2026-02-01', '2026-02-28')).toBe(28)
    expect(daysBetween('2028-02-01', '2028-02-29')).toBe(29) // leap year
  })

  /**
   * The old `daysUntil` divided a local-midnight delta by a fixed 24h. Across
   * spring-forward that yields -0, which `=== 0` matched, so a plan that expired
   * the previous day rendered as "Due today".
   */
  it('is not off by one across a DST transition', () => {
    const beforeSpringForward = new Date('2026-03-07T12:00:00-05:00')
    expect(gymDaysUntil('2026-03-08', NEW_YORK, beforeSpringForward)).toBe(1)
    expect(gymDaysUntil('2026-03-07', NEW_YORK, beforeSpringForward)).toBe(0)
    expect(gymDaysUntil('2026-03-06', NEW_YORK, beforeSpringForward)).toBe(-1)
  })

  it('measures expiry from today in the gym zone, not the device zone', () => {
    // 19:00Z is already the 16th in Kolkata.
    const now = new Date('2026-01-15T19:00:00.000Z')
    expect(gymDaysUntil('2026-01-16', KOLKATA, now)).toBe(0)
    expect(gymDaysUntil('2026-01-15', KOLKATA, now)).toBe(-1)
    expect(gymDaysUntil('2026-01-15', NEW_YORK, now)).toBe(0)
    expect(gymDaysUntil('2026-01-20', KOLKATA, now)).toBe(4)
  })

  it('returns null for a missing expiry', () => {
    expect(gymDaysUntil('', KOLKATA, new Date())).toBeNull()
    expect(gymDaysUntil(null, KOLKATA, new Date())).toBeNull()
  })
})