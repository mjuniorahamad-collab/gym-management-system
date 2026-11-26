import { createContext, useContext, useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileNav } from './MobileNav'
import { Outlet } from 'react-router-dom'
import { backfillMemberNumbers } from '@/services/memberNumbers'
import { OfflineActionsNotice } from '@/components/ui/OfflineActionsNotice'

const LayoutContext = createContext({ sidebarOpen: false, setSidebarOpen: () => {} })
export const useLayout = () => useContext(LayoutContext)

let backfillStarted = false

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    if (backfillStarted) return
    backfillStarted = true
    if (localStorage.getItem('memberNoBackfilled')) return
    backfillMemberNumbers()
      .then(() => localStorage.setItem('memberNoBackfilled', '1'))
      .catch(() => {})
  }, [])

  return (
    <LayoutContext.Provider value={{ sidebarOpen, setSidebarOpen }}>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
          <Topbar />
          {/* Renders nothing while online. When offline it says why the money
              actions on whatever page is open are disabled. */}
          <OfflineActionsNotice className="mx-3 mt-3 sm:mx-4 lg:mx-6" />
          {/* Phone-sized padding, plus room for the bottom tab bar so the last
              row of a table is never hidden behind it. */}
          <main className="flex-1 px-3 py-4 pb-28 sm:px-4 lg:p-6 lg:pb-6">
            <Outlet />
          </main>
        </div>
        <MobileNav />
      </div>
    </LayoutContext.Provider>
  )
}
