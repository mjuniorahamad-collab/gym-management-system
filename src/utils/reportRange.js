/**
 * Report range selection and aggregation.
 *
 * Kept free of React and of Firestore so the arithmetic that decides what a
 * gym's numbers *are* can be tested directly. Every day comparison goes through
 * gym-local day keys, so a report means the same thing on every device in the
 * building.
 *
 * The read path is still the existing tenant-scoped collection subscription.
 * Switching these to bounded server-side date queries needs a `gymId + date`
 * composite index that is not deployed yet; until it is, Firestore rejects such
 * a query with `failed-precondition`. See docs/security for the deploy-gated
 * follow-up. Filtering here is correct but does not reduce read volume.
 */

import { addDaysToKey, daysBetween, gymDayKey, gymMonthKey } from './gymTime'

/**
 * Default window: the six calendar months ending with the current gym-local
 * month, matching the page's previous "last 6 months" behaviour.
 */
export function defaultReportRange(timezone, now = new Date()) {
  const today = gymDayKey(now, timezone)
  if (!today) return null
  // First day of the month six months back.
  const [y, m] = today.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1 - 5, 1))
  const from = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01`
  return { from, to: today }
}

/**
 * Validate and order a requested range.
 *
 * Returns `null` when the range is unusable so the caller can keep the previous
 * one rather than silently reporting on a different period than the labels
 * claim. A reversed range is treated as unusable too: swapping it would be a
 * guess about what the owner meant.
 */
export function normalizeReportRange(from, to) {
  if (!isDayKey(from) || !isDayKey(to)) return null
  if (from > to) return null
  return { from, to }
}

export function isDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Inclusive calendar-day count in the range — the approved denominator. */
export function rangeDayCount(range) {
  if (!range) return 0
  return daysBetween(range.from, range.to)
}

/** True when a record's `date`/`joinDate` falls inside the inclusive range. */
export function inRange(value, range, timezone) {
  if (!range) return false
  const day = gymDayKey(value, timezone)
  if (!day) return false
  return day >= range.from && day <= range.to
}

/**
 * Average check-ins per calendar day across the range.
 *
 * The denominator is the number of calendar days in the selected range, not the
 * number of days that happen to have attendance. Dividing by "days with
 * attendance" makes a quiet gym look busy: 30 check-ins spread over 3 active
 * days reported 10/day and invited the owner to add staff on the 27 days the
 * gym was closed. A gym open 6 days a week should still see its real daily
 * average, so closed days count as zero rather than being excluded.
 */
export function averageDailyCheckIns(attendance, range, timezone) {
  if (!range) return 0
  const days = rangeDayCount(range)
  if (days <= 0) return 0
  const inWindow = attendance.filter((a) => inRange(a?.date, range, timezone)).length
  return Math.round((inWindow / days) * 10) / 10
}

/** Every `YYYY-MM` month in the range, oldest first. */
export function monthsInRange(range) {
  if (!range) return []
  const [fy, fm] = range.from.split('-').map(Number)
  const [ty, tm] = range.to.split('-').map(Number)
  const keys = []
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    if (keys.length > 240) break // ~20 years; a guard against a nonsense range
  }
  return keys
}

/** 'Jan' style label for a `YYYY-MM` key, without constructing a local Date. */
export function monthLabel(key) {
  const [y, m] = String(key).split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1, 1))
  return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
}

/** Revenue vs expense per month, limited to months inside the range. */
export function monthlyCashFlow(payments, expenses, range, timezone) {
  const keys = monthsInRange(range)
  return keys.map((key) => ({
    label: monthLabel(key),
    income: payments
      .filter((p) => inRange(p?.date, range, timezone) && gymMonthKey(p.date, timezone) === key)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0),
    expense: expenses
      .filter((e) => inRange(e?.date, range, timezone) && gymMonthKey(e.date, timezone) === key)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0),
  }))
}

/** New members per month, by join date. */
export function monthlyNewMembers(members, range, timezone) {
  return monthsInRange(range).map((key) => ({
    label: monthLabel(key),
    newMembers: members.filter(
      (m) => inRange(m?.joinDate, range, timezone) && gymMonthKey(m.joinDate, timezone) === key
    ).length,
  }))
}

function sumInRange(items, range, timezone) {
  return items
    .filter((item) => inRange(item?.date, range, timezone))
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
}

/**
 * Headline totals for the selected range.
 *
 * `revenue` and `costs` were previously all-time sums on a page whose charts
 * covered six months, so the "Total revenue" tile and the cash-flow chart could
 * not be reconciled by the owner. Both are now range-scoped, and `net` is
 * derived from them rather than from a separately filtered "this month" slice.
 */
export function rangeTotals({ payments, expenses, members }, range, timezone) {
  const revenue = sumInRange(payments, range, timezone)
  const costs = sumInRange(expenses, range, timezone)
  const active = members.filter((m) => m?.status === 'active').length
  return { revenue, costs, net: revenue - costs, active }
}

/** Expenses grouped by category within the range, largest first. */
export function expensesByCategory(expenses, range, timezone, limit = 6) {
  const map = {}
  for (const e of expenses) {
    if (!inRange(e?.date, range, timezone)) continue
    const cat = e?.category || 'Other'
    map[cat] = (map[cat] || 0) + (Number(e.amount) || 0)
  }
  return Object.entries(map)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

/** Revenue grouped by plan within the range, largest first. */
export function revenueByPlan(payments, plans, range, timezone, limit = 5) {
  const planNames = new Map(plans.map((pl) => [pl.id, pl.name]))
  const map = {}
  for (const p of payments) {
    if (!inRange(p?.date, range, timezone)) continue
    const name = planNames.get(p?.planId) || (p?.type === 'membership' ? 'Membership' : 'Other')
    map[name] = (map[name] || 0) + (Number(p.amount) || 0)
  }
  return Object.entries(map)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

/** Convenience for the date inputs' min/max and for nudging the window. */
export function shiftRange(range, days) {
  if (!range) return null
  return { from: addDaysToKey(range.from, days), to: addDaysToKey(range.to, days) }
}