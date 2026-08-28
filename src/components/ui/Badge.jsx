import clsx from 'clsx'

const TONES = {
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
  neutral: 'badge-neutral',
  indigo: 'badge-indigo',
}

export function Badge({ tone = 'neutral', className, children, ...props }) {
  return (
    <span className={clsx('badge', TONES[tone] || TONES.neutral, className)} {...props}>
      {children}
    </span>
  )
}

export function StatusBadge({ status }) {
  const map = {
    active: { tone: 'success', label: 'Active' },
    expired: { tone: 'danger', label: 'Expired' },
    frozen: { tone: 'warning', label: 'Frozen' },
    booked: { tone: 'info', label: 'Booked' },
    cancelled: { tone: 'neutral', label: 'Cancelled' },
    attended: { tone: 'success', label: 'Attended' },
  }
  const config = map[status] || { tone: 'neutral', label: status || '—' }
  return <Badge tone={config.tone}>{config.label}</Badge>
}
