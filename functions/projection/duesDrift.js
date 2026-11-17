/**
 * DUES DRIFT RECONCILIATION — report only, never repair. Bounded per run.
 *
 * The detector is the canonical `src/utils/duesDrift.js`, and the grouping is
 * the bundled `findDuesDrift`. A second copy of the ledger math OR of the
 * grouping here could disagree with the app, which is the one failure mode a
 * reconciliation job must not have.
 *
 * ## Inputs must equal the ledger's inputs, not "the gym's documents"
 *
 * This job used to read `payments` and `memberships` with `where('gymId','==',gymId)`.
 * The ledger does not: `readLedgerInputs` reads them by **memberId only**, and
 * plans with no filter at all. A payment carrying no `gymId` (recorded by a
 * script, or written before per-gym isolation) was therefore invisible to the
 * job but counted by the ledger — and the job reported drift where there was
 * none. A false report is worse than no report: it teaches people to ignore the
 * next one. So the job partitions by MEMBER and reads each member's payments and
 * periods exactly as the ledger does.
 *
 * ## Why a run is bounded
 *
 * That per-member read is correct but linear: two queries per member. A gym with
 * a few thousand members would spend the whole scheduled window reading, and the
 * run would be killed rather than finish — leaving a report that looks current
 * but is not. So each run scans at most `DRIFT_MAX_MEMBERS_PER_RUN` members and
 * stores the cursor it stopped at. The next run resumes from that cursor, and
 * the report keeps accumulating this cycle's counts and sample.
 *
 * What that means for the report:
 * - `complete: false` → a PARTIAL check. `nextCursor` is where it resumes. This
 *   must never be read as "clean": only part of the gym has been looked at.
 * - `complete: true` → the whole gym was covered; `clean` is only written here.
 *
 * What it writes: ONE report document per gym at
 * `systemReports/duesDrift-<gymId>`, overwritten on every run so the latest
 * answer is always the document. Nothing is fixed, and no membership, payment or
 * member document is touched.
 *
 * Why report instead of repair: a period whose snapshots disagree may have been
 * edited by a script on purpose, and rewriting it would silently discard a
 * decision a human made.
 */
import { FieldPath } from 'firebase-admin/firestore'
import { findDuesDrift } from '../vendor/projection.mjs'
import { fetchAll, readAllGyms } from './sources.js'

/** Admin-only collection: no client rule grants access. */
export const DRIFT_REPORT_COLLECTION = 'systemReports'
export const DRIFT_REPORT_PREFIX = 'duesDrift-'

/** How many drifted periods the report keeps as evidence. Counts stay exact. */
export const DRIFT_SAMPLE_LIMIT = 25

/**
 * Members scanned per scheduled run. Two reads each, so this bounds the run's
 * wall time; a bigger gym finishes over several nights and says so.
 */
export const DRIFT_MAX_MEMBERS_PER_RUN = 400

/** Member-level reads run a few at a time; a page must not open 400 sockets. */
const READ_CONCURRENCY = 5

const stamp = (snapshot) => ({ id: snapshot.id, ...snapshot.data() })

/** Every plan in the project — the ledger's own scope, not the gym's. */
async function readAllPlans(db) {
  return (await fetchAll(db.collection('membershipPlans'))).map(stamp)
}

/**
 * One page of a gym's members, in document-id order, resuming after `afterId`.
 * `nextCursor` is null when this page reached the end of the gym.
 */
async function readMemberPage(db, gymId, { afterId = null, limit }) {
  // Ask for one extra document: a FULL page cannot tell you whether it was the
  // last one, which made a gym of exactly N members take an extra empty run
  // before the cycle could be called complete.
  // Explicit document-id order: a cursor has to match the query's ordering, and
  // a value that does not is rejected rather than silently ignored.
  let query = db
    .collection('members')
    .where('gymId', '==', gymId)
    .orderBy(FieldPath.documentId())
    .limit(limit + 1)
  if (afterId) query = query.startAfter(afterId)
  const snapshot = await query.get()
  const hasMore = snapshot.size > limit
  const docs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs
  return {
    members: docs.map(stamp),
    nextCursor: hasMore ? docs[docs.length - 1]?.id ?? null : null,
  }
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

/** Merge samples by period, keeping the cap. Later evidence wins on duplicates. */
function mergeSample(existing, incoming) {
  const merged = new Map()
  for (const row of [...(existing || []), ...(incoming || [])]) {
    merged.set(`${row.memberId}|${row.periodId}`, row)
  }
  return Array.from(merged.values()).slice(0, DRIFT_SAMPLE_LIMIT)
}

/**
 * Drift for ONE PAGE of a gym: counts plus a capped sample. Reads only.
 */
export async function collectGymDuesDrift(
  db,
  gymId,
  { plans, afterId = null, limit = DRIFT_MAX_MEMBERS_PER_RUN } = {}
) {
  const allPlans = plans ?? (await readAllPlans(db))
  const { members, nextCursor } = await readMemberPage(db, gymId, { afterId, limit })

  const perMember = await mapWithConcurrency(members, (member) =>
    member?.id ? readMemberInputs(db, member.id) : { payments: [], memberships: [] }
  )

  const result = findDuesDrift({
    members,
    plans: allPlans,
    payments: perMember.flatMap((entry) => entry.payments),
    memberships: perMember.flatMap((entry) => entry.memberships),
  })

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
    nextCursor,
  }
}

async function readReport(db, gymId) {
  const snapshot = await db.doc(`${DRIFT_REPORT_COLLECTION}/${DRIFT_REPORT_PREFIX}${gymId}`).get()
  return snapshot.exists ? snapshot.data() : null
}

/**
 * Run the reconciliation over every gym (or one, when `gymId` is given).
 *
 * A previous PARTIAL report for the same gym is resumed: the cursor, the counts
 * and the sample carry over, so a large gym is covered over consecutive runs
 * instead of restarting from the top every night.
 *
 * Per-gym containment mirrors the other jobs. `writeReport: false` scans one
 * page and writes nothing — a dry run looks at this run's slice only.
 */
export async function runDuesDriftJob(
  db,
  { gymId, log = console.log, writeReport = true, now = new Date(), maxMembersPerRun } = {}
) {
  const limit = maxMembersPerRun ?? DRIFT_MAX_MEMBERS_PER_RUN
  const summary = {
    gyms: 0,
    membersScanned: 0,
    periodsScanned: 0,
    driftedMembers: 0,
    driftedPeriods: 0,
    partial: 0,
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
      const previous = writeReport ? await readReport(db, gym.id) : null
      const resuming = Boolean(previous && previous.complete === false && previous.nextCursor)
      const cycle = resuming
        ? {
            afterId: previous.nextCursor,
            membersScanned: Number(previous.membersScanned) || 0,
            periodsScanned: Number(previous.periodsScanned) || 0,
            driftedMembers: Number(previous.driftedMembers) || 0,
            driftedPeriods: Number(previous.driftedPeriods) || 0,
            sample: Array.isArray(previous.sample) ? previous.sample : [],
          }
        : { afterId: null, membersScanned: 0, periodsScanned: 0, driftedMembers: 0, driftedPeriods: 0, sample: [] }

      const page = await collectGymDuesDrift(db, gym.id, { plans, afterId: cycle.afterId, limit })
      const totals = {
        membersScanned: cycle.membersScanned + page.membersScanned,
        periodsScanned: cycle.periodsScanned + page.periodsScanned,
        driftedMembers: cycle.driftedMembers + page.driftedMembers,
        driftedPeriods: cycle.driftedPeriods + page.driftedPeriods,
      }
      const sample = mergeSample(cycle.sample, page.sample)
      const complete = page.nextCursor === null

      summary.gyms += 1
      summary.membersScanned += page.membersScanned
      summary.periodsScanned += page.periodsScanned
      summary.driftedMembers += page.driftedMembers
      summary.driftedPeriods += page.driftedPeriods
      if (!complete) summary.partial += 1

      const generatedAt = now.toISOString()
      if (writeReport) {
        const report = {
          gymId: gym.id,
          complete,
          generatedAt,
          membersScanned: totals.membersScanned,
          periodsScanned: totals.periodsScanned,
          driftedMembers: totals.driftedMembers,
          driftedPeriods: totals.driftedPeriods,
          sample,
        }
        // `clean` is only meaningful once the whole gym has been covered.
        if (complete) report.clean = totals.driftedPeriods === 0
        else report.nextCursor = page.nextCursor
        await db.doc(`${DRIFT_REPORT_COLLECTION}/${DRIFT_REPORT_PREFIX}${gym.id}`).set(report)
      }

      summary.perGym.push({
        gymId: gym.id,
        membersScanned: page.membersScanned,
        periodsScanned: page.periodsScanned,
        driftedMembers: page.driftedMembers,
        driftedPeriods: page.driftedPeriods,
        complete,
      })
      log('dues drift per gym', {
        gymId: gym.id,
        scannedThisRun: page.membersScanned,
        complete,
        driftedPeriods: page.driftedPeriods,
      })
    } catch (error) {
      summary.failed += 1
      summary.perGym.push({ gymId: gym.id, failed: true })
      log('dues drift gym failed', { gymId: gym.id, error: error?.message ?? String(error) })
    }
  }

  log('dues drift reconciliation complete', {
    gyms: summary.gyms,
    scannedThisRun: summary.membersScanned,
    partial: summary.partial,
    driftedPeriods: summary.driftedPeriods,
    failed: summary.failed,
  })

  return summary
}
