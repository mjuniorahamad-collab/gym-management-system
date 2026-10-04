import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'
import { DEFAULT_GYM_TIMEZONE, resolveGymTimezone } from '@/utils/gymTime'
import {
  TENANT_SETTINGS_DOC,
  buildTenantSettingsSeed,
  describeSettingsCompleteness,
  withSettingsFallbacks,
} from '@/services/tenantSettings'

/**
 * Initial form values only.
 *
 * This object is NEVER written to Firestore and is NOT merged over a stored
 * settings document for rendering (see `withSettingsFallbacks`). It exists so
 * the Settings form has something to render before the first snapshot lands.
 *
 * `gymName` and `receiptPrefix` are deliberately BLANK here. The previous
 * values ('Himalye Wonders Gym', 'HWG') were invented branding and receipt
 * numbering that the bootstrap persisted into every tenant on first sign-in.
 * They must come from the gym's own record, or from the owner.
 *
 * `timezone` keeps its documented meaning: the canonical zone for every
 * calendar-day decision, resolved through `resolveGymTimezone` so an absent or
 * unresolvable stored value can never reach a day-boundary calculation.
 */
export const DEFAULT_SETTINGS = {
  gymName: '',
  tagline: '',
  currency: 'INR',
  dateFormat: 'MMM D, YYYY',
  receiptPrefix: '',
  logoUrl: '',
  timezone: DEFAULT_GYM_TIMEZONE,
}

const SETTINGS_DOC = TENANT_SETTINGS_DOC

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
  needsConfiguration: false,
  missingRequiredFields: [],
  updateSettings: () => {},
})

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [missingRequiredFields, setMissingRequiredFields] = useState([])
  // The gym's own owner-of-record document. Read once per bound gym and used for
  // two things: the trusted source of the bootstrap's gymName/tagline, and a
  // display fallback so a partially configured gym is never rendered under an
  // invented name.
  const [gymRecord, setGymRecord] = useState(null)
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
    const gymRef = doc(db, 'gyms', gymId)
    let active = true
    let unsubscribe = null

    setError(null)
    setLoading(true)
    setMissingRequiredFields([])

    // Create the settings doc before subscribing (if missing). We avoid
    // calling setDoc from inside the onSnapshot callback — writing to a
    // document while listening to it is a known trigger for the Firestore
    // "INTERNAL ASSERTION FAILED" crash (firebase-js-sdk #10008).
    const ensureSettings = async () => {
      // Read the owner-of-record first. firestore.rules:183-186 exposes it only
      // to the gym's own owner-of-record or to staff of that gym, so it is a
      // trustworthy source of the gym's registered name.
      let gym = null
      try {
        const gymSnap = await getDoc(gymRef)
        if (!active) return
        gym = gymSnap.exists() ? gymSnap.data() : null
        setGymRecord(gym)
      } catch {
        if (!active) return
      }

      try {
        const snap = await getDoc(ref)
        if (!active) return
        if (!snap.exists()) {
          // Safe bootstrap. `gymId` comes from the signed-in users/{uid}
          // profile, which the rules freeze after the one-time bind, and the
          // write is additionally gated by firestore.rules:210-213 to an owner
          // of this gym whose document carries that same gymId.
          //
          // The seed deliberately contains NO invented business values:
          // gymName/tagline are copied from the tenant's own record, and
          // receiptPrefix is left unset so it cannot reach a printed receipt or
          // a persisted payment receipt number until an owner chooses it.
          const seed = buildTenantSettingsSeed({
            gymId,
            gym,
            existing: null,
          })
          if (seed.write) {
            await setDoc(ref, seed.write)
            if (!active) return
          }
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
            const stored = snap.data()
            setSettings(withSettingsFallbacks(stored, gym?.name))
            setMissingRequiredFields(describeSettingsCompleteness(stored).missing)
            setError(null)
            setLoading(false)
          } else {
            setSettings(withSettingsFallbacks(null, gym?.name))
            setMissingRequiredFields(describeSettingsCompleteness(null).missing)
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
        setMissingRequiredFields(
          describeSettingsCompleteness({ ...(settings || {}), ...data }).missing
        )
        toast.success('Settings saved')
        return true
      } catch (e) {
        toast.error(e.message || 'Could not save settings')
        return false
      }
    },
    [toast, gymId, settings]
  )

  // `timezone` is resolved once here so no caller has to remember to normalise
  // it, and so an unresolvable stored value can never reach a day-boundary
  // calculation. Consumers take this and pass it to the gymTime helpers.
  const timezone = resolveGymTimezone(settings.timezone)

  // True when the gym has a settings document but required values are still
  // unset. The app stays fully usable; this exists so an unconfigured gym is
  // visible as unconfigured instead of silently rendering an invented value.
  const needsConfiguration = missingRequiredFields.length > 0

  const value = useMemo(
    () => ({
      settings,
      timezone,
      loading,
      error,
      needsConfiguration,
      missingRequiredFields,
      gymRecord,
      updateSettings,
    }),
    [
      settings,
      timezone,
      loading,
      error,
      needsConfiguration,
      missingRequiredFields,
      gymRecord,
      updateSettings,
    ]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  return useContext(SettingsContext)
}
