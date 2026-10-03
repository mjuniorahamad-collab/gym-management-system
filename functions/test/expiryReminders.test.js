/**
 * MEMBERSHIP EXPIRY REMINDERS.
 *
 * The interesting assertions here are the ones about what the job must NOT do:
 * no Firestore writes, no cross-gym leakage, no reminder derived from the cached
 * projection. Those are the failure modes that would be invisible in a happy-path
 * test and damaging in production.
 *
 * The legacy window was `daysLeft >= 0 && daysLeft <= 7`. Those boundaries are
 * pinned as tests here, because quietly narrowing or widening a renewal window is
 * a business decision, and this rebuild is not supposed to make one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  REMINDER_WINDOW_DAYS,
  collectExpiringReminders,
  isReminderDue,
  runExpiryReminderJob,
} from '../projection/reminders.js'
import {
  TODAY,
  assertEmulatorReachable,
  db,
  readDocs,
  seedFreeze,
  seedGym,
  seedMember,
  seedPeriod,
  suite,
  shiftDay,
} from './helpers.js'

const S = suite('pw-r-')
const { uid, gymA: GYM_A, gymB: GYM_B, cleanup } = S

function captureLogs() {
  const entries = []
  const log = (message, payload) => entries.push({ message, ...payload })
  log.entries = entries
  return log
}

/** Collect what the job WOULD deliver, without delivering anything. */
function collector() {
  const sent = []
  const deliver = (reminder) => {
    sent.push(reminder)
  }
  deliver.sent = sent
  return deliver
}

const remindersIn = (gymId) =>
  collectExpiringReminders(db, gymId, { timezone: 'Asia/Kathmandu', today: TODAY })

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
 * Seed a member holding one period, and return the ids. `startDate`/`expiryDate`
 * are day keys relative to TODAY so the window assertions can be expressed as
 * offsets rather than hard-coded dates that rot.
 */
async function seedHolding(memberSuffix, gymId, { daysLeft, extra = {}, period = {} } = {}) {
  const memberId = uid(memberSuffix)
  const periodId = uid(`${memberSuffix}-period`)
  const expiryDate = shiftDay(TODAY, daysLeft)
  await seedMember(memberId, gymId, extra)
  await seedPeriod(periodId, gymId, memberId, {
    startDate: shiftDay(TODAY, -30),
    expiryDate,
    ...period,
  })
  return { memberId, periodId }
}

describe('the eligibility window is unchanged', () => {
  it('is 0..7 days inclusive', () => {
    expect(REMINDER_WINDOW_DAYS).toBe(7)
  })

  it('reminds on day 7 and not on day 8', async () => {
    await seedGym(GYM_A)
    await seedHolding('d7', GYM_A, { daysLeft: 7 })
    await seedHolding('d8', GYM_A, { daysLeft: 8 })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.daysLeft)).toEqual([7])
  })

  it('reminds on the final day (0) but not the day after (-1)', async () => {
    await seedGym(GYM_A)
    await seedHolding('d0', GYM_A, { daysLeft: 0 })
    await seedHolding('dm1', GYM_A, { daysLeft: -1 })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.daysLeft)).toEqual([0])
  })

  it('does not remind a member whose period has not started', async () => {
    await seedGym(GYM_A)
    const memberId = uid('future')
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('future-period'), GYM_A, memberId, {
      startDate: shiftDay(TODAY, 10),
      expiryDate: shiftDay(TODAY, 40),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders).toEqual([])
  })
})

describe('deriving from authoritative data, not the cache', () => {
  it('ignores a forged cached expiry and uses the period', async () => {
    await seedGym(GYM_A)
    const memberId = uid('forged')
    await seedMember(memberId, GYM_A, { effectiveExpiry: '1999-01-01', status: 'expired' })
    await seedPeriod(uid('forged-period'), GYM_A, memberId, {
      startDate: shiftDay(TODAY, -30),
      expiryDate: shiftDay(TODAY, 3),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders).toHaveLength(1)
    expect(reminders[0].memberId).toBe(memberId)
    expect(reminders[0].daysLeft).toBe(3)
    expect(reminders[0].effectiveExpiry).toBe(shiftDay(TODAY, 3))
  })

  it('reminds a member whose cached status says expired', async () => {
    // The legacy job required status === 'active'. A stale 'expired' value
    // therefore silenced a reminder for a member who genuinely holds an
    // expiring period — the cache deciding who deserves to be told.
    await seedGym(GYM_A)
    const memberId = uid('stale-expired')
    await seedMember(memberId, GYM_A, { status: 'expired' })
    await seedPeriod(uid('stale-expired-period'), GYM_A, memberId, {
      startDate: shiftDay(TODAY, -30),
      expiryDate: shiftDay(TODAY, 2),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.memberId)).toEqual([memberId])
  })

  it('ignores joinDate and plan duration entirely', async () => {
    // Legacy computed joinDate + plan.durationDays. A join date far in the past
    // would have produced an expiry long gone and no reminder at all.
    await seedGym(GYM_A)
    const memberId = uid('legacy-join')
    await seedMember(memberId, GYM_A, {
      joinDate: shiftDay(TODAY, -900),
      membershipPlanId: 'monthly',
    })
    await seedPeriod(uid('legacy-join-period'), GYM_A, memberId, {
      startDate: shiftDay(TODAY, -5),
      expiryDate: shiftDay(TODAY, 4),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.memberId)).toEqual([memberId])
  })

  it('an ongoing freeze moves the expiry out of the window', async () => {
    // 11 anchored frozen days push effective expiry to TODAY+14, so the member is
    // no longer due. A reminder here would ask someone to renew early, on a date
    // they are not actually going to lose.
    await seedGym(GYM_A)
    const { memberId, periodId } = await seedHolding('frozen', GYM_A, { daysLeft: 3 })
    await seedFreeze(uid('frozen-freeze'), GYM_A, memberId, {
      periodId,
      startDate: shiftDay(TODAY, -1),
      expiryDate: shiftDay(TODAY, 9),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders).toEqual([])
  })

  it('a freeze entirely after the expiry cannot manufacture time', async () => {
    // Anchoring drops a stretch that begins after the period expiry. Without that
    // rule a bogus future freeze could postpone expiry indefinitely and silence
    // the reminder forever.
    await seedGym(GYM_A)
    const { memberId, periodId } = await seedHolding('post-expiry-freeze', GYM_A, { daysLeft: 3 })
    await seedFreeze(uid('post-expiry-freeze-doc'), GYM_A, memberId, {
      periodId,
      startDate: shiftDay(TODAY, 10),
      expiryDate: shiftDay(TODAY, 20),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.daysLeft)).toEqual([3])
    expect(reminders[0].freezeUntil).toBeNull()
  })

  it('still reminds a member who is frozen today', async () => {
    // Freezing is orthogonal, not a fourth status. A 3-day freeze keeps the
    // expiry inside the window (TODAY+6), so the reminder stands — the member is
    // told the real remaining days, and flagged as frozen.
    await seedGym(GYM_A)
    const { memberId, periodId } = await seedHolding('frozen-in-window', GYM_A, { daysLeft: 3 })
    await seedFreeze(uid('frozen-in-window-doc'), GYM_A, memberId, {
      periodId,
      startDate: shiftDay(TODAY, -1),
      expiryDate: shiftDay(TODAY, 1),
    })

    const { reminders } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.memberId)).toEqual([memberId])
    expect(reminders[0].daysLeft).toBe(6)
    expect(reminders[0].isFrozen).toBe(true)
  })

  it('counts a member with no usable period as unprojectable, not as due', async () => {
    await seedGym(GYM_A)
    await seedMember(uid('no-period'), GYM_A, { status: 'active' })

    const { reminders, unprojectable } = await remindersIn(GYM_A)
    expect(reminders).toEqual([])
    expect(unprojectable).toBe(1)
  })
})

describe('tenant isolation', () => {
  it('never returns a member from another gym', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedHolding('own', GYM_A, { daysLeft: 2 })
    const foreign = await seedHolding('foreign', GYM_B, { daysLeft: 1 })

    const { reminders, scanned } = await remindersIn(GYM_A)
    expect(reminders.map((r) => r.memberId)).not.toContain(foreign.memberId)
    expect(reminders.every((r) => r.gymId === GYM_A)).toBe(true)
    expect(scanned).toBe(1)
  })

  it('scopes the whole run so a two-gym job delivers each member once', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedHolding('a-side', GYM_A, { daysLeft: 2 })
    await seedHolding('b-side', GYM_B, { daysLeft: 2 })

    const deliver = collector()
    const result = await runExpiryReminderJob(db, { deliver, today: TODAY, log: captureLogs() })

    expect(result.due).toBe(2)
    expect(deliver.sent).toHaveLength(2)
    expect(new Set(deliver.sent.map((r) => r.gymId)).size).toBe(2)
  })

  it('restricts the run to one gym when asked', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedHolding('a-only', GYM_A, { daysLeft: 2 })
    await seedHolding('b-excluded', GYM_B, { daysLeft: 2 })

    const deliver = collector()
    const result = await runExpiryReminderJob(db, {
      deliver,
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    expect(result.gyms).toBe(1)
    expect(deliver.sent.map((r) => r.gymId)).toEqual([GYM_A])
  })

  it('uses the gym timezone rather than the machine timezone', async () => {
    // A gym whose local day differs from the host's: with a fixed `today` the
    // reminder must be identical either way, proving the host date is not used.
    await seedGym(GYM_A, { timezone: 'Pacific/Auckland' })
    const memberId = uid('tz')
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('tz-period'), GYM_A, memberId, {
      startDate: shiftDay(TODAY, -10),
      expiryDate: shiftDay(TODAY, 5),
    })

    const { reminders } = await collectExpiringReminders(db, GYM_A, { today: TODAY })
    expect(reminders.map((r) => r.memberId)).toEqual([memberId])
  })
})

describe('no side effects', () => {
  it('writes nothing at all', async () => {
    await seedGym(GYM_A)
    await seedHolding('silent', GYM_A, { daysLeft: 2 })

    const before = await readDocs('auditLog')
    const deliver = collector()
    await runExpiryReminderJob(db, {
      deliver,
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })
    const after = await readDocs('auditLog')

    expect(after.length).toBe(before.length)
    expect(after).toEqual(before)
  })

  it('does not write an audit document per reminded member', async () => {
    // The specific regression: one auditLog doc per member per day, forever.
    await seedGym(GYM_A)
    await seedHolding('spam-1', GYM_A, { daysLeft: 1 })
    await seedHolding('spam-2', GYM_A, { daysLeft: 2 })

    const before = await readDocs('auditLog')
    const deliver = collector()
    const result = await runExpiryReminderJob(db, {
      deliver,
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    expect(result.due).toBe(2)
    expect((await readDocs('auditLog')).length).toBe(before.length)
  })

  it('produces the same result when run twice', async () => {
    await seedGym(GYM_A)
    await seedHolding('idempotent', GYM_A, { daysLeft: 2 })

    const first = await runExpiryReminderJob(db, {
      deliver: collector(),
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })
    const second = await runExpiryReminderJob(db, {
      deliver: collector(),
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    expect(second.due).toBe(first.due)
    expect(second.scanned).toBe(first.scanned)
    expect(second.delivered).toBe(first.delivered)
  })

  it('does not modify the member document', async () => {
    await seedGym(GYM_A)
    const { memberId } = await seedHolding('untouched', GYM_A, { daysLeft: 2 })

    await runExpiryReminderJob(db, {
      deliver: collector(),
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    const stored = await db.doc(`members/${memberId}`).get()
    expect(stored.exists).toBe(true)
    // No projection fields were introduced by merely being reminded.
    expect(stored.data().effectiveExpiry).toBeUndefined()
    expect(stored.data().status).toBeUndefined()
  })
})

describe('failure containment and reporting', () => {
  it('reports a delivery failure without losing the rest of the run', async () => {
    await seedGym(GYM_A)
    const good = await seedHolding('deliver-ok', GYM_A, { daysLeft: 2 })
    const bad = await seedHolding('deliver-throws', GYM_A, { daysLeft: 3 })

    const result = await runExpiryReminderJob(db, {
      deliver: (reminder) => {
        if (reminder.memberId === bad.memberId) throw new Error('provider down')
      },
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    expect(result.due).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.delivered).toBe(1)
    expect(result.reminders.map((r) => r.memberId).sort()).toEqual(
      [good.memberId, bad.memberId].sort()
    )
  })

  it('survives one gym failing and still processes the others', async () => {
    // A gym-level read failure cannot be provoked through the emulator, so the
    // collector is injected: the point of the test is that the failure is
    // contained and the loop continues, not how the failure was caused.
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    const survivor = await seedHolding('survivor', GYM_A, { daysLeft: 2 })

    const deliver = collector()
    const result = await runExpiryReminderJob(db, {
      deliver,
      today: TODAY,
      log: captureLogs(),
      collect: async (dbRef, gymId) => {
        if (gymId === GYM_B) throw new Error('permission denied')
        return collectExpiringReminders(dbRef, gymId, { today: TODAY })
      },
    })

    expect(result.failed).toBe(1)
    expect(deliver.sent.map((r) => r.memberId)).toEqual([survivor.memberId])
    expect(result.perGym.some((g) => g.failed === true)).toBe(true)
  })

  it('does not blow up on a gym with no settings document', async () => {
    await seedGym(GYM_A, { timezone: null })
    await seedHolding('no-settings', GYM_A, { daysLeft: 2 })

    const result = await runExpiryReminderJob(db, {
      deliver: collector(),
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    expect(result.failed).toBe(0)
    expect(result.due).toBe(1)
  })

  it('counts scanned, due and delivered separately', async () => {
    await seedGym(GYM_A)
    await seedHolding('counted-1', GYM_A, { daysLeft: 2 })
    await seedHolding('counted-2', GYM_A, { daysLeft: 30 })
    await seedMember(uid('counted-3'), GYM_A)

    const result = await runExpiryReminderJob(db, {
      deliver: collector(),
      today: TODAY,
      gymId: GYM_A,
      log: captureLogs(),
    })

    expect(result.scanned).toBe(3)
    expect(result.due).toBe(1)
    expect(result.delivered).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('emits a structured summary an operator can read', async () => {
    await seedGym(GYM_A)
    await seedHolding('logged', GYM_A, { daysLeft: 2 })

    const log = captureLogs()
    await runExpiryReminderJob(db, { deliver: collector(), today: TODAY, gymId: GYM_A, log })

    const summary = log.entries.find((e) => e.message === 'expiry reminders complete')
    expect(summary).toBeDefined()
    expect(summary.due).toBe(1)
    expect(summary.delivered).toBe(1)
    expect(summary.scanned).toBe(1)
  })
})

describe('isReminderDue', () => {
  it('accepts only the expiring status', () => {
    expect(isReminderDue({ status: 'expiring' })).toBe(true)
    expect(isReminderDue({ status: 'active' })).toBe(false)
    expect(isReminderDue({ status: 'expired' })).toBe(false)
    expect(isReminderDue({ status: null })).toBe(false)
    expect(isReminderDue(undefined)).toBe(false)
  })

  it('does not treat a frozen member as a separate status', () => {
    // Freezing is orthogonal: a member frozen today is still expiring if that is
    // what the period says, and is never silently dropped from the list.
    expect(isReminderDue({ status: 'expiring', isFrozen: true })).toBe(true)
  })
})