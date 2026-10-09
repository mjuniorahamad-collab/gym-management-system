import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'
import { DEFAULT_GYM_TIMEZONE, resolveGymTimezone } from '@/utils/gymTime'
import { provisionTenantSettings, settingsRef, settingsUpdatePayload, persistSettingsUpdate } from '@/services/tenantSettingsDoc'
import {
  describeSettingsCompleteness,
  withSettingsFallbacks,
} from '@/services/tenantSettings'
import { classifyPrefixConsistency } from '@/utils/receiptPrefix'

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

const SettingsContext = createContext({
  settings: DEFAULT_SETTINGS,
  loading: true,
  error: null,
  needsConfiguration: false,
  missingRequiredFields: [],
  pendingProvisioning: false,
  updateSettings: () => {},
})

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [missingRequiredFields, setMissingRequiredFields] = useState([])
  // True while the settings document is absent AND the client refused to
  // create it (no canonical prefix declared on gyms/{gymId}, or an unusable
  // tenant record). Such a gym must be provisioned by the controlled CLI
  // migration, never by a hidden generic client create.
  const [pendingProvisioning, setPendingProvisioning] = useState(false)
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
    setPendingProvisioning(false)

    // Create the settings doc before subscribing (if missing). We avoid
    // calling setDoc from inside the onSnapshot callback — writing to a
    // document while listening to it is a known trigger for the Firestore
    // "INTERNAL ASSERTION FAILED" crash (firebase-js-sdk #10008).
    const ensureSettings = async () => {
      // Read the owner-of-record first. firestore.rules:183-186 exposes it only
      // to the gym's own owner-of-record or to staff of that gym, so it is a
      // trustworthy source of the gym's registered name.
      let gym = null
      // Distinguishes "the read happened and found no gym" from "the read
      // failed". Only the first is evidence that the authority is missing; a
      // transient failure must not be reported as an authority/mirror
      // inconsistency, which would blame the tenant for a network error.
      let gymEstablished = false
      try {
        const gymSnap = await getDoc(gymRef)
        if (!active) return
        gymEstablished = true
        gym = gymSnap.exists() ? gymSnap.data() : null
        setGymRecord(gym)
      } catch {
        if (!active) return
      }

      let refusal = null
      try {
        await provisionTenantSettings({
          gymId,
          gym,
          receiptPrefix: gym?.receiptPrefix,
        })
        if (!active) return
        setPendingProvisioning(false)
      } catch (err) {
        if (!active) return
        if (err?.code === 'settings-exists') {
          setPendingProvisioning(false)
        } else {
          refusal = err
          setPendingProvisioning(true)
        }
      }

      unsubscribe = onSnapshot(
        ref,
        (snap) => {
          if (!active) return
          if (snap.exists()) {
            const stored = snap.data()
            setSettings(withSettingsFallbacks(stored, gym?.name))
            setMissingRequiredFields(describeSettingsCompleteness(stored).missing)
            setPendingProvisioning(false)
            // Authority/mirror consistency is checked here rather than
            // repaired: with both documents already in memory it costs no
            // extra read, and a mismatch must surface as an error naming both
            // paths instead of being silently resolved one way or the other.
            const consistency = gymEstablished
              ? classifyPrefixConsistency({
                  gymId,
                  authority: gym?.receiptPrefix,
                  mirror: stored.receiptPrefix,
                  settingsExists: true,
                })
              : null
            setError(consistency?.blocking ? consistency.message : null)
            setLoading(false)
          } else {
            setSettings(withSettingsFallbacks(null, gym?.name))
            setMissingRequiredFields(describeSettingsCompleteness(null).missing)
            setError(
              refusal?.message ||
                `No settings document exists for this gym (gyms/${gymId}/settings/app). ` +
                  'Settings must be provisioned for every active gym before this gym can be used.'
            )
            setLoading(false)
          }
        },
        (err) => {
          if (!active) return
          setError(
            refusal?.message ||
              (err?.message
                ? `Could not load settings for this gym: ${err.message}`
                : 'Could not load settings for this gym.')
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
      try {
        // `receiptPrefix` is stripped by settingsUpdatePayload: it is an
        // immutable property of the gyms/{gymId} owner-of-record and only the
        // create-only provisionTenantSettings / CLI migration may ever write it.
        const writable = settingsUpdatePayload(data)
        // persistSettingsUpdate uses updateDoc, never setDoc, so a missing
        // document makes the write fail with NOT_FOUND instead of quietly
        // creating one outside the create-only provisioning path.
        await persistSettingsUpdate({ gymId, data })
        setSettings((prev) => ({ ...prev, ...writable }))
        setMissingRequiredFields(
          describeSettingsCompleteness({ ...(settings || {}), ...writable }).missing
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
      pendingProvisioning,
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
      pendingProvisioning,
      gymRecord,
      updateSettings,
    ]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  return useContext(SettingsContext)
}
