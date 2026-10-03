import { parseDate, toDateInputValue } from '@/utils/dateHelpers'
import { collection, doc, runTransaction } from 'firebase/firestore'
import { gymTodayKey } from '@/utils/gymTime'
import { getMembershipPeriod, getRenewalPaymentSummary } from '@/utils/renewal'
import { createDoc, isReady, updateDocById } from './firestore'
import { db } from '@/firebase'
import { logAudit } from './audit'
import { getGymId } from './ownerContext'
import { fallbackReceiptNo, mintReceiptNoInTransaction, nextReceiptNo, prepareReceiptFloor } from './receipts'

function requireValidPlan(plan) {
  if (!plan || !plan.id) throw new Error('Select a valid membership plan')
  const price = Number(plan.price)
  const duration = Number(plan.durationDays)
  if (!Number.isFinite(price) || price <= 0) throw new Error('Selected plan has an invalid price')
  if (!Number.isFinite(duration) || duration < 1) throw new Error('Selected plan has an invalid duration')
  return { price, duration }
}

function requirePaidAmount(paidAmount) {
  const paid = Number(paidAmount)
  if (!Number.isFinite(paid) || paid < 0) throw new Error('Payment amount cannot be negative')
  return paid
}

function requireDate(date) {
  const d = parseDate(date)
  if (!d) throw new Error('A valid payment date is required')
  return date
}

/**
 * Renew a member's membership.
 *
 * Writes, all committed together or not at all:
 *
 * 1. A `memberships` period document (history + the anchor for expiry).
 * 2. A `payments` document linked to that period (`type: 'renewal'`).
 * 3. The member's current plan and status.
 * 4. This gym's receipt counter.
 *
 * ## Why one transaction
 *
 * The period, its payment and the member update used to be four separate
 * writes. A failure partway through left the ledger describing something that
 * never happened, and the damage was not recoverable by retrying:
 *
 * - Payment written, period update failed: the member paid for a period the
 *   app does not know exists, so the money is unattributable and the expiry is
 *   stale.
 * - Period written, payment written, member update failed: the member holds a
 *   period nobody paid for, and `amountDue` says the opposite.
 * - Any failure after the counter increment burned a receipt number, and the
 *   retry burned another, so the sequence grew gaps that looked like missing
 *   payments in a reconciliation.
 *
 * Minting the receipt number inside this transaction is what closes the third
 * case: the number and the payment it labels share a fate.
 *
 * ## joinDate is NOT rewritten
 *
 * `joinDate` is when the member joined the GYM. Overwriting it with each
 * renewal's effective start silently corrupted three things: the dashboard and
 * Reports "new members this month" counts (both filter on `joinDate`), the
 * "Joined" date on the member page, and the member summary text. A member who
 * renewed four times in a month looked like four new joiners.
 *
 * It is still backfilled when genuinely absent, because the legacy origin-period
 * fallback in utils/dues.js derives a billing start from it for members who
 * predate period documents.
 *
 * Returns { membership, payment }. Throws on any invalid input or write failure.
 */
export async function renewMembership({
  member,
  plan,
  currentExpiry,
  effectiveStartDate,
  paidAmount,
  method,
  date,
  note,
  receiptPrefix = 'HWG',
  effectivePrice,
  isPT = false,
  ptSurcharge = 0,
  timezone,
}) {
  if (!member || !member.id) throw new Error('A valid member is required to renew')
  const { price: basePrice } = requireValidPlan(plan)
  const paid = requirePaidAmount(paidAmount)
  // Payment date = when money was actually received. It is stored on the
  // payment and NEVER overwritten by the membership effective start date.
  // Defaults to today in the GYM's timezone, not the staff device's, so a
  // renewal taken after midnight at the desk is not filed under the previous
  // day by a laptop whose clock is on another zone.
  const paymentDate = requireDate(date || gymTodayKey(timezone))
  if (!method) throw new Error('Select a payment method')

  // The amount charged for this period. Normally the plan price; when a PT
  // surcharge applies the caller supplies the PT-inclusive total
  // (computed by the canonical getMembershipCharge helper). This is the
  // SNAPSHOT stored on the period and payment — it is never recomputed or
  // rewritten later, so a later PT toggle cannot change a past record.
  let price = basePrice
  if (effectivePrice !== undefined && effectivePrice !== null) {
    const effective = Number(effectivePrice)
    if (Number.isFinite(effective) && effective >= 0) price = effective
  }

  // Preserve why the total was charged. The base price and PT surcharge are
  // snapshot alongside the total so a later change to the plan or PT settings
  // never rewrites this historical record. The PT surcharge only applies when
  // the caller actually charged a PT-inclusive total (effectivePrice given);
  // a bare renewal with no PT price never fabricates a surcharge.
  const ptInclusive = effectivePrice !== undefined && effectivePrice !== null
  const addonSnapshot = ptInclusive && Boolean(isPT) ? Math.max(0, Number(ptSurcharge) || 0) : 0
  const baseSnapshot = Math.max(0, price - addonSnapshot)

  // Membership period = the effective active window. When the owner backdates
  // (effectiveStartDate given) the period starts there; otherwise it defaults
  // to the automatic start (today when expired).
  const period = getMembershipPeriod({ currentExpiry, plan, effectiveStartDate })
  if (!period) throw new Error('Selected plan has an invalid duration')

  const summary = getRenewalPaymentSummary({ planPrice: price, paidAmount: paid })
  const startDate = toDateInputValue(period.startDate)
  const expiryDate = toDateInputValue(period.expiryDate)

  const membershipData = {
    memberId: member.id,
    planId: plan.id,
    planName: plan.name,
    startDate,
    expiryDate,
    price: summary.price,
    basePrice: baseSnapshot,
    ptSurcharge: addonSnapshot,
    isPT: Boolean(isPT),
    amountPaid: summary.paid,
    amountDue: summary.due,
    paymentStatus: summary.status,
    // Filled in below, once the payment reference exists. Both documents are
    // written in the same transaction, so the forward reference is safe and
    // avoids the second write the old flow needed to backfill these.
    paymentId: null,
    receiptNo: null,
  }

  const paymentData = {
    memberId: member.id,
    planId: plan.id,
    memberName: member.name,
    planName: plan.name,
    amount: summary.paid,
    basePrice: baseSnapshot,
    ptSurcharge: addonSnapshot,
    isPT: Boolean(isPT),
    method,
    date: paymentDate,
    note: note || `Renewal — ${plan.name}`,
    type: 'renewal',
    startDate,
    expiryDate,
    paymentStatus: summary.status,
  }

  // The member projection. `joinDate` is deliberately absent: see the note
  // above. `status` stays a maintained projection because Reports counts
  // active members from it, even though authority now lives in the periods.
  const memberPatch = { membershipPlanId: plan.id, status: 'active' }
  if (!parseDate(member.joinDate)) memberPatch.joinDate = startDate

  const auditEntries = (membershipId, paymentId) => [
    {
      action: 'create',
      entity: 'payments',
      entityId: paymentId,
      details: { member: member.name, amount: summary.paid, renewal: true, paymentDate, membershipStart: startDate },
    },
    {
      action: 'create',
      entity: 'memberships',
      entityId: membershipId,
      details: { member: member.name, plan: plan.name, startDate, expiryDate },
    },
    {
      action: 'update',
      entity: 'members',
      entityId: member.id,
      details: { status: 'active', renewed: true, plan: plan.name, startDate, expiryDate },
    },
  ]

  let membershipId
  let paymentId
  let receiptNo

  // The transactional path needs both a live database and an established gym:
  // the receipt counter is per-gym and every write is checked against it.
  const gymId = getGymId()
  if (isReady() && !gymId) {
    // Configured but no tenancy. Refuse here rather than letting the write fail
    // the rules' tenant check with a bare PERMISSION_DENIED, which tells staff
    // nothing about the actual problem.
    throw new Error('No gym selected — a renewal cannot be recorded before tenancy is established')
  }

  if (!isReady()) {
    // Demo / offline mode. The mock store has no transaction primitive, so the
    // sequential writes stand in; the invariants they are checking are enforced
    // by the real transaction below, which is covered by
    // src/tests/renewalTransaction.test.js.
    receiptNo = await nextReceiptNo(receiptPrefix)
    membershipId = await createDoc('memberships', membershipData)
    paymentId = await createDoc('payments', { ...paymentData, membershipId, receiptNo })
    await updateDocById('memberships', membershipId, { paymentId, receiptNo })
    await updateDocById('members', member.id, memberPatch)
  } else {
    // Refs are created up front so the payment's id can be stored on the period
    // inside a single transaction. Firestore allocates the id client-side when
    // the reference is built, so nothing is written yet.
    const membershipRef = doc(collection(db, 'memberships'))
    const paymentRef = doc(collection(db, 'payments'))
    membershipId = membershipRef.id
    paymentId = paymentRef.id

    // Read the counter floor BEFORE the transaction: the legacy-payments scan
    // must not be repeated on every contention retry.
    const floor = await prepareReceiptFloor()

    try {
      receiptNo = await runTransaction(db, async (tx) => {
        const minted = await mintReceiptNoInTransaction(tx, gymId, receiptPrefix, floor)
        tx.set(membershipRef, { ...membershipData, paymentId, receiptNo: minted })
        tx.set(paymentRef, { ...paymentData, membershipId, receiptNo: minted })
        tx.set(doc(db, 'members', member.id), memberPatch, { merge: true })
        return minted
      })
    } catch (err) {
      // A failed transaction has no side effects, so retrying without the
      // counter is safe. This preserves the rule that a payment is never
      // refused just because a receipt number could not be minted — the
      // counter is a convenience, the ledger entry is the record.
      console.warn('[renewals] receipt counter unavailable; retrying without it', err)
      receiptNo = fallbackReceiptNo(receiptPrefix)
      await runTransaction(db, async (tx) => {
        tx.set(membershipRef, { ...membershipData, paymentId, receiptNo })
        tx.set(paymentRef, { ...paymentData, membershipId, receiptNo })
        tx.set(doc(db, 'members', member.id), memberPatch, { merge: true })
      })
    }
  }

  // Audit is deliberately AFTER the commit. An audit write inside the
  // transaction would make a logging failure roll back a real payment, and the
  // previous behaviour — audits recorded alongside the data — is preserved.
  for (const entry of auditEntries(membershipId, paymentId)) {
    await logAudit(entry)
  }

  return {
    membership: { id: membershipId, ...membershipData, paymentId, receiptNo },
    payment: { id: paymentId, ...paymentData, membershipId, receiptNo },
  }
}
