import { commitAtomically, getById, listAll, updateDocById } from './firestore'
import { logAudit } from './audit'
import { computeMemberLedger } from '@/utils/dues'
import { safePaymentAmount } from '@/utils/payments'
import {
  formatReceiptNo,
  nextReceiptSequence,
  prepareReceiptFloor,
  receiptCounterId,
} from './receipts'
import { requireReceiptPrefix } from './receiptPrefixGuard'

/**
 * The documents the finance ledger is computed from, read once.
 *
 * These queries happen OUTSIDE the money transaction on purpose: the web SDK's
 * transaction can only fetch individual documents, not run a query, and a
 * member's payment history is a query. The transaction below therefore makes
 * the WRITES atomic (payment + receipt counter + period snapshots commit
 * together or not at all); the figures it writes are the ones computed here.
 */
async function readLedgerInputs(memberId) {
  const [member, plans, payments, memberships] = await Promise.all([
    getById('members', memberId),
    listAll('membershipPlans'),
    listAll('payments', { where: { field: 'memberId', value: memberId } }),
    listAll('memberships', { where: { field: 'memberId', value: memberId } }),
  ])
  return { member, plans, payments, memberships }
}

/**
 * The snapshot fields each stored period needs so the documents match the
 * ledger. Periods already carrying the right figures produce no patch, so a
 * payment only rewrites what it actually changed.
 *
 * `payments` here is the ledger INCLUDING the payment being recorded (or
 * EXCLUDING the one being deleted) — the caller decides.
 */
function snapshotPatches({ member, plans, payments, memberships }) {
  const ledger = computeMemberLedger({ member, plans, payments, memberships })
  const figuresById = new Map(ledger.periods.filter((p) => p.id).map((p) => [p.id, p]))

  const patches = []
  for (const period of memberships) {
    if (!period?.id) continue
    const figures = figuresById.get(period.id)
    if (!figures) continue
    const fields = {
      amountPaid: figures.paid,
      amountDue: figures.due,
      paymentStatus: figures.status,
    }
    const unchanged =
      Number(period.amountPaid) === fields.amountPaid &&
      Number(period.amountDue) === fields.amountDue &&
      period.paymentStatus === fields.paymentStatus
    if (!unchanged) patches.push({ id: period.id, fields })
  }
  return patches
}

const asWritten = (patches) => patches.map((p) => ({ id: p.id, ...p.fields }))

/**
 * Recompute every membership-period snapshot (amountPaid / amountDue /
 * paymentStatus) for one member from the finance ledger — the same single
 * source of truth used by all UI screens — without touching a payment.
 *
 * `recordPayment`/`deletePayment` do this inside their own transaction; this
 * entry point is for the period-editing flows (PT pricing, period edits,
 * period deletion), which do not move money themselves.
 *
 * Returns the list of period snapshots that were written.
 */
export async function refreshMembershipSnapshots(memberId) {
  if (!memberId) return []
  const patches = snapshotPatches(await readLedgerInputs(memberId))
  for (const patch of patches) {
    await updateDocById('memberships', patch.id, patch.fields)
  }
  return asWritten(patches)
}

/**
 * Record a member payment in one consistent, ATOMIC workflow:
 *
 * 1. Validates the target period against this member's own periods — a stale
 *    target (e.g. the member was changed after the form opened) is dropped, so
 *    cash is never attributed to someone else's period.
 * 2. In ONE transaction: mints the receipt number (per-gym counter), creates
 *    the `payments` document, and rewrites every period snapshot that the new
 *    payment changes.
 *
 * The transaction is the point: previously the payment was written first and
 * the snapshots recomputed afterwards, so a failure in between left a recorded
 * payment with a stale "due"/"paid in full" state that only the nightly sweep
 * could repair. Now either the whole money movement lands or none of it does.
 *
 * The audit entry is written AFTER the commit and stays outside it: auditing
 * must never be able to roll back a payment, and it never throws.
 */
export async function recordPayment({
  values,
  memberName = '',
  planName = '',
  receiptPrefix: suppliedPrefix,
  type = 'membership',
}) {
  const amount = safePaymentAmount(values.amount)
  // Resolved before anything is written: the authoritative prefix lives on
  // gyms/{gymId}, and a caller holding the settings mirror is only trusted
  // while the two still agree.
  const receiptPrefix = await requireReceiptPrefix(suppliedPrefix, 'recordPayment')

  const inputs = values.memberId ? await readLedgerInputs(values.memberId) : null

  let membershipId = values.membershipId || ''
  if (membershipId) {
    const valid = inputs
      ? inputs.memberships.some((p) => p.id === membershipId && p.memberId === values.memberId)
      : Boolean(await getById('memberships', membershipId))
    // Never attribute cash to another member's period.
    if (!valid) membershipId = ''
  }

  const paymentData = {
    ...values,
    membershipId,
    type,
    ...(planName ? { planName } : {}),
    memberName,
  }

  // The payment being recorded is part of the ledger that decides its own
  // snapshots, so it is included before it exists.
  const patches = inputs
    ? snapshotPatches({
        ...inputs,
        payments: [...inputs.payments, { ...paymentData, id: 'pending-payment' }],
      })
    : []
  const targetPatch = patches.find((p) => p.id === membershipId) || null

  // Legacy receipt numbers were derived from the clock and can collide with a
  // minted one, so the counter floor is seeded from them. Computed (and cached)
  // outside the transaction: a full payments read must not run on every retry.
  const floor = await prepareReceiptFloor()

  const { id, receiptNo } = await commitAtomically(async (tx) => {
    // Counter read INSIDE the transaction, so the number and the payment it
    // labels are committed together — a receipt can be neither burned nor
    // reissued by a failure or a concurrent terminal.
    const counter = await tx.get('counters', receiptCounterId())
    const sequence = nextReceiptSequence(counter?.value, floor)
    const minted = formatReceiptNo(receiptPrefix, sequence)
    tx.upsert('counters', receiptCounterId(), { value: sequence })
    const paymentId = await tx.create('payments', { ...paymentData, receiptNo: minted })
    for (const patch of patches) tx.update('memberships', patch.id, patch.fields)
    return { id: paymentId, receiptNo: minted }
  })

  let membership = null
  if (membershipId) {
    const period = inputs?.memberships.find((p) => p.id === membershipId) || null
    if (period) membership = { ...period, ...(targetPatch?.fields || {}) }
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
 * Delete a payment atomically:
 *
 * 1. Computes the member's snapshots with the payment REMOVED from the ledger.
 * 2. In ONE transaction: deletes the `payments` document and rewrites the
 *    changed period snapshots, so dues, statuses ("Paid in full") and totals
 *    revert together with the deleted cash.
 *
 * Same reasoning as `recordPayment`: no window where the money is gone but the
 * stored figures still include it. Audit stays outside the transaction.
 */
export async function deletePayment({ payment }) {
  if (!payment?.id) throw new Error('A payment reference is required')

  const inputs = payment.memberId ? await readLedgerInputs(payment.memberId) : null
  const patches = inputs
    ? snapshotPatches({
        ...inputs,
        payments: inputs.payments.filter((p) => p.id !== payment.id),
      })
    : []

  await commitAtomically(async (tx) => {
    tx.remove('payments', payment.id)
    for (const patch of patches) tx.update('memberships', patch.id, patch.fields)
  })

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

  return { id: payment.id, memberships: asWritten(patches) }
}
