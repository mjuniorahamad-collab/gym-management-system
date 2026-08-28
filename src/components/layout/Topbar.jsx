import { Menu } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { roleLabel } from '@/utils/permissions'
import { initials } from '@/utils/formatters'
import { ThemeToggle } from './ThemeToggle'
import { OnlineIndicator } from './OnlineIndicator'
import { useLayout } from './Layout'

export function Topbar() {
  const { setSidebarOpen } = useLayout()
  const { profile } = useAuth()

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 lg:px-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setSidebarOpen(true)}
          className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 lg:hidden"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <div className="hidden items-center gap-2 sm:flex">
          <OnlineIndicator />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ThemeToggle />
        <div className="hidden items-center gap-2.5 rounded-full border border-slate-200 py-1 pl-1 pr-3 dark:border-slate-800 sm:flex">
          <div className="avatar bg-indigo-600 text-white">{initials(profile?.name || '?')}</div>
          <div className="leading-tight">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
              {profile?.name || 'User'}
            </p>
            <p className="text-[11px] text-slate-400">{roleLabel(profile?.role)}</p>
          </div>
        </div>
      </div>
    </header>
  )
}
