import { useEffect, useState } from 'react'
import { isOffline } from '@/services/connectivity'

const readOnline = () => !isOffline()

/**
 * Live "can this device reach the backend right now?" state for the UI.
 *
 * One implementation, shared by the header indicator and by every surface that
 * disables a money action while offline. The header used to track
 * `navigator.onLine` itself, which disagreed with the guard in demo mode (where
 * there is no backend and nothing is ever "offline").
 */
export function useOnline() {
  const [online, setOnline] = useState(readOnline)

  useEffect(() => {
    const sync = () => setOnline(readOnline())
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    // Re-read on mount in case the state changed between render and effect.
    sync()
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  return online
}
