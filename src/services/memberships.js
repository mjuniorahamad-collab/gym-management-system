import { getById, listAll, removeDoc, updateDocById } from './firestore'
import { logAudit } from './audit'
import { refreshMembershipSnapshots } from './payments'
import { getMembershipCharge, getEffectivePtSurcharge } from '@/utils/pt'

/**
 * Apply PT-inclusive pricing to ONE membership period (the owner's explicit,
 * audited "apply PT to the current period" action).
 *
 * This is the SAFE, INTENTIONAL adjustment referenced by the PT enable flow:
 * it re-prices a single (current/open) period to the canonical effective
 * price (base plan + applicable PT surcharge/override), snapshots WHY on the
 * record (basePrice / ptSurcharge / isPT), and recomputes that member's dues
 * from the finance ledger. It NEVER touches older or closed periods, and
 * NEVER rewrites a payment record.
 *
 * Returns the updated period document. Throws on invalid input or write failure.
 */
export async function applyPTInclusivePriceToPeriod({
  periodId,
  memberId,
  isPT = true,
  ptSurcharge = 0,
  ptSurchargeOverride,
}) {
  if (!periodId) throw new Error('A period ID is required')
  if (!memberId) throw new Error('A member ID is required')

  const period = await getById('memberships', periodId)
  if (!period) throw new Error('Membership period not found')
  if (period.memberId !== memberId) throw new Error('Period does not belong to this member')

  const plans = await listAll('membershipPlans')
  const plan = plans.find((p) => String(p.id) === String(period.planId)) || null

  let charge
  if (plan) {
    charge = getMembershipCharge({ plan, isPT, ptSurcharge, ptSurchargeOverride })
  } else {
    const rawBase = Number(period.price)
    const base = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : 0
    const addon = isPT ? getEffectivePtSurcharge({ ptSurcharge, ptSurchargeOverride }) : 0
    charge = { base, addon, total: base + addon }
  }

  const patch = {
    price: charge.total,
    basePrice: charge.base,
    ptSurcharge: charge.addon,
    isPT: Boolean(isPT),
  }
  await updateDocById('memberships', periodId, patch)
  await refreshMembershipSnapshots(memberId)

  await logAudit({
    action: 'update',
    entity: 'memberships',
    entityId: periodId,
    details: { memberId, ptAdjusted: true, ...patch },
  })

  return { id: periodId, ...period, ...patch }
}

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
  // `allPayments` was read above to find the reallocated payments, and those
  // payments have since been unlinked. Reflect that in the in-memory copy so it
  // is identical to what a fresh read would return, then hand it over instead
  // of reading the whole collection a second time in the same operation.
  const unlinkedIds = new Set(affected.map((p) => p.id))
  const paymentsAfterUnlink = allPayments.map((p) =>
    unlinkedIds.has(p.id) ? { ...p, membershipId: '' } : p
  )
  await refreshMembershipSnapshots(memberId, { payments: paymentsAfterUnlink })

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
