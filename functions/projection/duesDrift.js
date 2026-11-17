/**
 * DUES DRIFT RECONCILIATION — report only, never repair.
 *
 * The detector is the canonical `src/utils/duesDrift.js`, bundled into
 * `vendor/projection.mjs` like the projection engine, and the grouping is the
 * bundled `findDuesDrift`. A second copy of the ledger math OR of the grouping
 * here could disagree with the app, which is the one failure mode a
 * reconciliation job must not have.
 *
 * ## Inputs must equal the ledger's inputs, not "the gym's documents"
 *
 * This job used to read `payments` and `memberships` with `where('gymId','==',gymId)`.
 * The ledger does not: `readLedgerInputs` reads them by **memberId only**, and
 * plans with no filter at all. So a payment that carries no `gymId` (recorded by
 * a script, or written before per-gym isolation) was invisible to the job but
 * very visible to the ledger — and the job reported the period as drifted when
 * nothing was wrong. A false report is worse than no report: it teaches people
 * to ignore the next one.
 *
 * The job therefore partitions by the MEMBER (a member belongs to a gym), and
 * reads each member's payments and periods exactly as the ledger does — by
 * memberId, with no gymId filter — plus every plan in the project, also as the
 * ledger does. The cost is two reads per member instead of two per gym; that is
 * the price of comparing the same thing the app compares.
 *
 * What it writes: ONE report document per gym at
 * `systemReports/duesDrift-<gymId>`, overwritten on every run so the latest
 * answer is always the document — including a clean run, which is evidence the
 * job ran. Nothing is fixed, and no membership, payment or member document is
 * touched.
 *
 * Why report instead of repair: a period whose snapshots disagree may have been
 * edited by a script on purpose, and rewriting it would silently discard a
 * decision a human made.
 */
import { findDuesDrift } from '../vendor/projection.mjs'
import { fetchAll, readAllGyms, readMembersForGym } from './sources.js'

/** Admin-only collection: no client rule grants access. */
export const DRIFT_REPORT_COLLECTION = 'systemReports'
export const DRIFT_REPORT_PREFIX = 'duesDrift-'

/** How many drifted periods the report keeps as evidence. Counts stay exact. */
export const DRIFT_SAMPLE_LIMIT = 25

/** Member-level reads run a few at a time; a big gym must not open 1000 sockets. */
const READ_CONCURRENCY = 5

const stamp = (snapshot) => ({ id: snapshot.id, ...snapshot.data() })

/** Every plan in the project — the ledger's own scope, not the gym's. */
async function readAllPlans(db) {
  return (await fetchAll(db.collection('membershipPlans'))).map(stamp)
}

/**
 * One member's ledger inputs, read by memberId exactly like `readLedgerInputs`.
 * Deliberately no gymId filter: a payment with a blank or different gymId is
 * still that member's money, and the ledger counts it.
 */
async function readMemberInputs(db, memberId) {
  const [payments, memberships] = await Promise.all([
    fetchAll(db.collection('payments').where('memberId', '==', memberId)),
    fetchAll(db.collection('memberships').where('memberId', '==', memberId)),
  ])
  return { payments: payments.map(stamp), memberships: memberships.map(stamp) }
}

/** Run `worker` over `items` with a small fixed concurrency, preserving order. */
async function mapWithConcurrency(items, worker, limit = READ_CONCURRENCY) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/**
 * Drift for one gym: counts plus a capped sample. Reads only.
 */
export async function collectGymDuesDrift(db, gymId, { plans } = {}) {
  const members = await readMembersForGym(db, gymId)
  const allPlans = plans ?? (await readAllPlans(db))

  const perMember = await mapWithConcurrency(members, (member) =>
    member?.id ? readMemberInputs(db, member.id) : { payments: [], memberships: [] }
  )

  const payments = perMember.flatMap((entry) => entry.payments)
  const memberships = perMember.flatMap((entry) => entry.memberships)

  const result = findDuesDrift({ members, plans: allPlans, payments, memberships })

  const sample = []
  for (const entry of result.driftedMembers) {
    for (const row of entry.periods) {
      if (sample.length >= DRIFT_SAMPLE_LIMIT) break
      sample.push({
        memberId: entry.memberId,
        memberName: entry.memberName,
        periodId: row.periodId,
        fields: row.fields,
        stored: row.stored,
        expected: row.expected,
      })
    }
    if (sample.length >= DRIFT_SAMPLE_LIMIT) break
  }

  return {
    gymId,
    membersScanned: result.membersScanned,
    periodsScanned: result.periodsScanned,
    driftedMembers: result.driftedMembers.length,
    driftedPeriods: result.driftedPeriods,
    sample,
  }
}

/**
 * Run the reconciliation over every gym (or one, when `gymId` is given).
 *
 * Per-gym containment mirrors the other jobs: an unreadable gym is reported and
 * the rest still run. `writeReport: false` keeps the report documents untouched
 * while still returning the counts, which is what a dry run needs.
 */
export async function runDuesDriftJob(
  db,
  { gymId, log = console.log, writeReport = true, now = new Date() } = {}
) {
  const summary = {
    gyms: 0,
    membersScanned: 0,
    periodsScanned: 0,
    driftedMembers: 0,
    driftedPeriods: 0,
    failed: 0,
    perGym: [],
  }

  let gyms
  let plans
  try {
    gyms = gymId ? [{ id: gymId }] : await readAllGyms(db)
    // Read once for the whole run: the ledger's plan scope is project-wide, and
    // re-reading per gym would let two gyms be compared against different plans.
    plans = await readAllPlans(db)
  } catch (error) {
    log('dues drift could not start', { error: error?.message ?? String(error) })
    summary.failed += 1
    summary.error = error?.message ?? 'unknown error'
    return summary
  }

  for (const gym of gyms) {
    try {
      const result = await collectGymDuesDrift(db, gym.id, { plans })
      summary.gyms += 1
      summary.membersScanned += result.membersScanned
      summary.periodsScanned += result.periodsScanned
      summary.driftedMembers += result.driftedMembers
      summary.driftedPeriods += result.driftedPeriods

      const generatedAt = now.toISOString()
      if (writeReport) {
        await db.doc(`${DRIFT_REPORT_COLLECTION}/${DRIFT_REPORT_PREFIX}${gym.id}`).set({
          gymId: gym.id,
          generatedAt,
          membersScanned: result.membersScanned,
          periodsScanned: result.periodsScanned,
          driftedMembers: result.driftedMembers,
          driftedPeriods: result.driftedPeriods,
          clean: result.driftedPeriods === 0,
          sample: result.sample,
        })
      }

      summary.perGym.push({
        gymId: gym.id,
        membersScanned: result.membersScanned,
        periodsScanned: result.periodsScanned,
        driftedMembers: result.driftedMembers,
        driftedPeriods: result.driftedPeriods,
      })
      log('dues drift per gym', {
        gymId: gym.id,
        members: result.membersScanned,
        driftedPeriods: result.driftedPeriods,
      })
    } catch (error) {
      summary.failed += 1
      summary.perGym.push({ gymId: gym.id, failed: true })
      log('dues drift gym failed', { gymId: gym.id, error: error?.message ?? String(error) })
    }
  }

  log('dues drift reconciliation complete', {
    gyms: summary.gyms,
    membersScanned: summary.membersScanned,
    driftedMembers: summary.driftedMembers,
    driftedPeriods: summary.driftedPeriods,
    failed: summary.failed,
  })

  return summary
}
