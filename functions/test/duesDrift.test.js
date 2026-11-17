/**
 * DUES DRIFT RECONCILIATION JOB.
 *
 * The job's contract is narrow on purpose: it REPORTS, it never repairs. These
 * tests therefore assert both what it writes (one report document per gym, with
 * exact counts and a capped sample) and what it must not touch (no membership,
 * payment or member document changes).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DRIFT_REPORT_COLLECTION,
  DRIFT_REPORT_PREFIX,
  collectGymDuesDrift,
  runDuesDriftJob,
} from '../projection/duesDrift.js'
import {
  assertEmulatorReachable,
  db,
  readDocs,
  seedGym,
  seedMember,
  seedPeriod,
  suite,
} from './helpers.js'

const S = suite('pw-d-')
const { uid, gymA: GYM_A, gymB: GYM_B, cleanup } = S

const reportId = (gymId) => `${DRIFT_REPORT_PREFIX}${gymId}`

async function readReport(gymId) {
  const snap = await db.doc(`${DRIFT_REPORT_COLLECTION}/${reportId(gymId)}`).get()
  return snap.exists ? snap.data() : null
}

async function clearReports() {
  for (const gymId of [GYM_A, GYM_B]) {
    await db.doc(`${DRIFT_REPORT_COLLECTION}/${reportId(gymId)}`).delete()
  }
}

const silent = () => {}

/**
 * A payment written the way the LEDGER sees it: by `memberId`. `gymId` is
 * optional on purpose — legacy and scripted payments may carry none, or the
 * wrong one, and the ledger still counts them for the member.
 */
async function seedPayment(id, { memberId, amount = 1000, date = '2026-01-05', membershipId = '', gymId } = {}) {
  const data = { memberId, amount, date, membershipId, method: 'Cash' }
  if (gymId !== undefined) data.gymId = gymId
  await db.doc(`payments/${id}`).set(data)
}

beforeAll(async () => {
  await assertEmulatorReachable()
  await cleanup()
  await clearReports()
})

afterEach(async () => {
  await cleanup()
  await clearReports()
})

afterAll(async () => {
  await cleanup()
  await clearReports()
})

/** A member holding one period whose cached figures are given explicitly. */
async function seedHolding(gymId, { price = 2500, amountPaid = 0, amountDue = 2500, paymentStatus = 'due' } = {}) {
  const memberId = uid('member')
  const periodId = uid('period')
  await seedMember(memberId, gymId)
  await seedPeriod(periodId, gymId, memberId, {
    startDate: '2026-01-01',
    expiryDate: '2026-01-31',
    price,
    amountPaid,
    amountDue,
    paymentStatus,
  })
  return { memberId, periodId }
}

describe('a clean gym', () => {
  it('writes a report that says so, with exact counts', async () => {
    await seedGym(GYM_A)
    await seedHolding(GYM_A)

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })

    expect(summary.gyms).toBe(1)
    expect(summary.membersScanned).toBe(1)
    expect(summary.periodsScanned).toBe(1)
    expect(summary.driftedPeriods).toBe(0)
    expect(summary.failed).toBe(0)

    const report = await readReport(GYM_A)
    expect(report).not.toBeNull()
    expect(report.clean).toBe(true)
    expect(report.driftedPeriods).toBe(0)
    expect(report.sample).toEqual([])
    expect(typeof report.generatedAt).toBe('string')
  })
})

describe('a drifted period', () => {
  it('is reported with the stored and expected figures', async () => {
    await seedGym(GYM_A)
    const { memberId, periodId } = await seedHolding(GYM_A, {
      amountDue: 0,
      paymentStatus: 'paid',
    })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    expect(summary.driftedMembers).toBe(1)
    expect(summary.driftedPeriods).toBe(1)

    const report = await readReport(GYM_A)
    expect(report.clean).toBe(false)
    expect(report.sample).toHaveLength(1)
    expect(report.sample[0]).toMatchObject({
      memberId,
      periodId,
      fields: ['amountDue', 'paymentStatus'],
      stored: { amountPaid: 0, amountDue: 0, paymentStatus: 'paid' },
      expected: { amountPaid: 0, amountDue: 2500, paymentStatus: 'due' },
    })
  })

  it('is not repaired: the period document is left exactly as it was', async () => {
    await seedGym(GYM_A)
    const { periodId } = await seedHolding(GYM_A, { amountDue: 0, paymentStatus: 'paid' })
    const before = (await db.doc(`memberships/${periodId}`).get()).data()

    await runDuesDriftJob(db, { gymId: GYM_A, log: silent })

    const after = (await db.doc(`memberships/${periodId}`).get()).data()
    expect(after).toEqual(before)
  })

  it('does not write audit entries or touch members', async () => {
    await seedGym(GYM_A)
    const { memberId } = await seedHolding(GYM_A, { amountDue: 0, paymentStatus: 'paid' })
    const auditBefore = await readDocs('auditLog')
    const memberBefore = (await db.doc(`members/${memberId}`).get()).data()

    await runDuesDriftJob(db, { gymId: GYM_A, log: silent })

    expect(await readDocs('auditLog')).toEqual(auditBefore)
    expect((await db.doc(`members/${memberId}`).get()).data()).toEqual(memberBefore)
  })
})

describe('a deliberate price change', () => {
  it('is not reported as drift', async () => {
    await seedGym(GYM_A)
    // What the edit flow writes: new price AND figures that follow it.
    await seedHolding(GYM_A, { price: 3000, amountDue: 3000, paymentStatus: 'due' })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    expect(summary.driftedPeriods).toBe(0)
    expect((await readReport(GYM_A)).clean).toBe(true)
  })
})

describe('tenant isolation', () => {
  it('reports only the gym it was asked about', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedHolding(GYM_A)
    const foreign = await seedHolding(GYM_B, { amountDue: 0, paymentStatus: 'paid' })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    expect(summary.driftedPeriods).toBe(0)

    const report = await readReport(GYM_A)
    expect(report.sample).toEqual([])
    expect(JSON.stringify(report)).not.toContain(foreign.memberId)
  })

  it('collects a gym without reading another gym’s documents', async () => {
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    await seedHolding(GYM_A)
    await seedHolding(GYM_B, { amountDue: 0, paymentStatus: 'paid' })

    const result = await collectGymDuesDrift(db, GYM_A)
    expect(result.membersScanned).toBe(1)
    expect(result.driftedPeriods).toBe(0)
  })
})

describe('inputs match the ledger, not the gym filter', () => {
  it('does not report drift for a payment that carries no gymId', async () => {
    // The ledger reads payments by memberId only. A gymId filter here would have
    // hidden this payment and reported the period as drifted.
    await seedGym(GYM_A)
    const { periodId } = await seedHolding(GYM_A, { amountPaid: 1000, amountDue: 1500, paymentStatus: 'partial' })
    await seedPayment(uid('payment'), { memberId: (await db.doc(`memberships/${periodId}`).get()).data().memberId, membershipId: periodId })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    expect(summary.driftedPeriods).toBe(0)
    expect((await readReport(GYM_A)).clean).toBe(true)
  })

  it('counts a payment filed under another gymId for the same member', async () => {
    // Same memberId, wrong gymId: the ledger still credits the member, so the job
    // must too — otherwise it invents drift out of a filing mistake.
    await seedGym(GYM_A)
    await seedGym(GYM_B)
    const { periodId } = await seedHolding(GYM_A, { amountPaid: 1000, amountDue: 1500, paymentStatus: 'partial' })
    const memberId = (await db.doc(`memberships/${periodId}`).get()).data().memberId
    await seedPayment(uid('payment'), { memberId, membershipId: periodId, gymId: GYM_B })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    expect(summary.driftedPeriods).toBe(0)
  })

  it('still scans a period document that carries no gymId', async () => {
    // A member’s period is read by memberId, so a gymId-less document is part of
    // the ledger and must be part of the scan — here as genuine drift.
    await seedGym(GYM_A)
    const memberId = uid('member')
    await seedMember(memberId, GYM_A)
    await db.doc(`memberships/${uid('period')}`).set({
      memberId,
      planId: '',
      price: 2500,
      startDate: '2026-01-01',
      expiryDate: '2026-01-31',
      amountPaid: 0,
      amountDue: 0,
      paymentStatus: 'paid',
    })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    expect(summary.periodsScanned).toBe(1)
    expect(summary.driftedPeriods).toBe(1)
  })
})

describe('dry run and repeatability', () => {
  it('reports counts without writing a report when asked not to', async () => {
    await seedGym(GYM_A)
    await seedHolding(GYM_A, { amountDue: 0, paymentStatus: 'paid' })

    const summary = await runDuesDriftJob(db, { gymId: GYM_A, log: silent, writeReport: false })
    expect(summary.driftedPeriods).toBe(1)
    expect(await readReport(GYM_A)).toBeNull()
  })

  it('produces the same counts on a second run and keeps one report document', async () => {
    await seedGym(GYM_A)
    await seedHolding(GYM_A, { amountDue: 0, paymentStatus: 'paid' })

    const first = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })
    const second = await runDuesDriftJob(db, { gymId: GYM_A, log: silent })

    expect(second.driftedPeriods).toBe(first.driftedPeriods)
    expect(second.membersScanned).toBe(first.membersScanned)

    const reports = (await readDocs(DRIFT_REPORT_COLLECTION)).filter((doc) =>
      doc.id.startsWith(DRIFT_REPORT_PREFIX)
    )
    expect(reports).toHaveLength(1)
  })
})
