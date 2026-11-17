/**
 * `getDuesDriftReport` AUTHORIZATION.
 *
 * The report lives in an admin-only collection, so this callable is the only way
 * a browser reads it. The tests are about the chain, not the payload: who may
 * ask, whose gym they get, and what an empty answer looks like.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { handleGetDuesDriftReport } from '../projection/duesDriftReport.js'
import { DRIFT_REPORT_COLLECTION, DRIFT_REPORT_PREFIX } from '../projection/duesDrift.js'
import { assertEmulatorReachable, db, seedGym, seedProfile, suite } from './helpers.js'

const S = suite('pw-rpt-')
const { uid, gymA: GYM_A, gymB: GYM_B, cleanup } = S

const writeReport = (gymId, data) =>
  db.doc(`${DRIFT_REPORT_COLLECTION}/${DRIFT_REPORT_PREFIX}${gymId}`).set(data)

const clearReport = (gymId) =>
  db.doc(`${DRIFT_REPORT_COLLECTION}/${DRIFT_REPORT_PREFIX}${gymId}`).delete()

beforeAll(async () => {
  await assertEmulatorReachable()
  await cleanup()
  await clearReport(GYM_A)
  await clearReport(GYM_B)
})

afterEach(async () => {
  await cleanup()
  await clearReport(GYM_A)
  await clearReport(GYM_B)
})

afterAll(async () => {
  await cleanup()
  await clearReport(GYM_A)
  await clearReport(GYM_B)
})

describe('authorization chain', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect(handleGetDuesDriftReport({ db, auth: null })).resolves.toEqual({
      ok: false,
      reason: 'unauthenticated',
    })
  })

  it('rejects a signed-in account with no profile', async () => {
    const result = await handleGetDuesDriftReport({ db, auth: { uid: uid('ghost') } })
    expect(result).toEqual({ ok: false, reason: 'not-authorized' })
  })

  it('rejects a profile with no bound gym', async () => {
    const owner = uid('owner')
    await seedProfile(owner, { gymId: null, role: 'owner' })
    const result = await handleGetDuesDriftReport({ db, auth: { uid: owner } })
    expect(result.ok).toBe(false)
  })

  it('rejects a role without finance access', async () => {
    await seedGym(GYM_A)
    const desk = uid('desk')
    await seedProfile(desk, { gymId: GYM_A, role: 'front-desk' })
    await writeReport(GYM_A, { gymId: GYM_A, clean: true })

    const result = await handleGetDuesDriftReport({ db, auth: { uid: desk } })
    expect(result).toEqual({ ok: false, reason: 'not-authorized' })
  })
})

describe('the answer', () => {
  it('returns the caller’s own gym report to an owner', async () => {
    await seedGym(GYM_A)
    const owner = uid('owner')
    await seedProfile(owner, { gymId: GYM_A, role: 'owner' })
    const report = { gymId: GYM_A, clean: false, driftedPeriods: 2, sample: [] }
    await writeReport(GYM_A, report)

    const result = await handleGetDuesDriftReport({ db, auth: { uid: owner } })
    expect(result.ok).toBe(true)
    expect(result.report).toMatchObject(report)
  })

  it('serves admins as well as owners', async () => {
    await seedGym(GYM_A)
    const admin = uid('admin')
    await seedProfile(admin, { gymId: GYM_A, role: 'admin' })
    await writeReport(GYM_A, { gymId: GYM_A, clean: true })

    const result = await handleGetDuesDriftReport({ db, auth: { uid: admin } })
    expect(result.ok).toBe(true)
    expect(result.report.clean).toBe(true)
  })

  it('never returns another gym’s report', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    const owner = uid('owner')
    await seedProfile(owner, { gymId: GYM_A, role: 'owner' })
    await writeReport(GYM_B, { gymId: GYM_B, clean: false, driftedPeriods: 9 })

    const result = await handleGetDuesDriftReport({ db, auth: { uid: owner } })
    expect(result).toEqual({ ok: true, report: null })
  })

  it('reports “not run yet” as null, not as an error', async () => {
    await seedGym(GYM_A)
    const owner = uid('owner')
    await seedProfile(owner, { gymId: GYM_A, role: 'owner' })

    const result = await handleGetDuesDriftReport({ db, auth: { uid: owner } })
    expect(result).toEqual({ ok: true, report: null })
  })
})
