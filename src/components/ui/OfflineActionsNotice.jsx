import { WifiOff } from 'lucide-react'
import { useOnline } from '@/hooks/useOnline'

/**
 * One sentence, in the place the operator is looking, explaining WHY a money
 * button is disabled. Renders nothing while online, so pages can drop it in
 * unconditionally.
 */
export function OfflineActionsNotice({ className = '' }) {
  const online = useOnline()
  if (online) return null

  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 ${className}`}
    >
      <WifiOff size={16} className="mt-0.5 shrink-0" />
      <p>
        <span className="font-semibold">You&apos;re offline.</span> Recording payments,
        renewals and membership edits are disabled until the connection returns — nothing
        is queued.
      </p>
    </div>
  )
}
