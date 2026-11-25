import { formatDate } from '@/utils/formatters'

/**
 * Spreadsheet formula injection (OWASP CSV Injection).
 *
 * A cell whose text starts with = + - @ or a control character is evaluated as
 * a FORMULA by Excel, LibreOffice and Google Sheets rather than shown as text.
 * Member names, expense titles and notes are free-text user input, so a member
 * named "=HYPERLINK(...)" would execute in the spreadsheet of any staff member
 * who opened the export. Prefixing with an apostrophe forces literal text.
 *
 * Numbers are passed through untouched so negative and decimal amounts stay
 * numeric instead of becoming text.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/

function escapeCsv(value) {
  if (value == null) return ''
  if (typeof value === 'number') return String(value)
  const s = String(value)
  const safe = FORMULA_TRIGGER.test(s) ? `'${s}` : s
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}

export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.map(escapeCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','))
  }
  return lines.join('\n')
}

export function downloadCsv(filename, rows) {
  const csv = toCsv(rows)
  if (!csv) return false
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return true
}

export function exportMembersToCsv(members, _settings) {
  const rows = members.map((m) => ({
    Name: m.name,
    Email: m.email || '',
    Phone: m.phone || '',
    Gender: m.gender || '',
    Plan: m.planName || m.membershipPlanId || '',
    Status: m.status || '',
    JoinDate: formatDate(m.joinDate),
    Notes: m.notes || '',
  }))
  return downloadCsv(`members-${new Date().toISOString().slice(0, 10)}.csv`, rows)
}

/**
 * Filename for an export.
 *
 * When a report range is supplied the range is part of the name
 * (`payments-2026-03-01_to_2026-03-31.csv`), so an accountant holding three
 * monthly files can tell them apart without opening each one. Without a range
 * the export is "everything as of today", which keeps the existing buttons
 * unchanged.
 */
export function exportFileName(kind, from, to) {
  const stamp =
    from && to ? `${from}_to_${to}` : new Date().toISOString().slice(0, 10)
  return `${kind}-${stamp}.csv`
}

export function exportPaymentsToCsv(payments, _settings, options = {}) {
  const rows = payments.map((p) => ({
    Member: p.memberName || p.memberId || '',
    Amount: p.amount,
    Method: p.method || '',
    Type: p.type || '',
    Date: formatDate(p.date),
    Note: p.note || '',
  }))
  return downloadCsv(exportFileName('payments', options.from, options.to), rows)
}

export function exportExpensesToCsv(expenses, options = {}) {
  const rows = expenses.map((e) => ({
    Title: e.title,
    Category: e.category,
    Amount: e.amount,
    Date: formatDate(e.date),
    Note: e.note || '',
  }))
  return downloadCsv(exportFileName('expenses', options.from, options.to), rows)
}

/**
 * Outstanding dues as an accountant-readable table.
 *
 * One row per member with a remaining balance. The ledger's own figures are
 * copied, never recomputed here: `Billed`/`Paid`/`Due` come from
 * computeOutstandingDues, the same engine the dashboard and member page use.
 * `OldestOpenPeriod` is the start of the oldest unpaid period — that is the
 * date a "pending since" column in a paper khata meant. No GST columns: the app
 * does not issue tax invoices.
 */
export function duesExportRows(rows = []) {
  return rows.map((r) => ({
    Member: r.member?.name || '',
    MemberNo: r.member?.memberNo || '',
    Phone: r.member?.phone || '',
    Plan: r.plan?.name || '',
    Billed: r.planAmount,
    Paid: r.totalPaid,
    Due: r.dueAmount,
    OldestOpenPeriod: formatDate(r.periods?.[0]?.startDate),
  }))
}

export function exportDuesToCsv(rows, _settings, options = {}) {
  return downloadCsv(
    exportFileName('dues', options.from, options.to),
    duesExportRows(rows)
  )
}
