/**
 * Lazily-initialised Admin SDK handle.
 *
 * The trusted writer is the ONLY code in this project that writes member
 * projections through the Admin SDK, which is precisely why it needs a single,
 * auditable place where the app is initialised. Nothing else in `functions/`
 * should call `initializeApp`.
 *
 * Admin SDK writes bypass Firestore Security Rules. That is the point — clients
 * are forbidden from touching the projected fields, and this is the one writer
 * allowed to. It also means the rules hardening and this module are independent
 * concerns: neither can lock the other out.
 */
import admin from 'firebase-admin'

let cached = null

/**
 * @param {{ projectId?: string }} [options]
 *   `projectId` is supplied by the test harness. In production the project comes
 *   from the environment, exactly as the two existing scheduled jobs expect.
 */
export function firestore(options = {}) {
  if (cached) return cached
  if (!admin.apps.length) {
    const appOptions = options.projectId ? { projectId: options.projectId } : {}
    admin.initializeApp(appOptions)
  }
  cached = admin.firestore()
  return cached
}

/**
 * Cloud Storage handle, for the nightly backup job.
 *
 * Shares the app created above rather than initialising a second one, so the
 * project is configured in exactly one place.
 */
export function storage() {
  if (!admin.apps.length) admin.initializeApp()
  return admin.storage.getStorage()
}

/** Test-only: drop the memoised handle so a suite can start from a clean app. */
export function resetFirestoreForTests() {
  cached = null
}