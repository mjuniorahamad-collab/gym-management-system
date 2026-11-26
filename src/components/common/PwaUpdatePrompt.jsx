import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { pwaUpdates } from '@/utils/pwaUpdates'

/**
 * The one thing an installed app needs when a new build has been deployed:
 * permission to reload. Renders nothing until the service worker reports a
 * waiting version, and nothing at all in a normal browser tab that has no
 * service worker.
 */
export function PwaUpdatePrompt() {
  const [available, setAvailable] = useState(false)

  useEffect(() => pwaUpdates.subscribe(setAvailable), [])

  if (!available) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-20 z-50 lg:bottom-3 mx-auto flex max-w-md flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg dark:border-slate-700 dark:bg-slate-800"
    >
      <div className="flex items-center gap-2">
        <RefreshCw size={16} className="shrink-0 text-slate-500 dark:text-slate-400" />
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          A new version is available.
        </p>
      </div>
      <Button size="sm" onClick={() => pwaUpdates.apply()}>
        Reload
      </Button>
    </div>
  )
}
