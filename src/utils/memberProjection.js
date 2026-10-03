/**
 * PURE MEMBER PROJECTION ENGINE.
 *
 * ## What this is
 *
 * A deterministic function of the AUTHORITATIVE membership documents — the
 * `memberships` periods and the `membershipFreezes` — that produces the member
 * fields the app reads and queries:
 *
 *   members.membershipStart
 *   members.effectiveExpiry
 *   members.freezeUntil
 *   members.status
 *
 * Those four fields are a READ MODEL. They exist so a Firestore query can filter
 * and sort a member list without loading every period and freeze document first.
 * They are NOT financial authority and they are NOT access authority: deleting
 * all four changes nothing about what a member is owed or whether they hold
 * entitlement, because both of those are answered from the periods.
 *
 * ## Why it is written as a pure function
 *
 * `member.status` used to be a maintained field, written by whatever operation
 * happened to touch the member last. It drifted constantly: a backdated renewal,
 * a deleted period or a freeze recorded by the front desk each left it saying
 * something the documents no longer supported, and there was no way to tell a
 * stale status from a wrong one.
 *
 * Making the projection a pure function of the periods removes the possibility of
 * drift by construction. There is no write path that can set a status, so a status
 * cannot be wrong — it can only be STALE, and staleness has a single, testable
 * cause: the projection has not been recomputed since the periods changed.
 *
 * ## The one rule this module exists to enforce
 *
 * `deriveMemberProjection` NEVER reads a stored projection field as an input. It
 * does not accept the member document at all. It cannot be tempted to prefer a
 * stored `member.status` over the periods, because it never sees one.
 *
 * That is not stylistic. A projection that falls back to the previous projection
 * when it cannot derive an answer is self-reinforcing: it launders a stale value
 * into a fresh-looking one, and the drift it was built to remove comes back
 * wearing a new timestamp. Here, "I could not derive this" is answered with null
 * and nothing else.
 *
 * ## No-fabrication
 *
 * When the periods do not support an answer, the answer is null — never a guess.
 * Specifically:
 *
 * - No period covers today, and none has ended  -> everything null, status null.
 *   A member who has not started yet has not been granted access, and reporting
 *   them as active would be inventing entitlement.
 * - A period has ended -> status 'expired', and the dates come from THAT period.
 *   The post-expiry days it holds are real paid time and staff need to see them,
 *   so they are projected rather than blanked. Dropping them here is precisely the
 *   bug documented in `utils/membershipPeriods.js`: a null expiry made members
 *   vanish from the dashboard's expiring list, the one screen whose job is to
 *   prompt the renewal.
 * - A FUTURE period is never used as a date source while the member holds nothing
 *   current. Prepaid membership is not entitlement yet. It is surfaced separately
 *   by `resolvePeriodState`, and it becomes this projection's basis on its own
 *   start date, with no writer involvement.
 *
 * ## Money is deliberately absent
 *
 * There is no amount, no `amountDue` and no paid/unpaid flag here. Whether a
 * period is settled is owned by `utils/dues.js`, which derives it from the
 * payments ledger. A member with a partly-paid current period is `active` here:
 * they hold the period they bought, and the balance is a receivables question,
 * not an entitlement one. Duplicating the figure would create a second answer to
 * a question the ledger already owns, and the two would eventually disagree.
 *
 * The projection therefore carries no `currency` either. Period documents have
 * never stored a currency code — it is a pricing-time parameter in
 * `services/renewals.js` — so emitting one would mean inventing a value no
 * document supports.
 */

import { gymDayKey, gymTodayKey, resolveGymTimezone } from './gymTime'
import {
  daysToExpiry,
  periodDayKey,
  periodsForMember,
  resolvePeriodState,
} from './membershipPeriods'
import {
  anchoredFreezeRanges,
  applyFreezes,
  effectiveExpiryKey,
  freezeUntilKey,
} from './membershipFreezes'

/**
 * Days before expiry at which a member is reported as `expiring`.
 *
 * Seven is not a new number. It is the threshold the rest of the app already uses:
 * `matchesExpiryFilter(days, 'all')` in `utils/membership.js` admits days 0..7, and
 * the Dashboard labels its card "Expired and expiring within the next 7 days". A
 * second threshold here would let the projection disagree with the list it feeds.
 */
export const EXPIRING_WITHIN_DAYS = 7

/** The three projection statuses. A fourth state — "unknown" — is null. */
export const PROJECTION_STATUS = {
  ACTIVE: 'active',
  EXPIRING: 'expiring',
  EXPIRED: 'expired',
}

const EMPTY = {
  status: null,
  hasCurrentPeriod: false,
  periodId: null,
  periodBasis: null,
  membershipStart: null,
  effectiveExpiry: null,
  freezeUntil: null,
  isFrozen: false,
  isPT: false,
  expiringWithinDays: null,
}

/**
 * Derive one member's projection from the authoritative documents.
 *
 * ## Parameters
 *
 * @param {string} memberId    Whose projection to derive. Required in practice;
 *                             a missing id yields the empty projection rather than
 *                             an answer about an unknown member.
 * @param {Array}  memberships The `memberships` collection, or any superset of it.
 *                             Narrowed to this member by `periodsForMember`, which
 *                             also imposes the canonical ordering.
 * @param {Array}  freezes     The `membershipFreezes` collection. Scoped to the
 *                             member AND to the chosen period by the freeze helpers
 *                             themselves; this module never filters them by hand.
 * @param {string} [timezone]  The gym's zone, from
 *                             `gyms/{gymId}/settings/app.timezone`. Resolved
 *                             through `resolveGymTimezone`, so a blank or unknown
 *                             zone falls back to the canonical default instead of
 *                             throwing or, worse, silently using the server's zone.
 * @param {string|Date} [today]
 *                             The gym-local day to evaluate against. A
 *                             `YYYY-MM-DD` key is used verbatim; an instant
 *                             (Date, Firestore Timestamp, ISO string) is resolved
 *                             to its calendar day IN THE GYM'S ZONE, which is the
 *                             only correct reading. Defaults to the gym's current
 *                             day.
 *
 * ## Returns
 *
 * `{ memberId, timezone, today, ...projection }`, where projection is:
 *
 *   status             'active' | 'expiring' | 'expired' | null
 *   hasCurrentPeriod   whether a period covers today
 *   periodId           the period the dates were derived from, or null
 *   periodBasis        'current' | 'past' | null — never 'future'
 *   membershipStart    that period's `startDate` key
 *   effectiveExpiry    original expiry plus anchored freeze days
 *   freezeUntil        the last frozen DAY (not the expiry), or null
 *   isFrozen           whether today falls inside a live anchored freeze
 *   isPT               the period's own immutable PT snapshot
 *   expiringWithinDays signed days to `effectiveExpiry`; 0 today, negative lapsed
 *
 * ## Purity
 *
 * No input is mutated and nothing outside the arguments is read: no clock except
 * through `today`/`gymTodayKey`, no Firestore, no member document. Given the same
 * arguments it returns the same value, which is what makes it safe to run over a
 * whole collection, safe to re-run after a rules change, and safe to assert on.
 */
export function deriveMemberProjection({
  memberId,
  memberships,
  freezes,
  timezone,
  today,
} = {}) {
  const tz = resolveGymTimezone(timezone)

  // A date-only `today` is a calendar date and is used verbatim. An instant has to
  // be converted, and converted into the GYM's day rather than the server's — the
  // whole class of bug this codebase keeps eliminating is a correct instant being
  // read on the wrong calendar.
  const suppliedToday = today ? gymDayKey(today, tz) : ''
  // An unusable `today` means the engine cannot say anything about currency at
  // all, because every status is relative to a day. Answering null is the safe
  // direction: the member is not reported as active, and a caller recomputing a
  // whole collection is not aborted by one bad argument.
  const todayKey = today ? suppliedToday : gymTodayKey(tz)

  const own = periodsForMember(Array.isArray(memberships) ? memberships : [], memberId)
  const freezeList = Array.isArray(freezes) ? freezes : []

  const state = resolvePeriodState(applyFreezes(own, freezeList), { today: todayKey, timezone: tz })

  // The authoritative current period, else the most recent one that has ended.
  // `future` is deliberately absent: a prepaid period is not entitlement yet, and
  // projecting its dates would put a future expiry on a member who holds nothing.
  const basis = state.current || state.past || null
  const basisKind = state.current ? 'current' : state.past ? 'past' : null

  if (!todayKey || !basis) {
    return { memberId: memberId ?? null, timezone: tz, today: todayKey, ...EMPTY }
  }

  // The freeze helpers scope by `period.memberId` and `period.id`. The id is
  // stamped so a caller passing periods without one still resolves its freezes,
  // and the member id is restated from the argument the collection was narrowed
  // by — the same defensive shape `utils/dues.js` uses for freeze tails.
  const period = { ...basis, memberId: basis.memberId ?? memberId }

  const start = periodDayKey(period.startDate)
  const effective = effectiveExpiryKey(period, freezeList)
  const until = freezeUntilKey(period, freezeList)
  const days = daysToExpiry({ ...period, effectiveExpiry: effective }, todayKey)

  // Membership currency and freezing are orthogonal: a member frozen today is
  // still `active`, and reporting a fourth "frozen" status would have made frozen
  // look like an alternative to being current rather than something layered on top
  // of it.
  let status = PROJECTION_STATUS.EXPIRED
  if (state.current) {
    status = days !== null && days <= EXPIRING_WITHIN_DAYS
      ? PROJECTION_STATUS.EXPIRING
      : PROJECTION_STATUS.ACTIVE
  }

  // Whether today is itself inside a frozen stretch. Asked separately from
  // `freezeUntil` because the two answer different questions: a member frozen to
  // 14 August whose entitlement runs to 26 August is still frozen on 10 August but
  // not on the 20th, and `isFrozen` has to be able to say so.
  const isFrozen = anchoredFreezeRanges(period, freezeList).some(
    ([from, to]) => from <= todayKey && todayKey <= to
  )

  return {
    memberId: memberId ?? null,
    timezone: tz,
    today: todayKey,
    status,
    hasCurrentPeriod: Boolean(state.current),
    periodId: period.id ?? null,
    periodBasis: basisKind,
    membershipStart: start || null,
    effectiveExpiry: effective || null,
    freezeUntil: until || null,
    isFrozen,
    // The period's own snapshot, not the member's live PT flag: a surcharge toggled
    // on the member today must not rewrite what this period was sold as.
    isPT: Boolean(period.isPT),
    expiringWithinDays: days,
  }
}