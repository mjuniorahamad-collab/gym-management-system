/**
 * Walk-in leads (the paper enquiry diary, in the app).
 *
 * A lead is someone who enquired — walked in, messaged, or was referred — but
 * is not a member yet. The point of the list is the FOLLOW-UP date: the owner
 * opens it, sees who is due today and who was missed, and calls them.
 *
 * Everything here is pure so the page and its tests share one definition of
 * "due", "overdue" and "closed". No Firebase import.
 */

export const LEAD_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'trial', label: 'Trial' },
  { value: 'joined', label: 'Joined' },
  { value: 'lost', label: 'Lost' },
]

export const LEAD_STATUS_VALUES = LEAD_STATUSES.map((s) => s.value)

/** Statuses that still need work. Joined/lost are finished. */
export const OPEN_LEAD_STATUSES = ['new', 'contacted', 'trial']
export const CLOSED_LEAD_STATUSES = ['joined', 'lost']

export const LEAD_SOURCES = ['Walk-in', 'Instagram', 'Facebook', 'Referral', 'Phone', 'Other']

export const LEAD_FOLLOW_UP_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Due today' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'upcoming', label: 'Upcoming' },
]

export function leadStatusLabel(status) {
  return LEAD_STATUSES.find((s) => s.value === status)?.label || status || '—'
}

export function isLeadOpen(lead) {
  return Boolean(lead) && !CLOSED_LEAD_STATUSES.includes(lead.status)
}

/** A `YYYY-MM-DD` key from a stored date, without timezone reinterpretation. */
function dayKey(value) {
  if (!value) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString().slice(0, 10)
    } catch {
      return ''
    }
  }
  const s = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return ''
}

/**
 * Where a lead stands on follow-up.
 *
 * - `closed`   — joined/lost; a follow-up date no longer matters.
 * - `overdue`  — the date has passed and the lead is still open.
 * - `today`    — due today in the gym's calendar.
 * - `upcoming` — a future date.
 * - `none`     — no date was set.
 */
export function leadFollowUpState(lead, todayKey) {
  if (!lead) return 'none'
  if (!isLeadOpen(lead)) return 'closed'
  const date = dayKey(lead.followUpDate)
  if (!date) return 'none'
  const today = dayKey(todayKey)
  if (!today) return 'upcoming'
  if (date < today) return 'overdue'
  if (date === today) return 'today'
  return 'upcoming'
}

export function matchesLeadFollowUp(lead, filter, todayKey) {
  if (!filter || filter === 'all') return true
  return leadFollowUpState(lead, todayKey) === filter
}

/** Open leads that are due today or overdue — the day's call list. */
export function countFollowUps(leads = [], todayKey) {
  let today = 0
  let overdue = 0
  for (const lead of leads) {
    const state = leadFollowUpState(lead, todayKey)
    if (state === 'today') today += 1
    else if (state === 'overdue') overdue += 1
  }
  return { today, overdue }
}

const STATE_ORDER = { overdue: 0, today: 1, upcoming: 2, none: 3, closed: 4 }

/**
 * Urgent first: overdue, then today, then upcoming, then undated, then closed.
 * Within a bucket the earliest follow-up wins; ties fall back to newest first,
 * so a lead added this morning is above one from last month.
 */
export function sortLeads(leads = [], todayKey) {
  return [...leads].sort((a, b) => {
    const byState =
      (STATE_ORDER[leadFollowUpState(a, todayKey)] ?? 9) -
      (STATE_ORDER[leadFollowUpState(b, todayKey)] ?? 9)
    if (byState !== 0) return byState
    const dateA = dayKey(a.followUpDate) || '9999-12-31'
    const dateB = dayKey(b.followUpDate) || '9999-12-31'
    if (dateA !== dateB) return dateA.localeCompare(dateB)
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
}

/** Name or phone match, case-insensitive. */
export function matchesLeadSearch(lead, search) {
  const q = String(search || '').trim().toLowerCase()
  if (!q) return true
  return (
    String(lead?.name || '').toLowerCase().includes(q) ||
    String(lead?.phone || '').toLowerCase().includes(q)
  )
}
