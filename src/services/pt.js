import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { getGymId } from './ownerContext'
import { logAudit } from './audit'

/**
 * Per-gym Personal Training (PT) surcharge.
 *
 * Stored tenant-safely as the singleton document `gyms/{gymId}/settings/pt`.
 * This is a SUB-COLLECTION of the owner-of-record gym document — it carries
 * gymId and inherits the per-gym security gating in firestore.rules, so one
 * gym can never read or write another gym's PT pricing. The global
 * `settings/app` singleton is deliberately NOT used because it is shared
 * across tenants.
 *
 * A missing document means "no PT surcharge configured" → treated as 0
 * (regular behavior preserved). Each gym explicitly sets its own amount.
 */

const SETTINGS_SUB = 'settings'
const PT_DOC = 'pt'

// Module-level cache used only in demo/offline (mock) mode, mirroring the
// mockStore pattern so the UI stays testable without Firebase.
let mockSurcharge = 0

function isReady() {
  return isFirebaseConfigured && Boolean(db)
}

function ptRef() {
  const gymId = getGymId()
  if (!gymId && isReady()) {
    throw new Error('No gym selected — PT settings are scoped to a gym')
  }
  return { gymId, ref: doc(db, 'gyms', gymId, SETTINGS_SUB, PT_DOC) }
}

/**
 * Read the current gym's PT surcharge.
 *
 * Returns a non-negative number. Errors reading (e.g. cross-gym denial,
 * missing profile) are surfaced to the caller rather than silently hidden.
 *
 * @returns {Promise<number>} the configured surcharge for the bound gym (0 if unset)
 */
export async function getPtSurcharge() {
  if (!isReady()) return mockSurcharge
  const { ref } = ptRef()
  const snap = await getDoc(ref)
  if (!snap.exists()) return 0
  const data = snap.data()
  const value = Number(data.surcharge)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Set the current gym's PT surcharge (owner-only gated in rules).
 *
 * @param {number} surcharge non-negative number
 * @returns {Promise<void>}
 */
export async function setPtSurcharge(surcharge) {
  const value = Math.max(0, Number(surcharge))
  if (!Number.isFinite(value)) throw new Error('A valid PT surcharge is required')
  if (!isReady()) {
    mockSurcharge = value
    return
  }
  const { gymId, ref } = ptRef()
  await setDoc(ref, { surcharge: value, gymId, updatedAt: new Date() }, { merge: true })
  await logAudit({
    action: 'update',
    entity: 'settings',
    entityId: `pt-${gymId}`,
    details: { ptSurcharge: value },
  })
}

export { PT_DOC }
