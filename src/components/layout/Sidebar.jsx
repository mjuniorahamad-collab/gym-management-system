import { NavLink, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  BadgePercent,
  CalendarDays,
  ClipboardCheck,
  Dumbbell,
  LayoutDashboard,
  LogOut,
  Receipt,
  Settings as SettingsIcon,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { NAV_ITEMS } from '@/utils/constants'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useLayout } from './Layout'

const ICON_MAP = {
  LayoutDashboard,
  Users,
  Dumbbell,
  CalendarDays,
  ClipboardCheck,
  Wallet,
  Receipt,
  BadgePercent,
  BarChart3,
  Settings: SettingsIcon,
}

function NavLinkItem({ item, onNavigate }) {
  const Icon = ICON_MAP[item.icon]
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-indigo-600 text-white shadow-sm'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        )
      }
    >
      {Icon && <Icon size={18} />}
      {item.label}
    </NavLink>
  )
}

export function Sidebar() {
  const { sidebarOpen, setSidebarOpen } = useLayout()
  const { can, signOut } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

  const items = NAV_ITEMS.filter((item) => !item.permission || can(item.permission))

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900',
          'lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-600 to-emerald-600 text-white">
              <Dumbbell size={18} />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-bold text-slate-900 dark:text-slate-100">Gym Management System</p>
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                {settings.gymName}
              </p>
            </div>
          </div>
          <button
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {items.map((item) => (
            <NavLinkItem key={item.to} item={item} onNavigate={() => setSidebarOpen(false)} />
          ))}
        </nav>

        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
          >
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </aside>
    </>
  )
}
