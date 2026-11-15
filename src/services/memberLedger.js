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
 *
 * Atomicity alone is not isolation: two terminals could each read the same
 * history, compute different snapshots, and the later commit would overwrite
 * the other's — a period showing less money than the ledger holds. The
 * revision guard below closes that window, and `readLedgerSnapshot` is the
 * entry point that pairs the reads with the revision they are valid for.
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
 * A concurrent money write moved this member's ledger between the read and the
 * commit. Nothing was written: the caller re-reads and recomputes.
 */
export class LedgerConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerConflictError'
  }
}

/** A member document's stored revision, or 0 when it is absent or not usable. */
const revisionOf = (member) => {
  const stored = Number(member?.ledgerRevision)
  return Number.isFinite(stored) && stored > 0 ? stored : 0
}

/**
 * The ledger inputs PLUS the revision they were read at.
 *
 * The revision lives on the member document itself (`ledgerRevision`), which is
 * already part of the ledger read: no extra query, no new collection and no new
 * permission — the roles that may record money are exactly the roles allowed to
 * update a member. Every writer of a period snapshot increments it inside its
 * own transaction, so "revision still the same" means "nobody wrote this
 * member's money or snapshots since I read them".
 */
export async function readLedgerSnapshot(memberId) {
  const inputs = await readLedgerInputs(memberId)
  return { ...inputs, revision: revisionOf(inputs.member) }
}

/**
 * FIRST read of a money transaction: refuse to write figures that are already
 * stale. Must run before any write, because the web SDK requires all reads to
 * precede all writes inside a transaction.
 *
 * The member document is guaranteed present here: `readLedgerSnapshot` has
 * already read it, and `firestore.rules` denies reading a member document that
 * does not exist (`sameGym`/`legacy` are both false for a missing document), so
 * a deleted member fails before any transaction opens. The bump below is
 * therefore unconditional.
 */
export async function assertLedgerFresh(tx, memberId, revision) {
  const member = await tx.get('members', memberId)
  const current = revisionOf(member)
  if (current !== revision) {
    throw new LedgerConflictError(
      `member ledger moved from revision ${revision} to ${current} since it was read`
    )
  }
}

/**
 * Stage the revision bump that tells later readers the ledger changed.
 *
 * `patch` is for a caller that already updates the member document: folding the
 * bump into that write keeps one write per transaction instead of two.
 */
export function bumpLedgerRevision(tx, memberId, revision, patch = {}) {
  tx.update('members', memberId, { ...patch, ledgerRevision: revision + 1 })
}

/**
 * Run `attempt` against a fresh ledger read, retrying when a concurrent write
 * bumped the revision first. `attempt` receives the inputs AND the revision, so
 * a retry recomputes the figures from the new history rather than replaying the
 * stale ones. Any other error propagates unchanged: this is not a retry loop
 * for permission failures.
 *
 * A payment can be recorded against no member at all; there is then no ledger
 * to be stale against, so it is attempted once with `null`.
 */
export async function withLedgerRevision(memberId, attempt, { retries = 3 } = {}) {
  if (!memberId) return attempt(null)
  for (let i = 1; ; i += 1) {
    const inputs = await readLedgerSnapshot(memberId)
    try {
      return await attempt(inputs)
    } catch (err) {
      if (!(err instanceof LedgerConflictError) || i >= retries) throw err
    }
  }
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
