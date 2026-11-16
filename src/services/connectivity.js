import { isFirebaseConfigured } from '@/firebase'

/**
 * OFFLINE MONEY WRITES — refuse them loudly instead of failing later.
 *
 * The Firestore web SDK queues writes while the device is offline and flushes
 * them on reconnect. For ordinary edits that is a feature. For MONEY it is a
 * trap: the desk sees a spinner, the tab is closed or the device sleeps, and the
 * payment either never lands or lands hours later against a ledger that has
 * moved on. Neither is recoverable by the operator without a reconciliation.
 *
 * So every money path calls `assertOnline` before it resolves a receipt prefix,
 * mints a number or stages a transaction, and the UI disables the same actions
 * (`useOnline`, `OfflineActionsNotice`) so the refusal is visible before anyone
 * fills in a form.
 *
 * Limits worth knowing: `navigator.onLine === false` is authoritative about the
 * device having no link, but `true` only means "a link exists" — a captive
 * portal still reports online, and a write that fails mid-flight is caught by
 * the transaction, not here. This guard closes the queued-write hole, not every
 * network failure.
 *
 * Scope: only when Firebase is actually configured. Demo/offline mode is a local
 * in-memory store that is *supposed* to work with no network.
 */
export class OfflineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OfflineError'
    this.code = 'offline'
  }
}

/** True only when a real backend is configured AND the browser reports offline. */
export function isOffline() {
  if (!isFirebaseConfigured) return false
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return false
  return navigator.onLine === false
}

/**
 * Throw `OfflineError` when the device cannot reach the backend.
 *
 * `action` is the operator-facing verb phrase, e.g. "Recording a payment".
 */
export function assertOnline(action = 'This action') {
  if (!isOffline()) return
  throw new OfflineError(
    `${action} needs an internet connection. Nothing was saved — reconnect and try again.`
  )
}

/**
 * Recognise the refusal wherever it surfaces.
 *
 * A page rendered in its own chunk can hold a different copy of this module, so
 * `instanceof` alone is not reliable in the UI; the stable `code` is.
 */
export function isOfflineError(error) {
  if (!error) return false
  return error instanceof OfflineError || error.code === 'offline' || error.name === 'OfflineError'
}
