import { describe, expect, it } from 'vitest'
import { getCurrentMembershipExpiry, getMembershipExpiry, isMemberCurrent } from '@/utils/membership'

const MONTHLY = { id: 'p1', name: 'Monthly', durationDays: 30, price: 1500 }

const member = { id: 'm1', name: 'Ayesha', joinDate: '2026-07-01', membershipPlanId: 'p1' }

const period = (over = {}) => ({
  id: 'ms-1',
  memberId: 'm1',
  planId: 'p1',
  planName: 'Monthly',
  startDate: '2026-07-01',
  expiryDate: '2026-07-31',
  ...over,
})

/**
 * Every case pins `today`. Period selection depends on the current day, so a
 * test that let it float would start failing on a date nobody touched.
 */
const AT = '2026-08-15'

describe('getCurrentMembershipExpiry', () => {
  it('returns a date-only key, not a Date', () => {
    // An instant has no calendar meaning: reinterpreting it in the gym's
    // timezone can move it a day, which is how a correct stored expiry came to
    // display a day late.
    const expiry = getCurrentMembershipExpiry(member, MONTHLY, [period()], { today: AT })
    expect(typeof expiry).toBe('string')
    expect(expiry).toBe('2026-07-31')
  })

  it('prefers the period covering today over the joinDate derivation', () => {
    // joinDate + 30 days = 2026-07-31, which is the FIRST period's expiry. On
    // 2026-08-15 the second period is the one actually running, so its expiry is
    // the answer - not the joinDate derivation and not the first period.
    const memberships = [
      period(),
      period({ id: 'ms-2', startDate: '2026-07-31', expiryDate: '2026-09-30' }),
    ]
    expect(getCurrentMembershipExpiry(member, MONTHLY, memberships, { today: AT })).toBe('2026-09-30')
  })

  it('reports the running period while an earlier one is still on file', () => {
    const memberships = [
      period(),
      period({ id: 'ms-2', startDate: '2026-07-31', expiryDate: '2026-09-30' }),
    ]
    // Sanity check against the derivation, which would say 2026-07-31.
    expect(getMembershipExpiry(member, MONTHLY)).toBe('2026-07-31')
    expect(getCurrentMembershipExpiry(member, MONTHLY, memberships, { today: AT })).not.toBe('2026-07-31')
  })

  it('reflects a corrected period expiry even when joinDate is unchanged', () => {
    // Editing a period's dates never updates member.joinDate, because a period
    // is its own record. That drift made the member page and dashboard show a
    // stale expiry.
    const corrected = [period({ startDate: '2026-07-01', expiryDate: '2026-08-31' })]
    expect(getCurrentMembershipExpiry(member, MONTHLY, corrected, { today: AT })).toBe('2026-08-31')
  })

  it('orders periods by startDate, matching the ledger', () => {
    // Deliberately supplied out of order.
    const memberships = [
      period({ id: 'ms-new', startDate: '2026-07-31', expiryDate: '2026-09-30' }),
      period({ id: 'ms-old', startDate: '2026-07-01', expiryDate: '2026-07-31' }),
    ]
    expect(getCurrentMembershipExpiry(member, MONTHLY, memberships, { today: AT })).toBe('2026-09-30')
  })

  /**
   * The defect this replaced.
   *
   * The running period ends in 5 days; the member has also prepaid one starting
   * in 60. The old "newest by startDate" rule reported the prepaid period's
   * expiry, so the countdown was ~240 days, `matchesExpiryFilter(days, 'all')`
   * was false, and the member vanished from the dashboard's expiring list.
   */
  it('does not let a prepaid future period mask the running one', () => {
    const memberships = [
      period({ id: 'ms-current', startDate: '2026-08-01', expiryDate: '2026-08-20' }),
      period({ id: 'ms-future', startDate: '2026-10-14', expiryDate: '2027-01-13' }),
    ]
    expect(getCurrentMembershipExpiry(member, MONTHLY, memberships, { today: AT })).toBe('2026-08-20')
  })

  it('ignores periods belonging to another member', () => {
    const memberships = [period({ memberId: 'other', startDate: '2030-01-01', expiryDate: '2030-12-31' })]
    expect(getCurrentMembershipExpiry(member, MONTHLY, memberships, { today: AT })).toBe(
      getMembershipExpiry(member, MONTHLY)
    )
  })

  it('falls back to joinDate + duration when there are no recorded periods', () => {
    expect(getCurrentMembershipExpiry(member, MONTHLY, [], { today: AT })).toBe(
      getMembershipExpiry(member, MONTHLY)
    )
  })

  it('falls back when memberships is not an array', () => {
    expect(getCurrentMembershipExpiry(member, MONTHLY, undefined, { today: AT })).toBe(
      getMembershipExpiry(member, MONTHLY)
    )
    expect(getCurrentMembershipExpiry(member, MONTHLY, null, { today: AT })).toBe(
      getMembershipExpiry(member, MONTHLY)
    )
  })

  // A period with an unusable expiry must not blank out a resolvable one.
  it('skips periods with no usable expiry and uses the previous one', () => {
    const memberships = [
      period({ id: 'ms-1', startDate: '2026-07-01', expiryDate: '2026-07-31' }),
      period({ id: 'ms-2', startDate: '2026-07-31', expiryDate: '' }),
      period({ id: 'ms-3', startDate: '2026-07-31', expiryDate: 'not-a-date' }),
    ]
    expect(getCurrentMembershipExpiry(member, MONTHLY, memberships, { today: '2026-08-15' })).toBe('2026-07-31')
  })

  it('returns null for a member with no usable data at all', () => {
    expect(getCurrentMembershipExpiry(null, MONTHLY, [], { today: AT })).toBeNull()
    expect(getCurrentMembershipExpiry({}, MONTHLY, [], { today: AT })).toBeNull()
    expect(getCurrentMembershipExpiry(member, null, [], { today: AT })).toBeNull()
  })

  it('does not fabricate an expiry from the current time', () => {
    // An unparseable joinDate must yield null, never "today + duration".
    expect(getCurrentMembershipExpiry({ ...member, joinDate: 'not-a-date' }, MONTHLY, [], { today: AT })).toBeNull()
  })
})

describe('isMemberCurrent', () => {
  const periods = [
    { ...period(), expiryDate: '2026-09-30' }, // covers 2026-08-15
    { ...period({ id: 'ms-2' }), startDate: '2026-11-01', expiryDate: '2026-12-31' }, // future
  ]

  it('is true when a period covers today', () => {
    expect(isMemberCurrent(member, periods, { today: AT })).toBe(true)
  })

  it('is false once every period has ended', () => {
    expect(isMemberCurrent(member, periods, { today: '2027-06-01' })).toBe(false)
  })

  it('is false before the first period begins', () => {
    const futureOnly = [{ ...period(), startDate: '2026-11-01', expiryDate: '2026-12-31' }]
    expect(isMemberCurrent(member, futureOnly, { today: AT })).toBe(false)
  })

  /**
   * A legacy member with no period documents is not current. The origin-period
   * backfill is what documents them; until then this reports false, which is the
   * safe direction - it never grants access the records do not support.
   */
  it('is false for a member with no period documents', () => {
    expect(isMemberCurrent(member, [], { today: AT })).toBe(false)
    expect(isMemberCurrent(member, undefined, { today: AT })).toBe(false)
  })

  it('is false for a missing member', () => {
    expect(isMemberCurrent(null, periods, { today: AT })).toBe(false)
    expect(isMemberCurrent({}, periods, { today: AT })).toBe(false)
  })

  it('ignores periods belonging to other members', () => {
    const other = [{ ...period(), memberId: 'm2' }]
    expect(isMemberCurrent(member, other, { today: AT })).toBe(false)
  })

  it('is false when the covering period has an unusable expiry', () => {
    const broken = [{ ...period(), expiryDate: 'not-a-date' }]
    expect(isMemberCurrent(member, broken, { today: AT })).toBe(false)
  })
})