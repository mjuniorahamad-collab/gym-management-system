import { parseDate } from './dateHelpers'

/**
 * Recorded membership periods of one member whose [startDate, expiryDate]
 * window overlaps the given window. Used as a DUPLICATE-PERIOD GUARD: an
 * accidental double-renewal creates overlapping windows, so saving an
 * overlapping period warns the operator — while still allowing intentional
 * overlaps to be saved.
 */
export function findOverlappingPeriods(
  { memberId, startDate, expiryDate, excludeId },
  memberships = []
) {
  const start = parseDate(startDate)?.getTime()
  const end = parseDate(expiryDate)?.getTime()
  if (!start || !end) return []

  return memberships
    .filter((m) => {
      if (!m || !m.id || m.id === excludeId) return false
      if (memberId && m.memberId !== memberId) return false
      const s = parseDate(m.startDate)?.getTime()
      const e = parseDate(m.expiryDate)?.getTime()
      if (!s || !e) return false
      return s <= end && start <= e
    })
    .map((m) => ({
      id: m.id,
      planName: m.planName || '',
      startDate: m.startDate,
      expiryDate: m.expiryDate,
    }))
}
