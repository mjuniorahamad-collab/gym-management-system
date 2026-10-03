/**
 * THE TRUSTED MEMBER PROJECTION WRITER.
 *
 * ## What it is
 *
 * One function: read a member's authoritative membership periods and freezes,
 * derive the projection with the canonical pure engine, and write back ONLY the
 * fields that actually differ.
 *
 * ## What it is not
 *
 * It is not financial authority, membership authority, freeze authority or
 * payment authority. It cannot grant entitlement, cannot move money, and cannot
 * alter a period or a freeze. It writes four derived fields and nothing else.
 *
 * ## The rule this module exists to enforce
 *
 * `deriveMemberProjection` never receives the member document. Its inputs are
 * `memberId`, the periods, the freezes, the gym's timezone and optionally a day.
 * A forged `member.status` left on a document by a compromised client therefore
 * cannot influence the result — the stored projection is read here ONLY to
 * compute a diff, and is never an input to the calculation.
 *
 * ## Why the diff matters
 *
 * The sweep runs nightly across every member. If it wrote unconditionally it
 * would rewrite every member document every night, which means an unbounded
 * stream of pointless writes, a permanently churning collection, and a
 * last-write-wins race against any concurrent real edit. Comparing first makes
 * the operation idempotent: the second run over unchanged authoritative data
 * performs ZERO writes, so retrying is free and safe.
 *
 * ## No fabrication
 *
 * When the authoritative documents do not support an answer, the engine returns
 * null and this module writes null. It never substitutes a far-future expiry, a
 * default "active", or a zero-valued date to make a member look healthy. If the
 * authoritative data cannot be READ, this throws rather than guessing, so the
 * caller can count the failure and leave the previous projection untouched —
 * a stale value is recoverable and visible, a fabricated one is neither.
 */
import { deriveMemberProjection } from '../vendor/projection.mjs'
import { PROJECTED_FIELDS, readFreezesForMember, readGymTimezone, readMember, readPeriodsForMember } from './sources.js'

/**
 * The four values to store, extracted from the engine's richer result.
 *
 * The engine returns more than this (periodId, isFrozen, expiringWithinDays and
 * so on). Those are deliberately NOT persisted: they are derivable from the four
 * stored fields plus the authoritative documents, and storing a second copy
 * would create something to drift. Only the four queryable fields are kept,
 * because those are the ones a Firestore query cannot compute for itself.
 */
export function desiredProjection(derived) {
  return {
    membershipStart: derived.membershipStart ?? null,
    effectiveExpiry: derived.effectiveExpiry ?? null,
    freezeUntil: derived.freezeUntil ?? null,
    status: derived.status ?? null,
  }
}

/**
 * Reduce (current, desired) to the fields that genuinely differ.
 *
 * `?? null` on both sides is what makes this idempotent rather than merely
 * correct: a field that was never written reads back as `undefined`, and treating
 * absent and null as the same thing means a member who SHOULD have no expiry is
 * not written to once per sweep forever. Only a real disagreement — a stored
 * value where null is derived, or two different values — produces a write.
 */
export function diffProjection(current, desired) {
  const patch = {}
  const updated = []
  for (const field of PROJECTED_FIELDS) {
    const want = desired[field] ?? null
    const have = current?.[field] ?? null
    if (want !== have) {
      patch[field] = want
      updated.push(field)
    }
  }
  return { patch, updated }
}

/**
 * Plan one member's projection from already-read sources. NO database access.
 *
 * This is the single calculation path in the codebase. Both the callable and the
 * nightly sweep go through it, which is why the sweep cannot quietly drift from
 * the callable: there is only one place where authoritative data becomes four
 * fields, and it is here.
 *
 * Splitting "decide" from "write" is what lets the sweep bulk-read a gym once and
 * reuse those reads for every member, instead of re-querying per member. A second
 * implementation for the sweep would be a second projection algorithm, and the
 * whole design exists to make that impossible.
 *
 * @param {object} args
 * @param {string} args.memberId
 * @param {object} args.current    the member document, used ONLY to compute a diff
 * @param {Array}  [args.periods]  stamped, ALREADY filtered to this member AND gym
 * @param {Array}  [args.freezes]  stamped, ALREADY filtered to this member AND gym
 * @param {string} [args.timezone]
 * @param {string} [args.today]
 * @returns {{ desired: object, patch: object, updated: string[] }}
 *
 * `gymId` is deliberately not a parameter: this function cannot enforce tenancy,
 * because the engine it calls does not know what a gym is. Filtering is the
 * caller's obligation, which is why both callers pass pre-filtered sources.
 */
export function planProjection({ memberId, current, periods = [], freezes = [], timezone, today } = {}) {
  const derived = deriveMemberProjection({ memberId, memberships: periods, freezes, timezone, today })
  const desired = desiredProjection(derived)
  const { patch, updated } = diffProjection(current, desired)
  return { desired, patch, updated }
}

/**
 * Apply planned patches, isolating individual failures.
 *
 * Firestore batches are all-or-nothing, so a single bad document in a batch would
 * otherwise take down every other member in it — the exact "one bad record stops
 * the nightly repair" failure this sweep exists to prevent. So batches are
 * committed optimistically, and any batch that fails is retried one document at a
 * time to find out which member was at fault. The cost is paid only on failure.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Array<{memberId: string, patch: object}>} entries
 * @returns {Promise<{written: number, failed: Array<{memberId: string, error: string}>}>}
 */
export async function applyPatches(db, entries) {
  const written = []
  const failed = []
  const BATCH_LIMIT = 400

  for (let start = 0; start < entries.length; start += BATCH_LIMIT) {
    const chunk = entries.slice(start, start + BATCH_LIMIT)
    try {
      const batch = db.batch()
      for (const entry of chunk) batch.update(db.doc(`members/${entry.memberId}`), entry.patch)
      await batch.commit()
      written.push(...chunk)
      continue
    } catch {
      // Fall through to the per-document path below to isolate the failure.
    }

    for (const entry of chunk) {
      try {
        await db.doc(`members/${entry.memberId}`).update(entry.patch)
        written.push(entry)
      } catch (error) {
        failed.push({ memberId: entry.memberId, error: error?.message ?? 'unknown error' })
      }
    }
  }

  return { written: written.length, failed }
}

/** @typedef {object} ReprojectResult */
/// @property {boolean} ok        false only for a rejected request or unreadable target
/// @property {string}  [reason]  machine-readable rejection reason
/// @property {boolean} [changed] whether a write happened
/// @property {string[]} [updated] the fields actually written
/// @property {object}  [fields]  the projection now stored

/**
 * Recompute one member's projection from authoritative sources.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} args
 * @param {string} args.memberId
 * @param {string} args.gymId      MUST be the caller's own bound gym. Never taken
 *                                 from the client.
 * @param {string} [args.timezone] Gym zone override. Production resolves this from
 *                                 `gyms/{gymId}/settings/app.timezone`; tests pass a
 *                                 fixed zone so day arithmetic is deterministic.
 * @param {string} [args.today]    Gym-local `YYYY-MM-DD` day. Tests pin it.
 */
export async function recomputeMemberProjection(db, { memberId, gymId, timezone, today } = {}) {
  if (typeof memberId !== 'string' || !memberId.trim()) {
    return { ok: false, reason: 'invalid-member-id' }
  }
  if (typeof gymId !== 'string' || !gymId.trim()) {
    return { ok: false, reason: 'invalid-gym-id' }
  }

  const member = await readMember(db, memberId)
  if (!member) return { ok: false, reason: 'member-not-found' }

  // Defence in depth. The source reads below are already gym-scoped, so this
  // cannot be reached by a wrong `gymId` alone — it catches a member document
  // that does not belong to the gym the caller is bound to, and it is checked
  // BEFORE anything is written so a mismatch can never produce a write.
  if (member.data?.gymId !== gymId) return { ok: false, reason: 'tenant-mismatch' }

  const zone = timezone === undefined ? await readGymTimezone(db, gymId) : timezone
  const [periods, freezes] = await Promise.all([
    readPeriodsForMember(db, gymId, memberId),
    readFreezesForMember(db, gymId, memberId),
  ])

  // Any read failure above propagates. The projection is left exactly as it was:
  // a stale value the sweep will repair, rather than a guess.
  const { patch, updated, desired } = planProjection({
    memberId,
    current: member.data,
    periods,
    freezes,
    timezone: zone,
    today,
  })

  if (!updated.length) {
    return { ok: true, changed: false, memberId, gymId, fields: desired }
  }

  await member.ref.update(patch)
  return { ok: true, changed: true, memberId, gymId, fields: desired, updated }
}