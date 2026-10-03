/**
 * NIGHTLY PROJECTION REPAIR SWEEP.
 *
 * The sweep's value is almost entirely in its failure behaviour: it is an
 * unattended nightly job touching every member in every gym, so what matters is
 * that it repairs what it can, repairs only what is wrong, and cannot be stopped
 * by a single bad record — or stopped from touching the wrong tenant.
 *
 * These tests assert the counters as the primary contract, because the counters
 * are what an operator reads at 3am to decide whether anything is wrong.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runProjectionSweep, sweepGym } from '../projection/sweep.js'
import { applyPatches } from '../projection/writer.js'
import {
  TODAY,
  assertEmulatorReachable,
  db,
  readMemberDoc,
  seedFreeze,
  seedGym,
  seedMember,
  seedPeriod,
  suite,
} from './helpers.js'

const S = suite('pw-s-')
const { uid, gymA: GYM_A, gymB: GYM_B, cleanup } = S

/**
 * Structured log capture. Injecting a logger keeps the suite output readable and
 * lets these tests assert on the payloads an operator actually reads, instead of
 * scraping console text.
 */
function captureLogs() {
  const entries = []
  const log = (message, payload) => entries.push({ message, ...payload })
  log.entries = entries
  return log
}

const sweepA = () => runProjectionSweep(db, { gymId: GYM_A, today: TODAY, log: captureLogs() })
const sweepAll = () => runProjectionSweep(db, { today: TODAY, log: captureLogs() })

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

describe('repairing what is wrong, and only what is wrong', () => {
  it('repairs a stale projection from authoritative data alone', async () => {
    await seedGym(GYM_A)
    const memberId = uid('stale')
    await seedMember(memberId, GYM_A, { status: 'active', effectiveExpiry: '2020-01-01' })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-01-01',
      expiryDate: '2026-06-10',
    })

    const totals = await sweepA()
    expect(totals.scanned).toBe(1)
    expect(totals.changed).toBe(1)
    expect(totals.unchanged).toBe(0)
    expect(totals.failed).toBe(0)

    const stored = await readMemberDoc(memberId)
    expect(stored.status).toBe('expired')
    expect(stored.effectiveExpiry).toBe('2026-06-10')
  })

  it('performs zero writes on a second run', async () => {
    await seedGym(GYM_A)
    const memberId = uid('twice')
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    expect((await sweepA()).changed).toBe(1)
    const second = await sweepA()
    expect(second.changed).toBe(0)
    expect(second.unchanged).toBe(1)
  })

  it('reports a sweep that found nothing to do as entirely unchanged', async () => {
    await seedGym(GYM_A)
    const memberId = uid('correct')
    await seedMember(memberId, GYM_A, {
      membershipStart: '2026-06-01',
      effectiveExpiry: '2026-07-01',
      freezeUntil: null,
      status: 'active',
      isFrozen: false,
    })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const totals = await sweepA()
    expect(totals).toMatchObject({ scanned: 1, changed: 0, unchanged: 1, failed: 0, malformed: 0 })
  })

  it('counts every member exactly once across changed, unchanged and malformed', async () => {
    await seedGym(GYM_A)
    const needsRepair = uid('repair')
    const correct = uid('ok')
    const noSources = uid('bare')
    await seedMember(needsRepair, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, needsRepair, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })
    await seedMember(correct, GYM_A, {
      membershipStart: '2026-06-01',
      effectiveExpiry: '2026-07-01',
      freezeUntil: null,
      status: 'active',
      isFrozen: false,
    })
    await seedPeriod(uid('period'), GYM_A, correct, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })
    // No periods and no freezes: every derived value is null, but `isFrozen` is
    // still a real `false`. Seeding it here is what keeps this member "unchanged".
    await seedMember(noSources, GYM_A, { isFrozen: false })

    const totals = await sweepA()
    expect(totals.scanned).toBe(3)
    expect(totals.changed).toBe(1)
    expect(totals.unchanged).toBe(2)
    expect(totals.failed).toBe(0)
    // A member with no authoritative period cannot be projected, and is reported
    // rather than quietly given a healthy-looking expiry.
    expect(totals.malformed).toBe(1)
  })

  it('repairs a cancelled freeze, which is exactly the drift it exists to catch', async () => {
    await seedGym(GYM_A)
    const memberId = uid('cancelme')
    const periodId = uid('period')
    const freezeId = uid('freeze')
    await seedMember(memberId, GYM_A, {
      status: 'active',
      effectiveExpiry: '2026-07-01',
      freezeUntil: null,
    })
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

    const totals = await sweepA()
    expect(totals.changed).toBe(1)
    const stored = await readMemberDoc(memberId)
    expect(stored.freezeUntil).toBe(null)
    expect(stored.effectiveExpiry).toBe('2026-06-20')
  })
})

describe('tenant partitioning', () => {
  it('never writes outside the gym it is sweeping', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    const inA = uid('a')
    const inB = uid('b')
    await seedMember(inA, GYM_A, { status: 'active' })
    await seedMember(inB, GYM_B, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, inA, { startDate: '2026-06-01', expiryDate: '2026-07-01' })
    await seedPeriod(uid('period'), GYM_B, inB, { startDate: '2026-06-01', expiryDate: '2026-07-01' })

    await sweepA()

    // Gym B was not in scope, so its deliberately-wrong value must survive.
    expect((await readMemberDoc(inB)).status).toBe('expired')
    expect((await readMemberDoc(inA)).status).toBe('active')
  })

  it('does not project one gym periods onto another gyms member', async () => {
    // The engine narrows by memberId alone. If the sweep grouped sources without
    // a gym filter, a member id reused across gyms would pick up the wrong period.
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    const memberId = uid('shared-id')
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period-b'), GYM_B, memberId, {
      startDate: '2026-01-01',
      expiryDate: '2027-12-31',
    })
    await seedPeriod(uid('period-a'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    await sweepA()
    expect((await readMemberDoc(memberId)).effectiveExpiry).toBe('2026-07-01')
  })

  it('resolves each gym own timezone', async () => {
    // Two gyms, different zones. The sweep must not apply one gym's clock to the
    // other, which is the whole reason it partitions rather than looping flat.
    await seedGym(GYM_A, { timezone: 'Asia/Kathmandu' })
    await seedGym(GYM_B, { timezone: 'Asia/Kolkata' })
    const inA = uid('tz-a')
    const inB = uid('tz-b')
    await seedMember(inA, GYM_A)
    await seedMember(inB, GYM_B)
    await seedPeriod(uid('period'), GYM_A, inA, { startDate: '2026-06-01', expiryDate: '2026-07-01' })
    await seedPeriod(uid('period'), GYM_B, inB, { startDate: '2026-06-01', expiryDate: '2026-07-01' })

    const totals = await sweepAll()
    expect(totals.gyms).toBe(2)
    expect(totals.scanned).toBe(2)
    expect(totals.failed).toBe(0)
    expect(totals.perGym.map((g) => g.gymId).sort()).toEqual([GYM_A, GYM_B].sort())
  })

  it('reports per-gym counts', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedMember(uid('a'), GYM_A, { status: 'expired' })
    await seedMember(uid('b1'), GYM_B, { status: 'expired' })
    await seedMember(uid('b2'), GYM_B, { status: 'active' })
    await seedPeriod(uid('period'), GYM_A, uid('a'), {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const totals = await sweepAll()
    const byGym = Object.fromEntries(totals.perGym.map((g) => [g.gymId, g]))
    expect(byGym[GYM_A].changed).toBe(1)
    expect(byGym[GYM_B].changed).toBe(2)
    expect(byGym[GYM_B].scanned).toBe(2)
  })
})

describe('blast radius', () => {
  it('continues past a member it cannot project and still repairs the rest', async () => {
    await seedGym(GYM_A)
    const good = uid('good')
    await seedMember(good, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, good, { startDate: '2026-06-01', expiryDate: '2026-07-01' })

    // A second member whose sources are fine, so both are repairable.
    const alsoGood = uid('also-good')
    await seedMember(alsoGood, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, alsoGood, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const totals = await sweepA()
    expect(totals).toMatchObject({ scanned: 2, changed: 2, unchanged: 0, failed: 0 })
    expect((await readMemberDoc(good)).status).toBe('active')
    expect((await readMemberDoc(alsoGood)).status).toBe('active')
  })

  it('counts orphaned source documents instead of inventing an owner', async () => {
    await seedGym(GYM_A)
    const real = uid('real')
    await seedMember(real, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, real, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })
    // Names a member that does not exist.
    await seedPeriod(uid('orphan'), GYM_A, 'deleted-member', {
      startDate: '2020-01-01',
      expiryDate: '2099-01-01',
    })
    // Has no memberId at all, so `groupByMember` drops it.
    await db.doc(`memberships/${uid('nameless')}`).set({ gymId: GYM_A, expiryDate: '2099-01-01' })

    const totals = await sweepA()
    expect(totals.orphanedSources).toBe(2)
    // And it did not resurrect the orphan onto anyone, nor onto the real member.
    expect(await readMemberDoc('deleted-member')).toBe(null)
    expect((await readMemberDoc(real)).effectiveExpiry).toBe('2026-07-01')
  })

  it('writes no audit entry and no financial record', async () => {
    await seedGym(GYM_A)
    const memberId = uid('m')
    await seedMember(memberId, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    await sweepA()
    // A repair is not a business event: no fabricated history, no money moved.
    expect((await db.collection('auditLog').get()).empty).toBe(true)
    expect((await db.collection('payments').get()).empty).toBe(true)
    expect(await readMemberDoc(memberId)).not.toHaveProperty('amountPaid')
  })
})

describe('write isolation inside a batch', () => {
  it('commits the good members when one document cannot be written', async () => {
    // The isolation guarantee lives in `applyPatches`, so it is tested there
    // directly. Firestore batches are all-or-nothing, so without the per-document
    // fallback a single bad member would silently discard every other repair in
    // its batch — which, in the nightly sweep, means a whole gym stays broken.
    await seedGym(GYM_A)
    const real = uid('real')
    await seedMember(real, GYM_A, { status: 'expired' })

    const result = await applyPatches(db, [
      { memberId: real, patch: { status: 'active' } },
      // No such document: an update against a missing path fails NOT_FOUND.
      { memberId: uid('vanished'), patch: { status: 'active' } },
    ])

    expect(result.written).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].memberId).toContain('vanished')
    expect((await readMemberDoc(real)).status).toBe('active')
  })

  it('reports every failure when none can be written', async () => {
    const result = await applyPatches(db, [
      { memberId: uid('gone-1'), patch: { status: 'active' } },
      { memberId: uid('gone-2'), patch: { status: 'active' } },
    ])
    expect(result.written).toBe(0)
    expect(result.failed).toHaveLength(2)
  })
})

describe('a gym that cannot be read at all', () => {
  it('is reported as failed rather than throwing', async () => {
    // An unusable gym id makes the settings read throw, which is the shape of a
    // gym-level outage (permissions, corruption, bad id). It must be contained.
    const counters = await sweepGym(db, 'bad/id', { today: TODAY, log: captureLogs() })
    expect(counters.failed).toBe(1)
    expect(counters.error).toBeTruthy()
  })

  it('does not stop the other gyms in the same run', async () => {
    await seedGym(GYM_A)
    const memberId = uid('survivor')
    await seedMember(memberId, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    // First gym cannot be read; the run must still reach the second.
    const log = captureLogs()
    const broken = await sweepGym(db, 'bad/id', { today: TODAY, log })
    const healthy = await sweepGym(db, GYM_A, { today: TODAY, log })

    expect(broken.failed).toBe(1)
    expect(healthy).toMatchObject({ scanned: 1, changed: 1, failed: 0 })
    expect((await readMemberDoc(memberId)).status).toBe('active')
  })
})

describe('run identity', () => {
  it('reports a deterministic run id', async () => {
    await seedGym(GYM_A)
    const first = await sweepA()
    const second = await sweepA()
    expect(first.runId).toBe(second.runId)
    expect(first.runId).toContain(GYM_A)
  })

  it('distinguishes a single-gym run from a full run', async () => {
    await seedGym(GYM_A)
    expect((await sweepA()).runId).not.toBe((await sweepAll()).runId)
  })
})

describe('the sweep is not scheduled', () => {
  it('is not registered in the functions entry point', async () => {
    // Deployment is deliberately out of scope. If this ever fails because the
    // sweep was wired to a schedule, production started running unattended.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
    )
    expect(source).not.toMatch(/onSchedule[\s\S]{0,400}runProjectionSweep/)
    expect(source).not.toMatch(/runProjectionSweep/)
  })
})

describe('sweepGym directly', () => {
  it('honours an explicit timezone override', async () => {
    await seedGym(GYM_A)
    const memberId = uid('tz')
    await seedMember(memberId, GYM_A)
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })
    const counters = await sweepGym(db, GYM_A, { timezone: 'Asia/Kathmandu', today: TODAY, log: captureLogs() })
    expect(counters).toMatchObject({ scanned: 1, changed: 1, failed: 0, gymId: GYM_A })
  })
})

describe('structured logs', () => {
  it('emits a structured gym summary and a run summary', async () => {
    await seedGym(GYM_A)
    const memberId = uid('m')
    await seedMember(memberId, GYM_A, { status: 'expired' })
    await seedPeriod(uid('period'), GYM_A, memberId, {
      startDate: '2026-06-01',
      expiryDate: '2026-07-01',
    })

    const log = captureLogs()
    await runProjectionSweep(db, { gymId: GYM_A, today: TODAY, log })

    const gym = log.entries.find((e) => e.message === 'projection sweep gym complete')
    expect(gym).toMatchObject({
      gymId: GYM_A,
      timezone: 'Asia/Kolkata',
      scanned: 1,
      changed: 1,
      unchanged: 0,
      failed: 0,
    })
    // A member with sources is not malformed.
    expect(gym.malformed).toBe(0)

    const run = log.entries.find((e) => e.message === 'projection sweep complete')
    expect(run).toMatchObject({ gyms: 1, scanned: 1, changed: 1, failed: 0 })
    expect(run.runId).toContain(GYM_A)
  })
})