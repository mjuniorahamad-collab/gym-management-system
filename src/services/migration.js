import { createDoc, listAll } from './firestore'
import { logAudit } from './audit'
import { computeMemberFinanceRollups, computeMemberLedger } from '@/utils/dues'
import { toDateInputValue } from '@/utils/dateHelpers'

/**
 * How many members still carry an undocumented origin period (reconstructed
 * implicitly by the finance ledger because their earliest payment predates
 * their oldest membership record)? Used by the Dashboard banner and the
 * Settings action so the owner can see and resolve pending cleanup.
 *
 * Delegates to the same single-pass rollup the dashboard uses, so the count
 * cannot drift from the one shown on the banner. ptSurcharge stays optional and
 * defaults to 0, which is exactly what this function always used - it only
 * affects an implicit period's PRICE, never whether one is reconstructed.
 */
export function countPendingOriginPeriods({
  members = [],
  plans = [],
  payments = [],
  memberships = [],
  ptSurcharge = 0,
} = {}) {
  return computeMemberFinanceRollups({ members, plans, payments, memberships, ptSurcharge })
    .pendingOriginPeriods
}

function isoOrNull(date) {
  return date ? toDateInputValue(date) : ''
}

/**
 * One-time idempotent backfill: materializes every implicit origin period
 * into a real `memberships` document so ALL historical balances become
 * first-class records.
 *
 * - Price comes from the member's current plan (historic prices were never
 *   stored); documents are flagged `migratedFromLegacy: true` for review.
 * - Existing unallocated payments keep flowing to these periods via FIFO,
 *   so figures match what the ledger already shows.
 * - Running twice is a no-op: once recorded, periods are no longer implicit.
 */
export async function ensureOriginPeriods() {
  const [members, plans, payments, memberships] = await Promise.all([
    listAll('members'),
    listAll('membershipPlans'),
    listAll('payments'),
    listAll('memberships'),
  ])

  const planMap = Object.fromEntries(plans.map((p) => [p.id, p]))
  let created = 0

  for (const member of members) {
    if (!member?.id) continue
    // Only members that have (or had) a plan can owe for a period.
    if (!planMap[member.membershipPlanId]) continue

    const ledger = computeMemberLedger({ member, plans, payments, memberships })
    for (const period of ledger.periods.filter((p) => p.implicit)) {
      await createDoc('memberships', {
        memberId: member.id,
        planId: period.planId || '',
        planName: period.label.replace(/ \(earlier\)$/, ''),
        startDate: isoOrNull(period.startDate),
        expiryDate: isoOrNull(period.expiryDate),
        price: period.price,
        amountPaid: period.paid,
        amountDue: period.due,
        paymentStatus: period.status,
        paymentId: null,
        receiptNo: null,
        note: 'Reconstructed earlier membership (created during financial data cleanup)',
        migratedFromLegacy: true,
      })
      created += 1
    }
  }

  await logAudit({
    action: 'create',
    entity: 'memberships',
    entityId: null,
    details: { migration: 'origin-period-backfill', created },
  })

  return { created }
}

// NOTE: the former client-driven tenancy backfill (ensureGymTenancy) has been
// REMOVED. It enumerated every business collection unscoped and stamped the
// caller's gymId onto any document that lacked one, which is a
// first-come-first-served claim: whichever tenant happened to sign in first
// would silently absorb pre-tenancy records that may belong to another tenant.
// It also depended on an unscoped read helper (listAllUnscoped) that bypassed
// the app's gym scoping, and provisioned a global member-number counter.
//
// Re-tagging legacy records is now an Admin/infrastructure responsibility,
// performed under rules-bypassed access with a verified backup taken first,
// and it is idempotent and auditable. Security rules no longer permit a client
// to adopt an untagged document at all (see canWriteTenant in firestore.rules).
