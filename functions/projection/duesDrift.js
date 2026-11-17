/**
 * DUES DRIFT RECONCILIATION — report only, never repair.
 *
 * The detector itself is the canonical `src/utils/duesDrift.js`, bundled into
 * `vendor/projection.mjs` like the projection engine. A second copy of the
 * ledger math here could disagree with the app, which is the one failure mode a
 * reconciliation job must not have.
 *
 * What it writes: ONE report document per gym at
 * `systemReports/duesDrift-<gymId>`, overwritten on every run so the latest
 * answer is always the document — including a clean run, which is evidence the
 * job ran rather than an absence of evidence. Nothing is fixed, and no membership,
 * payment or member document is touched.
 *
 * Why report instead of repair: a period whose snapshots disagree may have been
 * edited by a script on purpose, and rewriting it would silently discard a
 * decision a human made. The job's job is to make drift visible while it is
 * still cheap.
 */
import { duesDriftForMember } from '../vendor/projection.mjs'
import { fetchAll, readAllGyms } from './sources.js'

/** Admin-only collection: no client rule grants write access. */
export const DRIFT_REPORT_COLLECTION = 'systemReports'
export const DRIFT_REPORT_PREFIX = 'duesDrift-'

/** How many drifted periods the report keeps as evidence. Counts stay exact. */
export const DRIFT_SAMPLE_LIMIT = 25

const stamp = (snapshot) => ({ id: snapshot.id, ...snapshot.data() })

function groupByMember(docs) {
  const grouped = new Map()
  for (const doc of docs) {
    if (!doc?.memberId) continue
    const bucket = grouped.get(doc.memberId)
    if (bucket) bucket.push(doc)
    else grouped.set(doc.memberId, [doc])
  }
  return grouped
}

/** Every input one gym's drift calculation needs, in one round of queries. */
async function readGymInputs(db, gymId) {
  const [members, periods, payments, plans] = await Promise.all([
    fetchAll(db.collection('members').where('gymId', '==', gymId)),
    fetchAll(db.collection('memberships').where('gymId', '==', gymId)),
    fetchAll(db.collection('payments').where('gymId', '==', gymId)),
    fetchAll(db.collection('membershipPlans').where('gymId', '==', gymId)),
  ])
  return {
    members: members.map(stamp),
    memberships: periods.map(stamp),
    payments: payments.map(stamp),
    plans: plans.map(stamp),
  }
}

/**
 * Drift for one gym: counts plus a capped sample. Reads only.
 */
export async function collectGymDuesDrift(db, gymId) {
  const { members, memberships, payments, plans } = await readGymInputs(db, gymId)
  const periodsByMember = groupByMember(memberships)
  const paymentsByMember = groupByMember(payments)

  const sample = []
  let membersScanned = 0
  let periodsScanned = 0
  let driftedMembers = 0
  let driftedPeriods = 0

  for (const member of members) {
    if (!member?.id) continue
    membersScanned += 1
    const memberPeriods = periodsByMember.get(member.id) || []
    periodsScanned += memberPeriods.filter((p) => p.id).length

    const rows = duesDriftForMember({
      member,
      plans,
      payments: paymentsByMember.get(member.id) || [],
      memberships: memberPeriods,
    })
    if (rows.length === 0) continue

    driftedMembers += 1
    driftedPeriods += rows.length
    for (const row of rows) {
      if (sample.length >= DRIFT_SAMPLE_LIMIT) break
      sample.push({
        memberId: member.id,
        memberName: member.name ?? null,
        periodId: row.periodId,
        fields: row.fields,
        stored: row.stored,
        expected: row.expected,
      })
    }
  }

  return {
    gymId,
    membersScanned,
    periodsScanned,
    driftedMembers,
    driftedPeriods,
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
  try {
    gyms = gymId ? [{ id: gymId }] : await readAllGyms(db)
  } catch (error) {
    log('dues drift could not enumerate gyms', { error: error?.message ?? String(error) })
    summary.failed += 1
    summary.error = error?.message ?? 'unknown error'
    return summary
  }

  for (const gym of gyms) {
    try {
      const result = await collectGymDuesDrift(db, gym.id)
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
