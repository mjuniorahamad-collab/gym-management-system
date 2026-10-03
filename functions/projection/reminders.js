/**
 * MEMBERSHIP EXPIRY REMINDERS — rebuilt on the authoritative membership model.
 *
 * ## What was wrong
 *
 * The previous implementation computed expiry as `joinDate + plan.durationDays`
 * and filtered on `member.status === 'active'`. Every one of those inputs is
 * wrong now:
 *
 * - `joinDate + durationDays` is the pre-freeze arithmetic. It ignores
 *   `membershipFreezes` entirely, so it reported a date the member does not
 *   actually hold, and it ignored every period edited, cancelled or backfilled
 *   since the join.
 * - `member.status` is a CACHE. Reading it to decide who to remind means the
 *   reminder inherits whatever drift the cache happens to have: a member whose
 *   projection is stale gets no reminder, or a wrong one.
 * - It ignored `memberships` altogether, so a member with a corrected or
 *   re-dated period was reminded about a date that had never existed.
 *
 * ## What it does now
 *
 * Derives each member's expiry from `memberships` + `membershipFreezes` through
 * the same canonical engine the projection writer uses, in the gym's own
 * timezone. There is one expiry algorithm in this codebase and this is not a
 * second one — it imports the identical function from the identical bundle.
 *
 * ## Eligibility is unchanged
 *
 * The legacy window was `daysLeft >= 0 && daysLeft <= 7`. The engine reports
 * `expiring` for a current period whose `daysToExpiry` is `<= 7`, and for a
 * current period that is always `>= 0`. So the two windows are identical — 0..7
 * inclusive — and this change corrects *where the date comes from* without
 * changing *who gets reminded*. That matters: quietly widening or narrowing a
 * renewal window is a business decision, and this is not one.
 *
 * ## No side effects
 *
 * The legacy job wrote one `auditLog` document per reminded member per day. That
 * is not an audit trail — it is the system recording that it did its job, at
 * volume, forever. Audit is for things a human did. The job is read-only: it
 * computes a list and hands it to an injected deliverer, so nothing here writes
 * to Firestore, and running it twice changes nothing.
 *
 * Delivery is injected and defaults to a logging placeholder. No provider is
 * wired, and no production deployment has been attempted.
 */
import { logger } from 'firebase-functions'
import { deriveMemberProjection, PROJECTION_STATUS } from '../vendor/projection.mjs'
import {
  groupByMember,
  readAllGyms,
  readFreezesForGym,
  readGymTimezone,
  readMembersForGym,
  readPeriodsForGym,
} from './sources.js'

/** Days before expiry at which a member is reminded. Mirrors the engine's own threshold. */
export const REMINDER_WINDOW_DAYS = 7

/**
 * Is this member due a reminder?
 *
 * Decided purely from the freshly derived projection, never from the stored one.
 * `expiring` already encodes "current period expiring within the window", so
 * there is no second date comparison here to disagree with the engine.
 */
export function isReminderDue(derived) {
  return derived?.status === PROJECTION_STATUS.EXPIRING
}

/**
 * Can this member's expiry be answered at all?
 *
 * Same definition the sweep uses for `malformed`: no projection status means the
 * authoritative data does not support any answer. Counted rather than skipped
 * silently — the legacy job `continue`d past these, so a member with no usable
 * period simply disappeared from the process with nothing to indicate it.
 */
function isUnprojectable(derived) {
  return derived?.status == null
}

/**
 * Collect the reminders due for one gym.
 *
 * Member contact details (name, email, phone) are read from the member document,
 * but only to address the message. Eligibility is decided exclusively by the
 * derived projection — a member document cannot vote on whether it is reminded.
 *
 * @returns {Promise<{reminders: object[], scanned: number, unprojectable: number}>}
 */
export async function collectExpiringReminders(db, gymId, { timezone, today } = {}) {
  const zone = timezone === undefined ? await readGymTimezone(db, gymId) : timezone

  const [members, periods, freezes] = await Promise.all([
    readMembersForGym(db, gymId),
    readPeriodsForGym(db, gymId),
    readFreezesForGym(db, gymId),
  ])

  const periodsByMember = groupByMember(periods)
  const freezesByMember = groupByMember(freezes)

  const reminders = []
  let unprojectable = 0

  for (const member of members) {
    let derived
    try {
      derived = deriveMemberProjection({
        memberId: member.id,
        memberships: periodsByMember.get(member.id) ?? [],
        freezes: freezesByMember.get(member.id) ?? [],
        timezone: zone,
        today,
      })
    } catch {
      // One unprojectable member must not stop the rest of the gym.
      unprojectable += 1
      continue
    }

    if (isUnprojectable(derived)) unprojectable += 1
    if (!isReminderDue(derived)) continue

    reminders.push({
      memberId: member.id,
      gymId,
      name: member.name ?? null,
      email: member.email ?? null,
      phone: member.phone ?? null,
      daysLeft: derived.expiringWithinDays,
      effectiveExpiry: derived.effectiveExpiry,
      freezeUntil: derived.freezeUntil,
      isFrozen: derived.isFrozen,
    })
  }

  return { reminders, scanned: members.length, unprojectable }
}

/**
 * Run the job across every gym.
 *
 * Read-only, so retry-safe by construction: a repeated run recomputes the same
 * list and writes nothing.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} [options]
 * @param {Function} [options.deliver] called per reminder; defaults to a logging
 *                                    placeholder. Injected so tests can assert on
 *                                    what WOULD be sent without sending anything.
 * @param {Function} [options.collect] per-gym collector; defaults to
 *                                     `collectExpiringReminders`. A seam for
 *                                     testing gym-level containment, which
 *                                     cannot be provoked through the emulator.
 * @param {string} [options.today]
 * @param {string} [options.gymId]   restrict to one gym
 */
export async function runExpiryReminderJob(
  db,
  { deliver, collect = collectExpiringReminders, today, gymId, log } = {}
) {
  const emit = log ?? logger.info
  const send = deliver ?? placeholderDelivery

  const totals = {
    gyms: 0,
    scanned: 0,
    due: 0,
    delivered: 0,
    failed: 0,
    unprojectable: 0,
    perGym: [],
    reminders: [],
  }

  let gyms
  try {
    gyms = gymId ? [{ id: gymId }] : await readAllGyms(db)
  } catch (error) {
    emit('expiry reminders could not enumerate gyms', { error })
    totals.failed += 1
    totals.error = error?.message ?? 'unknown error'
    return totals
  }

  for (const gym of gyms) {
    // Per-gym containment: one unreadable gym must not stop the others.
    try {
      const { reminders, scanned, unprojectable } = await collect(db, gym.id, {
        today,
      })
      totals.gyms += 1
      totals.scanned += scanned
      totals.due += reminders.length
      totals.unprojectable += unprojectable

      let delivered = 0
      for (const reminder of reminders) {
        try {
          await send(reminder)
          delivered += 1
        } catch (error) {
          totals.failed += 1
          logger.error('expiry reminder delivery failed', {
            gymId: reminder.gymId,
            memberId: reminder.memberId,
            error: error?.message ?? 'unknown error',
          })
        }
      }

      totals.delivered += delivered
      totals.reminders.push(...reminders)
      totals.perGym.push({ gymId: gym.id, scanned, due: reminders.length, delivered })
    } catch (error) {
      totals.failed += 1
      emit('expiry reminders gym failed', { gymId: gym.id, error })
      totals.perGym.push({ gymId: gym.id, scanned: 0, due: 0, delivered: 0, failed: true })
    }
  }

  emit('expiry reminders complete', {
    gyms: totals.gyms,
    scanned: totals.scanned,
    due: totals.due,
    delivered: totals.delivered,
    failed: totals.failed,
  })

  return totals
}

/**
 * The delivery placeholder.
 *
 * Deliberately not an email provider and not a Firestore write. Wiring a real
 * provider is a deployment decision; what must not happen is the job quietly
 * writing audit documents in the meantime.
 */
async function placeholderDelivery(reminder) {
  logger.info('expiry reminder (not sent — no provider configured)', {
    memberId: reminder.memberId,
    gymId: reminder.gymId,
    daysLeft: reminder.daysLeft,
    effectiveExpiry: reminder.effectiveExpiry,
  })
}