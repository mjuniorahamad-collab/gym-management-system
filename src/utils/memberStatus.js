/**
 * THE STATUS A SCREEN SHOWS — derived from the periods, not copied from the cache.
 *
 * `member.status` is a projection field written by the trusted server writer
 * (`reprojectMember`). That function is not deployed for this project, so:
 *
 * - a member added today has NO status field at all, and the badge rendered "—",
 *   with the "Active" filter never matching them;
 * - a renewed member keeps yesterday's status, because nothing recomputes it.
 *
 * The membership periods are the authority — they are what a renewal actually
 * writes — so the status is derived from them here with the SAME pure engine the
 * server writer uses. This is a display decision only: nothing is written back,
 * and the stored field stays the server's business.
 *
 * Falls back to `member.status` for a member with no period documents at all
 * (legacy records that predate periods): the engine answers `null` there, and
 * `null` must not erase a status some other writer did set.
 *
 * @param {object} args
 * @param {object} args.member        the member document
 * @param {Array}  args.memberships   periods (the whole collection is fine)
 * @param {Array}  [args.freezes]     membershipFreezes, so a freeze-extended
 *                                    expiry is not reported as expired
 * @param {string} [args.timezone]    the gym's timezone
 * @param {string|Date} [args.today]  injected for tests; defaults to the gym's today
 * @returns {'active'|'expiring'|'expired'|null}
 */
import { deriveMemberProjection } from './memberProjection'

export function memberDisplayStatus({ member, memberships, freezes = [], timezone, today } = {}) {
  if (!member || !member.id) return member?.status ?? null

  const projection = deriveMemberProjection({
    memberId: member.id,
    memberships,
    freezes,
    timezone,
    today,
  })

  return projection.status ?? member.status ?? null
}
