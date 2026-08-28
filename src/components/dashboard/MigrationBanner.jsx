import { Link } from 'react-router-dom'
import { DatabaseBackup } from 'lucide-react'

/**
 * One-time cleanup prompt: members whose earliest payment predates their
 * oldest membership record still carry an undocumented origin period. The
 * finance engine already accounts for it, but recording it properly keeps
 * history complete. Owner runs the backfill from Settings.
 */
export function MigrationBanner({ pendingMembers = 0 }) {
  if (pendingMembers <= 0) return null

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <DatabaseBackup size={18} className="shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">Financial data cleanup recommended.</span>{' '}
        {pendingMembers} member{pendingMembers === 1 ? '' : 's'} have earlier membership periods that
        predate digital records. Dues are already calculated correctly, but you can materialize
        those periods into membership history for complete records.
      </p>
      <Link
        to="/settings"
        className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700"
      >
        Review in Settings
      </Link>
    </div>
  )
}
