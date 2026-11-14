import { getById, listAll } from './firestore'
import { computeMemberLedger } from '@/utils/dues'

/**
 * The documents the finance ledger is computed from, read once.
 *
 * These queries happen OUTSIDE a money transaction on purpose: the web SDK's
 * transaction can only fetch individual documents, not run a query, and a
 * member's payment history is a query. The transactions in payments.js,
 * memberships.js and renewals.js therefore make the WRITES atomic (payment,
 * period, counter and the period snapshots commit together or not at all); the
 * figures they write are the ones computed from these reads.
 */
export async function readLedgerInputs(memberId) {
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
 * `payments`/`memberships` are the ledger AS IT WILL BE after the operation
 * (e.g. including the payment being recorded, or excluding a deleted period) —
 * the caller decides.
 */
export function snapshotPatches({ member, plans, payments, memberships }) {
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

/** Flatten patches to the shape the services return/report. */
export const asWritten = (patches) => patches.map((p) => ({ id: p.id, ...p.fields }))
