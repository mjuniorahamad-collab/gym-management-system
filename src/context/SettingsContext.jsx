import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'

export const DEFAULT_SETTINGS = {
  gymName: 'Himalye Wonders Gym',
  tagline: 'Strength • Discipline • Growth',
  currency: 'INR',
  dateFormat: 'MMM D, YYYY',
  receiptPrefix: 'HWG',
  logoUrl: '',
}

const SETTINGS_DOC = 'app'

const SettingsContext = createContext({ settings: DEFAULT_SETTINGS, updateSettings: () => {} })

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const { user } = useAuth()
  const toast = useToast()

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      setLoading(false)
      return
    }
    // Never listen to Firestore without a signed-in user.
    if (!user) {
      setLoading(false)
      return
    }
    const ref = doc(db, 'settings', SETTINGS_DOC)
    let active = true
    let unsubscribe = null

    // Create the settings doc before subscribing (if missing). We avoid
    // calling setDoc from inside the onSnapshot callback — writing to a
    // document while listening to it is a known trigger for the Firestore
    // "INTERNAL ASSERTION FAILED" crash (firebase-js-sdk #10008).
    const ensureSettings = async () => {
      try {
        const snap = await getDoc(ref)
        if (!active) return
        if (!snap.exists()) {
          await setDoc(ref, DEFAULT_SETTINGS)
          if (!active) return
        }
      } catch {
        // Not permitted to create it (e.g. read-only role). Keep listening
        // anyway — a settings doc may already exist server-side.
        if (!active) return
      }
      unsubscribe = onSnapshot(
        ref,
        (snap) => {
          if (!active) return
          if (snap.exists()) {
            setSettings({ ...DEFAULT_SETTINGS, ...snap.data() })
          }
          setLoading(false)
        },
        () => {
          if (active) setLoading(false)
        }
      )
    }

    ensureSettings()

    return () => {
      active = false
      if (unsubscribe) unsubscribe()
    }
  }, [user])

  const updateSettings = useCallback(
    async (data) => {
      if (!isFirebaseConfigured || !db) {
        setSettings((prev) => ({ ...prev, ...data }))
        toast.success('Settings saved (demo mode)')
        return true
      }
      const ref = doc(db, 'settings', SETTINGS_DOC)
      try {
        await updateDoc(ref, data)
        setSettings((prev) => ({ ...prev, ...data }))
        toast.success('Settings saved')
        return true
      } catch (e) {
        toast.error(e.message || 'Could not save settings')
        return false
      }
    },
    [toast]
  )

  const value = useMemo(() => ({ settings, loading, updateSettings }), [settings, loading, updateSettings])

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  return useContext(SettingsContext)
}
