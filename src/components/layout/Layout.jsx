import { createContext, useContext, useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
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
          <OfflineActionsNotice className="mx-4 mt-4 lg:mx-6" />
          <main className="flex-1 p-4 lg:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </LayoutContext.Provider>
  )
}
