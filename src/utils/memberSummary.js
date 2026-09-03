import { formatCurrency, formatDate } from './formatters'

/**
 * Build a customer-facing membership summary as plain text.
 *
 * All financial values MUST come from the canonical sources passed in:
 *   - ptCharge (from getMembershipCharge) for plan / PT / total
 *   - ledger.totals (from computeMemberLedger) for paid / due
 *
 * No independent calculations are performed here.
 */
export function buildMemberSummary({
  member,
  plan,
  expiry,
  ptCharge,
  ledger,
  settings,
  whatsAppLink,
}) {
  const gymName = settings?.gymName || 'Our Gym'
  const currency = settings?.currency || 'INR'
  const memberName = member?.name || 'Member'
  const planName = plan?.name || 'No plan'

  const lines = []

  lines.push(`Hi ${memberName},`)
  lines.push('')
  lines.push('Here is your membership summary:')
  lines.push('')
  lines.push(`Gym: ${gymName}`)

  if (member?.fatherName) {
    lines.push(`Father's Name: ${member.fatherName}`)
  }

  lines.push(`Membership: ${planName}`)
  lines.push(`Started: ${formatDate(member?.joinDate)}`)
  lines.push(`Valid until: ${expiry ? formatDate(expiry) : '—'}`)

  if (ptCharge) {
    lines.push(`Plan: ${formatCurrency(ptCharge.base, currency)}`)
    if (ptCharge.addon > 0) {
      lines.push(`Personal Training: ${formatCurrency(ptCharge.addon, currency)}`)
    }
    lines.push(`Total: ${formatCurrency(ptCharge.total, currency)}`)
  } else if (plan) {
    lines.push(`Plan: ${formatCurrency(plan.price, currency)}`)
    lines.push(`Total: ${formatCurrency(plan.price, currency)}`)
  }

  if (ledger?.totals) {
    lines.push(`Paid: ${formatCurrency(ledger.totals.paid, currency)}`)
    lines.push(
      `Due: ${ledger.totals.due === 0 ? 'Paid in full' : formatCurrency(ledger.totals.due, currency)}`
    )
  }

  lines.push('')
  lines.push('Thank you.')

  const link = String(whatsAppLink || '').trim()
  if (link) {
    lines.push('')
    lines.push(`Join our WhatsApp group: ${link}`)
  }

  return lines.join('\n')
}
