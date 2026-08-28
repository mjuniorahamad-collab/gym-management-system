import { listAll, removeDoc, updateDocById } from './firestore'
import { logAudit } from './audit'
import { refreshMembershipSnapshots } from './payments'

/**
 * Edit an existing membership period's plan, price, start/expiry dates.
 *
 * After writing the patch, ALL period snapshots for this member are
 * recomputed from the finance ledger so payment allocations stay correct.
 *
 * Returns the updated document. Throws on invalid input or write failure.
 */
export async function editMembershipPeriod({ periodId, memberId, patch }) {
  if (!periodId) throw new Error('A period ID is required')
  if (!memberId) throw new Error('A member ID is required')
  if (!patch || typeof patch !== 'object') throw new Error('A patch object is required')

  const allowed = ['planId', 'planName', 'price', 'startDate', 'expiryDate']
  const safe = {}
  for (const key of allowed) {
    if (key in patch) safe[key] = patch[key]
  }
  if (Object.keys(safe).length === 0) throw new Error('No valid fields to update')

  await updateDocById('memberships', periodId, safe)
  await refreshMembershipSnapshots(memberId)

  await logAudit({
    action: 'update',
    entity: 'memberships',
    entityId: periodId,
    details: { memberId, ...safe },
  })

  return { id: periodId, ...safe }
}

/**
 * Delete a membership period and safely reallocate its payments.
 *
 * Strategy:
 * 1. Find all payments whose `membershipId` points at this period.
 * 2. Clear their `membershipId` so they become unallocated cash.
 * 3. Delete the membership document itself.
 * 4. Recompute ALL period snapshots — the ledger's FIFO logic will
 *    automatically reassign those now-unallocated payments to the
 *    remaining periods in chronological order.
 *
 * Returns { id, affectedPayments } — the list of payments that were
 * reallocated so the UI can inform the operator.
 */
export async function deleteMembershipPeriod({ periodId, memberId }) {
  if (!periodId) throw new Error('A period ID is required')
  if (!memberId) throw new Error('A member ID is required')

  const allPayments = await listAll('payments')
  const affected = allPayments.filter((p) => p && p.id && p.membershipId === periodId)

  for (const payment of affected) {
    await updateDocById('payments', payment.id, { membershipId: '' })
  }

  await removeDoc('memberships', periodId)
  await refreshMembershipSnapshots(memberId)

  await logAudit({
    action: 'delete',
    entity: 'memberships',
    entityId: periodId,
    details: {
      memberId,
      affectedPayments: affected.map((p) => ({ id: p.id, amount: p.amount })),
    },
  })

  return { id: periodId, affectedPayments: affected }
}
