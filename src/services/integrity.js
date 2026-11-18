/**
 * DATA-INTEGRITY REPORT — the browser side of the nightly dues reconciliation.
 *
 * The report itself is an admin-only Firestore document, so the browser asks a
 * callable for it. Like the reprojection client, this NEVER throws: the card
 * that renders it should show "unavailable" rather than break the Settings page,
 * and a report is diagnostic information, not a money path.
 *
 * The gym is not sent. The callable derives it from the caller's `users/{uid}`
 * profile — a client-supplied gym id would be a claim of authority this app
 * deliberately does not grant.
 */
import { getFunctions, httpsCallable } from 'firebase/functions'
import { isFirebaseConfigured } from '@/firebase'

/**
 * @returns {Promise<{ok: boolean, report?: object|null, reason?: string}>}
 *   `report: null` means the nightly job has not run for this gym yet.
 */
export async function fetchDuesDriftReport() {
  // Demo/offline mode has no Cloud Functions at all.
  if (!isFirebaseConfigured) return { ok: false, reason: 'offline-mode' }

  try {
    const callable = httpsCallable(getFunctions(), 'getDuesDriftReport')
    const { data } = await callable()
    return { ok: true, report: data?.report ?? null }
  } catch (error) {
    return { ok: false, reason: error?.message || 'report unavailable' }
  }
}
