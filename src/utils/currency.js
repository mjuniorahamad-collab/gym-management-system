/**
 * Currency MINOR UNITS - the number of decimal places a money amount is
 * allowed to carry.
 *
 * This exists so the financial engine never hard-codes a "2" of its own. Every
 * place that rounds money asks this module for the currency's precision, so a
 * gym on a currency with no minor unit (or a future currency with three) is a
 * one-line change here instead of an audit of rounding sites.
 *
 * Scope is deliberately narrow: this module knows PRECISION, nothing else. It
 * does not convert between currencies, does not read gym settings, and does not
 * format display strings (that is `formatters.js`). It exists purely so
 * `roundCurrency` has a single, testable definition of "one rounding step".
 *
 * ## Why rounding is centralised
 *
 * Rounding money more than once is how a total drifts from the sum of its
 * parts. The freeze-tail charge divides a plan price by its duration to get a
 * daily rate, then multiplies by a day count: that is the ONLY place a
 * fractional amount is allowed to exist, and `roundCurrency` is applied exactly
 * once, at charge creation. Everything downstream reads the already-rounded
 * value and never re-rounds it.
 */

/**
 * Decimal places per currency code.
 *
 * Only the currencies this app offers are listed. Anything unknown falls back to
 * `DEFAULT_MINOR_UNITS` rather than throwing, because refusing to price a
 * charge would be worse than pricing it at a conventional precision - and
 * `roundCurrency` is never the place that decides whether a charge is valid.
 */
const MINOR_UNITS_BY_CURRENCY = {
  AUD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  // The Nepalese rupee is not subdivided in practice; paise are not in
  // circulation, so a rupee amount is a whole number.
  NPR: 0,
  USD: 2,
}

/** Used for an unrecognised or missing currency code. */
export const DEFAULT_MINOR_UNITS = 2

/** Sanity bound so a bad code can never produce `toFixed(500)`. */
const MAX_MINOR_UNITS = 6

/**
 * How many decimal places this currency's amounts carry.
 *
 * @param {string} currency ISO-ish code, e.g. 'INR'.
 * @returns {number} a non-negative integer, never NaN.
 */
export function currencyMinorUnits(currency) {
  const code = String(currency ?? '').trim().toUpperCase()
  if (!code) return DEFAULT_MINOR_UNITS
  const units = MINOR_UNITS_BY_CURRENCY[code]
  if (!Number.isInteger(units)) return DEFAULT_MINOR_UNITS
  return Math.min(Math.max(units, 0), MAX_MINOR_UNITS)
}

/**
 * Round a money amount to this currency's minor unit.
 *
 * This is the ONLY sanctioned rounding step in the financial engine. It is
 * idempotent: rounding an already-rounded amount returns it unchanged, which is
 * what makes "round exactly once at creation" verifiable rather than aspirational.
 *
 * Non-numeric input yields 0 rather than NaN, matching the safe-clamping
 * convention used by `safePaymentAmount` elsewhere in the ledger.
 *
 * @param {number} amount
 * @param {string} currency
 * @returns {number}
 */
export function roundCurrency(amount, currency) {
  const value = Number(amount)
  if (!Number.isFinite(value)) return 0
  const units = currencyMinorUnits(currency)
  if (units === 0) return Math.round(value)
  const factor = 10 ** units
  // The epsilon nudge keeps a value that is mathematically exactly on a minor
  // unit from being pushed DOWN by binary representation - the classic
  // `1.005.toFixed(2) === '1.00'` problem. It only ever moves a value that is
  // within one float-epsilon of a minor-unit boundary, which is the value we
  // already meant.
  const scaled = value * factor
  const nudged = Math.sign(scaled) * (Math.abs(scaled) + Number.EPSILON * Math.abs(scaled))
  return Math.round(nudged) / factor
}