import { addDaysToKey, gymDaysUntil } from './gymTime'
import {
  displayExpiry,
  periodDayKey,
  periodsForMember,
  resolvePeriodState,
} from './membershipPeriods'

/**
 * Derive a member's membership expiry date from the existing data model:
 * `joinDate` (member) + `durationDays` (membership plan). Returns a `YYYY-MM-DD`
 * key, or null when either input is missing or invalid.
 *
 * ## Why a key and not a Date
 *
 * This used to return a local-midnight `Date`. That is an instant, and an
 * instant has no calendar meaning: reinterpreting it in the gym's timezone can
 * move it a day. A device at UTC-5 parsing '2026-03-15' produced local noon,
 * which is 17:00Z, which is 06:00 the NEXT day in Pacific/Auckland. The stored
 * expiry was correct and the display was a day late.
 *
 * A date-only value is a calendar date, so it survives every conversion
 * unchanged. `addDaysToKey` does the arithmetic in UTC, which is DST-proof, and
 * `getDaysRemaining`/`formatExpiryDate` both understand the key form.
 */
export function getMembershipExpiry(member, plan) {
  if (!member || !plan) return null
  const start = periodDayKey(member.joinDate)
  if (!start) return null
  const duration = Number(plan.durationDays)
  if (!Number.isFinite(duration) || duration < 0) return null
  return addDaysToKey(start, duration)
}

/**
 * Signed whole days until `expiry` (0 = today, negative = expired), counted in
 * the gym's timezone.
 *
 * The previous implementation divided two device-local midnights by a fixed
 * 24h. Across a spring-forward that lands on -0, which `=== 0` matches, so a
 * membership that expired the previous day was reported as "due today" and the
 * expiring-soon list on the dashboard told a member to renew a plan they had
 * already lost.
 */
export function getDaysRemaining(expiry, timezone) {
  return gymDaysUntil(expiry, timezone)
}

/**
 * The member's CURRENT membership expiry, as a `YYYY-MM-DD` key or null.
 *
 * Period selection is delegated to `utils/membershipPeriods.js` so there is
 * exactly one definition of "the current period" in the codebase. This function
 * only supplies the joinDate fallback for members who have no period documents
 * at all, because only the caller knows the plan.
 *
 * ## Why the fallback still exists
 *
 * Legacy members predate period records. `getMembershipExpiry` keeps them
 * displayable instead of blank. It is a fallback, never an override: as soon as
 * one real period document exists, the periods decide.
 *
 * ## Why the previous "newest period by startDate" rule was wrong
 *
 * It made a prepaid future period outrank the period actually running. A member
 * whose current period ended in 5 days but who had also prepaid one starting in
 * 60 was reported as expiring in ~240 days, failed the dashboard's
 * `matchesExpiryFilter(days, 'all')` check, and vanished from the expiring list
 * - the one screen whose purpose is to prompt that renewal.
 */
export function getCurrentMembershipExpiry(member, plan, memberships, options = {}) {
  if (!member || !member.id) return null
  if (Array.isArray(memberships)) {
    const own = periodsForMember(memberships, member.id)
    const state = resolvePeriodState(own, options)
    const expiry = displayExpiry(state)
    if (expiry) return expiry
  }
  return getMembershipExpiry(member, plan)
}

/**
 * Whether the member currently holds a membership period covering today.
 *
 * This is the derived replacement for the stored `member.status` field. It reads
 * the authoritative period documents, so it cannot drift from them the way a
 * stored flag does after a period is edited, deleted, or backdated.
 *
 * A member with no period documents is NOT current. The origin-period backfill
 * in `services/migration.js` is what turns legacy joinDate-only members into
 * real periods; until it has run for them, they have no documented membership
 * and this reports false. That is the safe direction - it never grants access
 * that the records do not support.
 */
export function isMemberCurrent(member, memberships, options = {}) {
  if (!member || !member.id) return false
  const own = periodsForMember(Array.isArray(memberships) ? memberships : [], member.id)
  return Boolean(resolvePeriodState(own, options).current)
}

export function getExpiryBucket(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return null
  if (days < 0) return 'expired'
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days <= 3) return '3days'
  if (days <= 7) return '7days'
  return null
}

/**
 * Whether a signed `days` value belongs to a given dashboard filter.
 * "3days"/"7days" are inclusive ranges (today + tomorrow included).
 */
export function matchesExpiryFilter(days, filter) {
  if (days === null || days === undefined || Number.isNaN(days)) return false
  switch (filter) {
    case 'all':
      return days < 0 || (days >= 0 && days <= 7)
    case 'expired':
      return days < 0
    case 'today':
      return days === 0
    case 'tomorrow':
      return days === 1
    case '3days':
      return days >= 0 && days <= 3
    case '7days':
      return days >= 0 && days <= 7
    default:
      return false
  }
}

/**
 * Normalize a stored phone number into an E.164 digit string for wa.me.
 * Handles +91, 91XXXXXXXXXX, 0XXXXXXXXXX and bare 10-digit Indian mobiles.
 * Other country-code prefixes (e.g. +977) are kept as-is.
 */
export function normalizeWhatsAppNumber(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return { ok: false, number: null, error: 'No phone number on file' }

  let digits = raw.replace(/[\s().-]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  else if (digits.startsWith('00')) digits = digits.slice(2)

  if (!/^\d+$/.test(digits)) {
    return { ok: false, number: null, error: 'Phone number contains invalid characters' }
  }

  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    digits = `91${digits}`
  } else if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) {
    digits = `91${digits.slice(1)}`
  }

  if (digits.length < 11 || digits.length > 15) {
    return { ok: false, number: null, error: 'Invalid phone number for WhatsApp' }
  }

  return { ok: true, number: digits, error: null }
}

/**
 * Render an expiry for display, as "9 March 2026".
 *
 * A `YYYY-MM-DD` key is formatted at local NOON rather than passed to
 * `new Date(key)`. The latter parses as UTC midnight, which is the previous day
 * for any device west of UTC - so a member's expiry read one day early on their
 * own screen while the stored value was correct.
 */
export function formatExpiryDate(date) {
  const key = periodDayKey(date)
  if (key) {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d, 12).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  }
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Build a personalized renewal reminder. A pre-filled WhatsApp message only —
 * nothing is ever sent automatically.
 */
export function buildWhatsAppMessage({ memberName, gymName, planName, expiryDate }) {
  const name = String(memberName || '').trim() || 'there'
  const gym = String(gymName || '').trim() || 'our gym'
  const plan = String(planName || '').trim()
  const when = expiryDate ? formatExpiryDate(expiryDate) : ''
  const planPhrase = plan ? `Your ${plan} membership` : 'Your membership'
  const expirySentence = when
    ? `${planPhrase} at ${gym} expires on ${when}.`
    : `${planPhrase} at ${gym} is expiring soon.`

  return [
    `Hi ${name},`,
    '',
    expirySentence,
    '',
    'Please renew your membership to continue your training without interruption.',
    '',
    'Thank you,',
    gym,
  ].join('\n')
}

/**
 * Build a pre-filled invite message for adding a member to the gym's WhatsApp
 * group. Only ever a draft — it is never sent automatically; the owner presses
 * Send in WhatsApp themselves.
 */
export function buildWhatsAppGroupInviteMessage({ memberName, gymName, link }) {
  const name = String(memberName || '').trim()
  const gym = String(gymName || '').trim() || 'our gym'
  const invite = String(link || '').trim()
  return name
    ? `Hi ${name}, welcome to ${gym}! Please join our gym WhatsApp group using this link:\n${invite}`
    : `Welcome to ${gym}! Please join our gym WhatsApp group using this link:\n${invite}`
}

/**
 * Build a https://wa.me link with a URL-encoded pre-filled message.
 * Returns { ok, url, error } — never an invalid link.
 */
export function buildWhatsAppUrl(phone, message) {
  const normalized = normalizeWhatsAppNumber(phone)
  if (!normalized.ok) {
    return { ok: false, url: null, error: normalized.error }
  }
  return {
    ok: true,
    url: `https://wa.me/${normalized.number}?text=${encodeURIComponent(message)}`,
    error: null,
  }
}
