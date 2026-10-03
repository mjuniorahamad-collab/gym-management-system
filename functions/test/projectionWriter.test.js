/**
 * TRUSTED PROJECTION WRITER — core correctness, diff-only behaviour, idempotency,
 * failure isolation and tenant isolation.
 *
 * The projection VALUES asserted here are deliberately not re-derived by this
 * suite. `src/tests/memberProjection.test.js` owns that: it already pins the
 * engine's arithmetic with 69 tests. What is under test here is everything the
 * engine cannot see — that the writer reads the right documents, from the right
 * gym, stamps the ids the engine depends on, trusts nothing on the member
 * document, writes only real differences, and does nothing at all when it has
 * no business doing something.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { checkFreshness } from '../build.mjs'
import { desiredProjection, diffProjection, recomputeMemberProjection } from '../projection/writer.js'
import {
  GYM_A,
  GYM_B,
  TODAY,
  assertEmulatorReachable,
  cleanup,
  db,
  readMemberDoc,
  seedFreeze,
  seedGym,
  seedMember,
  seedPeriod,
} from './helpers.js'

let seq = 0
/** Unique id per test, so parallel cases cannot see each other's documents. */
const uid = (label) => `pw-${label}-${++seq}`

/** Recompute with the pinned day and zone so nothing depends on the clock. */
const project = (memberId, gymId = GYM_A) =>
  recomputeMemberProjection(db, { memberId, gymId, timezone: 'Asia/Kolkata', today: TODAY })

beforeAll(async () => {
  await assertEmulatorReachable()
  await cleanup()
})

afterEach(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
})

describe('the generated bundle is not stale', () => {
  it('vendor/projection.mjs matches the canonical engine in src/utils', async () => {
    // The deployed function runs the bundle, not src/utils. If this fails, a
    // deploy would ship last month's projection logic and every value below
    // would still pass while production quietly disagreed.
    const result = await checkFreshness()
    expect(result.fresh, result.reason).toBe(true)
  })
})

describe('projection correctness, derived from authoritative sources', () => {
  it('projects an active member from a current period', async () => {
    const memberId = uid('active')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const result = await project(memberId)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    // 16 days out, so not yet inside the 7-day window.
    expect(result.fields).toEqual({
      membershipStart: '2026-06-01',
      effectiveExpiry: '2026-07-01',
      freezeUntil: null,
      status: 'active',
    })
  })

  it('projects an expiring member inside the 7-day window', async () => {
    const memberId = uid('expiring')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-01-01',
      expiryDate: '2026-06-20',
    })

    const result = await project(memberId)
    expect(result.fields.status).toBe('expiring')
    expect(result.fields.effectiveExpiry).toBe('2026-06-20')
  })

  it('projects an expired member from the last ended period', async () => {
    const memberId = uid('expired')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-01-01',
      expiryDate: '2026-06-10',
    })

    const result = await project(memberId)
    expect(result.fields.status).toBe('expired')
    // The dates still come from that period: staff need to see the paid time
    // that ran out, and blanking them hides the member from the expiry list.
    expect(result.fields.membershipStart).toBe('2026-01-01')
    expect(result.fields.effectiveExpiry).toBe('2026-06-10')
  })

  it('keeps a frozen member active and extends the expiry by the frozen days', async () => {
    const memberId = uid('frozen')
    const periodId = uid('period')
    const freezeId = uid('freeze')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(periodId, GYM_A, memberId, { startDate: '2026-06-01', expiryDate: '2026-07-01' })
    // 14th-16th inclusive = 3 frozen days, and today (the 15th) is inside it.
    await seedFreeze(freezeId, GYM_A, memberId, {
      periodId,
      startDate: '2026-06-14',
      expiryDate: '2026-06-16',
      reason: 'travel',
    })

    const result = await project(memberId)
    // Currency and freezing are orthogonal: frozen, and still active.
    expect(result.fields.status).toBe('active')
    expect(result.fields.freezeUntil).toBe('2026-06-16')
    expect(result.fields.effectiveExpiry).toBe('2026-07-04')
  })

  it('anchors a freeze that runs past the expiry instead of dropping it', async () => {
    const memberId = uid('crossing')
    const periodId = uid('period')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(periodId, GYM_A, memberId, { startDate: '2026-06-01', expiryDate: '2026-06-20' })
    // 18th-25th = 8 frozen days, of which 5 fall beyond the original expiry.
    await seedFreeze(uid('freeze'), GYM_A, memberId, {
      periodId,
      startDate: '2026-06-18',
      expiryDate: '2026-06-25',
    })

    const result = await project(memberId)
    expect(result.fields.effectiveExpiry).toBe('2026-06-28')
    expect(result.fields.freezeUntil).toBe('2026-06-25')
  })

  it('drops a freeze that begins after the expiry has already passed', async () => {
    const memberId = uid('stranded')
    const periodId = uid('period')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(periodId, GYM_A, memberId, { startDate: '2026-06-01', expiryDate: '2026-06-20' })
    await seedFreeze(uid('freeze'), GYM_A, memberId, {
      periodId,
      startDate: '2026-06-25',
      expiryDate: '2026-06-27',
    })

    const result = await project(memberId)
    // A stretch wholly after the expiry must not manufacture paid time.
    expect(result.fields.effectiveExpiry).toBe('2026-06-20')
    expect(result.fields.freezeUntil).toBe(null)
  })

  it('honours an appended freeze cancellation', async () => {
    const memberId = uid('cancelled')
    const periodId = uid('period')
    const freezeId = uid('freeze')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(periodId, GYM_A, memberId, { startDate: '2026-06-01', expiryDate: '2026-06-20' })
    await seedFreeze(freezeId, GYM_A, memberId, {
      periodId,
      startDate: '2026-06-18',
      expiryDate: '2026-06-25',
    })
    await seedFreeze(uid('cancel'), GYM_A, memberId, {
      kind: 'cancellation',
      cancelsFreezeId: freezeId,
    })

    const result = await project(memberId)
    // This only works because the writer stamps `id` onto every snapshot: the
    // engine matches the cancellation to the freeze by id.
    expect(result.fields.effectiveExpiry).toBe('2026-06-20')
    expect(result.fields.freezeUntil).toBe(null)
  })

  it('never uses a future period as a date source', async () => {
    const memberId = uid('prepaid')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-09-01',
      expiryDate: '2026-10-01',
    })

    const result = await project(memberId)
    // Prepaid is not entitlement yet. Inventing an expiry here would put a
    // future date on a member who holds nothing.
    expect(result.fields).toEqual({
      membershipStart: null,
      effectiveExpiry: null,
      freezeUntil: null,
      status: null,
    })
  })

  it('writes no dates and no status for a member with no usable period', async () => {
    const memberId = uid('noperiod')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)

    const result = await project(memberId)
    expect(result.ok).toBe(true)
    expect(result.fields.status).toBe(null)
    expect(result.fields.effectiveExpiry).toBe(null)
  })

  it('refuses to invent an answer from a malformed period', async () => {
    const memberId = uid('malformed')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    // No expiryDate: `resolvePeriodState` discards it as unusable.
    await seedPeriod(uid('period'), GYM_A, memberId, { startDate: '2026-06-01' })

    const result = await project(memberId)
    expect(result.ok).toBe(true)
    expect(result.fields.status).toBe(null)
    expect(result.fields.effectiveExpiry).toBe(null)
    // Explicitly not a far-future expiry and not a default 'active'.
    expect(result.fields.effectiveExpiry).not.toBe('2099-12-31')
  })

  it('resolves the gym timezone from authoritative settings', async () => {
    const memberId = uid('tz')
    await seedGym(GYM_A, { timezone: 'Asia/Kolkata' })
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    // No `timezone` argument: the writer must read the gym's own setting.
    const result = await recomputeMemberProjection(db, { memberId, gymId: GYM_A, today: TODAY })
    expect(result.ok).toBe(true)
    expect(result.fields.status).toBe('active')
  })
})

describe('trust boundary — the member document is never an input', () => {
  it('overwrites a forged projection instead of believing it', async () => {
    const memberId = uid('forged')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A, {
      status: 'frozen',
      effectiveExpiry: '2099-01-01',
      membershipStart: '1999-01-01',
      freezeUntil: '2099-12-31',
    })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const result = await project(memberId)
    expect(result.fields.status).toBe('active')
    expect(result.fields.effectiveExpiry).toBe('2026-07-01')
    expect(result.fields.membershipStart).toBe('2026-06-01')
    expect(result.fields.freezeUntil).toBe(null)

    const stored = await readMemberDoc(memberId)
    expect(stored.status).toBe('active')
    expect(stored.effectiveExpiry).toBe('2026-07-01')
  })

  it('ignores authoritative documents belonging to another gym', async () => {
    const memberId = uid('crossgym')
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedMember(memberId, GYM_A)
    // A far-future period in the wrong gym, plus a freeze that would extend it.
    await seedPeriod(uid('period-b'), GYM_B, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2027-07-01',
    })
    await seedFreeze(uid('freeze-b'), GYM_B, memberId, {
      periodId: uid('period-b'),
      startDate: '2026-06-02',
      expiryDate: '2026-06-20',
    })
    await seedPeriod(uid('period-a'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const result = await project(memberId, GYM_A)
    // The engine narrows by memberId only; the gym filter is the writer's job.
    expect(result.fields.effectiveExpiry).toBe('2026-07-01')
    expect(result.fields.freezeUntil).toBe(null)
  })

  it('refuses a member that is not in the caller gym', async () => {
    const memberId = uid('tenant')
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedMember(memberId, GYM_B, { status: 'active' })
    await seedPeriod(uid('period'), GYM_B, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const result = await project(memberId, GYM_A)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('tenant-mismatch')
    // Untouched: a rejected request must never write.
    const stored = await readMemberDoc(memberId)
    expect(stored.status).toBe('active')
    expect(stored.effectiveExpiry).toBeUndefined()
  })

  it('rejects a malformed member document without writing', async () => {
    const memberId = uid('nogym')
    await seedGym(GYM_A)
    // A member with no gymId at all — legacy or half-created data.
    await db.doc(`members/${memberId}`).set({ name: memberId })

    const result = await project(memberId)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('tenant-mismatch')
  })

  it('reports a missing member rather than inventing a projection', async () => {
    const result = await project(uid('ghost'))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('member-not-found')
  })
})

describe('diff-only writes and idempotency', () => {
  it('writes nothing when the projection is already correct', async () => {
    const memberId = uid('noop')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A, {
      membershipStart: '2026-06-01',
      effectiveExpiry: '2026-07-01',
      status: 'active',
    })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const result = await project(memberId)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(result.updated).toBeUndefined()
  })

  it('produces the same projection and no second write when run twice', async () => {
    const memberId = uid('twice')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const first = await project(memberId)
    expect(first.changed).toBe(true)
    const second = await project(memberId)
    expect(second.changed).toBe(false)
    expect(second.fields).toEqual(first.fields)
  })

  it('treats an absent field and an explicit null as the same answer', async () => {
    const memberId = uid('nullish')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A)
    // A future period: the projection is legitimately all-null.
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-09-01',
      expiryDate: '2026-10-01',
    })

    // Nothing stored, nothing derived: all-null on both sides, so no write.
    expect((await project(memberId)).changed).toBe(false)

    // A stored value where null is derived IS a real disagreement.
    await db
      .doc(`members/${memberId}`)
      .update({ effectiveExpiry: '2020-01-01', status: 'expired' })
    const corrected = await project(memberId)
    expect(corrected.changed).toBe(true)
    expect(corrected.updated.sort()).toEqual(['effectiveExpiry', 'status'])

    // And it settles: a later sweep has nothing left to write.
    expect((await project(memberId)).changed).toBe(false)
  })

  it('writes only the fields that actually differ', async () => {
    const memberId = uid('partial')
    await seedGym(GYM_A)
    await seedMember(memberId, GYM_A, { status: 'active' })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const result = await project(memberId)
    expect(result.updated.sort()).toEqual(['effectiveExpiry', 'membershipStart'])
    expect(result.updated).not.toContain('status')
  })
})

describe('diffProjection in isolation', () => {
  it('reduces a matching pair to an empty patch', () => {
    const desired = desiredProjection({
      membershipStart: '2026-06-01',
      effectiveExpiry: '2026-07-01',
      freezeUntil: null,
      status: 'active',
    })
    expect(diffProjection({ ...desired }, desired)).toEqual({ patch: {}, updated: [] })
  })

  it('normalises undefined to null on both sides', () => {
    const desired = { membershipStart: null, effectiveExpiry: null, freezeUntil: null, status: null }
    expect(diffProjection({}, desired)).toEqual({ patch: {}, updated: [] })
  })

  it('flags a field the engine wants cleared', () => {
    const desired = { membershipStart: null, effectiveExpiry: null, freezeUntil: null, status: 'expired' }
    const { patch, updated } = diffProjection(
      { membershipStart: '2026-01-01', effectiveExpiry: '2026-06-10', freezeUntil: '2026-05-01', status: 'expired' },
      desired
    )
    expect(updated.sort()).toEqual(['effectiveExpiry', 'freezeUntil', 'membershipStart'])
    expect(patch).toEqual({ membershipStart: null, effectiveExpiry: null, freezeUntil: null })
  })
})