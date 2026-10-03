import { describe, expect, it } from 'vitest'
import {
  averageDailyCheckIns,
  defaultReportRange,
  expensesByCategory,
  inRange,
  isDayKey,
  monthsInRange,
  monthlyCashFlow,
  monthlyNewMembers,
  normalizeReportRange,
  rangeDayCount,
  rangeTotals,
  revenueByPlan,
  shiftRange,
} from '@/utils/reportRange'

const KOLKATA = 'Asia/Kolkata'
const NEW_YORK = 'America/New_York'

describe('defaultReportRange', () => {
  it('covers the six calendar months ending with the current gym month', () => {
    const range = defaultReportRange(KOLKATA, new Date('2026-03-15T06:00:00.000Z'))
    expect(range).toEqual({ from: '2025-10-01', to: '2026-03-15' })
  })

  it('crosses the year boundary correctly', () => {
    const range = defaultReportRange(KOLKATA, new Date('2026-01-20T06:00:00.000Z'))
    expect(range).toEqual({ from: '2025-08-01', to: '2026-01-20' })
  })

  it('ends on today in the gym timezone, not on the device day', () => {
    // 19:00Z is already the 16th in Kolkata.
    const instant = new Date('2026-03-15T19:00:00.000Z')
    expect(defaultReportRange(KOLKATA, instant).to).toBe('2026-03-16')
    expect(defaultReportRange(NEW_YORK, instant).to).toBe('2026-03-15')
  })
})

describe('normalizeReportRange', () => {
  it('accepts an ordered range', () => {
    expect(normalizeReportRange('2026-01-01', '2026-01-31')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    })
  })

  it('accepts a single-day range', () => {
    expect(normalizeReportRange('2026-01-05', '2026-01-05')).toEqual({
      from: '2026-01-05',
      to: '2026-01-05',
    })
  })

  // Swapping a reversed range would be a guess about what the owner meant, and
  // reporting the wrong period silently is worse than ignoring the edit.
  it('rejects a reversed range rather than guessing which end is which', () => {
    expect(normalizeReportRange('2026-01-31', '2026-01-01')).toBeNull()
  })

  it('rejects malformed or missing bounds', () => {
    expect(normalizeReportRange('', '2026-01-01')).toBeNull()
    expect(normalizeReportRange('2026-01-01', '')).toBeNull()
    expect(normalizeReportRange('01/01/2026', '2026-01-01')).toBeNull()
    expect(normalizeReportRange('2026-1-1', '2026-01-31')).toBeNull()
    expect(normalizeReportRange(undefined, undefined)).toBeNull()
  })

  it('validates day-key shape', () => {
    expect(isDayKey('2026-01-01')).toBe(true)
    expect(isDayKey('2026-01-01T00:00:00Z')).toBe(false)
    expect(isDayKey(20260101)).toBe(false)
  })
})

describe('rangeDayCount', () => {
  it('counts calendar days inclusively', () => {
    expect(rangeDayCount({ from: '2026-01-01', to: '2026-01-31' })).toBe(31)
    expect(rangeDayCount({ from: '2026-01-01', to: '2026-01-01' })).toBe(1)
    expect(rangeDayCount({ from: '2028-02-01', to: '2028-02-29' })).toBe(29)
  })

  it('is zero without a range', () => {
    expect(rangeDayCount(null)).toBe(0)
  })
})

describe('inRange', () => {
  const range = { from: '2026-01-01', to: '2026-01-31' }

  it('includes both endpoints', () => {
    expect(inRange('2026-01-01', range, KOLKATA)).toBe(true)
    expect(inRange('2026-01-31', range, KOLKATA)).toBe(true)
  })

  it('excludes the day outside either endpoint', () => {
    expect(inRange('2025-12-31', range, KOLKATA)).toBe(false)
    expect(inRange('2026-02-01', range, KOLKATA)).toBe(false)
  })

  /**
   * A payment at 23:30 IST on 31 Jan is 18:00Z on the 31st but already the 1st of
   * February for a device in another zone. It belongs in January for this gym.
   */
  it('classifies instants by the gym day, not the device day', () => {
    const instant = '2026-01-31T18:30:00.000Z' // 00:00 IST on 1 Feb
    expect(inRange(instant, range, KOLKATA)).toBe(false)
    expect(inRange(instant, { from: '2026-02-01', to: '2026-02-28' }, KOLKATA)).toBe(true)
    // In New York the same instant is still 31 January.
    expect(inRange(instant, range, NEW_YORK)).toBe(true)
  })

  it('treats unusable values as outside the range instead of throwing', () => {
    expect(inRange(null, range, KOLKATA)).toBe(false)
    expect(inRange('not-a-date', range, KOLKATA)).toBe(false)
    expect(inRange(undefined, range, KOLKATA)).toBe(false)
    expect(inRange('2026-01-15', null, KOLKATA)).toBe(false)
  })
})

describe('averageDailyCheckIns', () => {
  const range = { from: '2026-01-01', to: '2026-01-31' }

  /**
   * The core fix: 30 check-ins over 3 active days is 1/day across January, not
   * 10/day. Dividing by "days that had attendance" made a quiet gym look busy.
   */
  it('divides by calendar days in the range, not days with attendance', () => {
    const attendance = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, date: '2026-01-05' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, date: '2026-01-06' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, date: '2026-01-07' })),
    ]
    expect(averageDailyCheckIns(attendance, range, KOLKATA)).toBe(1) // 30/31
  })

  it('counts closed days as zero rather than excluding them', () => {
    const attendance = Array.from({ length: 62 }, (_, i) => ({
      id: `a${i}`,
      date: i % 2 === 0 ? '2026-01-05' : '2026-01-06',
    }))
    // 62 check-ins in 2 active days of a 31-day month = 2.0/day.
    expect(averageDailyCheckIns(attendance, range, KOLKATA)).toBe(2)
  })

  it('only counts check-ins inside the range', () => {
    const attendance = [
      { id: 'in', date: '2026-01-10' },
      { id: 'before', date: '2025-12-25' },
      { id: 'after', date: '2026-02-03' },
    ]
    expect(averageDailyCheckIns(attendance, range, KOLKATA)).toBe(0) // 1/31 -> 0.0
  })

  it('rounds to one decimal place', () => {
    const attendance = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, date: '2026-01-05' }))
    expect(averageDailyCheckIns(attendance, range, KOLKATA)).toBe(0.3) // 10/31
  })

  it('is zero with no attendance or no range', () => {
    expect(averageDailyCheckIns([], range, KOLKATA)).toBe(0)
    expect(averageDailyCheckIns([{ date: '2026-01-05' }], null, KOLKATA)).toBe(0)
  })
})

describe('monthsInRange', () => {
  it('lists every month touched by the range', () => {
    expect(monthsInRange({ from: '2025-10-01', to: '2026-03-15' })).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
    ])
  })

  it('lists a single month once', () => {
    expect(monthsInRange({ from: '2026-02-05', to: '2026-02-20' })).toEqual(['2026-02'])
  })

  it('spans a year boundary', () => {
    expect(monthsInRange({ from: '2025-11-15', to: '2026-01-10' })).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
    ])
  })

  it('is empty without a range', () => {
    expect(monthsInRange(null)).toEqual([])
  })
})

describe('monthlyCashFlow', () => {
  const range = { from: '2026-01-01', to: '2026-03-31' }
  const payments = [
    { id: 'p1', amount: 1000, date: '2026-01-10' },
    { id: 'p2', amount: 500, date: '2026-02-10' },
    { id: 'p3', amount: 250, date: '2026-03-10' },
    { id: 'p4', amount: 9999, date: '2025-12-31' }, // outside range
  ]
  const expenses = [
    { id: 'e1', amount: 300, date: '2026-01-15' },
    { id: 'e2', amount: 700, date: '2026-03-15' },
  ]

  it('buckets amounts into the months inside the range', () => {
    const series = monthlyCashFlow(payments, expenses, range, KOLKATA)
    expect(series.map((s) => s.label)).toEqual(['Jan', 'Feb', 'Mar'])
    expect(series[0].income).toBe(1000)
    expect(series[0].expense).toBe(300)
    expect(series[1].income).toBe(500)
    expect(series[2].income).toBe(250)
    expect(series[2].expense).toBe(700)
  })

  it('excludes records outside the range entirely', () => {
    const total = monthlyCashFlow(payments, expenses, range, KOLKATA)
    expect(total.reduce((s, m) => s + m.income, 0)).toBe(1750) // not 10749
  })

  it('returns an empty series without a range', () => {
    expect(monthlyCashFlow(payments, expenses, null, KOLKATA)).toEqual([])
  })
})

describe('monthlyNewMembers', () => {
  it('counts joins per month inside the range', () => {
    const members = [
      { id: 'm1', joinDate: '2026-01-02' },
      { id: 'm2', joinDate: '2026-01-20' },
      { id: 'm3', joinDate: '2026-02-11' },
      { id: 'm4', joinDate: '2025-12-01' },
    ]
    const trend = monthlyNewMembers(members, { from: '2026-01-01', to: '2026-02-28' }, KOLKATA)
    expect(trend).toEqual([
      { label: 'Jan', newMembers: 2 },
      { label: 'Feb', newMembers: 1 },
    ])
  })
})

describe('rangeTotals', () => {
  const range = { from: '2026-01-01', to: '2026-01-31' }
  const payments = [
    { id: 'p1', amount: 3000, date: '2026-01-10' },
    { id: 'p2', amount: 1500, date: '2026-01-20' },
    { id: 'p3', amount: 7000, date: '2025-06-01' }, // all-time only
  ]
  const expenses = [
    { id: 'e1', amount: 400, date: '2026-01-12' },
    { id: 'e2', amount: 900, date: '2025-01-12' }, // outside range
  ]
  const members = [
    { id: 'm1', status: 'active' },
    { id: 'm2', status: 'active' },
    { id: 'm3', status: 'expired' },
  ]

  /**
   * Revenue and costs were all-time sums on a page whose charts covered six
   * months, so the tiles and the chart could not be reconciled. Both are now
   * scoped to the selected range.
   */
  it('scopes revenue and costs to the range instead of summing all time', () => {
    const totals = rangeTotals({ payments, expenses, members }, range, KOLKATA)
    expect(totals.revenue).toBe(4500)
    expect(totals.costs).toBe(400)
    expect(totals.net).toBe(4100)
  })

  it('keeps active members as a current-state figure, not a range filter', () => {
    const totals = rangeTotals({ payments, expenses, members }, range, KOLKATA)
    expect(totals.active).toBe(2)
  })
})

describe('expensesByCategory', () => {
  it('groups by category inside the range, largest first, capped', () => {
    const expenses = [
      { amount: 100, category: 'Rent', date: '2026-01-05' },
      { amount: 300, category: 'Equipment', date: '2026-01-06' },
      { amount: 200, category: 'Rent', date: '2026-01-07' },
      { amount: 999, category: 'Stale', date: '2025-01-01' },
      { amount: 50, category: 'Misc', date: '2026-01-08' },
    ]
    const out = expensesByCategory(expenses, { from: '2026-01-01', to: '2026-01-31' }, KOLKATA)
    expect(out).toEqual([
      { name: 'Rent', value: 300 },
      { name: 'Equipment', value: 300 },
      { name: 'Misc', value: 50 },
    ])
    expect(out).not.toContainEqual({ name: 'Stale', value: 999 })
  })

  it('labels an uncategorised expense Other', () => {
    const out = expensesByCategory(
      [{ amount: 10, date: '2026-01-05' }],
      { from: '2026-01-01', to: '2026-01-31' },
      KOLKATA
    )
    expect(out).toEqual([{ name: 'Other', value: 10 }])
  })
})

describe('revenueByPlan', () => {
  const plans = [
    { id: 'pl1', name: 'Gold Monthly' },
    { id: 'pl2', name: 'Silver Monthly' },
  ]

  it('groups by plan name inside the range', () => {
    const payments = [
      { planId: 'pl1', type: 'membership', amount: 3000, date: '2026-01-10' },
      { planId: 'pl1', type: 'membership', amount: 3000, date: '2026-02-10' },
      { planId: 'pl2', type: 'membership', amount: 1500, date: '2026-01-11' },
    ]
    const out = revenueByPlan(payments, plans, { from: '2026-01-01', to: '2026-01-31' }, KOLKATA)
    expect(out).toEqual([
      { name: 'Gold Monthly', value: 3000 },
      { name: 'Silver Monthly', value: 1500 },
    ])
  })

  it('falls back to a stable label for an unknown or absent plan', () => {
    const payments = [
      { type: 'membership', amount: 100, date: '2026-01-10' },
      { type: 'pt', amount: 50, date: '2026-01-10' },
      { planId: 'missing', type: 'membership', amount: 25, date: '2026-01-10' },
    ]
    const out = revenueByPlan(payments, plans, { from: '2026-01-01', to: '2026-01-31' }, KOLKATA)
    expect(out).toEqual([
      { name: 'Membership', value: 125 },
      { name: 'Other', value: 50 },
    ])
  })
})

describe('shiftRange', () => {
  it('moves both ends by the same number of days', () => {
    expect(shiftRange({ from: '2026-01-01', to: '2026-01-31' }, -1)).toEqual({
      from: '2025-12-31',
      to: '2026-01-30',
    })
  })

  it('is null without a range', () => {
    expect(shiftRange(null, 7)).toBeNull()
  })
})