import { commitAtomically, listAll } from './firestore'
import { logAudit } from './audit'
import {
  asWritten,
  assertLedgerFresh,
  bumpLedgerRevision,
  snapshotPatches,
  withLedgerRevision,
} from './memberLedger'
import { requestReprojection } from './projection'
import { getMembershipCharge, getEffectivePtSurcharge } from '@/utils/pt'

/**
 * ONE guarded transaction for a period edit: the period's own patch, the
 * snapshots the ledger now implies for every one of the member's periods, and
 * the revision bump that tells other writers the ledger moved.
 *
 * One update per document: the edited period's own recomputed figures are
 * merged into its patch instead of being written twice.
 */
async function writePeriodAndSnapshots({ memberId, inputs, periodId, patch }) {
  // The period as it will be once the patch lands, so its own dues are
  // recomputed too and not only its siblings'.
  const patched = inputs.memberships.map((p) => (p.id === periodId ? { ...p, ...patch } : p))
  const snapshots = snapshotPatches({ ...inputs, memberships: patched })

  const fieldsById = new Map()
  for (const snapshot of snapshots) fieldsById.set(snapshot.id, { ...snapshot.fields })
  fieldsById.set(periodId, { ...(fieldsById.get(periodId) || {}), ...patch })

  await commitAtomically(async (tx) => {
    // First read: the figures above are only valid while the ledger holds.
    await assertLedgerFresh(tx, memberId, inputs.revision)
    for (const [id, fields] of fieldsById) tx.update('memberships', id, fields)
    bumpLedgerRevision(tx, memberId, inputs.revision)
  })

  return snapshots
}

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
 * The re-price and the recomputed figures are ONE guarded transaction: the
 * period's own `amountDue` follows its new price, and a payment recorded while
 * the operator was on the form cannot be overwritten by the figures computed
 * before it landed.
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

  const attempt = async (inputs) => {
    const period = inputs.memberships.find((p) => p.id === periodId) || null
    if (!period) throw new Error('Membership period not found')
    if (period.memberId !== memberId) throw new Error('Period does not belong to this member')

    const plan = inputs.plans.find((p) => String(p.id) === String(period.planId)) || null

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

    await writePeriodAndSnapshots({
      memberId,
      inputs,
      periodId,
      patch,
    })

    return { period, patch }
  }

  const { period, patch } = await withLedgerRevision(memberId, attempt)

  // The period changed, so the member's projection is now stale. The browser
  // never writes it; it asks the server to. Never awaited-thrown — see
  // services/projection.js.
  await requestReprojection(memberId)

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
 * The period is validated against THIS member's own periods first (the same
 * check the PT flow makes): a stale form — the member was switched, or the
 * period was deleted — must not re-price someone else's period and then
 * recompute the caller's dues from the edit.
 *
 * The patch and ALL of this member's recomputed period snapshots are written in
 * ONE guarded transaction — the dates/price a payment is allocated against and
 * the resulting dues can never disagree, and a payment recorded while the form
 * was open survives instead of being overwritten by pre-payment figures.
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

  await withLedgerRevision(memberId, async (inputs) => {
    // Ownership first: the period must be one of THIS member's periods.
    const period = inputs.memberships.find((p) => p.id === periodId) || null
    if (!period) throw new Error('Membership period not found')
    if (period.memberId !== memberId) throw new Error('Period does not belong to this member')

    await writePeriodAndSnapshots({ memberId, inputs, periodId, patch: safe })
  })
  await requestReprojection(memberId)

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
 * Strategy, all in ONE transaction:
 * 1. Find the payments whose `membershipId` points at this period.
 * 2. Clear their `membershipId` so they become unallocated cash.
 * 3. Delete the membership document itself.
 * 4. Write the new snapshots of the remaining periods — the ledger's FIFO
 *    logic reassigns those now-unallocated payments to them in chronological
 *    order.
 *
 * The transaction matters here for the same reason it does for a payment: the
 * unlinks, the delete and the reallocation used to be separate writes, so a
 * failure partway left the period gone while its cash was still attributed to
 * it (or the remaining periods still showed the old dues).
 *
 * Returns { id, affectedPayments, memberships } — the affected payments so the
 * UI can inform the operator, and the snapshots that were rewritten.
 */
export async function deleteMembershipPeriod({ periodId, memberId }) {
  if (!periodId) throw new Error('A period ID is required')
  if (!memberId) throw new Error('A member ID is required')

  // Everything this operation decides from — the period's payments and the
  // member's ledger — is read per attempt, inside the revision guard: a
  // concurrent money write bumps the revision, the transaction refuses to
  // commit figures computed before it, and the retry re-reads both.
  const attempt = async (inputs) => {
    // Only payments ATTRIBUTED to this period matter here, so query them by
    // membershipId instead of reading the whole payments collection.
    const affected = await listAll('payments', {
      where: { field: 'membershipId', value: periodId },
    })

    // The ledger as it WILL be: the period gone and its payments unlinked.
    const unlinked = new Set(affected.map((p) => p.id))
    const patches = snapshotPatches({
      ...inputs,
      payments: inputs.payments.map((p) =>
        unlinked.has(p.id) ? { ...p, membershipId: '' } : p
      ),
      memberships: inputs.memberships.filter((p) => p.id !== periodId),
    })

    await commitAtomically(async (tx) => {
      // First read: the figures above are only valid while the ledger holds.
      await assertLedgerFresh(tx, memberId, inputs.revision)
      for (const payment of affected) tx.update('payments', payment.id, { membershipId: '' })
      tx.remove('memberships', periodId)
      bumpLedgerRevision(tx, memberId, inputs.revision)
      for (const patch of patches) tx.update('memberships', patch.id, patch.fields)
    })

    return { affected, patches }
  }

  const { affected, patches } = await withLedgerRevision(memberId, attempt)

  // Deleting a period can leave the member with NO current period, which is a
  // different projection than a wrong one — and the one most likely to go stale.
  await requestReprojection(memberId)

  await logAudit({
    action: 'delete',
    entity: 'memberships',
    entityId: periodId,
    details: {
      memberId,
      affectedPayments: affected.map((p) => ({ id: p.id, amount: p.amount })),
    },
  })

  return { id: periodId, affectedPayments: affected, memberships: asWritten(patches) }
}
