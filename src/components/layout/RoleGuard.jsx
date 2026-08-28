import { Navigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'

/**
 * Restrict a page to a set of roles and/or a permission.
 * If the current user is not allowed, they are redirected to the dashboard.
 */
export function RoleGuard({ roles, permission, children }) {
  const { role, can } = useAuth()

  const allowed =
    (Array.isArray(roles) && roles.includes(role)) || (permission && can(permission))

  if (!allowed) return <Navigate to="/" replace />

  return children
}
