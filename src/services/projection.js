/**
 * CLIENT-SIDE PROJECTION REQUEST.
 *
 * The projection on a member document is a CACHE. It is written by the trusted
 * server writer, never by the browser. All the browser does after changing an
 * authoritative document is ASK for it to be recomputed.
 *
 * ## Why this cannot fail the caller
 *
 * The authoritative write has already committed by the time anything here runs.
 * The payment is recorded, the period is edited, the renewal exists. If the
 * reprojection then fails, the correct outcome is a projection that is stale for
 * a few minutes — not a refund. So this function NEVER throws: every path
 * returns a result object, and the failure is reported rather than propagated.
 *
 * ## Failure is not the end of the story
 *
 * A failed request is logged and counted, and the nightly sweep repairs anything
 * this missed. That is the whole reason the sweep exists. It is still worth
 * knowing: a silent failure here is a projection nobody else will notice is
 * stale until the sweep touches it.
 */
import { getFunctions, httpsCallable } from 'firebase/functions'
import { isFirebaseConfigured } from '@/firebase'

let warned = {}

/** Reset the once-per-reason warning. Exported for tests. */
export function _resetReprojectionWarnings() {
  warned = {}
}

/**
 * Ask the server to recompute one member's projection.
 *
 * Sends ONLY `{ memberId }`. The gym is derived server-side from the caller's
 * `users/{uid}` profile; sending a gymId from the client would be a claim about
 * authority the client does not have.
 *
 * @param {string} memberId
 * @returns {Promise<{ok: boolean, status?: string, reason?: string}>} never throws
 */
export async function requestReprojection(memberId) {
  if (!memberId) return { ok: false, reason: 'no-member-id' }

  // Demo / offline mode has no Functions at all. The mock store keeps its own
  // derived values, so there is nothing to ask for.
  //
  // The guard is `isFirebaseConfigured`, not the Firestore service's `isReady`:
  // this module talks to Cloud Functions, and importing the Firestore service
  // purely for a readiness flag would couple the Functions client to that
  // module's entire export surface — which several suites mock.
  if (!isFirebaseConfigured) return { ok: false, reason: 'offline-mode' }

  try {
    const callable = httpsCallable(getFunctions(), 'reprojectMember')
    const { data } = await callable({ memberId })
    return { ok: true, status: data?.status ?? 'ok' }
  } catch (error) {
    // Once per reason, so a systematic failure (unreachable Functions, wrong
    // deployment) shows up in the console without spamming it on every keystroke.
    const reason = error?.code || 'unknown'
    if (!warned[reason]) {
      warned[reason] = true
      console.warn(
        `[projection] reprojection request failed (${reason}); the nightly sweep will repair this member`,
        error
      )
    }
    return { ok: false, reason, error }
  }
}

/**
 * Ask for a reprojection and wait, then report whether the cache is now trusted.
 *
 * Separate from `requestReprojection` because callers that immediately re-read
 * the member need to know the write landed, while fire-and-forget callers do
 * not. Both are safe; the difference is only whether a stale read follows.
 */
export async function requestReprojectionAndConfirm(memberId) {
  const result = await requestReprojection(memberId)
  return { ...result, trusted: result.ok }
}