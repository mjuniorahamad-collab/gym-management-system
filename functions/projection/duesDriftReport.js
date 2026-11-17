/**
 * `getDuesDriftReport` — read the latest reconciliation report for the caller's gym.
 *
 * The report lives in `systemReports`, an admin-only collection: no client rule
 * grants access, so the browser cannot read it directly even if it guessed the
 * document id. A callable is the narrow door:
 *
 *   1. authenticated
 *   2. the caller's profile exists and carries a bound gymId (taken from
 *      `users/{uid}`, never from the request)
 *   3. the caller's role can see finance (`owner` / `admin` — the same roles
 *      `finance.view` grants in the app)
 *
 * Nothing is parameterised: the gym is resolved server-side, so this cannot be
 * used to read another tenant's report. A missing report is a normal answer
 * ("the job has not run yet"), not an error.
 *
 * Read-only by construction. This module never writes.
 */
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { firestore } from './admin.js'
import { resolveCallerGym } from './reproject.js'
import { DRIFT_REPORT_COLLECTION, DRIFT_REPORT_PREFIX } from './duesDrift.js'

/** Mirrors `finance.view` in src/utils/constants.js. Kept explicit and tiny. */
export const REPORT_ROLES = Object.freeze(['owner', 'admin'])

const PUBLIC_DENIAL = 'not-authorized'

/** The caller's role and gym, or null when the profile is unusable. */
async function resolveCallerProfile(db, auth) {
  const uid = auth?.uid
  if (!uid) return null
  const snapshot = await db.doc(`users/${uid}`).get()
  if (!snapshot.exists) return null
  const profile = snapshot.data() || {}
  const gymId = await resolveCallerGym(db, auth)
  if (!gymId) return null
  return { gymId, role: profile.role ?? null }
}

/**
 * The handler as a plain function, so the emulator suite can drive every rung of
 * the authorization chain without the Functions emulator.
 */
export async function handleGetDuesDriftReport({ db, auth } = {}) {
  if (!auth?.uid) return { ok: false, reason: 'unauthenticated' }

  const profile = await resolveCallerProfile(db, auth)
  if (!profile) return { ok: false, reason: PUBLIC_DENIAL }
  if (!REPORT_ROLES.includes(profile.role)) {
    logger.warn('getDuesDriftReport denied by role', { uid: auth.uid, gymId: profile.gymId })
    return { ok: false, reason: PUBLIC_DENIAL }
  }

  const snapshot = await db
    .doc(`${DRIFT_REPORT_COLLECTION}/${DRIFT_REPORT_PREFIX}${profile.gymId}`)
    .get()

  if (!snapshot.exists) return { ok: true, report: null }

  return { ok: true, report: snapshot.data() }
}

export const getDuesDriftReport = onCall({ region: 'asia-south1' }, async (request) => {
  try {
    const result = await handleGetDuesDriftReport({
      db: firestore(),
      auth: request.auth,
    })
    if (!result.ok) {
      throw new HttpsError(
        result.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
        result.reason
      )
    }
    return result
  } catch (error) {
    if (error instanceof HttpsError) throw error
    logger.error('getDuesDriftReport failed', { error })
    throw new HttpsError('internal', 'report unavailable')
  }
})
