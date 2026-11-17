import { computeMemberLedger } from './dues'

/**
 * DUES DRIFT — the cached money fields disagreeing with the ledger.
 *
 * ## What is (and is not) drift
 *
 * A membership period carries three DERIVED figures next to its authoritative
 * data: `amountPaid`, `amountDue` and `paymentStatus`. They exist so lists and
 * receipts do not recompute the ledger on every render. The ledger itself is
 * derived from period prices plus payments.
 *
 * A deliberate price change is NOT drift. Editing a period's price, or applying
 * the PT-inclusive price, re-prices the period and recomputes these three fields
 * in the SAME guarded transaction (`writePeriodAndSnapshots`). The result is a
 * period whose price was chosen by the owner and whose snapshots agree with that
 * price. Reporting it would train operators to ignore the report.
 *
 * Drift is only this: the three derived fields disagree with what
 * `computeMemberLedger` derives from the very same period documents and
 * payments. That happens when a write did not go through the services (a
 * script, a console edit, a legacy document written before snapshots existed, a
 * partially failed repair), and it is exactly the state that makes a list show
 * a different balance than a receipt.
 *
 * Nothing here repairs anything. The detector reports; a human decides.
 */

/** The fields this module compares. `price` is deliberately not one of them. */
export const DRIFT_FIELDS = Object.freeze(['amountPaid', 'amountDue', 'paymentStatus'])

const numberOrZero = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Drift rows for ONE member.
 *
 * Returns `[{ periodId, fields, stored, expected }]` — empty when the stored
 * snapshots match the ledger, which is the normal case for every write made
 * through the app. Periods without an id (the reconstructed "implicit" origin
 * period) are skipped: there is no document to disagree with.
 */
export function duesDriftForMember({
  member,
  plans = [],
  payments = [],
  memberships = [],
} = {}) {
  if (!member?.id) return []

  const ledger = computeMemberLedger({ member, plans, payments, memberships })
  const figuresById = new Map(ledger.periods.filter((p) => p.id).map((p) => [p.id, p]))

  const rows = []
  for (const period of memberships) {
    if (!period?.id) continue
    const figures = figuresById.get(period.id)
    if (!figures) continue

    const stored = {
      amountPaid: numberOrZero(period.amountPaid),
      amountDue: numberOrZero(period.amountDue),
      paymentStatus: period.paymentStatus ?? null,
    }
    const expected = {
      amountPaid: figures.paid,
      amountDue: figures.due,
      paymentStatus: figures.status,
    }
    const fields = DRIFT_FIELDS.filter((field) => stored[field] !== expected[field])
    if (fields.length > 0) rows.push({ periodId: period.id, fields, stored, expected })
  }
  return rows
}

/** Group rows by member id. `members` may be the whole gym; other members' docs are ignored. */
function groupByMember(docs) {
  const grouped = new Map()
  for (const doc of docs) {
    if (!doc?.memberId) continue
    const bucket = grouped.get(doc.memberId)
    if (bucket) bucket.push(doc)
    else grouped.set(doc.memberId, [doc])
  }
  return grouped
}

/**
 * Drift across a whole gym (or any list of members).
 *
 * Returns counts plus the per-member rows, so a caller can both log a number and
 * point at the documents. `plans`, `payments` and `memberships` are the gym-wide
 * lists; they are grouped per member here.
 */
export function findDuesDrift({ members = [], plans = [], payments = [], memberships = [] } = {}) {
  const periodsByMember = groupByMember(memberships)
  const paymentsByMember = groupByMember(payments)

  const driftedMembers = []
  let periodsScanned = 0

  for (const member of members) {
    if (!member?.id) continue
    const memberPeriods = periodsByMember.get(member.id) || []
    periodsScanned += memberPeriods.filter((p) => p.id).length

    const rows = duesDriftForMember({
      member,
      plans,
      payments: paymentsByMember.get(member.id) || [],
      memberships: memberPeriods,
    })
    if (rows.length > 0) {
      driftedMembers.push({
        memberId: member.id,
        memberName: member.name ?? null,
        periods: rows,
      })
    }
  }

  return {
    membersScanned: members.filter((m) => m?.id).length,
    periodsScanned,
    driftedMembers,
    driftedPeriods: driftedMembers.reduce((sum, entry) => sum + entry.periods.length, 0),
  }
}
