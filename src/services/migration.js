import { createDoc, getById, listAll, isReady, listAllUnscoped, updateDocById, upsertDoc } from './firestore'
import { logAudit } from './audit'
import { getGymId } from './ownerContext'
import { computeMemberLedger } from '@/utils/dues'
import { toDateInputValue } from '@/utils/dateHelpers'
import { parseMemberNo } from '@/utils/memberNo'

/**
 * How many members still carry an undocumented origin period (reconstructed
 * implicitly by the finance ledger because their earliest payment predates
 * their oldest membership record)? Used by the Dashboard banner and the
 * Settings action so the owner can see and resolve pending cleanup.
 */
export function countPendingOriginPeriods({ members = [], plans = [], payments = [], memberships = [] } = {}) {
  let count = 0
  for (const member of members) {
    const ledger = computeMemberLedger({ member, plans, payments, memberships })
    if (ledger.periods.some((p) => p.implicit)) count += 1
  }
  return count
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

// Business collections that carry the gymId tenancy key and can be safely
// updated (the audit log is deliberately excluded because it is append-only).
const TENANCY_COLLECTIONS = [
  'members',
  'membershipPlans',
  'memberships',
  'payments',
  'expenses',
  'attendance',
  'classes',
  'bookings',
  'trainers',
]

// Mirrors memberNumbers.js counterKey: the deterministic per-gym document the
// member-number sequence is stored in. nextMemberNo() reads and increments it
// inside a transaction, so it MUST exist for member creation to be allowed
// (security rules deny reading a non-existent counters doc).
function memberNoCounterId(gymId) {
  const normalized = String(gymId).replace(/[^a-zA-Z0-9_-]/g, '_')
  return `memberNo_${normalized}`
}

/**
 * Provisions the caller's per-gym member-number counter if it is missing, so
 * member creation (which reads the counter in a transaction) is not blocked by
 * a rules-denied read of a non-existent document. NEVER overwrites an existing
 * counter. Returns the count of counters created (0 or 1).
 */
async function ensureMemberNumberCounter(gymId) {
  const id = memberNoCounterId(gymId)

  // If the counter already exists (readable or not) we must not overwrite it.
  // A missing counter is unreadable under the rules (it throws), which is
  // treated as "not yet provisioned" so we fall through to create it.
  let existing = null
  try {
    existing = await getById('counters', id)
  } catch {
    existing = null
  }
  if (existing) return 0

  // Seed from the highest member number already in this gym so numbering
  // continues without collisions; default 0 when there are none.
  let max = 0
  const members = await listAllUnscoped('members').catch(() => [])
  for (const m of members) {
    const n = parseMemberNo(m.memberNo)
    if (n !== null && n > max) max = n
  }

  await upsertDoc('counters', id, { value: max, gymId })
  return 1
}

/**
 * Idempotent tenancy backfill: stamps the caller's bound gymId onto every
 * existing business document that does not already carry one, and provisions
 * the per-gym member-number counter if it is missing. It NEVER overwrites an
 * existing gymId/counter and never destroys data — re-running is a no-op once
 * everything is tagged. Requires a bound gym (owner-of-record); otherwise it
 * reports `no-gym` and does nothing.
 */
export async function ensureGymTenancy() {
  const gymId = getGymId()
  if (!gymId) return { status: 'no-gym' }
  if (!isReady()) return { status: 'demo' }

  let tagged = 0
  const perCollection = {}

  for (const name of TENANCY_COLLECTIONS) {
    let docs
    try {
      docs = await listAllUnscoped(name)
    } catch {
      perCollection[name] = 'error'
      continue
    }
    let taggedHere = 0
    for (const doc of docs) {
      if (doc && doc.gymId !== undefined && doc.gymId !== null) continue
      await updateDocById(name, doc.id, { gymId })
      taggedHere += 1
    }
    if (taggedHere > 0) perCollection[name] = taggedHere
    tagged += taggedHere
  }

  if (tagged > 0) {
    await logAudit({
      action: 'update',
      entity: 'tenancy',
      entityId: null,
      details: { migration: 'gymId-backfill', gymId, tagged },
    })
  }

  // Provision the per-gym member-number counter so member creation is never
  // blocked by a denied read of a missing counter. Idempotent + non-destructive.
  let countersCreated = 0
  try {
    countersCreated = await ensureMemberNumberCounter(gymId)
  } catch {
    countersCreated = 0
  }

  return { status: 'ok', tagged, countersCreated, perCollection }
}
