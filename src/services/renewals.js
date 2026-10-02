import { parseDate, toDateInputValue } from '@/utils/dateHelpers'
import { gymTodayKey } from '@/utils/gymTime'
import { getMembershipPeriod, getRenewalPaymentSummary } from '@/utils/renewal'
import { createDoc, updateDocById } from './firestore'
import { logAudit } from './audit'
import { nextReceiptNo } from './receipts'

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
 * Renew a member's membership in one professional workflow:
 *
 * 1. Creates a `memberships` record for the new period (history + anchor).
 * 2. Creates a `payments` record linked to that membership (`type: 'renewal'`).
 * 3. Links the membership to the payment.
 * 4. Updates the member's current membership (plan, joinDate = new start,
 *    status = active). Expiry is derived from joinDate + plan duration, so
 *    every existing screen (Dashboard, MemberDetail) reflects the new period
 *    automatically.
 *
 * Existing payment/membership history is never modified.
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
  // Same per-gym counter as payments.js, so a renewal receipt can never collide
  // with a payment receipt or another renewal.
  const receiptNo = await nextReceiptNo(receiptPrefix)

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
    paymentId: null,
    receiptNo: null,
  }

  const membershipId = await createDoc('memberships', membershipData)

  const paymentData = {
    memberId: member.id,
    planId: plan.id,
    membershipId,
    memberName: member.name,
    planName: plan.name,
    amount: summary.paid,
    basePrice: baseSnapshot,
    ptSurcharge: addonSnapshot,
    isPT: Boolean(isPT),
    method,
    date: paymentDate,
    note: note || `Renewal — ${plan.name}`,
    receiptNo,
    type: 'renewal',
    startDate,
    expiryDate,
    paymentStatus: summary.status,
  }

  const paymentId = await createDoc('payments', paymentData)

  await updateDocById('memberships', membershipId, { paymentId, receiptNo })
  await updateDocById('members', member.id, {
    membershipPlanId: plan.id,
    joinDate: startDate,
    status: 'active',
  })

  await logAudit({
    action: 'create',
    entity: 'payments',
    entityId: paymentId,
    details: { member: member.name, amount: summary.paid, renewal: true, paymentDate, membershipStart: startDate },
  })
  await logAudit({
    action: 'create',
    entity: 'memberships',
    entityId: membershipId,
    details: { member: member.name, plan: plan.name, startDate, expiryDate },
  })
  await logAudit({
    action: 'update',
    entity: 'members',
    entityId: member.id,
    details: { status: 'active', renewed: true, plan: plan.name, startDate, expiryDate },
  })

  return {
    membership: { id: membershipId, ...membershipData, paymentId, receiptNo },
    payment: { id: paymentId, ...paymentData },
  }
}
