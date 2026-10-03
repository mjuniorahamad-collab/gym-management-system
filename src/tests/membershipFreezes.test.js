import { describe, expect, it } from 'vitest'
import {
  applyFreezes,
  cancelledFreezeIds,
  daysBetweenKeys,
  effectiveExpiryKey,
  findOverlappingFreezes,
  frozenDaysForPeriod,
  normalizeFreeze,
  resolveFreezeState,
  unionFrozenDays,
  validateFreezeInput,
} from '@/utils/membershipFreezes'
import { getCurrentMembershipExpiry, isMemberCurrent } from '@/utils/membership'
import { resolvePeriodState, displayExpiry } from '@/utils/membershipPeriods'

const PERIOD = {
  id: 'ms-1',
  memberId: 'm1',
  planId: 'p1',
  planName: 'Monthly',
  startDate: '2026-07-01',
  expiryDate: '2026-07-31',
}

const freeze = (over = {}) => ({
  id: 'fz-1',
  kind: 'freeze',
  memberId: 'm1',
  periodId: 'ms-1',
  startDate: '2026-07-10',
  expiryDate: '2026-07-20',
  reason: 'travel',
  ...over,
})

const cancellation = (over = {}) => ({
  id: 'fz-1-cancel',
  kind: 'cancellation',
  memberId: 'm1',
  periodId: 'ms-1',
  cancelsFreezeId: 'fz-1',
  reason: 'entered in error',
  ...over,
})

describe('daysBetweenKeys', () => {
  it('counts whole days forward and backward', () => {
    expect(daysBetweenKeys('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetweenKeys('2026-01-31', '2026-01-01')).toBe(-30)
    expect(daysBetweenKeys('2026-03-01', '2026-03-01')).toBe(0)
  })

  it('handles a leap day', () => {
    expect(daysBetweenKeys('2024-02-28', '2024-03-01')).toBe(2)
    expect(daysBetweenKeys('2023-02-28', '2023-03-01')).toBe(1)
  })

  it('is not shifted by the device timezone', () => {
    // Both operands are plain calendar dates; parsing them as local instants is
    // what produced off-by-one countdowns earlier in this codebase.
    expect(daysBetweenKeys('2026-11-01', '2026-11-02')).toBe(1)
  })

  it('returns null for unusable input', () => {
    expect(daysBetweenKeys('nope', '2026-01-01')).toBeNull()
    expect(daysBetweenKeys('2026-01-01', '')).toBeNull()
  })
})

describe('normalizeFreeze', () => {
  it('keeps a well-formed freeze', () => {
    expect(normalizeFreeze(freeze())).toMatchObject({
      id: 'fz-1',
      kind: 'freeze',
      memberId: 'm1',
      periodId: 'ms-1',
      startDate: '2026-07-10',
      expiryDate: '2026-07-20',
    })
  })

  it('accepts a single-day freeze', () => {
    expect(normalizeFreeze(freeze({ startDate: '2026-07-10', expiryDate: '2026-07-10' })).expiryDate).toBe('2026-07-10')
  })

  /**
   * A malformed row must never widen an expiry. Failing open here would hand a
   * member paid-for time nobody granted.
   */
  it('rejects a freeze with an unusable date', () => {
    expect(normalizeFreeze(freeze({ expiryDate: '' }))).toBeNull()
    expect(normalizeFreeze(freeze({ startDate: 'not-a-date' }))).toBeNull()
    expect(normalizeFreeze(freeze({ expiryDate: null }))).toBeNull()
  })

  it('rejects a freeze that ends before it starts', () => {
    expect(normalizeFreeze(freeze({ startDate: '2026-07-20', expiryDate: '2026-07-10' }))).toBeNull()
  })

  it('rejects a non-object', () => {
    expect(normalizeFreeze(null)).toBeNull()
    expect(normalizeFreeze('2026-07-01')).toBeNull()
  })

  it('accepts a cancellation with no interval of its own', () => {
    expect(normalizeFreeze(cancellation())).toMatchObject({ kind: 'cancellation', cancelsFreezeId: 'fz-1' })
  })
})

describe('unionFrozenDays', () => {
  it('counts a single inclusive interval', () => {
    expect(unionFrozenDays([{ startDate: '2026-07-01', expiryDate: '2026-07-31' }])).toBe(31)
  })

  it('counts a single day once', () => {
    expect(unionFrozenDays([{ startDate: '2026-07-05', expiryDate: '2026-07-05' }])).toBe(1)
  })

  it('counts disjoint intervals separately', () => {
    expect(
      unionFrozenDays([
        { startDate: '2026-07-01', expiryDate: '2026-07-10' },
        { startDate: '2026-07-20', expiryDate: '2026-07-25' },
      ])
    ).toBe(16)
  })

  /**
   * The overlap case that matters: two staff members record overlapping
   * suspensions. Counting both in full would grant 40 days from two 20-day
   * freezes.
   */
  it('counts an overlap once', () => {
    expect(
      unionFrozenDays([
        { startDate: '2026-07-01', expiryDate: '2026-07-20' },
        { startDate: '2026-07-15', expiryDate: '2026-08-03' },
      ])
    ).toBe(34)
  })

  it('counts fully contained intervals once', () => {
    expect(
      unionFrozenDays([
        { startDate: '2026-07-01', expiryDate: '2026-07-31' },
        { startDate: '2026-07-10', expiryDate: '2026-07-12' },
      ])
    ).toBe(31)
  })

  it('merges adjacent intervals without a gap', () => {
    expect(
      unionFrozenDays([
        { startDate: '2026-07-01', expiryDate: '2026-07-15' },
        { startDate: '2026-07-16', expiryDate: '2026-07-30' },
      ])
    ).toBe(30)
  })

  it('clips every interval to the ceiling', () => {
    expect(unionFrozenDays([{ startDate: '2026-07-01', expiryDate: '2026-07-31' }], '2026-07-10')).toBe(10)
  })

  it('drops an interval entirely after the ceiling', () => {
    expect(unionFrozenDays([{ startDate: '2026-08-01', expiryDate: '2026-08-10' }], '2026-07-31')).toBe(0)
  })

  it('ignores unusable intervals', () => {
    expect(unionFrozenDays([{ startDate: 'x' }, null, { startDate: '2026-07-01', expiryDate: '' }])).toBe(0)
    expect(unionFrozenDays('nope')).toBe(0)
    expect(unionFrozenDays([])).toBe(0)
  })
})

describe('effectiveExpiryKey', () => {
  it('returns the original expiry when there are no freezes', () => {
    expect(effectiveExpiryKey(PERIOD, [])).toBe('2026-07-31')
  })

  it('extends the expiry by the frozen days', () => {
    expect(effectiveExpiryKey(PERIOD, [freeze()])).toBe('2026-08-11')
  })

  /**
   * The membership document is never touched. What the member bought stays on
   * record; the freeze is applied on read.
   */
  it('does not modify the period it is given', () => {
    const period = { ...PERIOD }
    effectiveExpiryKey(period, [freeze()])
    expect(period.expiryDate).toBe('2026-07-31')
    expect(period.effectiveExpiry).toBeUndefined()
  })

  it('ignores a freeze belonging to another member', () => {
    expect(effectiveExpiryKey(PERIOD, [freeze({ memberId: 'm2' })])).toBe('2026-07-31')
  })

  it('ignores a freeze belonging to another period of the same member', () => {
    expect(effectiveExpiryKey(PERIOD, [freeze({ periodId: 'ms-9' })])).toBe('2026-07-31')
  })

  it('ignores a cancelled freeze', () => {
    const live = [freeze(), cancellation()]
    expect(effectiveExpiryKey(PERIOD, live)).toBe('2026-07-31')
  })

  it('honours a cancellation that targets the wrong freeze', () => {
    const live = [freeze(), cancellation({ cancelsFreezeId: 'fz-other' })]
    expect(effectiveExpiryKey(PERIOD, live)).toBe('2026-08-11')
  })

  /**
   * A freeze running past the expiry only credits the days the member actually
   * lost. They were absent 45 days but their entitlement ended on the 31st, so
   * they are absent for 31 of the days they paid for and resume on 1 October.
   */
  it('credits only the frozen days at or before the original expiry', () => {
    const spanning = freeze({ startDate: '2026-07-01', expiryDate: '2026-08-14' })
    expect(effectiveExpiryKey(PERIOD, [spanning])).toBe('2026-08-31')
  })

  /**
   * Absence after the entitlement ended is not a freeze of anything: there was
   * no paid-for time left to suspend.
   */
  it('does not extend an expiry for a freeze entirely after it', () => {
    const later = freeze({ startDate: '2026-08-10', expiryDate: '2026-08-20' })
    expect(effectiveExpiryKey(PERIOD, [later])).toBe('2026-07-31')
  })

  it('does not double-count overlapping freezes', () => {
    const both = [freeze({ id: 'a', startDate: '2026-07-01', expiryDate: '2026-07-20' }), freeze({ id: 'b', startDate: '2026-07-15', expiryDate: '2026-07-25' })]
    expect(frozenDaysForPeriod(PERIOD, both)).toBe(25)
    expect(effectiveExpiryKey(PERIOD, both)).toBe('2026-08-25')
  })

  it('returns null when the period has no usable expiry', () => {
    expect(effectiveExpiryKey({ ...PERIOD, expiryDate: '' }, [freeze()])).toBeNull()
    expect(effectiveExpiryKey(null, [freeze()])).toBeNull()
  })

  it('tolerates a non-array freezes argument', () => {
    expect(effectiveExpiryKey(PERIOD, undefined)).toBe('2026-07-31')
    expect(effectiveExpiryKey(PERIOD, null)).toBe('2026-07-31')
  })
})

describe('findOverlappingFreezes', () => {
  it('finds a freeze sharing a single day', () => {
    const found = findOverlappingFreezes([freeze()], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-20', expiryDate: '2026-07-25' })
    expect(found.map((f) => f.id)).toEqual(['fz-1'])
  })

  it('finds a freeze fully containing the candidate', () => {
    const found = findOverlappingFreezes([freeze()], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-12', expiryDate: '2026-07-13' })
    expect(found.map((f) => f.id)).toEqual(['fz-1'])
  })

  it('reports adjacency as no overlap', () => {
    const found = findOverlappingFreezes([freeze()], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-21', expiryDate: '2026-07-25' })
    expect(found).toEqual([])
  })

  it('ignores another period', () => {
    expect(findOverlappingFreezes([freeze({ periodId: 'ms-9' })], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-10', expiryDate: '2026-07-20' })).toEqual([])
  })

  it('ignores another member', () => {
    expect(findOverlappingFreezes([freeze({ memberId: 'm2' })], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-10', expiryDate: '2026-07-20' })).toEqual([])
  })

  it('can exclude the freeze being edited', () => {
    expect(findOverlappingFreezes([freeze()], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-10', expiryDate: '2026-07-20', excludeId: 'fz-1' })).toEqual([])
  })

  it('never reports a cancellation as an overlap', () => {
    expect(findOverlappingFreezes([cancellation()], { memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-10', expiryDate: '2026-07-20' })).toEqual([])
  })
})

describe('validateFreezeInput', () => {
  it('accepts a valid freeze', () => {
    const result = validateFreezeInput({ memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-10', expiryDate: '2026-07-20' })
    expect(result).toEqual({ ok: true, startDate: '2026-07-10', expiryDate: '2026-07-20' })
  })

  it('requires a member and a period', () => {
    expect(validateFreezeInput({ periodId: 'ms-1' }).ok).toBe(false)
    expect(validateFreezeInput({ memberId: 'm1' }).ok).toBe(false)
  })

  it('requires usable dates', () => {
    expect(validateFreezeInput({ memberId: 'm1', periodId: 'ms-1', startDate: '', expiryDate: '2026-07-20' }).ok).toBe(false)
    expect(validateFreezeInput({ memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-10', expiryDate: 'x' }).ok).toBe(false)
  })

  it('rejects an end date before the start date', () => {
    const result = validateFreezeInput({ memberId: 'm1', periodId: 'ms-1', startDate: '2026-07-20', expiryDate: '2026-07-10' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/end before it starts/i)
  })

  /**
   * Rejected rather than merged. Merging would produce a different interval from
   * the one on screen, and the operator could not tell which record won.
   */
  it('rejects an overlap with a live freeze', () => {
    const result = validateFreezeInput({
      memberId: 'm1',
      periodId: 'ms-1',
      startDate: '2026-07-15',
      expiryDate: '2026-07-25',
      freezes: [freeze()],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already has a freeze/i)
  })

  it('allows the interval of a freeze that was cancelled', () => {
    const result = validateFreezeInput({
      memberId: 'm1',
      periodId: 'ms-1',
      startDate: '2026-07-10',
      expiryDate: '2026-07-20',
      freezes: [freeze(), cancellation()],
    })
    expect(result.ok).toBe(true)
  })

  it('allows two freezes on different periods of the same member', () => {
    const result = validateFreezeInput({
      memberId: 'm1',
      periodId: 'ms-2',
      startDate: '2026-07-10',
      expiryDate: '2026-07-20',
      freezes: [freeze()],
    })
    expect(result.ok).toBe(true)
  })
})

describe('resolveFreezeState', () => {
  it('separates live freezes from cancellations', () => {
    const state = resolveFreezeState([freeze(), freeze({ id: 'fz-2' }), cancellation()], 'm1')
    expect(state.active.map((f) => f.id)).toEqual(['fz-2'])
    expect(state.cancellations).toHaveLength(1)
    expect(state.cancelledIds).toEqual(['fz-1'])
  })

  it('scopes to one member', () => {
    expect(resolveFreezeState([freeze(), freeze({ id: 'fz-2', memberId: 'm2' })], 'm1').active).toHaveLength(1)
  })

  it('tolerates a non-array', () => {
    expect(resolveFreezeState(undefined, 'm1').active).toEqual([])
  })

  it('exposes the cancelled ids directly', () => {
    expect([...cancelledFreezeIds([freeze(), cancellation()])]).toEqual(['fz-1'])
  })
})

describe('applyFreezes', () => {
  it('adds effectiveExpiry without touching expiryDate', () => {
    const [out] = applyFreezes([{ ...PERIOD }], [freeze()])
    expect(out.expiryDate).toBe('2026-07-31')
    expect(out.effectiveExpiry).toBe('2026-08-11')
  })

  /**
   * `effectiveExpiry` present means "a freeze moved this". Leaving it absent
   * when nothing changed keeps the derived field honest, so a reader can tell a
   * frozen period from an untouched one without recomputing.
   */
  it('leaves a period with no freeze untouched', () => {
    const [out] = applyFreezes([{ ...PERIOD }], [])
    expect(out.effectiveExpiry).toBeUndefined()
  })

  it('tolerates non-array input', () => {
    expect(applyFreezes(undefined, [])).toEqual([])
  })
})

describe('freeze-aware expiry and currency', () => {
  const member = { id: 'm1', name: 'Ayesha', membershipPlanId: 'p1' }
  const plan = { id: 'p1', name: 'Monthly', durationDays: 30, price: 1500 }
  const AT = '2026-08-05'

  it('extends the displayed expiry by the freeze', () => {
    // Without the freeze the period ended 2026-07-31 and today is 5 days past
    // it. With an 11-day freeze the member is still current.
    const expires = getCurrentMembershipExpiry(member, plan, [PERIOD], { today: AT, freezes: [freeze()] })
    expect(expires).toBe('2026-08-11')
  })

  /**
   * The member-facing consequence: a frozen member who has paid through 10
   * August must not read as expired on 5 August.
   */
  it('keeps a frozen member current past the original expiry', () => {
    expect(isMemberCurrent(member, [PERIOD], { today: AT, freezes: [freeze()] })).toBe(true)
    expect(isMemberCurrent(member, [PERIOD], { today: AT })).toBe(false)
  })

  it('stops being current once the extended expiry passes too', () => {
    expect(isMemberCurrent(member, [PERIOD], { today: '2026-08-12', freezes: [freeze()] })).toBe(false)
  })

  it('is current on the extended expiry day itself', () => {
    expect(isMemberCurrent(member, [PERIOD], { today: '2026-08-10', freezes: [freeze()] })).toBe(true)
  })

  it('reports expired again once the freeze is cancelled', () => {
    expect(isMemberCurrent(member, [PERIOD], { today: AT, freezes: [freeze(), cancellation()] })).toBe(false)
  })

  it('feeds the canonical period state', () => {
    const decorated = applyFreezes([PERIOD], [freeze()])
    const state = resolvePeriodState(decorated, { today: AT })
    expect(state.current).toBeTruthy()
    expect(displayExpiry(state)).toBe('2026-08-11')
  })

  it('ignores a malformed freeze rather than widening the expiry', () => {
    expect(isMemberCurrent(member, [PERIOD], { today: AT, freezes: [freeze({ expiryDate: '' })] })).toBe(false)
  })

  it('leaves members without period documents unaffected', () => {
    expect(isMemberCurrent(member, [], { today: AT, freezes: [freeze()] })).toBe(false)
  })
})