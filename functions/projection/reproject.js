/**
 * `reprojectMember` — the authorized entry point to the trusted projection writer.
 *
 * A callable rather than a Firestore trigger on purpose. Reprojection is not a
 * consequence of a membership write; it is a *correction*, and corrections are
 * requested by a human who knows something changed ("I just cancelled that
 * freeze, the member still shows frozen"). A trigger would fire on the writes
 * that already produce correct values and would still miss every case where the
 * stored value drifted for a reason nobody wrote about.
 *
 * ## The authorization chain
 *
 *   1. authenticated           — an unauthenticated caller gets nothing.
 *   2. payload is exactly `{ memberId }` — see "trusting nothing" below.
 *   3. the caller's profile exists and carries a bound gymId.
 *   4. the target member exists AND belongs to that gym.
 *
 * `gymId` is taken from `users/{uid}` — the same authority `firestore.rules`
 * uses via `gymOf()` — and never from the request. A caller cannot choose which
 * gym they are acting for, so they cannot use this to repair someone else's gym.
 *
 * ## Why rejection does not say which
 *
 * A missing member and a member belonging to another gym are the same
 * 'not-authorized' to the caller, and are only distinguished in the server log.
 * Reporting "no such member" versus "not your gym" would turn this callable into
 * an existence oracle for the whole member table: a caller could enumerate ids
 * and learn which ones are real and which gyms they belong to. The underlying
 * reason is still logged, so the distinction is available for support.
 *
 * ## Role gating
 *
 * There is deliberately no role check. The approved chain gates on a bound gym,
 * and the worst a plain gym member can do is ask for a recomputation that the
 * server then performs correctly from authoritative data: no entitlement is
 * granted, no money moves, no tenancy changes, and the response carries no
 * projection values. Adding a role list here would also mean a second copy of
 * `src/utils/constants.js`'s STAFF_ROLES to keep in sync, which is the same
 * drift risk this whole design exists to avoid.
 */
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { firestore } from './admin.js'
import { recomputeMemberProjection } from './writer.js'

/**
 * The single public rejection for "you may not know or touch this member".
 * Also used for a caller with no bound gym.
 */
const PUBLIC_DENIAL = 'not-authorized'

/** The callable accepts one field. Anything else is a client bug or an attack. */
const ALLOWED_KEYS = new Set(['memberId'])

/**
 * Read the caller's own gym binding.
 *
 * Null-safe in the same spirit as the rules' `gymOf()`: a brand-new account with
 * no profile, or a profile with no gymId yet, resolves to null and is denied
 * rather than throwing or defaulting to some gym.
 */
export async function resolveCallerGym(db, auth) {
  const uid = auth?.uid
  if (!uid) return null
  const snapshot = await db.doc(`users/${uid}`).get()
  if (!snapshot.exists) return null
  const gymId = snapshot.data()?.gymId
  return typeof gymId === 'string' && gymId.trim() ? gymId : null
}

/**
 * Validate the payload without touching Firestore.
 *
 * Unknown keys are rejected rather than ignored. Ignoring them would let a
 * client believe it had passed something the server honoured — and a caller
 * that later adds `gymId` to the payload would get a silent success while its
 * value sat unread, which is exactly the kind of quiet divergence that turns into
 * a vulnerability.
 */
export function validateReprojectionRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'invalid-request'
  const keys = Object.keys(data)
  if (keys.some((key) => !ALLOWED_KEYS.has(key))) return 'invalid-request'
  const { memberId } = data
  if (typeof memberId !== 'string' || !memberId.trim()) return 'invalid-request'
  if (memberId.length > 500) return 'invalid-request'
  return null
}

/**
 * The handler, as a plain async function.
 *
 * Deliberately not wrapped in `onCall` here: the emulator suite drives this
 * directly, so authorization can be tested for every rung of the chain without
 * standing up the Functions emulator. `reprojectMember` below is a thin adapter.
 *
 * @returns {Promise<{ok: boolean, reason?: string, changed?: boolean, updated?: string[]}>}
 */
export async function handleReprojectMember({ db, auth, data } = {}) {
  if (!auth?.uid) return { ok: false, reason: 'unauthenticated' }

  const invalid = validateReprojectionRequest(data)
  if (invalid) return { ok: false, reason: invalid }

  const { memberId } = data
  const gymId = await resolveCallerGym(db, auth)
  if (!gymId) return { ok: false, reason: PUBLIC_DENIAL }

  const result = await recomputeMemberProjection(db, { memberId, gymId })

  if (!result.ok) {
    // 'member-not-found' and 'tenant-mismatch' are different facts but the same
    // answer to the caller. Log the real one, return the flat one.
    const internal = result.reason === 'tenant-mismatch' ? 'foreign-gym-member' : result.reason
    logger.warn('reprojectMember denied', {
      uid: auth.uid,
      gymId,
      memberId,
      internal,
    })
return { ok: false, reason: PUBLIC_DENIAL }
  }

  logger.info('reprojectMember applied', {
    uid: auth.uid,
    gymId,
    memberId,
    changed: result.changed,
    updated: result.updated ?? [],
  })

  // No `fields` in the response. The caller is already entitled to read the
  // member document, so returning the values adds nothing — and if member-read
  // rules are ever tightened, this cannot become a way around them.
  return { ok: true, changed: result.changed, updated: result.updated ?? [] }
}

export const reprojectMember = onCall({ region: 'asia-south1' }, async (request) => {
  try {
    const result = await handleReprojectMember({
      db: firestore(),
      auth: request.auth,
      data: request.data,
    })
    if (!result.ok) {
      const unauthenticated = result.reason === 'unauthenticated'
      const invalid = result.reason === 'invalid-request'
      throw new HttpsError(
        unauthenticated ? 'unauthenticated' : invalid ? 'invalid-argument' : 'permission-denied',
        result.reason
      )
    }
    return result
  } catch (error) {
    // A HttpsError thrown above must keep its own code and message; anything
    // else is an unexpected fault and is allowed to surface as internal.
    if (error instanceof HttpsError) throw error
    logger.error('reprojectMember failed', { error })
    throw new HttpsError('internal', 'reprojection failed')
  }
})