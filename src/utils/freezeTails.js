import { roundCurrency } from './currency'
import { getMembershipCharge } from './pt'

/**
 * Freeze-tail pricing.
 *
 * When a freeze pushes a membership past its original expiry, the days beyond
 * that expiry are the TAIL: the member holds them as paid-for entitlement (see
 * `utils/membershipFreezes`), and they are invoiced at the next renewal rather
 * than given away or written off.
 *
 * This module turns a tail day count into a money amount. It is deliberately the
 * ONLY place a fractional money value is allowed to exist: a plan price divided
 * by its duration is not a currency amount, and `roundCurrency` is applied
 * exactly once, here, at charge creation. Every downstream reader takes the
 * already-rounded amount and never re-rounds it.
 */

/**
 * Why a tail could not be priced.
 *
 * These are reported rather than swallowed. A silently-zero charge is a
 * write-off wearing a disguise, so a caller that cannot price a tail is told so
 * explicitly instead of being handed a free membership.
 */
export const TAIL_UNPRICEABLE = {
  NO_TAIL: 'no tail days',
  NO_PLAN: 'the plan the freeze was granted against no longer exists',
  NO_DURATION: 'the plan has no usable duration in days',
  NO_PRICE: 'the plan has no usable price',
}

/**
 * A period's own immutable price/duration pair, used to value its tail.
 *
 * This exists because a plan document is LIVE: editing its price changes what
 * every historical period appears to be worth. A freeze is a historical fact, so
 * the rate it is settled at has to come from the period it belongs to, not from
 * whatever the plan costs today. `{ total, durationDays }` carries the period's
 * already-committed money and its actual length, both of which stay readable even
 * after the plan is renamed, repriced, or deleted.
 */
function rateFromBasis(basis) {
  const total = Number(basis?.total)
  const duration = Number(basis?.durationDays)
  if (!Number.isFinite(duration) || duration <= 0) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_DURATION }
  }
  if (!(total > 0)) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_PRICE }
  }
  return { rate: total / duration, priceable: true, reason: '' }
}

/**
 * The daily rate a plan is worth, PT-inclusive where applicable.
 *
 * `basis` (a period's immutable snapshot) wins when supplied. Otherwise this
 * falls back to `getMembershipCharge` - the single source of truth for PT pricing
 * - so the tail cannot be valued differently from the period it extends. A PT
 * member's daily rate therefore includes their surcharge; a regular member's does
 * not, and a stale per-gym surcharge can never leak onto a regular member here any
 * more than it can anywhere else.
 *
 * @returns {{ rate: number, priceable: boolean, reason: string }}
 */
export function planDailyRate({ plan, basis, isPT = false, ptSurcharge = 0, ptSurchargeOverride } = {}) {
  if (basis) return rateFromBasis(basis)

  if (!plan) return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_PLAN }

  const duration = Number(plan.durationDays)
  if (!Number.isFinite(duration) || duration <= 0) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_DURATION }
  }

  const charge = getMembershipCharge({ plan, isPT, ptSurcharge, ptSurchargeOverride })
  if (!(charge.total > 0)) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_PRICE }
  }

  return { rate: charge.total / duration, priceable: true, reason: '' }
}

/**
 * Build a period's immutable pricing basis from the snapshots the period carries.
 *
 * `basePrice` + `ptSurcharge` is what the member actually committed to; the plan
 * supplies only the length. A legacy period without a base snapshot falls back to
 * `price`, and only then to the live plan - the fallback order is deliberate so
 * pre-existing documents stay priceable without trusting a live price where a
 * snapshot exists.
 *
 * @returns {{ total: number, durationDays: number } | null}
 */
export function pricingBasisForPeriod(period, plan) {
  const isPT = Boolean(period?.isPT)
  const base = Number(period?.basePrice ?? period?.price)
  const addon = isPT ? Number(period?.ptSurcharge ?? 0) : 0
  const total = Number.isFinite(base) && Number.isFinite(addon) ? base + addon : NaN

  // Duration preference order: an explicit snapshot, the period's own start/end
  // dates, then the live plan. The dates come before the plan deliberately - a
  // period's length is fixed the day it is bought, and survives its plan being
  // shortened, renamed or deleted.
  const duration =
    Number(period?.durationDays) > 0
      ? Number(period.durationDays)
      : periodDayCount(period) || Number(plan?.durationDays)

  if (!(total > 0) || !Number.isFinite(duration) || duration <= 0) return null
  return { total, durationDays: duration }
}

/**
 * A period's own length in days, from the dates it was written with.
 *
 * @returns {number} 0 when either date is missing or unreadable.
 */
function periodDayCount(period) {
  const start = period?.startDate
  const expiry = period?.expiryDate
  if (!start || !expiry) return 0
  const ms = new Date(expiry).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round(ms / 86400000)
}

/**
 * Price a freeze tail.
 *
 * The rate is captured from the plan the freeze was GRANTED against, passed in by
 * the caller. It is never re-derived from the member's current plan: a freeze is
 * a historical fact, and repricing it at today's rate would silently change what
 * the member was granted when the freeze was recorded.
 *
 * @param {object} args
 * @param {number} args.tailDays         Days past the original expiry.
 * @param {object} [args.basis]          The period's immutable price/duration
 *                                       snapshot. Preferred over `plan`.
 * @param {object} [args.plan]           The plan the freeze was granted against,
 *                                       used when no snapshot is available.
 * @param {boolean} [args.isPT]
 * @param {number} [args.ptSurcharge]
 * @param {number} [args.ptSurchargeOverride]
 * @param {string} [args.currency]       ISO code; defaults to INR, the current
 *                                       product currency.
 * @returns {{ days: number, dailyRate: number, amount: number, priceable: boolean, reason: string, currency: string }}
 */
export function freezeTailCharge({
  tailDays = 0,
  plan,
  basis,
  isPT = false,
  ptSurcharge = 0,
  ptSurchargeOverride,
  currency = 'INR',
} = {}) {
  const days = Math.max(0, Math.trunc(Number(tailDays) || 0))
  const { rate, priceable, reason } = planDailyRate({ plan, basis, isPT, ptSurcharge, ptSurchargeOverride })

  if (!priceable) {
    return { days, dailyRate: 0, amount: 0, priceable: false, reason, currency }
  }
  if (days === 0) {
    // A priceable plan with no tail days is not an error - it is simply nothing
    // to charge, which is the overwhelmingly common case.
    return { days: 0, dailyRate: rate, amount: 0, priceable: true, reason: '', currency }
  }

  return {
    days,
    dailyRate: rate,
    // The single rounding step in the financial engine.
    amount: roundCurrency(rate * days, currency),
    priceable: true,
    reason: '',
    currency,
  }
}

/**
 * Whether a charge may be recorded against money that has actually been taken.
 *
 * A zero tail and an unpriceable tail are different states and must not be
 * conflated: the first needs no action, the second must be surfaced to staff
 * before a renewal silently absorbs the cost.
 */
export function tailRequiresAttention(charge) {
  if (!charge) return false
  return charge.days > 0 && !charge.priceable
}