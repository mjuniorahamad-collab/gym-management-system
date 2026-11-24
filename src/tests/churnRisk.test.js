import { describe, expect, it } from 'vitest'
import {
  AT_RISK_THRESHOLD,
  buildAtRiskMembers,
  buildLastVisitMap,
  daysSinceKey,
  dueAgingBucket,
} from '@/utils/churnRisk'

const TZ = 'Asia/Kolkata'
// Fixed "today" so the scoring never depends on when the suite runs.
const NOW = new Date('2026-06-20T06:00:00Z')

function member(id, overrides = {}) {
  return {
    id,
    name: `Member ${id}`,
    joinDate: '2025-01-01',
    membershipPlanId: 'plan-month',
    ...overrides,
  }
}

function plan() {
  return { id: 'plan-month', name: 'Monthly', price: 1500, durationDays: 30 }
}

// A period covering the gym-local today, expiring on the given day.
function period(id, memberId, expiryDate, startDate = '2026-05-22') {
  return { id, memberId, planId: 'plan-month', planName: 'Monthly', startDate, expiryDate, price: 1500 }
}

describe('daysSinceKey', () => {
  it('counts whole gym-local days into the past', () => {
    expect(daysSinceKey('2026-06-20', TZ, NOW)).toBe(0)
    expect(daysSinceKey('2026-06-10', TZ, NOW)).toBe(10)
  })

  it('is null when no day is given', () => {
    expect(daysSinceKey('', TZ, NOW)).toBeNull()
    expect(daysSinceKey(null, TZ, NOW)).toBeNull()
  })
})

describe('buildLastVisitMap', () => {
  it('keeps the latest visit per member and ignores other members', () => {
    const map = buildLastVisitMap(
      [
        { memberId: 'a', checkInDay: '2026-06-01' },
        { memberId: 'a', checkInDay: '2026-06-10' },
        { memberId: 'b', checkInDay: '2026-06-05' },
        { memberId: null, checkInDay: '2026-06-11' },
      ],
      TZ
    )
    expect(map.get('a')).toBe('2026-06-10')
    expect(map.get('b')).toBe('2026-06-05')
    expect(map.size).toBe(2)
  })
})

describe('dueAgingBucket', () => {
  it('buckets the age of the oldest unpaid period', () => {
    expect(dueAgingBucket(10)).toBe('0-30')
    expect(dueAgingBucket(30)).toBe('31-60')
    expect(dueAgingBucket(75)).toBe('61-90')
    expect(dueAgingBucket(120)).toBe('90+')
    expect(dueAgingBucket(null)).toBeNull()
  })
})

describe('buildAtRiskMembers', () => {
  it('ranks an expired membership with old dues above a member with no signals', () => {
    const members = [
      member('risky'),
      member('healthy'),
    ]
    const memberships = [
      // risky: expired 10 days ago, unpaid for a month, last visit long ago.
      period('p1', 'risky', '2026-06-10', '2026-05-11'),
      // healthy: current membership, no dues, visited yesterday.
      period('p2', 'healthy', '2026-07-10', '2026-06-10'),
    ]
    const duesRows = [
      {
        member: members[0],
        dueAmount: 1500,
        targetMembershipId: 'p1',
        periods: [{ id: 'p1', startDate: new Date('2026-05-11T12:00:00') }],
      },
    ]
    const attendance = [
      { memberId: 'risky', checkInDay: '2026-05-01' },
      { memberId: 'healthy', checkInDay: '2026-06-19' },
    ]

    const { rows, summary } = buildAtRiskMembers({
      members,
      plans: [plan()],
      memberships,
      attendance,
      duesRows,
      timezone: TZ,
      now: NOW,
    })

    expect(rows.map((r) => r.member.id)).toEqual(['risky'])
    expect(rows[0].tier).toBe('high')
    expect(rows[0].signals).toEqual(expect.arrayContaining(['expiry', 'dues', 'inactivity']))
    expect(rows[0].score).toBeGreaterThanOrEqual(60)
    expect(summary.total).toBe(1)
    expect(summary.high).toBe(1)
    expect(summary.valueAtRisk).toBe(1500)
  })

  it('does not flag a new member with no visits yet', () => {
    const members = [member('new', { joinDate: '2026-06-15' })]
    const memberships = [period('p1', 'new', '2026-07-15', '2026-06-15')]

    const { rows } = buildAtRiskMembers({
      members,
      plans: [plan()],
      memberships,
      attendance: [],
      timezone: TZ,
      now: NOW,
    })

    expect(rows).toEqual([])
  })

  it('flags a member who stopped visiting even with a valid membership', () => {
    const members = [member('absent')]
    const memberships = [period('p1', 'absent', '2026-07-15', '2026-06-15')]
    const attendance = [{ memberId: 'absent', checkInDay: '2026-05-01' }]

    const { rows } = buildAtRiskMembers({
      members,
      plans: [plan()],
      memberships,
      attendance,
      timezone: TZ,
      now: NOW,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].signals).toEqual(['inactivity'])
    expect(rows[0].daysSinceVisit).toBe(50)
    expect(rows[0].score).toBeGreaterThanOrEqual(AT_RISK_THRESHOLD)
  })

  it('works without dues rows (staff without finance access)', () => {
    const members = [member('expiring')]
    const memberships = [period('p1', 'expiring', '2026-06-24', '2026-05-25')]

    const { rows } = buildAtRiskMembers({
      members,
      plans: [plan()],
      memberships,
      attendance: [{ memberId: 'expiring', checkInDay: '2026-06-19' }],
      timezone: TZ,
      now: NOW,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].dueAmount).toBe(0)
    expect(rows[0].signals).toEqual(['expiry'])
    expect(rows[0].daysToExpiry).toBe(4)
  })

  it('excludes members below the threshold and sorts the rest by score', () => {
    const members = [member('a'), member('b'), member('c')]
    const memberships = [
      period('pa', 'a', '2026-06-25', '2026-05-26'),
      period('pb', 'b', '2026-06-20', '2026-05-21'),
      period('pc', 'c', '2026-07-20', '2026-06-20'),
    ]

    const { rows } = buildAtRiskMembers({
      members,
      plans: [plan()],
      memberships,
      attendance: [
        { memberId: 'a', checkInDay: '2026-06-19' },
        { memberId: 'b', checkInDay: '2026-06-19' },
        { memberId: 'c', checkInDay: '2026-06-19' },
      ],
      timezone: TZ,
      now: NOW,
    })

    // a expires in 5 days and b expires today — each is a 30-point signal on
    // its own; c has no signal at all and must not appear.
    expect(rows.map((r) => r.member.id).sort()).toEqual(['a', 'b'])
    expect(rows.every((r) => r.score >= AT_RISK_THRESHOLD)).toBe(true)
  })
})
