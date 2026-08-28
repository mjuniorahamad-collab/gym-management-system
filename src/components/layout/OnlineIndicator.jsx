import { useEffect, useState } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import clsx from 'clsx'

export function OnlineIndicator() {
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        online
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
      )}
      title={online ? 'Connected — data syncs live' : 'Offline — using cached data'}
    >
      {online ? <Wifi size={12} /> : <WifiOff size={12} />}
      {online ? 'Online' : 'Offline'}
    </span>
  )
}
