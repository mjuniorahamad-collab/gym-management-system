/**
 * Coerce a value to a non-negative finite number, treating invalid/missing
 * values as 0. Follows the same safe-clamping convention as the finance
 * ledger (safePaymentAmount), but also accepts 0 (unlike safePaymentAmount
 * which treats 0 as missing for payment amounts).
 */
function safeCurrencyNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * SINGLE SOURCE OF TRUTH for Personal Training (PT) pricing.
 *
 * PT is a member-level add-on layered on top of the member's normal
 * membership plan. The total amount charged for a PT member is:
 *
 *   base (plan price) + PT surcharge = total
 *
 * The surcharge is configurable per gym (never a global constant) and is
 * stored tenant-safely under `gyms/{gymId}/settings/pt` (see services/pt.js).
 * A member can optionally override the gym default with their own surcharge
 * (`member.ptSurchargeOverride`); when set (including 0 for free PT) the
 * member-specific value wins, otherwise the per-gym default applies.
 *
 * Regular members (isPT false) are charged only the plan price; the surcharge
 * is ignored outright so a stale/non-zero per-gym value can never leak onto a
 * regular member's bill.
 *
 * This is the ONLY place total charge is computed. Member profile, renewal
 * modal, origin periods and payment records all derive from
 * `getMembershipCharge`, so there can never be conflicting totalPrice fields.
 */

/**
 * Resolve the surcharge that applies to a member: the member-specific
 * override when one is set (including an explicit 0), otherwise the gym
 * default. Never returns a negative or invalid value.
 *
 * @param {object}  args
 * @param {number}  args.ptSurcharge        - per-gym PT surcharge (defaults to 0)
 * @param {number}  [args.ptSurchargeOverride] - optional member-specific surcharge
 * @returns {number}
 */
export function getEffectivePtSurcharge({ ptSurcharge = 0, ptSurchargeOverride }) {
  if (ptSurchargeOverride === undefined || ptSurchargeOverride === null || ptSurchargeOverride === '') {
    return safeCurrencyNumber(ptSurcharge)
  }
  return safeCurrencyNumber(ptSurchargeOverride)
}

/**
 * Compute the amount to charge for a membership period.
 *
 * @param {object}  args
 * @param {object}  args.plan        - membership plan ({ price })
 * @param {boolean} args.isPT        - whether the member takes Personal Training
 * @param {number}  args.ptSurcharge - per-gym PT surcharge (defaults to 0)
 * @param {number}  [args.ptSurchargeOverride] - optional member-specific surcharge
 * @returns {{ base: number, addon: number, total: number }}
 */
export function getMembershipCharge({ plan, isPT = false, ptSurcharge = 0, ptSurchargeOverride }) {
  const base = safeCurrencyNumber(plan?.price)
  const addon = isPT
    ? Math.max(0, getEffectivePtSurcharge({ ptSurcharge, ptSurchargeOverride }))
    : 0
  return { base, addon, total: base + addon }
}

/**
 * Reverse of getMembershipCharge — the plan price is the base before any PT
 * add-on. Provided for callers that already hold a period total and need the
 * pure base (not currently used by the pricing flow, kept for symmetry).
 */
export function basePlanPrice(plan) {
  return safeCurrencyNumber(plan?.price)
}
