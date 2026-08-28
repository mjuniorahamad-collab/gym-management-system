export function safePaymentAmount(amount) {
  const n = Number(amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Single source of truth for membership payment status.
 * dueAmount = planAmount - totalPaid, clamped so it is never negative.
 *
 * When `membershipId` is provided, only payments belonging to that membership
 * period are counted so unrelated historical payments are never combined.
 * When omitted, all of the member's payments are counted (legacy behavior).
 */
export function getPaymentSummary({ payments = [], memberId, planAmount, membershipId } = {}) {
  const totalPaid = payments
    .filter((p) => p && p.memberId === memberId && (!membershipId || p.membershipId === membershipId))
    .reduce((sum, p) => sum + safePaymentAmount(p.amount), 0)
  const total = Math.max(0, Number(planAmount) || 0)
  const due = Math.max(0, total - totalPaid)
  return { planAmount: total, totalPaid, dueAmount: due, paidInFull: total > 0 && due === 0 }
}
