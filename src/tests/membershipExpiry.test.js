import { describe, expect, it } from 'vitest'
import { getCurrentMembershipExpiry, getMembershipExpiry } from '@/utils/membership'

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

describe('getCurrentMembershipExpiry', () => {
  it('prefers the newest recorded period over the joinDate derivation', () => {
    // joinDate + 30 days = 2026-07-31, so this must come from the period.
    const memberships = [
      period(),
      period({
        id: 'ms-2',
        startDate: '2026-07-31',
        expiryDate: '2026-09-30',
        price: 5000,
      }),
    ]
    const expiry = getCurrentMembershipExpiry(member, MONTHLY, memberships)
    expect(expiry.getFullYear()).toBe(2026)
    expect(expiry.getMonth()).toBe(8) // September, index 8
    expect(expiry.getDate()).toBe(30)
  })

  // Editing a period's dates in the app never updates member.joinDate, because
  // a period is its own record. This is the drift that made the member page and
  // dashboard show a stale expiry.
  it('reflects a corrected period expiry even when joinDate is unchanged', () => {
    const staleJoinDate = '2026-07-01'
    const corrected = [period({ startDate: '2026-07-01', expiryDate: '2026-10-15' })]
    const expiry = getCurrentMembershipExpiry({ ...member, joinDate: staleJoinDate }, MONTHLY, corrected)
    expect(expiry.getMonth()).toBe(9) // October
    expect(expiry.getDate()).toBe(15)
  })

  it('orders periods by startDate, matching the ledger', () => {
    // Deliberately supplied out of order.
    const memberships = [
      period({ id: 'ms-new', startDate: '2026-07-31', expiryDate: '2026-09-30' }),
      period({ id: 'ms-old', startDate: '2026-07-01', expiryDate: '2026-07-31' }),
    ]
    const expiry = getCurrentMembershipExpiry(member, MONTHLY, memberships)
    expect(expiry.getMonth()).toBe(8)
    expect(expiry.getDate()).toBe(30)
  })

  it('ignores periods belonging to another member', () => {
    const memberships = [period({ memberId: 'other', startDate: '2030-01-01', expiryDate: '2030-12-31' })]
    const expiry = getCurrentMembershipExpiry(member, MONTHLY, memberships)
    expect(expiry).toEqual(getMembershipExpiry(member, MONTHLY))
  })

  it('falls back to joinDate + duration when there are no recorded periods', () => {
    const expiry = getCurrentMembershipExpiry(member, MONTHLY, [])
    expect(expiry).toEqual(getMembershipExpiry(member, MONTHLY))
  })

  it('falls back when memberships is not an array', () => {
    expect(getCurrentMembershipExpiry(member, MONTHLY, undefined)).toEqual(
      getMembershipExpiry(member, MONTHLY)
    )
    expect(getCurrentMembershipExpiry(member, MONTHLY, null)).toEqual(
      getMembershipExpiry(member, MONTHLY)
    )
  })

  // A period with an unusable expiry must not blank out a resolvable one.
  it('skips a newest period with no usable expiry and uses the previous one', () => {
    const memberships = [
      period({ id: 'ms-1', startDate: '2026-07-01', expiryDate: '2026-07-31' }),
      period({ id: 'ms-2', startDate: '2026-07-31', expiryDate: '' }),
      period({ id: 'ms-3', startDate: '2026-07-31', expiryDate: 'not-a-date' }),
    ]
    const expiry = getCurrentMembershipExpiry(member, MONTHLY, memberships)
    expect(expiry.getMonth()).toBe(6)
    expect(expiry.getDate()).toBe(31)
  })

  it('returns null for a member with no usable data at all', () => {
    expect(getCurrentMembershipExpiry(null, MONTHLY, [])).toBeNull()
    expect(getCurrentMembershipExpiry({}, MONTHLY, [])).toBeNull()
    expect(getCurrentMembershipExpiry(member, null, [])).toBeNull()
  })

  it('does not fabricate an expiry from the current time', () => {
    // An unparseable joinDate must yield null, never "today + duration".
    const result = getCurrentMembershipExpiry({ ...member, joinDate: 'not-a-date' }, MONTHLY, [])
    expect(result).toBeNull()
  })
})