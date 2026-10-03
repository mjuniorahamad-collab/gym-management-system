/**
 * `reprojectMember` — the authorization chain.
 *
 * The writer's own guarantees are covered in projectionWriter.test.js. What is
 * under test here is the door in front of it: who may ask for a recomputation,
 * on whose behalf, and what the rejection reveals.
 *
 * Every rung of the chain gets its own case, because each one is a separate way
 * for a caller to reach a member it should not reach.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  handleReprojectMember,
  reprojectMember,
  validateReprojectionRequest,
} from '../projection/reproject.js'
import { assertEmulatorReachable, db, readMemberDoc, seedGym, seedMember, seedPeriod, seedProfile, shiftDay, realToday, suite } from './helpers.js'

// Own id namespace: vitest runs this file in its own worker but against the same
// emulator as projectionWriter.test.js, and both clean up between cases.
const S = suite('pw-c-')
const { uid, gymA: GYM_A, gymB: GYM_B, cleanup } = S

/** A caller with a profile bound to `gymId`, as the callable sees them. */
const asUser = (userId) => ({ uid: userId })

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

/**
 * One gym, one caller bound to it, one member with a known-correct projection.
 *
 * Dates are relative to the real today: the callable evaluates against the real
 * clock and takes no `today` override, so a pinned date would make these cases
 * expire the day after they were written.
 */
async function scenario({ callerGym = GYM_A, memberGym = GYM_A } = {}) {
  await seedGym(GYM_A)
  await seedGym(GYM_B)
  const userId = uid('user')
  const memberId = uid('member')
  await seedProfile(userId, { gymId: callerGym })
  await seedMember(memberId, memberGym)
  const today = realToday()
  await seedPeriod(uid('period'), memberGym, memberId, {
    startDate: shiftDay(today, -14),
    // 16 days out: active, and outside the 7-day expiring window.
    expiryDate: shiftDay(today, 16),
  })
  return { userId, memberId }
}

const call = (userId, data) => handleReprojectMember({ db, auth: asUser(userId), data })

describe('payload validation', () => {
  it('accepts exactly one non-empty string memberId', () => {
    expect(validateReprojectionRequest({ memberId: 'abc' })).toBe(null)
  })

  it('rejects an empty or whitespace memberId', () => {
    expect(validateReprojectionRequest({ memberId: '' })).toBe('invalid-request')
    expect(validateReprojectionRequest({ memberId: '   ' })).toBe('invalid-request')
  })

  it('rejects a non-string memberId', () => {
    for (const memberId of [null, 42, true, {}, []]) {
      expect(validateReprojectionRequest({ memberId })).toBe('invalid-request')
    }
  })

  it('rejects a missing payload entirely', () => {
    expect(validateReprojectionRequest(undefined)).toBe('invalid-request')
    expect(validateReprojectionRequest(null)).toBe('invalid-request')
    expect(validateReprojectionRequest({})).toBe('invalid-request')
  })

  it('rejects any extra field rather than ignoring it', () => {
    // Silently dropping these would let a client believe it had influenced the
    // outcome. The dangerous one is `gymId`: a caller who assumed the server
    // honoured it would get a confident success for the wrong gym.
    expect(validateReprojectionRequest({ memberId: 'abc', gymId: GYM_B })).toBe('invalid-request')
    expect(validateReprojectionRequest({ memberId: 'abc', status: 'frozen' })).toBe('invalid-request')
    expect(validateReprojectionRequest({ memberId: 'abc', effectiveExpiry: '2099-01-01' })).toBe(
      'invalid-request'
    )
    // `today` is the subtlest of these: a client that could choose the evaluation
    // day could force any status it liked on any member in its gym.
    expect(validateReprojectionRequest({ memberId: 'abc', today: '2026-06-15' })).toBe('invalid-request')
  })

  it('rejects an absurdly long memberId before touching the database', () => {
    expect(validateReprojectionRequest({ memberId: 'x'.repeat(501) })).toBe('invalid-request')
  })
})

describe('the authorization chain, rung by rung', () => {
  it('refuses an unauthenticated caller', async () => {
    const { memberId } = await scenario()
    const result = await handleReprojectMember({ db, auth: null, data: { memberId } })
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' })
    // And it wrote nothing.
    expect((await readMemberDoc(memberId)).status).toBeUndefined()
  })

  it('refuses a caller whose profile does not exist', async () => {
    const { memberId } = await scenario()
    // A uid with no users/ document at all: not bootstrapped.
    const result = await call(uid('ghost-user'), { memberId })
    expect(result).toEqual({ ok: false, reason: 'not-authorized' })
    expect((await readMemberDoc(memberId)).status).toBeUndefined()
  })

  it('refuses a caller whose profile has no bound gym', async () => {
    const { memberId } = await scenario()
    const userId = uid('unbound')
    await seedProfile(userId, { gymId: null })
    const result = await call(userId, { memberId })
    expect(result).toEqual({ ok: false, reason: 'not-authorized' })
    expect((await readMemberDoc(memberId)).status).toBeUndefined()
  })

  it('refuses a malformed payload before resolving tenancy', async () => {
    const { userId } = await scenario()
    const result = await call(userId, { memberId: 'x', gymId: GYM_B })
    expect(result).toEqual({ ok: false, reason: 'invalid-request' })
  })

  it('lets a caller of the member own gym reproject', async () => {
    const { userId, memberId } = await scenario()
    const result = await call(userId, { memberId })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    const stored = await readMemberDoc(memberId)
    expect(stored.status).toBe('active')
    expect(stored.effectiveExpiry).toBe(shiftDay(realToday(), 16))
  })
})

describe('cross-tenant refusal, and what it is allowed to reveal', () => {
  it('refuses a member belonging to another gym', async () => {
    // Caller bound to A, member lives in B.
    const { userId, memberId } = await scenario({ callerGym: GYM_A, memberGym: GYM_B })
    const result = await call(userId, { memberId })
    expect(result).toEqual({ ok: false, reason: 'not-authorized' })
  })

  it('writes nothing when it refuses a foreign member', async () => {
    const { userId, memberId } = await scenario({ callerGym: GYM_A, memberGym: GYM_B })
    await call(userId, { memberId })
    const stored = await readMemberDoc(memberId)
    // The foreign member's own gym must not have been touched either.
    expect(stored.status).toBeUndefined()
    expect(stored.effectiveExpiry).toBeUndefined()
  })

  it('ignores a gymId the caller supplies to reach another gym', async () => {
    const { memberId } = await scenario({ callerGym: GYM_A, memberGym: GYM_B })
    const userId = uid('user')
    await seedProfile(userId, { gymId: GYM_A })

    // The caller lies in the payload. Rejected as a malformed request...
    const forged = await call(userId, { memberId, gymId: GYM_B })
    expect(forged).toEqual({ ok: false, reason: 'invalid-request' })
    // ...and even with a clean payload the gym it belongs to is not its own.
    const honest = await call(userId, { memberId })
    expect(honest).toEqual({ ok: false, reason: 'not-authorized' })
    expect((await readMemberDoc(memberId)).status).toBeUndefined()
  })

  it('gives the same answer for a foreign member and a member that does not exist', async () => {
    // The point of this test: an existence oracle. If these two answers differed,
    // the callable would let a caller enumerate the member table and learn which
    // ids are real and which gym each belongs to.
    const foreign = await scenario({ callerGym: GYM_A, memberGym: GYM_B })

    const userId = uid('user')
    await seedProfile(userId, { gymId: GYM_A })

    const onForeignMember = await call(userId, { memberId: foreign.memberId })
    const onMissingMember = await call(userId, { memberId: uid('never-existed') })

    expect(onForeignMember).toEqual(onMissingMember)
    expect(onForeignMember.reason).toBe('not-authorized')
  })

  it('gives the same answer for a foreign member and a member of no gym', async () => {
    // A legacy member with no gymId is a third "not yours" case that must not be
    // distinguishable either.
    const { userId } = await scenario()
    const legacyId = uid('legacy')
    await db.doc(`members/${legacyId}`).set({ name: 'legacy' })

    const onLegacy = await call(userId, { memberId: legacyId })
    const onForeign = await call(userId, { memberId: (await scenario({ memberGym: GYM_B })).memberId })
    expect(onLegacy).toEqual(onForeign)
  })
})

describe('trust and idempotency through the callable', () => {
  it('overwrites a forged projection on the member document', async () => {
    await seedGym(GYM_A)
    const userId = uid('user')
    const memberId = uid('forged')
    await seedProfile(userId, { gymId: GYM_A })
    await seedMember(memberId, GYM_A, {
      status: 'frozen',
      effectiveExpiry: '2099-01-01',
      freezeUntil: '2099-12-31',
    })
    const today = realToday()
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: shiftDay(today, -14),
      expiryDate: shiftDay(today, 16),
    })

    expect((await call(userId, { memberId })).ok).toBe(true)
    const stored = await readMemberDoc(memberId)
    expect(stored.status).toBe('active')
    expect(stored.effectiveExpiry).toBe(shiftDay(today, 16))
    expect(stored.freezeUntil).toBe(null)
  })

  it('is idempotent — a second call reports no change', async () => {
    const { userId, memberId } = await scenario()
    expect((await call(userId, { memberId })).changed).toBe(true)
    expect((await call(userId, { memberId })).changed).toBe(false)
  })

  it('converges after the underlying facts change, without the caller saying what they are', async () => {
    // The realistic sequence: staff cancels a freeze, then asks for a refresh.
    // The callable is told only "this member", never what changed.
    await seedGym(GYM_A)
    const userId = uid('user')
    const memberId = uid('converges')
    const periodId = uid('period')
    const freezeId = uid('freeze')
    await seedProfile(userId, { gymId: GYM_A })
    await seedMember(memberId, GYM_A)
    const today = realToday()
    const originalExpiry = shiftDay(today, 30)
    await seedPeriod(periodId, GYM_A, memberId, {
      startDate: shiftDay(today, -30),
      expiryDate: originalExpiry,
    })
    // Yesterday-tomorrow: 3 frozen days, and it covers today.
    await db.doc(`membershipFreezes/${freezeId}`).set({
      memberId,
      gymId: GYM_A,
      periodId,
      kind: 'freeze',
      startDate: shiftDay(today, -1),
      expiryDate: shiftDay(today, 1),
    })

    const before = await call(userId, { memberId })
    expect(before.changed).toBe(true)
    expect((await readMemberDoc(memberId)).freezeUntil).toBe(shiftDay(today, 1))

    // Append a cancellation, exactly as the app would.
    await db.doc(`membershipFreezes/${uid('cancel')}`).set({
      memberId,
      gymId: GYM_A,
      kind: 'cancellation',
      cancelsFreezeId: freezeId,
    })

    const after = await call(userId, { memberId })
    expect(after.changed).toBe(true)
    // Ordered by PROJECTED_FIELDS, not alphabetically.
    expect(after.updated).toEqual(['effectiveExpiry', 'freezeUntil', 'isFrozen'])
    const stored = await readMemberDoc(memberId)
    expect(stored.freezeUntil).toBe(null)
    expect(stored.effectiveExpiry).toBe(originalExpiry)
    // The cancellation must clear the FLAG too, not just the dates. Leaving
    // `isFrozen: true` here would keep the badge and the Frozen filter showing a
    // member whose freeze was explicitly voided.
    expect(stored.isFrozen).toBe(false)
  })

  it('reports isFrozen as changed when a freeze starts or ends on its own', async () => {
    const { userId, memberId } = await scenario()
    const today = realToday()
    const periodId = uid('period')
    await db.doc(`memberships/${periodId}`).set({
      gymId: GYM_A,
      memberId,
      planId: uid('plan'),
      planName: 'Monthly',
      startDate: shiftDay(today, -10),
      expiryDate: shiftDay(today, 20),
    })

    // Baseline: current, not frozen. The callable deliberately returns no `fields`,
    // so this reads the stored document rather than the response body.
    await call(userId, { memberId })
    expect((await readMemberDoc(memberId)).isFrozen).toBe(false)

    const freezeId = uid('freeze')
    await db.doc(`membershipFreezes/${freezeId}`).set({
      memberId,
      gymId: GYM_A,
      periodId,
      kind: 'freeze',
      startDate: shiftDay(today, -2),
      expiryDate: shiftDay(today, 2),
    })

    // The freeze is the ONLY reason this member's projection should change, so
    // this is what proves the flag is derived from the freeze records rather than
    // from the (unchanged) dates.
    const frozen = await call(userId, { memberId })
    const stored = await readMemberDoc(memberId)
    expect(stored.isFrozen).toBe(true)
    // Orthogonal to currency: a frozen member is still ACTIVE underneath.
    expect(stored.status).toBe('active')
    expect(frozen.updated).toContain('isFrozen')
    expect(frozen.updated).toContain('freezeUntil')
  })

  it('writes no audit or financial side effect', async () => {
    const { userId, memberId } = await scenario()
    await call(userId, { memberId })
    // Reprojection is a repair, not a business event: it must not fabricate
    // financial history or an audit trail that implies a human did something.
    expect((await db.collection('auditLog').get()).empty).toBe(true)
    expect((await db.collection('payments').get()).empty).toBe(true)
    const stored = await readMemberDoc(memberId)
    expect(stored).not.toHaveProperty('amountPaid')
  })
})

describe('the exported callable', () => {
  it('is a callable function', () => {
    // Guards against the export silently becoming a plain function, which would
    // deploy as something the SDK cannot invoke.
    expect(typeof reprojectMember).toBe('function')
    expect(reprojectMember.__endpoint).toBeDefined()
  })
})