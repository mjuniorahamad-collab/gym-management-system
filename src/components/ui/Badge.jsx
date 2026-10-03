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

/**
 * `frozen` is NOT here, and its absence is the point.
 *
 * Freezing is orthogonal to membership currency: a member frozen today is still
 * `active` or `expiring` underneath. Rendering a frozen member as the status
 * "Frozen" would present one attribute as if it were the whole truth, and would
 * hide whether their entitlement is running out. Callers that care about a live
 * freeze read `member.isFrozen` / `member.freezeUntil` and show it as a separate
 * badge — see FrozenBadge below.
 */
const STATUS_MAP = {
  active: { tone: 'success', label: 'Active' },
  // `warning`, not `danger`: an expiring member is still a paying member. They
  // need a nudge, not an alarm.
  expiring: { tone: 'warning', label: 'Expiring Soon' },
  expired: { tone: 'danger', label: 'Expired' },
  booked: { tone: 'info', label: 'Booked' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  attended: { tone: 'success', label: 'Attended' },
}

export function StatusBadge({ status }) {
  const config = STATUS_MAP[status] || { tone: 'neutral', label: status || '—' }
  return <Badge tone={config.tone}>{config.label}</Badge>
}

/**
 * The live-freeze flag, kept deliberately separate from `StatusBadge`.
 *
 * Renders nothing when the member is not currently inside a freeze, so a frozen
 * member shows "Active · Frozen to 26 Aug" rather than having their currency
 * replaced by the freeze.
 */
export function FrozenBadge({ isFrozen, freezeUntil }) {
  if (!isFrozen) return null
  return (
    <Badge tone="info" title={freezeUntil ? `Frozen until ${freezeUntil}` : undefined}>
      Frozen{freezeUntil ? ` to ${freezeUntil}` : ''}
    </Badge>
  )
}
