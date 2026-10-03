import { addDays, parseDate, startOfDay } from './dateHelpers'

/**
 * Earliest date a renewal period may begin.
 *
 * Business rule (see README / renewal spec):
 * - Membership already expired  → the new period starts today.
 * - Membership still active     → the new period starts the day after the
 *   current expiry so the remaining paid time is not lost.
 * - Expiring today              → starts tomorrow (today is still covered).
 * - No (or invalid) expiry      → starts today.
 *
 * Always returns a Date at local start-of-day to avoid timezone off-by-one.
 */
export function getRenewalStartDate(currentExpiry) {
  const today = startOfDay(new Date())
  if (!currentExpiry) return today
  const expiry = startOfDay(new Date(currentExpiry))
  if (Number.isNaN(expiry.getTime())) return today
  const afterExpiry = addDays(expiry, 1)
  return afterExpiry > today ? afterExpiry : today
}

/**
 * Resolve the effective start date of a renewal from an explicit selection.
 *
 * - 'previous-expiry' → the previous membership's expiry date (the member is
 *   considered active FROM that date, so a payment received days later still
 *   backdates the membership start to the expiry date).
 * - 'today'            → today (the default forward-dated renewal).
 * - 'custom'           → an explicitly chosen date.
 *
 * Falls back to today when the requested mode has no usable date, so a
 * renewal always resolves to a valid date.
 */
export function resolveEffectiveStart({ mode, currentExpiry, customDate } = {}) {
  if (mode === 'previous-expiry') {
    const expiry = parseDate(currentExpiry)
    if (expiry && !Number.isNaN(expiry.getTime())) return expiry
  }
  if (mode === 'custom') {
    const custom = parseDate(customDate)
    if (custom && !Number.isNaN(custom.getTime())) return custom
  }
  return startOfDay(new Date())
}

/**
 * Compute { startDate, expiryDate } for a renewal period using the same
 * duration convention as getMembershipExpiry (expiry = start + durationDays).
 *
 * `effectiveStartDate` (optional) lets the owner backdate the renewal — the
 * period starts on that date and the expiry is derived from it. When omitted
 * it falls back to the automatic start (today when expired). The membership
 * effective dates describe the period; the payment's own date is stored
 * separately and is never derived from or overwritten by this.
 *
 * Returns null when the plan has no usable duration.
 */
export function getMembershipPeriod({ currentExpiry, plan, effectiveStartDate } = {}) {
  const duration = Number(plan?.durationDays)
  if (!Number.isFinite(duration) || duration < 1) return null
  const startDate =
    effectiveStartDate && !Number.isNaN(new Date(effectiveStartDate).getTime())
      ? startOfDay(new Date(effectiveStartDate))
      : getRenewalStartDate(currentExpiry)
  return { startDate, expiryDate: addDays(startDate, duration) }
}

/**
 * Single source of truth for a renewal period's payment figures.
 * Due is clamped so it is never negative (same convention as getPaymentSummary).
 *
 * ## The freeze tail is part of what is charged, but not part of the period price
 *
 * `tailAmount` is the preserved post-expiry portion of a freeze. The member is
 * invoiced for it now, so it belongs in the total they are asked to pay and in
 * the payment that records the money. It is deliberately NOT folded into the
 * period's price: the price is what the period itself cost, and `dues.js` prices
 * a period from its own document. Folding the tail in here would make the ledger
 * bill those same days a second time on every later recompute.
 *
 * The two are reported separately so the caller can settle one amount while
 * keeping the tail attributable:
 *
 *   total    = price + tailAmount   what the member is charged now
 *   price    the period's own cost, what the ledger will keep billing
 *
 * status: 'paid'    when the total is fully covered
 *         'partial' when a payment was taken but the total is not fully covered
 *         'due'     when nothing was paid yet
 */
export function getRenewalPaymentSummary({ planPrice, paidAmount, tailAmount = 0 } = {}) {
  const price = Math.max(0, Number(planPrice) || 0)
  const rawTail = Number(tailAmount)
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? rawTail : 0
  const total = price + tail
  const rawPaid = Number(paidAmount)
  const paid = Number.isFinite(rawPaid) && rawPaid > 0 ? rawPaid : 0
  const due = Math.max(0, total - paid)
  const status = due === 0 ? 'paid' : paid > 0 ? 'partial' : 'due'
  return { price, tailAmount: tail, total, paid, due, status }
}

export const PAYMENT_STATUS_LABELS = {
  paid: 'Paid',
  partial: 'Partial',
  due: 'Due',
}
