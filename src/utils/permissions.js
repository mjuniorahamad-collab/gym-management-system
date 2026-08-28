import { PERMISSIONS, ROLE_LABELS, ROLE_LEVELS } from './constants'

export function can(role, permission) {
  const roles = PERMISSIONS[permission]
  if (!roles) return false
  return roles.includes(role)
}

export function isAtLeast(role, minRole) {
  if (!role || !minRole) return false
  return (ROLE_LEVELS[role] || 0) >= (ROLE_LEVELS[minRole] || 0)
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || '—'
}

export function permissionsFor(role) {
  return Object.fromEntries(
    Object.entries(PERMISSIONS).map(([key, roles]) => [key, roles.includes(role)])
  )
}
