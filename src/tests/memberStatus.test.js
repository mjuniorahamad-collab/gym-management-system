/**
 * A status staff can SEE on a fresh project.
 *
 * `member.status` is a server-written cache, and the projection functions are not
 * deployed. So the cases that matter are the ones this app actually produces:
 * a member with no status field at all, and a renewed member whose stored status
 * is older than the period that was just written.
 */
import { describe, expect, it } from 'vitest'
import { memberDisplayStatus } from '@/utils/memberStatus'

const TODAY = '2026-06-15'
const TIMEZONE = 'Asia/Kathmandu'

const period = (over = {}) => ({
  id: 'p1',
  memberId: 'm1',
  startDate: '2026-01-01',
  expiryDate: '2026-12-31',
  ...over,
})

const statusFor = (member, memberships, extra = {}) =>
  memberDisplayStatus({ member, memberships, timezone: TIMEZONE, today: TODAY, ...extra })

describe('members with no stored status (every member a fresh project can have)', () => {
  it('derives active from a period that covers today', () => {
    expect(statusFor({ id: 'm1', name: 'Naya' }, [period()])).toBe('active')
  })

  it('derives expiring within the last week of the period', () => {
    expect(statusFor({ id: 'm1' }, [period({ expiryDate: '2026-06-18' })])).toBe('expiring')
  })

  it('derives expired once the period has ended', () => {
    expect(statusFor({ id: 'm1' }, [period({ expiryDate: '2026-06-01' })])).toBe('expired')
  })

  it('says nothing for a member whose only period has not started (the badge shows "—")', () => {
    expect(
      statusFor({ id: 'm1' }, [period({ startDate: '2026-08-01', expiryDate: '2027-02-01' })])
    ).toBeNull()
  })

  it('ignores another member\u2019s periods', () => {
    expect(statusFor({ id: 'm1' }, [period({ memberId: 'm2' })])).toBeNull()
  })
})

describe('the periods win over a stale stored status', () => {
  it('shows active after a renewal even though the stored status says expired', () => {
    const member = { id: 'm1', status: 'expired' }
    const renewed = [
      period({ id: 'p0', startDate: '2025-01-01', expiryDate: '2026-01-01' }),
      period({ id: 'p1', startDate: '2026-01-02', expiryDate: '2027-01-02' }),
    ]

    expect(statusFor(member, renewed)).toBe('active')
  })

  it('shows expired after a lapse even though the stored status still says active', () => {
    expect(statusFor({ id: 'm1', status: 'active' }, [period({ expiryDate: '2026-06-01' })])).toBe(
      'expired'
    )
  })

  it('counts a freeze-extended expiry as still current', () => {
    const frozen = [period({ expiryDate: '2026-06-10' })]
    const freezes = [
      { id: 'f1', memberId: 'm1', periodId: 'p1', startDate: '2026-06-01', expiryDate: '2026-06-20' },
    ]

    expect(statusFor({ id: 'm1' }, frozen)).toBe('expired')
    expect(statusFor({ id: 'm1' }, frozen, { freezes })).toBe('active')
  })
})

describe('fallbacks', () => {
  it('keeps a legacy stored status when the member has no period documents', () => {
    expect(statusFor({ id: 'm1', status: 'active' }, [])).toBe('active')
  })

  it('has nothing to show for a member with neither', () => {
    expect(statusFor({ id: 'm1' }, [])).toBeNull()
  })

  it('does not throw for a missing member', () => {
    expect(statusFor(null, [])).toBeNull()
  })
})
