import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXPIRING_WITHIN_DAYS,
  PROJECTION_STATUS,
  deriveMemberProjection,
} from '@/utils/memberProjection'
import {
  anchoredFreezeRanges,
  effectiveExpiryKey,
  freezeUntilKey,
} from '@/utils/membershipFreezes'
import { daysToExpiry, resolvePeriodState } from '@/utils/membershipPeriods'
import { gymTodayKey } from '@/utils/gymTime'

const TODAY = '2026-03-10'
const TZ = 'Asia/Kolkata'

const period = (over = {}) => ({
  id: 'ms-1',
  memberId: 'm1',
  planId: 'p1',
  planName: 'Monthly',
  startDate: '2026-01-01',
  expiryDate: '2026-06-30',
  ...over,
})

const freeze = (over = {}) => ({
  id: 'fz-1',
  kind: 'freeze',
  memberId: 'm1',
  periodId: 'ms-1',
  startDate: '2026-02-01',
  expiryDate: '2026-02-10',
  ...over,
})

const cancellation = (over = {}) => ({
  id: 'fz-1-c',
  kind: 'cancellation',
  memberId: 'm1',
  periodId: 'ms-1',
  cancelsFreezeId: 'fz-1',
  ...over,
})

const derive = (over = {}) =>
  deriveMemberProjection({
    memberId: 'm1',
    memberships: [],
    freezes: [],
    timezone: TZ,
    today: TODAY,
    ...over,
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('1. active member', () => {
  it('projects the current period and stays active well before expiry', () => {
    const out = derive({ memberships: [period()] })
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
    expect(out.hasCurrentPeriod).toBe(true)
    expect(out.periodBasis).toBe('current')
    expect(out.periodId).toBe('ms-1')
    expect(out.membershipStart).toBe('2026-01-01')
    expect(out.effectiveExpiry).toBe('2026-06-30')
    expect(out.freezeUntil).toBeNull()
    expect(out.isFrozen).toBe(false)
    expect(out.expiringWithinDays).toBe(112)
  })

  it('includes both endpoints of the period', () => {
    // A period is a closed interval on the gym's calendar, so its own start and
    // expiry days are both covered.
    expect(derive({ memberships: [period({ startDate: TODAY, expiryDate: '2026-06-30' })] }).status).toBe(
      PROJECTION_STATUS.ACTIVE
    )
    expect(
      derive({ memberships: [period({ startDate: '2026-01-01', expiryDate: TODAY })] }).status
    ).toBe(PROJECTION_STATUS.EXPIRING)
  })
})

describe('2. expiring member', () => {
  it('is expiring inside the seven-day window', () => {
    const out = derive({ memberships: [period({ expiryDate: '2026-03-15' })] })
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRING)
    expect(out.expiringWithinDays).toBe(5)
  })

  it('treats the threshold as inclusive at seven days and exclusive at eight', () => {
    expect(EXPIRING_WITHIN_DAYS).toBe(7)
    expect(derive({ memberships: [period({ expiryDate: '2026-03-17' })] }).status).toBe(
      PROJECTION_STATUS.EXPIRING
    )
    expect(derive({ memberships: [period({ expiryDate: '2026-03-18' })] }).status).toBe(
      PROJECTION_STATUS.ACTIVE
    )
  })

  it('counts the expiry day itself as expiring, not as already lapsed', () => {
    const out = derive({ memberships: [period({ expiryDate: TODAY })] })
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRING)
    expect(out.expiringWithinDays).toBe(0)
  })
})

describe('3. expired member', () => {
  it('is expired and still carries the last real period dates', () => {
    // Nulling these is the bug documented in utils/membershipPeriods.js: a member
    // with no readable expiry vanished from the dashboard's expiring list.
    const out = derive({
      memberships: [period({ startDate: '2025-01-01', expiryDate: '2025-12-31' })],
    })
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(out.hasCurrentPeriod).toBe(false)
    expect(out.periodBasis).toBe('past')
    expect(out.membershipStart).toBe('2025-01-01')
    expect(out.effectiveExpiry).toBe('2025-12-31')
    expect(out.expiringWithinDays).toBeLessThan(0)
  })

  it('is expired the day after the expiry', () => {
    expect(
      derive({ memberships: [period({ startDate: '2026-01-01', expiryDate: '2026-03-09' })] }).status
    ).toBe(PROJECTION_STATUS.EXPIRED)
  })

  it('reports the newest ended period when several have lapsed', () => {
    const out = derive({
      memberships: [
        period({ id: 'old', startDate: '2024-01-01', expiryDate: '2024-12-31' }),
        period({ id: 'new', startDate: '2025-01-01', expiryDate: '2025-12-31' }),
      ],
    })
    expect(out.periodId).toBe('new')
    expect(out.effectiveExpiry).toBe('2025-12-31')
  })
})

describe('4. frozen and active member', () => {
  const FROZEN = freeze({ startDate: '2026-03-01', expiryDate: '2026-03-20' })

  it('is active AND frozen at the same time', () => {
    // Frozen is orthogonal to membership currency. It is not a fourth status.
    const out = derive({ memberships: [period()], freezes: [FROZEN] })
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
    expect(out.isFrozen).toBe(true)
    expect(out.hasCurrentPeriod).toBe(true)
  })

  it('extends the effective expiry without touching the original', () => {
    const out = derive({ memberships: [period()], freezes: [FROZEN] })
    // 03-01..03-20 is 20 frozen days added to the original 30 June expiry.
    expect(out.effectiveExpiry).toBe('2026-07-20')
    expect(out.freezeUntil).toBe('2026-03-20')
  })

  it('stops reporting frozen once the freeze has lifted, while staying active', () => {
    // A member frozen to 20 March whose entitlement runs to 9 April is still
    // frozen on 10 March but not on the 21st. isFrozen and freezeUntil answer
    // different questions and both have to be right.
    const out = derive({
      memberships: [period()],
      freezes: [FROZEN],
      today: '2026-03-21',
    })
    expect(out.isFrozen).toBe(false)
    expect(out.freezeUntil).toBe('2026-03-20')
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
  })
})

describe('5. future / prepaid period', () => {
  const RUNNING = period({ id: 'now', startDate: '2026-01-01', expiryDate: '2026-03-20' })
  const PREPAID = period({ id: 'later', startDate: '2026-04-01', expiryDate: '2026-06-30' })

  it('does not let a prepaid period mask the period actually running', () => {
    const out = derive({ memberships: [PREPAID, RUNNING] })
    expect(out.periodId).toBe('now')
    expect(out.effectiveExpiry).toBe('2026-03-20')
    expect(out.expiringWithinDays).toBe(10)
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
  })

  it('does not use a future period as the expiry basis for a lapsed member', () => {
    const out = derive({
      memberships: [period({ id: 'old', startDate: '2025-01-01', expiryDate: '2025-12-31' }), PREPAID],
    })
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(out.periodId).toBe('old')
    expect(out.effectiveExpiry).toBe('2025-12-31')
  })

  it('projects nothing at all when the only period has not started', () => {
    // Prepaid is not entitlement. Reporting this member as active would invent
    // access the documents do not grant.
    const out = derive({ memberships: [PREPAID] })
    expect(out.status).toBeNull()
    expect(out.hasCurrentPeriod).toBe(false)
    expect(out.periodBasis).toBeNull()
    expect(out.periodId).toBeNull()
    expect(out.membershipStart).toBeNull()
    expect(out.effectiveExpiry).toBeNull()
    expect(out.expiringWithinDays).toBeNull()
  })
})

describe('6. no membership period', () => {
  it('projects an empty record rather than inventing an active member', () => {
    for (const memberships of [[], null, undefined, 'nonsense', [null, undefined]]) {
      const out = derive({ memberships })
      expect(out.status).toBeNull()
      expect(out.hasCurrentPeriod).toBe(false)
      expect(out.membershipStart).toBeNull()
      expect(out.effectiveExpiry).toBeNull()
      expect(out.freezeUntil).toBeNull()
      expect(out.isFrozen).toBe(false)
    }
  })

  it('projects nothing for a missing member id', () => {
    const out = derive({ memberId: undefined, memberships: [period()] })
    expect(out.memberId).toBeNull()
    expect(out.status).toBeNull()
  })

  it('never answers for another member', () => {
    const out = derive({ memberId: 'm1', memberships: [period({ memberId: 'm2' })] })
    expect(out.status).toBeNull()
  })
})

describe('7. malformed membership period', () => {
  const MALFORMED = {
    'no dates at all': { startDate: undefined, expiryDate: undefined },
    'unparseable dates': { startDate: 'not-a-date', expiryDate: 'also-not' },
    'missing expiry': { expiryDate: undefined },
    'missing start': { startDate: undefined },
    'expiry before start': { startDate: '2026-06-30', expiryDate: '2026-01-01' },
  }

  it('is never promoted to current, and never reported as live', () => {
    for (const [label, over] of Object.entries(MALFORMED)) {
      const out = derive({ memberships: [period(over)] })
      expect(out.hasCurrentPeriod, label).toBe(false)
      // The safe direction for a row nobody can interpret: never active, never
      // expiring, never a current period. Granting access is the failure that
      // cannot be undone; a wrong expiry is visible and correctable.
      expect(out.status, label).not.toBe(PROJECTION_STATUS.ACTIVE)
      expect(out.status, label).not.toBe(PROJECTION_STATUS.EXPIRING)
    }
  })

  it('projects nothing at all for a period whose dates cannot be read', () => {
    for (const label of ['no dates at all', 'unparseable dates', 'missing expiry', 'missing start']) {
      const out = derive({ memberships: [period(MALFORMED[label])] })
      expect(out.status, label).toBeNull()
      expect(out.effectiveExpiry, label).toBeNull()
      expect(out.membershipStart, label).toBeNull()
      expect(out.periodId, label).toBeNull()
    }
  })

  it('reports an inverted period as lapsed, never as running', () => {
    // startDate after expiryDate is a corrupt row. `resolvePeriodState` already
    // refuses to make it current, and all that is left to report is that its
    // expiry is in the past - which is both true and harmless. What matters is
    // pinned here: it can never read as active.
    const out = derive({ memberships: [period(MALFORMED['expiry before start'])] })
    expect(out.hasCurrentPeriod).toBe(false)
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(out.effectiveExpiry).toBe('2026-01-01')
  })

  it('does not let a malformed period corrupt a real one', () => {
    const out = derive({
      memberships: [
        period({ id: 'ms-bad', startDate: 'nonsense', expiryDate: 'also-nonsense' }),
        period({ id: 'ms-2', startDate: '2026-03-01', expiryDate: '2026-08-01' }),
      ],
    })
    expect(out.periodId).toBe('ms-2')
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
  })

  it('ignores malformed freezes instead of failing or widening the expiry', () => {
    const out = derive({
      memberships: [period()],
      freezes: [
        { id: 'bad-1', kind: 'freeze', memberId: 'm1', periodId: 'ms-1' },
        { id: 'bad-2', kind: 'freeze', memberId: 'm1', periodId: 'ms-1', startDate: 'x', expiryDate: 'y' },
        null,
        'nonsense',
      ],
    })
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
    expect(out.effectiveExpiry).toBe('2026-06-30')
    expect(out.freezeUntil).toBeNull()
  })
})

describe('8. multiple periods', () => {
  it('selects the period covering today out of a full history', () => {
    const out = derive({
      memberships: [
        period({ id: 'p1', startDate: '2024-01-01', expiryDate: '2024-12-31' }),
        period({ id: 'p2', startDate: '2025-01-01', expiryDate: '2025-12-31' }),
        period({ id: 'p3', startDate: '2026-02-01', expiryDate: '2026-04-30' }),
      ],
    })
    expect(out.periodId).toBe('p3')
    expect(out.membershipStart).toBe('2026-02-01')
    expect(out.effectiveExpiry).toBe('2026-04-30')
  })

  it('is independent of the order the collection arrives in', () => {
    const all = [
      period({ id: 'p1', startDate: '2025-01-01', expiryDate: '2025-12-31' }),
      period({ id: 'p2', startDate: '2026-02-01', expiryDate: '2026-04-30' }),
      period({ id: 'p3', startDate: '2026-08-01', expiryDate: '2026-11-30' }),
    ]
    const forward = derive({ memberships: all })
    const reversed = derive({ memberships: [...all].reverse() })
    const shuffled = derive({ memberships: [all[2], all[0], all[1]] })
    expect(reversed).toEqual(forward)
    expect(shuffled).toEqual(forward)
  })

  it('does not leak another member periods in', () => {
    const out = derive({
      memberships: [
        period({ id: 'mine', startDate: '2026-02-01', expiryDate: '2026-04-30' }),
        period({ id: 'theirs', memberId: 'm2', startDate: '2026-01-01', expiryDate: '2026-12-31' }),
      ],
    })
    expect(out.periodId).toBe('mine')
    expect(out.effectiveExpiry).toBe('2026-04-30')
  })
})

describe('9. multiple periods flagged current', () => {
  const OVERLAPPING = [
    period({ id: 'a', startDate: '2026-01-01', expiryDate: '2026-06-30' }),
    period({ id: 'b', startDate: '2026-02-01', expiryDate: '2026-05-31' }),
  ]

  it('picks exactly one, deterministically, whichever way round they arrive', () => {
    // Overlapping periods are rejected at write time by findOverlappingPeriods,
    // but legacy data can contain them. "The current period" must still be a
    // single, stable answer or it would flap between renders.
    const state = resolvePeriodState(OVERLAPPING, { today: TODAY, timezone: TZ })
    expect(state.current.id).toBe('b')

    const forward = derive({ memberships: OVERLAPPING })
    const reversed = derive({ memberships: [...OVERLAPPING].reverse() })
    expect(forward.periodId).toBe('b')
    expect(reversed).toEqual(forward)
  })

  it('ignores a stored isCurrent flag entirely', () => {
    // A `isCurrent: true` field on a document is data, not authority. Authority
    // is the date interval, so a lapsed period that still claims to be current
    // resolves as lapsed.
    const flagged = derive({
      memberships: [period({ id: 'flagged', startDate: '2024-01-01', expiryDate: '2024-12-31', isCurrent: true })],
    })
    expect(flagged.hasCurrentPeriod).toBe(false)
    expect(flagged.status).toBe(PROJECTION_STATUS.EXPIRED)
  })

  it('is not swayed by a stored isCurrent:false on the period that does cover today', () => {
    const out = derive({ memberships: [period({ isCurrent: false })] })
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
    expect(out.periodId).toBe('ms-1')
  })
})

describe('10. future period incorrectly marked current', () => {
  it('is not promoted even when it claims to be current', () => {
    const out = derive({
      memberships: [
        period({ id: 'stale', startDate: '2025-01-01', expiryDate: '2025-12-31', isCurrent: true }),
        period({ id: 'future', startDate: '2026-06-01', expiryDate: '2026-08-31', isCurrent: true }),
      ],
    })
    expect(out.periodId).toBe('stale')
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRED)
  })

  it('becomes the basis on its own start date, with no writer involved', () => {
    const prepaid = period({ id: 'future', startDate: '2026-06-01', expiryDate: '2026-08-31' })
    expect(derive({ memberships: [prepaid] }).status).toBeNull()
    expect(derive({ memberships: [prepaid], today: '2026-06-01' }).status).toBe(
      PROJECTION_STATUS.ACTIVE
    )
  })
})

describe('11. one freeze', () => {
  it('adds exactly the anchored duration to the expiry', () => {
    const out = derive({
      memberships: [period({ startDate: '2026-01-01', expiryDate: '2026-06-30' })],
      freezes: [freeze({ startDate: '2026-05-01', expiryDate: '2026-05-10' })],
    })
    // 05-01..05-10 is 10 frozen days.
    expect(out.effectiveExpiry).toBe('2026-07-10')
    expect(out.freezeUntil).toBe('2026-05-10')
  })

  it('ignores a freeze recorded against a different member', () => {
    const out = derive({
      memberships: [period()],
      freezes: [freeze({ memberId: 'm2' })],
    })
    expect(out.effectiveExpiry).toBe('2026-06-30')
    expect(out.freezeUntil).toBeNull()
  })

  it('ignores a freeze recorded against a different period', () => {
    const out = derive({
      memberships: [period()],
      freezes: [freeze({ periodId: 'ms-other' })],
    })
    expect(out.effectiveExpiry).toBe('2026-06-30')
  })

  it('does not read as frozen before the freeze has begun', () => {
    // A freeze recorded for next month grants nothing today. Reporting the member
    // as frozen now would let a planned suspension look like an active one.
    const out = derive({
      memberships: [period()],
      freezes: [freeze({ startDate: '2026-04-01', expiryDate: '2026-04-10' })],
      today: '2026-03-10',
    })
    expect(out.freezeUntil).toBe('2026-04-10')
    expect(out.isFrozen).toBe(false)
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
  })
})

describe('12. multiple freezes', () => {
  it('sums disjoint freezes', () => {
    const out = derive({
      memberships: [period({ startDate: '2026-01-01', expiryDate: '2026-06-30' })],
      freezes: [
        freeze({ id: 'f1', startDate: '2026-02-01', expiryDate: '2026-02-10' }),
        freeze({ id: 'f2', startDate: '2026-04-01', expiryDate: '2026-04-05' }),
      ],
    })
    // 10 + 5 frozen days.
    expect(out.effectiveExpiry).toBe('2026-07-15')
    expect(out.freezeUntil).toBe('2026-04-05')
  })

  it('never double-counts overlapping intervals', () => {
    const out = derive({
      memberships: [period({ startDate: '2026-01-01', expiryDate: '2026-06-30' })],
      freezes: [
        freeze({ id: 'f1', startDate: '2026-02-01', expiryDate: '2026-02-20' }),
        freeze({ id: 'f2', startDate: '2026-02-10', expiryDate: '2026-03-05' }),
      ],
    })
    // 02-01..03-05 is 33 days inclusive, counted once — not 20 + 24.
    expect(out.effectiveExpiry).toBe('2026-08-02')
    expect(out.freezeUntil).toBe('2026-03-05')
  })

  it('never double-counts adjacent intervals recorded as two freezes', () => {
    const out = derive({
      memberships: [period({ startDate: '2026-01-01', expiryDate: '2026-06-30' })],
      freezes: [
        freeze({ id: 'f1', startDate: '2026-02-01', expiryDate: '2026-02-10' }),
        freeze({ id: 'f2', startDate: '2026-02-11', expiryDate: '2026-02-20' }),
      ],
    })
    expect(out.effectiveExpiry).toBe('2026-07-20')
  })
})

describe('13. cancelled freeze', () => {
  it('stops counting a freeze that a cancellation record voided', () => {
    const out = derive({
      memberships: [period()],
      freezes: [freeze(), cancellation()],
    })
    expect(out.effectiveExpiry).toBe('2026-06-30')
    expect(out.freezeUntil).toBeNull()
    expect(out.isFrozen).toBe(false)
  })

  it('leaves the other freezes counted', () => {
    const out = derive({
      memberships: [period()],
      freezes: [
        freeze({ id: 'f1', startDate: '2026-02-01', expiryDate: '2026-02-10' }),
        freeze({ id: 'f2', startDate: '2026-04-01', expiryDate: '2026-04-05' }),
        cancellation({ id: 'f2-c', cancelsFreezeId: 'f2' }),
      ],
    })
    expect(out.effectiveExpiry).toBe('2026-07-10')
    expect(out.freezeUntil).toBe('2026-02-10')
  })

  it('never mutates the freeze records it reads', () => {
    const freezes = [freeze(), cancellation()]
    const snapshot = JSON.stringify(freezes)
    derive({ memberships: [period()], freezes })
    expect(JSON.stringify(freezes)).toBe(snapshot)
  })
})

describe('14. freeze crossing the original expiry', () => {
  const P = period({ startDate: '2026-06-01', expiryDate: '2026-06-30' })
  const CROSSING = freeze({ startDate: '2026-06-20', expiryDate: '2026-07-14' })

  it('counts the whole freeze, including the days beyond the expiry', () => {
    const out = derive({ memberships: [P], freezes: [CROSSING], today: '2026-06-25' })
    // 06-20..07-14 is 25 days; the post-expiry part is the payable tail, not a
    // write-off, so it must appear in the effective expiry.
    expect(out.effectiveExpiry).toBe('2026-07-25')
    expect(out.freezeUntil).toBe('2026-07-14')
  })

  it('keeps a member current past their original expiry', () => {
    const out = derive({ memberships: [P], freezes: [CROSSING], today: '2026-07-10' })
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
    expect(out.hasCurrentPeriod).toBe(true)
    expect(out.isFrozen).toBe(true)
  })

  it('expires them once the whole freeze has elapsed', () => {
    // The effective expiry is itself inclusive, so the member holds the period
    // through 25 July and is lapsed the day after.
    expect(
      derive({ memberships: [P], freezes: [CROSSING], today: '2026-07-25' }).status
    ).toBe(PROJECTION_STATUS.EXPIRING)
    const lapsed = derive({ memberships: [P], freezes: [CROSSING], today: '2026-07-26' })
    expect(lapsed.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(lapsed.effectiveExpiry).toBe('2026-07-25')
  })
})

describe('15. freeze beginning after expiry', () => {
  const P = period({ startDate: '2026-06-01', expiryDate: '2026-06-30' })

  it('counts zero and changes nothing', () => {
    const out = derive({
      memberships: [P],
      freezes: [freeze({ startDate: '2026-07-05', expiryDate: '2026-07-15' })],
      today: '2026-06-15',
    })
    // The freeze suspended nothing, so it cannot manufacture time.
    expect(out.effectiveExpiry).toBe('2026-06-30')
    expect(out.freezeUntil).toBeNull()
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
  })

  it('does not resurrect an expired member', () => {
    const out = derive({
      memberships: [P],
      freezes: [freeze({ startDate: '2026-07-05', expiryDate: '2026-07-15' })],
      today: '2026-07-10',
    })
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(out.hasCurrentPeriod).toBe(false)
  })

  it('credits a freeze that begins exactly on the expiry', () => {
    const out = derive({
      memberships: [P],
      freezes: [freeze({ startDate: '2026-06-30', expiryDate: '2026-07-10' })],
      today: '2026-06-15',
    })
    // 06-30 is still entitlement, so anchoring counts the full 11 days.
    expect(out.effectiveExpiry).toBe('2026-07-11')
  })
})

describe('16. timezone-sensitive date boundary', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves an instant against the GYM day, not the server or device day', () => {
    vi.useFakeTimers()
    // 18:30Z is the next calendar day in Kolkata (+5:30) and the same day in
    // Los Angeles (-7). Reading it on the wrong calendar is how a renewal taken
    // after midnight at the desk gets filed under the previous day.
    vi.setSystemTime(new Date('2026-03-10T18:30:00.000Z'))
    expect(gymTodayKey('Asia/Kolkata')).toBe('2026-03-11')
    expect(gymTodayKey('America/Los_Angeles')).toBe('2026-03-10')
  })

  it('changes the projected status across the boundary for the same instant', () => {
    const memberships = [period({ startDate: '2026-01-01', expiryDate: '2026-03-10' })]
    const ist = '2026-03-10T18:30:00.000Z'

    const kolkata = derive({ memberships, timezone: 'Asia/Kolkata', today: ist })
    const la = derive({ memberships, timezone: 'America/Los_Angeles', today: ist })

    expect(kolkata.today).toBe('2026-03-11')
    expect(kolkata.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(la.today).toBe('2026-03-10')
    expect(la.status).toBe(PROJECTION_STATUS.EXPIRING)
  })

  it('never shifts a stored calendar date by reinterpreting it as an instant', () => {
    // `new Date('2026-03-10')` is UTC midnight, which is the PREVIOUS day in
    // Auckland. A stored date-only expiry must survive every zone unchanged.
    for (const timezone of ['Pacific/Auckland', 'Asia/Kolkata', 'UTC', 'America/Los_Angeles']) {
      const out = derive({ memberships: [period({ expiryDate: '2026-06-30' })], timezone })
      expect(out.effectiveExpiry, timezone).toBe('2026-06-30')
      expect(out.membershipStart, timezone).toBe('2026-01-01')
    }
  })

  it('defaults to the gym default zone for a blank or unknown timezone', () => {
    const memberships = [period()]
    const blank = derive({ memberships, timezone: '   ' })
    const unknown = derive({ memberships, timezone: 'Not/AZone' })
    expect(blank.timezone).toBe('Asia/Kolkata')
    expect(unknown.timezone).toBe('Asia/Kolkata')
  })

  it('answers nothing at all when today cannot be resolved', () => {
    // Every status is relative to a day, so with no usable day the honest answer
    // is that the engine knows nothing — not that the member is inactive.
    const out = derive({ memberships: [period()], today: 'not-a-day' })
    expect(out.today).toBe('')
    expect(out.status).toBeNull()
    expect(out.effectiveExpiry).toBeNull()
  })
})

describe('17. PT member', () => {
  it('reads the PT flag from the period snapshot, not from the member', () => {
    const out = derive({ memberships: [period({ isPT: true, ptSurcharge: 500 })] })
    expect(out.isPT).toBe(true)
    expect(out.status).toBe(PROJECTION_STATUS.ACTIVE)
  })

  it('reports a non-PT period as not PT', () => {
    expect(derive({ memberships: [period({ isPT: false })] }).isPT).toBe(false)
    expect(derive({ memberships: [period()] }).isPT).toBe(false)
  })

  it('does not let a PT surcharge change the dates or the status', () => {
    const plain = derive({ memberships: [period()] })
    const pt = derive({ memberships: [period({ isPT: true, ptSurcharge: 5000, basePrice: 1 })] })
    expect(pt.effectiveExpiry).toBe(plain.effectiveExpiry)
    expect(pt.membershipStart).toBe(plain.membershipStart)
    expect(pt.status).toBe(plain.status)
    expect(pt.expiringWithinDays).toBe(plain.expiringWithinDays)
  })
})

describe('18/19. payment state is not authority', () => {
  const paid = period({ price: 3500, amountPaid: 3500, amountDue: 0, paymentStatus: 'paid' })
  const partial = period({ price: 3500, amountPaid: 2000, amountDue: 1500, paymentStatus: 'partial' })
  const unpaid = period({ price: 3500, amountPaid: 0, amountDue: 3500, paymentStatus: 'due' })

  it('projects a partly-paid current period exactly like a paid one', () => {
    // Entitlement comes from the period the member bought. The balance is a
    // receivables question owned by utils/dues.js, and duplicating it here would
    // create a second answer that eventually disagrees with the ledger.
    expect(derive({ memberships: [partial] })).toEqual(derive({ memberships: [paid] }))
  })

  it('projects an unpaid current period exactly like a paid one', () => {
    expect(derive({ memberships: [unpaid] })).toEqual(derive({ memberships: [paid] }))
  })

  it('exposes no money at all', () => {
    const out = derive({ memberships: [partial] })
    for (const key of Object.keys(out)) {
      expect(key.toLowerCase()).not.toContain('amount')
      expect(key.toLowerCase()).not.toContain('paid')
      expect(key.toLowerCase()).not.toContain('due')
      expect(key.toLowerCase()).not.toContain('price')
      expect(key.toLowerCase()).not.toContain('currency')
    }
  })
})

describe('the projection composes the canonical helpers', () => {
  const P = period({ startDate: '2026-06-01', expiryDate: '2026-06-30' })
  const F = [freeze({ startDate: '2026-06-20', expiryDate: '2026-07-14' })]
  // Evaluated from inside the period, so the projection has a basis to report.
  const INSIDE = '2026-06-25'

  it('takes effectiveExpiry from effectiveExpiryKey, not a local calculation', () => {
    const out = derive({ memberships: [P], freezes: F, today: INSIDE })
    expect(out.effectiveExpiry).toBe(effectiveExpiryKey(P, F))
  })

  it('takes freezeUntil from freezeUntilKey', () => {
    const out = derive({ memberships: [P], freezes: F, today: INSIDE })
    expect(out.freezeUntil).toBe(freezeUntilKey(P, F))
    expect(out.freezeUntil).not.toBe(out.effectiveExpiry)
  })

  it('takes isFrozen from the anchored ranges, so a cancelled freeze cannot read as frozen', () => {
    const withFreeze = derive({ memberships: [P], freezes: F, today: '2026-07-01' })
    expect(anchoredFreezeRanges(P, F).length).toBe(1)
    expect(withFreeze.isFrozen).toBe(true)

    const cancelled = [...F, cancellation({ cancelsFreezeId: 'fz-1' })]
    expect(anchoredFreezeRanges(P, cancelled)).toEqual([])
    const out = derive({ memberships: [P], freezes: cancelled, today: '2026-07-01' })
    expect(out.isFrozen).toBe(false)
    expect(out.freezeUntil).toBeNull()
  })

  it('takes the countdown from daysToExpiry', () => {
    const out = derive({ memberships: [P], freezes: F, today: INSIDE })
    expect(out.expiringWithinDays).toBe(daysToExpiry({ ...P, effectiveExpiry: out.effectiveExpiry }, INSIDE))
  })
})

describe('the original expiry is never rewritten', () => {
  const P = period({ startDate: '2026-06-01', expiryDate: '2026-06-30' })
  const F = [freeze({ startDate: '2026-06-20', expiryDate: '2026-07-14' })]

  it('leaves the input documents byte-identical', () => {
    const memberships = [P]
    const freezes = [...F]
    const before = JSON.stringify({ memberships, freezes })
    derive({ memberships, freezes, today: '2026-06-25' })
    expect(JSON.stringify({ memberships, freezes })).toBe(before)
    expect(memberships[0].expiryDate).toBe('2026-06-30')
    expect(memberships[0].effectiveExpiry).toBeUndefined()
  })

  it('keeps the original expiry readable alongside the derived one', () => {
    const out = derive({ memberships: [P], freezes: F, today: '2026-06-25' })
    expect(P.expiryDate).toBe('2026-06-30')
    expect(out.effectiveExpiry).toBe('2026-07-25')
    expect(out.effectiveExpiry).not.toBe(P.expiryDate)
  })

  it('adds no competing extendedExpiryDate field', () => {
    // extendedExpiryDate was explicitly rejected as a second source of truth.
    const out = derive({ memberships: [P], freezes: F, today: '2026-06-25' })
    expect(out.extendedExpiryDate).toBeUndefined()
    expect(Object.keys(out).some((k) => /extended/i.test(k))).toBe(false)
  })
})

describe('the projection never reads a stored member projection', () => {
  it('is unaffected by a member document smuggled into the arguments', () => {
    const memberships = [period()]
    const clean = derive({ memberships })
    const forged = derive({
      memberships,
      member: {
        id: 'm1',
        status: 'expired',
        membershipStart: '1999-01-01',
        effectiveExpiry: '1999-12-31',
        freezeUntil: '1999-06-30',
        isCurrent: false,
      },
    })
    expect(forged).toEqual(clean)
    expect(forged.status).toBe(PROJECTION_STATUS.ACTIVE)
    expect(forged.effectiveExpiry).toBe('2026-06-30')
  })

  it('cannot be made to report active for an expired member', () => {
    const out = derive({
      memberships: [period({ startDate: '2025-01-01', expiryDate: '2025-12-31' })],
      member: { id: 'm1', status: 'active', membershipStart: '2026-01-01', effectiveExpiry: '2026-12-31' },
    })
    expect(out.status).toBe(PROJECTION_STATUS.EXPIRED)
    expect(out.effectiveExpiry).toBe('2025-12-31')
  })
})

describe('anti-forgery guard', () => {
  it('produces identical output for identical authority and different stored projections', () => {
    // THE load-bearing test. Two calls, byte-identical memberships / freezes /
    // timezone / today, carrying opposite stored member projections. If any part
    // of the answer came from the stored projection, these would differ — which is
    // exactly the drift this engine exists to make impossible.
    const memberships = [
      period({ id: 'ms-old', startDate: '2025-01-01', expiryDate: '2025-06-30' }),
      period({ id: 'ms-now', startDate: '2026-02-01', expiryDate: '2026-04-02' }),
    ]
    const freezes = [
      freeze({ id: 'fz-1', periodId: 'ms-now', startDate: '2026-03-01', expiryDate: '2026-03-18' }),
      cancellation({ id: 'fz-2-c', periodId: 'ms-now', cancelsFreezeId: 'fz-2' }),
      freeze({ id: 'fz-2', periodId: 'ms-now', startDate: '2026-05-01', expiryDate: '2026-05-09' }),
    ]
    const authority = { memberId: 'm1', memberships, freezes, timezone: TZ, today: TODAY }

    const honest = deriveMemberProjection(authority)
    const lying = deriveMemberProjection({
      ...authority,
      member: {
        id: 'm1',
        status: 'active',
        membershipStart: '2026-01-01',
        effectiveExpiry: '2027-01-01',
        freezeUntil: '2026-12-31',
        isFrozen: true,
      },
    })
    const alsoLying = deriveMemberProjection({
      ...authority,
      member: { id: 'm1', status: 'expired', membershipStart: null, effectiveExpiry: null },
      projections: { status: 'active' },
      status: 'active',
      effectiveExpiry: '2099-12-31',
    })

    expect(lying).toEqual(honest)
    expect(alsoLying).toEqual(honest)
    expect(JSON.stringify(lying)).toBe(JSON.stringify(honest))
  })

  it('recomputes the same value when a stale projection is fed back in', () => {
    // Idempotence: projecting twice, with the first result standing in for the
    // stored projection, must not move. A projection that is not idempotent
    // cannot be safely recomputed by a writer.
    const memberships = [period()]
    const freezes = [freeze()]
    const first = derive({ memberships, freezes })
    const second = derive({ memberships, freezes, member: first })
    expect(second).toEqual(first)
  })

  it('is a pure function of its arguments alone', () => {
    const memberships = [period()]
    const freezes = [freeze()]
    const a = derive({ memberships, freezes })
    const b = derive({ memberships, freezes })
    expect(b).toEqual(a)
    expect(a).toStrictEqual(b)
  })
})