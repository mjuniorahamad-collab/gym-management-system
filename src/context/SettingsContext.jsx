import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'
import { DEFAULT_GYM_TIMEZONE, resolveGymTimezone } from '@/utils/gymTime'

export const DEFAULT_SETTINGS = {
  gymName: 'Himalye Wonders Gym',
  tagline: 'Strength • Discipline • Growing',
  currency: 'INR',
  dateFormat: 'MMM D, YYYY',
  receiptPrefix: 'HWG',
  logoUrl: '',
  // Canonical timezone for every calendar-day decision: attendance day
  // boundaries, membership expiry, reports, billing months and freeze
  // arithmetic. Stored per gym at `gyms/{gymId}/settings/app.timezone` and
  // seeded here for gyms created from now on. Gyms predating this field have no
  // value, so every reader resolves through `resolveGymTimezone`, which falls
  // back to this same default rather than to the browser's timezone.
  timezone: DEFAULT_GYM_TIMEZONE,
}

const SETTINGS_DOC = 'app'

/**
 * Settings are tenant-scoped at `gyms/{gymId}/settings/app`.
 *
 * The former global `settings/app` singleton was readable and writable by ANY
 * signed-in user regardless of gym, which meant one tenant's branding,
 * currency and receipt prefix were visible to — and overwritable by — every
 * other tenant. That path is deliberately NOT used as a fallback here: a
 * silent fallback would keep exposing the insecure singleton whenever the
 * scoped document is missing or unreadable, which is exactly the failure this
 * change exists to remove. A missing or denied settings document is surfaced
 * as a loud, explicit error instead.
 */
function settingsRef(gymId) {
  return doc(db, 'gyms', gymId, 'settings', SETTINGS_DOC)
}

const SettingsContext = createContext({
  settings: DEFAULT_SETTINGS,
  loading: true,
  error: null,
  updateSettings: () => {},
})

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const { user, gymId } = useAuth()
  const toast = useToast()

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      // Demo / mock mode: no tenant exists, so the local defaults apply.
      setError(null)
      setLoading(false)
      return
    }
    // Never listen to Firestore without a signed-in user.
    if (!user) {
      setLoading(false)
      return
    }
    // No bound gym means there is no tenant-scoped settings document to read.
    // Do NOT fall back to the global singleton; report it instead.
    if (!gymId) {
      setError('No gym is assigned to this account, so tenant settings cannot be loaded.')
      setLoading(false)
      return
    }

    const ref = settingsRef(gymId)
    let active = true
    let unsubscribe = null

    setError(null)
    setLoading(true)

    // Create the settings doc before subscribing (if missing). We avoid
    // calling setDoc from inside the onSnapshot callback — writing to a
    // document while listening to it is a known trigger for the Firestore
    // "INTERNAL ASSERTION FAILED" crash (firebase-js-sdk #10008).
    const ensureSettings = async () => {
      try {
        const snap = await getDoc(ref)
        if (!active) return
        if (!snap.exists()) {
          await setDoc(ref, { ...DEFAULT_SETTINGS, gymId })
          if (!active) return
        }
      } catch {
        // Creating the document is owner-only. A non-owner may still be
        // permitted to read an existing one, so keep listening either way.
        if (!active) return
      }

      unsubscribe = onSnapshot(
        ref,
        (snap) => {
          if (!active) return
          if (snap.exists()) {
            setSettings({ ...DEFAULT_SETTINGS, ...snap.data() })
            setError(null)
            setLoading(false)
          } else {
            setSettings(DEFAULT_SETTINGS)
            setError(
              `No settings document exists for this gym (gyms/${gymId}/settings/app). ` +
                'Settings must be provisioned for every active gym before this gym can be used.'
            )
            setLoading(false)
          }
        },
        (err) => {
          if (!active) return
          setError(
            err?.message
              ? `Could not load settings for this gym: ${err.message}`
              : 'Could not load settings for this gym.'
          )
          setLoading(false)
        }
      )
    }

    ensureSettings()

    return () => {
      active = false
      if (unsubscribe) unsubscribe()
    }
  }, [user, gymId])

  const updateSettings = useCallback(
    async (data) => {
      if (!isFirebaseConfigured || !db) {
        setSettings((prev) => ({ ...prev, ...data }))
        toast.success('Settings saved (demo mode)')
        return true
      }
      if (!gymId) {
        toast.error('No gym is assigned to this account, so settings cannot be saved.')
        return false
      }
      const ref = settingsRef(gymId)
      try {
        // The scoped settings document must carry the owning gymId; the
        // security rules reject any write that does not match the caller.
        await updateDoc(ref, { ...data, gymId })
        setSettings((prev) => ({ ...prev, ...data }))
        toast.success('Settings saved')
        return true
      } catch (e) {
        toast.error(e.message || 'Could not save settings')
        return false
      }
    },
    [toast, gymId]
  )

  // `timezone` is resolved once here so no caller has to remember to normalise
  // it, and so an unresolvable stored value can never reach a day-boundary
  // calculation. Consumers take this and pass it to the gymTime helpers.
  const timezone = resolveGymTimezone(settings.timezone)

  const value = useMemo(
    () => ({ settings, timezone, loading, error, updateSettings }),
    [settings, timezone, loading, error, updateSettings]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  return useContext(SettingsContext)
}
