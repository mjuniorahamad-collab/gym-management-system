import { Wifi, WifiOff } from 'lucide-react'
import clsx from 'clsx'
import { useOnline } from '@/hooks/useOnline'

/**
 * Header connection badge. Reads the shared `useOnline` hook rather than
 * listening to `navigator.onLine` itself, so it can never disagree with the
 * guard that disables money actions.
 */
export function OnlineIndicator() {
  const online = useOnline()

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        online
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
      )}
      title={
        online
          ? 'Connected — data syncs live'
          : 'Offline — payments, renewals and edits are disabled'
      }
    >
      {online ? <Wifi size={12} /> : <WifiOff size={12} />}
      {online ? 'Online' : 'Offline'}
    </span>
  )
}
