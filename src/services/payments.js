import { commitAtomically, getById, updateDocById } from './firestore'
import { logAudit } from './audit'
import {
  asWritten,
  assertLedgerFresh,
  bumpLedgerRevision,
  readLedgerInputs,
  snapshotPatches,
  withLedgerRevision,
} from './memberLedger'
import { safePaymentAmount } from '@/utils/payments'
import {
  formatReceiptNo,
  nextReceiptSequence,
  prepareReceiptFloor,
  receiptCounterId,
} from './receipts'
import { requireReceiptPrefix } from './receiptPrefixGuard'

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
 * 2. In ONE transaction: verifies the member's ledger has not moved since it
 *    was read, mints the receipt number (per-gym counter), creates the
 *    `payments` document, and rewrites every period snapshot that the new
 *    payment changes.
 *
 * The transaction is the point: previously the payment was written first and
 * the snapshots recomputed afterwards, so a failure in between left a recorded
 * payment with a stale "due"/"paid in full" state that only the nightly sweep
 * could repair. Now either the whole money movement lands or none of it does.
 *
 * ## Isolation, not just atomicity
 *
 * The ledger is a QUERY, and the web SDK's transaction cannot run one, so the
 * history is read before the transaction opens. Two terminals recording
 * payments for the same member at the same time would then each compute
 * snapshots from the other's missing payment and the later commit would
 * overwrite the earlier one — atomic, but wrong. The member's ledger revision
 * is therefore read with the history and re-checked as the transaction's first
 * read; a mismatch aborts and `withLedgerRevision` re-reads and recomputes.
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

  // Legacy receipt numbers were derived from the clock and can collide with a
  // minted one, so the counter floor is seeded from them. Computed (and cached)
  // outside the transaction: a full payments read must not run on every retry.
  const floor = await prepareReceiptFloor()

  const attempt = async (inputs) => {
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

    const { id, receiptNo } = await commitAtomically(async (tx) => {
      // FIRST read: refuse to write figures computed from a stale ledger.
      if (inputs) await assertLedgerFresh(tx, values.memberId, inputs.revision)
      // Counter read INSIDE the transaction, so the number and the payment it
      // labels are committed together — a receipt can be neither burned nor
      // reissued by a failure or a concurrent terminal.
      const counter = await tx.get('counters', receiptCounterId())
      const sequence = nextReceiptSequence(counter?.value, floor)
      const minted = formatReceiptNo(receiptPrefix, sequence)
      if (inputs) bumpLedgerRevision(tx, values.memberId, inputs.revision)
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

    return { id, receiptNo, membership }
  }

  // A payment with no member has no ledger to be stale against (the target
  // period check above still applies), so it commits once, unguarded.
  const written = values.memberId
    ? await withLedgerRevision(values.memberId, attempt)
    : await attempt(null)

  await logAudit({
    action: 'create',
    entity: 'payments',
    entityId: written.id,
    details: {
      member: memberName || undefined,
      amount,
      membershipId: written.membership?.id || undefined,
    },
  })

  return { ...written, amount }
}

/**
 * Delete a payment atomically:
 *
 * 1. Computes the member's snapshots with the payment REMOVED from the ledger.
 * 2. In ONE transaction: verifies the ledger has not moved since that read,
 *    deletes the `payments` document and rewrites the changed period snapshots,
 *    so dues, statuses ("Paid in full") and totals revert together with the
 *    deleted cash.
 *
 * Same reasoning as `recordPayment`: no window where the money is gone but the
 * stored figures still include it, and no overwrite of a concurrent write.
 * Audit stays outside the transaction.
 */
export async function deletePayment({ payment }) {
  if (!payment?.id) throw new Error('A payment reference is required')

  const attempt = async (inputs) => {
    const patches = inputs
      ? snapshotPatches({
          ...inputs,
          payments: inputs.payments.filter((p) => p.id !== payment.id),
        })
      : []

    await commitAtomically(async (tx) => {
      if (inputs) await assertLedgerFresh(tx, payment.memberId, inputs.revision)
      tx.remove('payments', payment.id)
      if (inputs) bumpLedgerRevision(tx, payment.memberId, inputs.revision)
      for (const patch of patches) tx.update('memberships', patch.id, patch.fields)
    })

    return patches
  }

  const patches = payment.memberId
    ? await withLedgerRevision(payment.memberId, attempt)
    : await attempt(null)

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
