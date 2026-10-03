import { describe, expect, it } from 'vitest'
import {
  displayExpiry,
  daysToExpiry,
  findOverlappingPeriods,
  isCurrentMember,
  isPeriodCurrent,
  periodDayKey,
  periodsForMember,
  resolvePeriodState,
  sortPeriods,
} from '@/utils/membershipPeriods'

const TODAY = '2026-03-10'

const p = (id, startDate, expiryDate, extra = {}) => ({
  id,
  memberId: 'm1',
  startDate,
  expiryDate,
  ...extra,
})

describe('periodDayKey', () => {
  it('passes through a date-only string unchanged', () => {
    // A date-only value is a literal calendar date. Converting it through an
    // instant is what shifted expiries by a day in Auckland.
    expect(periodDayKey('2026-03-10')).toBe('2026-03-10')
  })

  it('truncates a full ISO timestamp to its UTC day', () => {
    expect(periodDayKey('2026-03-10T18:30:00.000Z')).toBe('2026-03-10')
  })

  it('accepts an ISO instant string as its UTC day', () => {
    expect(periodDayKey('2026-03-10T23:30:00.000Z')).toBe('2026-03-10')
  })

  it('reads a Date by its local calendar date, not UTC', () => {
    // Dates here are built as local calendar dates. Reading UTC components
    // would report the previous day for any device east of UTC.
    expect(periodDayKey(new Date(2026, 2, 10))).toBe('2026-03-10')
    expect(periodDayKey(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(periodDayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('returns empty for an invalid Date', () => {
    expect(periodDayKey(new Date('nonsense'))).toBe('')
  })

  it('accepts a Firestore Timestamp', () => {
    const ts = { toDate: () => new Date('2026-03-10T06:00:00.000Z') }
    expect(periodDayKey(ts)).toBe('2026-03-10')
  })

  it('returns empty for missing or unusable values', () => {
    expect(periodDayKey(null)).toBe('')
    expect(periodDayKey(undefined)).toBe('')
    expect(periodDayKey('')).toBe('')
    expect(periodDayKey('not-a-date')).toBe('')
  })

  it('returns empty when a Timestamp throws', () => {
    const ts = {
      toDate() {
        throw new Error('bad')
      },
    }
    expect(periodDayKey(ts)).toBe('')
  })
})

describe('sortPeriods', () => {
  it('orders oldest-first by start date', () => {
    const sorted = sortPeriods([
      p('c', '2026-06-01', '2026-08-31'),
      p('a', '2026-01-01', '2026-03-31'),
      p('b', '2026-04-01', '2026-05-31'),
    ])
    expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks start-date ties deterministically by createdAt then id', () => {
    // Two periods sharing a start date must not swap between reads, or "the
    // current period" would flap between renders.
    const a = p('b', '2026-01-01', '2026-03-31', { createdAt: '2026-01-01T00:00:00Z' })
    const b = p('a', '2026-01-01', '2026-03-31', { createdAt: '2026-01-01T00:00:00Z' })
    expect(sortPeriods([a, b]).map((x) => x.id)).toEqual(['a', 'b'])
    expect(sortPeriods([b, a]).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('prefers the earlier createdAt when start dates tie', () => {
    const a = p('z', '2026-01-01', '2026-03-31', { createdAt: '2026-01-02T00:00:00Z' })
    const b = p('a', '2026-01-01', '2026-03-31', { createdAt: '2026-01-01T00:00:00Z' })
    expect(sortPeriods([a, b]).map((x) => x.id)).toEqual(['a', 'z'])
  })

  it('tolerates junk input', () => {
    expect(sortPeriods(null)).toEqual([])
    expect(sortPeriods([null, undefined, p('a', '2026-01-01', '2026-02-01')]).map((x) => x.id)).toEqual(['a'])
  })
})

describe('periodsForMember', () => {
  const all = [p('a', '2026-01-01', '2026-03-31'), { ...p('b', '2026-01-01', '2026-03-31'), memberId: 'm2' }]

  it('filters to one member and sorts them', () => {
    expect(periodsForMember(all, 'm1').map((x) => x.id)).toEqual(['a'])
  })

  it('returns nothing for a missing member id', () => {
    expect(periodsForMember(all, null)).toEqual([])
    expect(periodsForMember(all, '')).toEqual([])
  })
})

describe('isPeriodCurrent', () => {
  it('is true when today falls inside the closed interval', () => {
    expect(isPeriodCurrent(p('a', '2026-01-01', '2026-12-31'), TODAY)).toBe(true)
  })

  it('is true on the first day of the period', () => {
    expect(isPeriodCurrent(p('a', '2026-03-10', '2026-04-10'), TODAY)).toBe(true)
  })

  /**
   * Both ends are closed. A period ending today still covers today, and the day
   * after is the first uncovered day. This is what makes a renewal starting
   * "the day after the previous expiry" seamless rather than leaving a gap.
   */
  it('is true on the last day of the period', () => {
    expect(isPeriodCurrent(p('a', '2026-01-01', '2026-03-10'), TODAY)).toBe(true)
  })

  it('is false the day after the period ends', () => {
    expect(isPeriodCurrent(p('a', '2026-01-01', '2026-03-09'), TODAY)).toBe(false)
  })

  it('is false the day before the period starts', () => {
    expect(isPeriodCurrent(p('a', '2026-03-11', '2026-04-10'), TODAY)).toBe(false)
  })

  it('is false for a period that has not begun', () => {
    expect(isPeriodCurrent(p('a', '2026-06-01', '2026-08-31'), TODAY)).toBe(false)
  })

  it('is false for a period that has already ended', () => {
    expect(isPeriodCurrent(p('a', '2026-01-01', '2026-02-01'), TODAY)).toBe(false)
  })

  /**
   * A malformed row must not grant indefinite access. The expiry figures still
   * render, so an owner can see the problem and fix it.
   */
  it('is false when the expiry is missing or unparseable', () => {
    expect(isPeriodCurrent(p('a', '2026-01-01', null), TODAY)).toBe(false)
    expect(isPeriodCurrent(p('a', '2026-01-01', 'garbage'), TODAY)).toBe(false)
  })

  it('is false when the start is missing', () => {
    expect(isPeriodCurrent(p('a', null, '2026-12-31'), TODAY)).toBe(false)
  })

  it('is false when expiry precedes start', () => {
    expect(isPeriodCurrent(p('a', '2026-06-01', '2026-01-01'), TODAY)).toBe(false)
  })

  it('is false for a missing period', () => {
    expect(isPeriodCurrent(null, TODAY)).toBe(false)
  })
})

describe('resolvePeriodState', () => {
  it('finds the period covering today', () => {
    const state = resolvePeriodState([p('a', '2026-01-01', '2026-03-31'), p('b', '2026-04-01', '2026-05-31')], {
      today: TODAY,
    })
    expect(state.current.id).toBe('a')
    // 'a' has not ended yet, so it is current rather than past.
    expect(state.past).toBeNull()
    expect(state.future.id).toBe('b')
    expect(state.expired).toBe(false)
    expect(state.notStarted).toBe(false)
  })

  /**
   * The defect that motivated this module.
   *
   * The member's running period ends in 5 days and they have prepaid a period
   * starting in 60. The old reader took the newest period by startDate, reported
   * ~240 days remaining, failed matchesExpiryFilter(days, 'all'), and the
   * member disappeared from the dashboard's expiring list entirely.
   */
  it('keeps a future-dated period from masking the current one', () => {
    const state = resolvePeriodState(
      [p('current', '2026-01-01', '2026-03-15'), p('future', '2026-05-09', '2026-08-08')],
      { today: TODAY }
    )
    expect(state.current.id).toBe('current')
    expect(displayExpiry(state)).toBe('2026-03-15')
    expect(daysToExpiry(state.current, state.todayKey)).toBe(5)
    expect(state.future.id).toBe('future')
  })

  it('reports a fully lapsed member as expired', () => {
    const state = resolvePeriodState([p('a', '2026-01-01', '2026-02-01')], { today: TODAY })
    expect(state.current).toBeNull()
    expect(state.expired).toBe(true)
    expect(state.notStarted).toBe(false)
    expect(displayExpiry(state)).toBe('2026-02-01')
  })

  it('reports a member whose only period is in the future as not started', () => {
    const state = resolvePeriodState([p('a', '2026-06-01', '2026-08-31')], { today: TODAY })
    expect(state.current).toBeNull()
    expect(state.notStarted).toBe(true)
    expect(state.expired).toBe(false)
    expect(displayExpiry(state)).toBe('2026-08-31')
  })

  /**
   * Lapsed with a prepaid future period. "Expired" describes today, and `future`
   * stays available so a caller can tell the two situations apart.
   */
  it('treats a gap between periods as expired while surfacing the prepaid period', () => {
    const state = resolvePeriodState(
      [p('past', '2026-01-01', '2026-02-01'), p('future', '2026-06-01', '2026-08-31')],
      { today: TODAY }
    )
    expect(state.current).toBeNull()
    expect(state.expired).toBe(true)
    expect(state.future.id).toBe('future')
    // Display prefers what they are waiting on.
    expect(displayExpiry(state)).toBe('2026-08-31')
  })

  it('reports a member with no periods at all', () => {
    const state = resolvePeriodState([], { today: TODAY })
    expect(state.hasPeriods).toBe(false)
    expect(state.current).toBeNull()
    expect(state.expired).toBe(false)
    expect(state.notStarted).toBe(false)
    expect(displayExpiry(state)).toBeNull()
  })

  /**
   * `resolvePeriodState` takes the member's OWN periods and has no member id to
   * filter by, so narrowing is `periodsForMember`'s job. If it were given a
   * whole collection it would answer for whichever member sorted last.
   */
  it('requires the caller to narrow to one member first', () => {
    const all = [
      { ...p('a', '2026-01-01', '2026-12-31'), memberId: 'm1' },
      { ...p('b', '2026-01-01', '2026-12-31'), memberId: 'm2' },
    ]
    expect(periodsForMember(all, 'm2').map((x) => x.id)).toEqual(['b'])
    expect(resolvePeriodState(periodsForMember(all, 'm2'), { today: TODAY }).current.id).toBe('b')
  })

  it('ignores malformed periods when deciding currency', () => {
    const state = resolvePeriodState([p('bad', null, null), p('good', '2026-01-01', '2026-12-31')], {
      today: TODAY,
    })
    expect(state.current.id).toBe('good')
  })

  /**
   * Two overlapping periods both cover today. Picking deterministically matters
   * more than which one wins: a flapping answer would change the displayed
   * expiry between renders.
   */
  it('picks the same winner among overlapping periods every time', () => {
    const periods = [p('a', '2026-01-01', '2026-12-31'), p('b', '2026-02-01', '2026-11-30')]
    const first = resolvePeriodState(periods, { today: TODAY }).current.id
    const second = resolvePeriodState([...periods].reverse(), { today: TODAY }).current.id
    expect(first).toBe(second)
  })

  it('derives today from the gym timezone when no day is supplied', () => {
    const state = resolvePeriodState([], { timezone: 'Pacific/Auckland' })
    expect(state.todayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('isCurrentMember', () => {
  const periods = [
    { ...p('a', '2026-01-01', '2026-03-31'), memberId: 'm1' },
    { ...p('b', '2026-06-01', '2026-08-31'), memberId: 'm1' },
    { ...p('c', '2026-01-01', '2026-12-31'), memberId: 'm2' },
  ]

  it('is true only for the member whose period covers today', () => {
    expect(isCurrentMember(periods, 'm1', { today: TODAY })).toBe(true)
    expect(isCurrentMember(periods, 'm2', { today: TODAY })).toBe(true)
  })

  it('is false for a member with no periods', () => {
    expect(isCurrentMember(periods, 'nobody', { today: TODAY })).toBe(false)
  })

  it('is false once the period has ended', () => {
    expect(isCurrentMember(periods, 'm1', { today: '2027-01-01' })).toBe(false)
  })

  it('is false before the period begins', () => {
    expect(isCurrentMember([{ ...p('x', '2026-06-01', '2026-08-31'), memberId: 'm1' }], 'm1', { today: TODAY })).toBe(
      false
    )
  })
})

describe('daysToExpiry', () => {
  it('is 0 on the expiry day and 1 the day after', () => {
    expect(daysToExpiry(p('a', '2026-01-01', TODAY), TODAY)).toBe(0)
    expect(daysToExpiry(p('a', '2026-01-01', '2026-03-11'), TODAY)).toBe(1)
  })

  it('is negative once expired', () => {
    expect(daysToExpiry(p('a', '2026-01-01', '2026-03-01'), TODAY)).toBe(-9)
  })

  it('is null without a usable expiry', () => {
    expect(daysToExpiry(p('a', '2026-01-01', null), TODAY)).toBeNull()
    expect(daysToExpiry(null, TODAY)).toBeNull()
    expect(daysToExpiry(p('a', '2026-01-01', TODAY), null)).toBeNull()
  })
})

describe('findOverlappingPeriods', () => {
  const periods = [
    p('a', '2026-01-01', '2026-03-31'),
    p('b', '2026-04-01', '2026-05-31'),
  ]

  /**
   * Adjacency is allowed and is what a normal renewal produces: the new period
   * starts the day after the previous one ends.
   */
  it('allows a period starting the day after the previous ends', () => {
    expect(findOverlappingPeriods(periods, 'm1', p('new', '2026-06-01', '2026-08-31'))).toEqual([])
  })

  it('flags a period starting on the previous expiry day as overlapping', () => {
    // Both intervals are closed, so the shared day is genuinely covered twice.
    expect(findOverlappingPeriods(periods, 'm1', p('new', '2026-03-31', '2026-06-30')).map((x) => x.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('flags a period fully inside an existing one', () => {
    expect(findOverlappingPeriods(periods, 'm1', p('new', '2026-02-01', '2026-03-01')).map((x) => x.id)).toEqual([
      'a',
    ])
  })

  it('flags a period spanning two existing ones', () => {
    expect(findOverlappingPeriods(periods, 'm1', p('new', '2026-01-01', '2026-12-31')).map((x) => x.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('ignores the candidate itself when editing', () => {
    expect(findOverlappingPeriods(periods, 'm1', { ...p('a', '2026-01-01', '2026-03-31') })).toEqual([])
  })

  it('ignores other members', () => {
    expect(
      findOverlappingPeriods([{ ...p('a', '2026-01-01', '2026-03-31'), memberId: 'm2' }], 'm1', p('new', '2026-02-01', '2026-03-01'))
    ).toEqual([])
  })

  it('returns nothing for a candidate with unusable dates', () => {
    expect(findOverlappingPeriods(periods, 'm1', p('new', null, null))).toEqual([])
    expect(findOverlappingPeriods(periods, 'm1', null)).toEqual([])
  })
})