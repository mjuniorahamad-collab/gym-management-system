/**
 * THE NIGHTLY PROJECTION REPAIR SWEEP.
 *
 * ## Why this exists
 *
 * The projection is a cache, and every cache needs a repair path. The callable
 * fixes a member when someone notices a problem; this fixes every member when
 * nobody does. Drift reaches the projection from several directions — an
 * authoritative write that succeeded while the reprojection call did not, a
 * period edited by a script that never called the callable, a member document
 * written before the trusted writer existed, or a stale value left behind by an
 * earlier algorithm. All of them look identical from the app's point of view: a
 * member whose status is wrong.
 *
 * ## What it may use as input
 *
 * Authoritative documents only: `memberships`, `membershipFreezes`, and each gym's
 * timezone. A member's existing projection is read solely to compute a diff and
 * is never an input — `planProjection` is the same function the callable uses, so
 * there is exactly one place where authoritative data becomes four fields.
 *
 * ## Conservative by construction
 *
 * - Diff-only, so a second run over unchanged data performs ZERO writes. Retrying
 *   is therefore free, and running it twice is indistinguishable from running it
 *   once.
 * - Tenant-partitioned. Each gym is processed with its OWN timezone, since a
 *   member's "today" is a gym-local fact and two gyms can disagree about the date.
 * - No fabricated values. A member with no usable period is projected null. That
 *   is counted as `malformed`, not silently healed, because a null projection is
 *   the honest answer and inventing an expiry would hide a real data problem.
 * - No financial side effects and no audit entry for unchanged members. An audit
 *   trail is for things a human did; this is a repair job.
 *
 * ## Blast radius
 *
 * One malformed member must not stop the sweep, and one broken gym must not stop
 * the others. Both are isolated: members are counted and skipped, gyms are caught
 * and the run continues. A sweep that aborts halfway leaves the data in exactly
 * the half-repaired state that makes it necessary.
 *
 * This module performs no scheduling. It is a plain function so it can be run
 * locally against the emulator, and it is intentionally NOT registered in
 * functions/index.js — wiring it to a production schedule is a deployment
 * decision, not a code change.
 */
import { logger } from 'firebase-functions'
import {
  groupByMember,
  readAllGyms,
  readFreezesForGym,
  readGymTimezone,
  readMembersForGym,
  readPeriodsForGym,
} from './sources.js'
import { applyPatches, planProjection } from './writer.js'

/** A run id that is identical for the same inputs, so a retry is recognisable. */
function deterministicRunId(scope, gymId) {
  return `${scope}:${gymId || 'all'}`
}

/**
 * The numeric counters, in one place so `emptyCounters` and `addCounters` cannot
 * drift apart.
 *
 * Deliberately a fixed list rather than `Object.keys(target)`: the accumulator
 * also carries non-numeric fields like `perGym`, and summing those with `+` would
 * silently turn an array into a string.
 */
const COUNTER_KEYS = Object.freeze([
  'scanned',
  'changed',
  'unchanged',
  'malformed',
  'failed',
  'orphanedSources',
  'writeFailures',
])

function emptyCounters() {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]))
}

function addCounters(target, source) {
  for (const key of COUNTER_KEYS) target[key] += source[key] ?? 0
  return target
}

/**
 * A projection of all-null is the engine saying "the authoritative data does not
 * support an answer". That is a data problem worth surfacing, not something to
 * paper over.
 */
function isUnprojectable(desired) {
  return desired.status === null && desired.effectiveExpiry === null
}

/**
 * Repair one gym.
 *
 * @returns {Promise<object>} counters plus per-gym context
 * @param {string} [options.timezone]  explicit zone, overriding the gym's own
 * @param {string} [options.today]
 * @param {Function} [options.log]
 */
export async function sweepGym(db, gymId, { timezone, today, log } = {}) {
  const emit = log ?? logger.info
  const counters = emptyCounters()
  counters.gymId = gymId

  try {
    const zone = timezone === undefined ? await readGymTimezone(db, gymId) : timezone

    const [members, periods, freezes] = await Promise.all([
      readMembersForGym(db, gymId),
      readPeriodsForGym(db, gymId),
      readFreezesForGym(db, gymId),
    ])

    const periodsByMember = groupByMember(periods)
    const freezesByMember = groupByMember(freezes)

    // Source documents naming a member that is not in this gym are dropped rather
    // than guessed at, and counted — a growing number means orphaned data that
    // will never be projected onto anyone. This covers both a blank `memberId`
    // (dropped by `groupByMember`) and a real id with no member behind it.
    const memberIds = new Set(members.map((member) => member.id))
    const countOrphaned = (docs, grouped) => {
      let orphans = docs.length - [...grouped.values()].reduce((n, list) => n + list.length, 0)
      for (const [memberId, list] of grouped) {
        if (!memberIds.has(memberId)) orphans += list.length
      }
      return orphans
    }
    counters.orphanedSources =
      countOrphaned(periods, periodsByMember) + countOrphaned(freezes, freezesByMember)

    const pending = []
    for (const member of members) {
      counters.scanned += 1
      try {
        const { desired, patch, updated } = planProjection({
          memberId: member.id,
          current: member,
          periods: periodsByMember.get(member.id) ?? [],
          freezes: freezesByMember.get(member.id) ?? [],
          timezone: zone,
          today,
        })

        if (isUnprojectable(desired)) counters.malformed += 1
        if (!updated.length) {
          counters.unchanged += 1
          continue
        }
        counters.changed += 1
        pending.push({ memberId: member.id, patch, updated })
      } catch (error) {
        // One bad member must not end the gym, let alone the run.
        counters.failed += 1
        counters.failures = counters.failures ?? []
        counters.failures.push({ memberId: member.id, error: error?.message ?? 'unknown error' })
      }
    }

    if (pending.length) {
      const result = await applyPatches(db, pending)
      counters.writeFailures = result.failed.length
      for (const failure of result.failed) {
        counters.failed += 1
        counters.failures = counters.failures ?? []
        counters.failures.push(failure)
      }
      // A member whose write was rejected was not actually repaired, so it is
      // reported as unchanged-not-changed rather than as success.
      if (result.failed.length) counters.changed -= result.failed.length
    }

    emit('projection sweep gym complete', {
      runId: deterministicRunId('sweep', gymId),
      gymId,
      timezone: zone,
      ...counters,
    })
    return counters
  } catch (error) {
    // A gym that cannot even be read is contained here, so the next gym still runs.
    counters.failed += 1
    counters.error = error?.message ?? 'unknown error'
    emit('projection sweep gym failed', {
      runId: deterministicRunId('sweep', gymId),
      gymId,
      error: counters.error,
    })
    return counters
  }
}

/**
 * Repair every gym.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} [options]
 * @param {string} [options.gymId]  restrict to one gym
 * @param {string} [options.today]   gym-local day; tests pin it, production leaves
 *                                   it to the engine so each gym resolves its own
 * @param {string} [options.scope]   label for the run id
 * @param {Function} [options.log]   structured logger; defaults to firebase-functions.
 *                                   Injectable so tests can silence it and assert on
 *                                   the payloads rather than parsing console output.
 */
export async function runProjectionSweep(db, { gymId, today, scope = 'sweep', log } = {}) {
  const emit = log ?? logger.info
  const totals = emptyCounters()
  totals.perGym = []

  let gyms
  try {
    gyms = gymId ? [{ id: gymId }] : await readAllGyms(db)
  } catch (error) {
    emit('projection sweep could not enumerate gyms', { error })
    totals.failed += 1
    totals.error = error?.message ?? 'unknown error'
    return totals
  }

  for (const gym of gyms) {
    const counters = await sweepGym(db, gym.id, { today, log })
    addCounters(totals, counters)
    const { failures, error, ...rest } = counters
    totals.perGym.push({ ...rest, ...(error ? { error } : {}), ...(failures ? { failures } : {}) })
  }

  totals.gyms = gyms.length
  totals.runId = deterministicRunId(scope, gymId ?? 'all')

  emit('projection sweep complete', {
    runId: totals.runId,
    gyms: totals.gyms,
    scanned: totals.scanned,
    changed: totals.changed,
    unchanged: totals.unchanged,
    malformed: totals.malformed,
    failed: totals.failed,
  })

  return totals
}