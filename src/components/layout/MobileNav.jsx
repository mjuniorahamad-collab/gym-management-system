import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import { ClipboardCheck, LayoutDashboard, Menu, Users, Wallet } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useLayout } from './Layout'

/**
 * Bottom tab bar for phones.
 *
 * The sidebar is a drawer on mobile, which means every destination costs two
 * taps and a reach to the top-left corner. Front-desk work is four screens, so
 * those four get a thumb-sized target at the bottom; everything else stays
 * behind "More", which opens the same drawer.
 */
const ITEMS = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/members', label: 'Members', icon: Users, permission: 'members.view' },
  { to: '/attendance', label: 'Check-in', icon: ClipboardCheck, permission: 'members.view' },
  { to: '/payments', label: 'Payments', icon: Wallet, permission: 'finance.view' },
]

export function MobileNav() {
  const { can } = useAuth()
  const { setSidebarOpen } = useLayout()
  const items = ITEMS.filter((item) => !item.permission || can(item.permission))

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 lg:hidden"
    >
      <div className="pb-safe mx-auto flex max-w-lg items-stretch px-1">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                clsx(
                  'flex min-h-[3.25rem] flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-semibold transition-colors',
                  isActive
                    ? 'text-indigo-600 dark:text-indigo-400'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={clsx(
                      'flex h-8 w-12 items-center justify-center rounded-full transition-colors',
                      isActive && 'bg-indigo-50 dark:bg-indigo-500/15'
                    )}
                  >
                    <Icon size={20} />
                  </span>
                  {item.label}
                </>
              )}
            </NavLink>
          )
        })}
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="flex min-h-[3.25rem] flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-semibold text-slate-500 transition-colors hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <span className="flex h-8 w-12 items-center justify-center">
            <Menu size={20} />
          </span>
          More
        </button>
      </div>
    </nav>
  )
}
