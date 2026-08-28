import { formatDate } from '@/utils/formatters'

function escapeCsv(value) {
  if (value == null) return ''
  const s = String(value)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
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

export function exportPaymentsToCsv(payments, _settings) {
  const rows = payments.map((p) => ({
    Member: p.memberName || p.memberId || '',
    Amount: p.amount,
    Method: p.method || '',
    Type: p.type || '',
    Date: formatDate(p.date),
    Note: p.note || '',
  }))
  return downloadCsv(`payments-${new Date().toISOString().slice(0, 10)}.csv`, rows)
}

export function exportExpensesToCsv(expenses) {
  const rows = expenses.map((e) => ({
    Title: e.title,
    Category: e.category,
    Amount: e.amount,
    Date: formatDate(e.date),
    Note: e.note || '',
  }))
  return downloadCsv(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, rows)
}
