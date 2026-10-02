import { createDoc, getById, listAll, removeDoc, updateDocById } from './firestore'
import { logAudit } from './audit'
import { computeMemberLedger } from '@/utils/dues'
import { safePaymentAmount } from '@/utils/payments'
import { nextReceiptNo } from './receipts'

/**
 * Recompute every membership-period snapshot (amountPaid / amountDue /
 * paymentStatus) for one member from the finance ledger — the same single
 * source of truth used by all UI screens.
 *
 * Called after EVERY payment mutation (create, delete) so stored snapshots
 * can never drift from reality and stale "Paid in full" states are
 * impossible.
 *
 * Returns the list of period snapshots that were written.
 *
 * `payments` may be supplied by a caller that has already read the collection
 * in the same operation, to avoid a second identical full read. It must be the
 * complete, unfiltered collection - the ledger filters by memberId itself.
 */
export async function refreshMembershipSnapshots(memberId, { payments: paymentsOverride } = {}) {
  if (!memberId) return []
  const [member, plans, payments, memberships] = await Promise.all([
    getById('members', memberId),
    listAll('membershipPlans'),
    paymentsOverride ? Promise.resolve(paymentsOverride) : listAll('payments'),
    listAll('memberships'),
  ])

  const ownPeriods = memberships.filter((m) => m && m.id && m.memberId === memberId)
  const ledger = computeMemberLedger({ member, plans, payments, memberships })
  const figuresById = new Map(ledger.periods.filter((p) => p.id).map((p) => [p.id, p]))

  const updated = []
  for (const period of ownPeriods) {
    const figures = figuresById.get(period.id)
    if (!figures) continue
    const patch = {
      amountPaid: figures.paid,
      amountDue: figures.due,
      paymentStatus: figures.status,
    }
    const unchanged =
      Number(period.amountPaid) === patch.amountPaid &&
      Number(period.amountDue) === patch.amountDue &&
      period.paymentStatus === patch.paymentStatus
    if (!unchanged) {
      await updateDocById('memberships', period.id, patch)
      updated.push({ id: period.id, ...patch })
    }
  }
  return updated
}

/**
 * Record a member payment in one consistent workflow:
 *
 * 1. Creates the `payments` document, stamping `type`, `memberName`,
 *    `planName` and `receiptNo`.
 * 2. The payment is attributed through `membershipId` when a target period
 *    is known — dues are computed per period, so an unattributed payment
 *    cannot reliably settle a specific balance.
 * 3. Recomputes ALL of the member's period snapshots from the finance
 *    ledger (covers both targeted payments and legacy unallocated cash).
 * 4. Appends an audit entry.
 */
export async function recordPayment({
  values,
  memberName = '',
  planName = '',
  receiptPrefix = 'HWG',
  type = 'membership',
}) {
  const amount = safePaymentAmount(values.amount)
  // Receipt numbers came from `Date.now().toString().slice(-6)`, whose value
  // space is 1e6 ms — so two payments roughly 16m40s apart with the same
  // sub-second offset minted the SAME receipt number. The per-gym counter
  // transaction makes duplicates impossible and keeps receipts in issue order.
  const receiptNo = await nextReceiptNo(receiptPrefix)

  let membershipId = values.membershipId || ''
  if (membershipId) {
    const doc = await getById('memberships', membershipId)
    if (!doc || (values.memberId && doc.memberId !== values.memberId)) {
      // Stale target (e.g. the member was changed after the form opened) —
      // never attribute cash to someone else's period.
      membershipId = ''
    }
  }

  const paymentData = {
    ...values,
    membershipId,
    type,
    ...(planName ? { planName } : {}),
    receiptNo,
    memberName,
  }
  const id = await createDoc('payments', paymentData)

  // Refresh EVERY period of this member from the ledger AFTER the payment
  // exists so all stored figures include it (targeted or FIFO-allocated).
  let membership = null
  if (values.memberId) {
    const refreshed = await refreshMembershipSnapshots(values.memberId)
    if (membershipId) {
      const figures = refreshed.find((r) => r.id === membershipId)
      if (figures) {
        const doc = await getById('memberships', membershipId)
        membership = doc ? { ...doc } : { id: membershipId, ...figures }
      }
    }
  }

  await logAudit({
    action: 'create',
    entity: 'payments',
    entityId: id,
    details: { member: memberName || undefined, amount, membershipId: membershipId || undefined },
  })

  return { id, receiptNo, membership, amount }
}

/**
 * Delete a payment through the same source of truth:
 *
 * 1. Removes the `payments` document from Firestore.
 * 2. Recomputes the affected member's period snapshots so paid amounts,
 *    dues, statuses ("Paid in full") and dashboard totals revert correctly.
 * 3. Appends an audit entry.
 */
export async function deletePayment({ payment }) {
  if (!payment?.id) throw new Error('A payment reference is required')
  await removeDoc('payments', payment.id)

  await logAudit({
    action: 'delete',
    entity: 'payments',
    entityId: payment.id,
    details: {
      amount: safePaymentAmount(payment.amount),
      member: payment.memberName || undefined,
      membershipId: payment.membershipId || undefined,
    },
  })

  let memberships = []
  if (payment.memberId) {
    memberships = await refreshMembershipSnapshots(payment.memberId)
  }

  return { id: payment.id, memberships }
}
