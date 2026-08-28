export const MEMBER_NO_PREFIX = 'MEM'

export function formatMemberNo(n) {
  const num = Number.parseInt(n, 10)
  if (Number.isNaN(num) || num < 0) return ''
  return `${MEMBER_NO_PREFIX}-${String(num).padStart(4, '0')}`
}

export function parseMemberNo(value) {
  if (typeof value !== 'string') return null
  const match = value.match(new RegExp(`^${MEMBER_NO_PREFIX}-(\\d+)$`, 'i'))
  return match ? Number.parseInt(match[1], 10) : null
}
