import { addDays, parseDate } from './dateHelpers'
import { gymDaysUntil } from './gymTime'

/**
 * Derive a member's membership expiry date from the existing data model:
 * `joinDate` (member) + `durationDays` (membership plan). Returns null when
 * either is missing or the date is invalid.
 */
export function getMembershipExpiry(member, plan) {
  if (!member || !plan) return null
  const start = parseDate(member.joinDate)
  if (!start) return null
  const duration = Number(plan.durationDays)
  if (!Number.isFinite(duration) || duration < 0) return null
  return addDays(start, duration)
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
 * The member's CURRENT membership expiry, preferring recorded history.
 *
 * `getMembershipExpiry()` derives expiry from `member.joinDate`, which is only
 * a fallback: renewals keep it current, but editing or deleting a membership
 * period does NOT, because a period is its own record. So a member whose period
 * dates were corrected in the app kept showing the stale joinDate-derived
 * expiry on the member page and on the dashboard.
 *
 * When the member has recorded membership periods, the newest one is
 * authoritative. Ordering matches the ledger in utils/dues.js (oldest to newest
 * by startDate), so the expiry shown always belongs to the same period the
 * ledger treats as current. Members with no recorded periods fall back to the
 * joinDate derivation.
 */
export function getCurrentMembershipExpiry(member, plan, memberships) {
  if (Array.isArray(memberships)) {
    const own = memberships
      .filter((m) => m && String(m.memberId) === String(member?.id))
      .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
    for (let i = own.length - 1; i >= 0; i -= 1) {
      const expiry = parseDate(own[i].expiryDate)
      if (expiry) return expiry
    }
  }
  return getMembershipExpiry(member, plan)
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

export function formatExpiryDate(date) {
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
