import { doc, getDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { getGymId } from './ownerContext'
import {
  assertValidReceiptPrefix,
  classifyPrefixConsistency,
  isValidReceiptPrefix,
} from '@/utils/receiptPrefix'

/**
 * Layer 2 of the receipt-prefix policy.
 *
 * `gyms/{gymId}.receiptPrefix` is the only authoritative value: it is written
 * once, at onboarding or by the controlled tenant-settings bootstrap, and the
 * client can never change it (`firestore.rules` locks gyms to `update, delete:
 * if false`). `settings/app.receiptPrefix` is a derived mirror, so a caller
 * handing that mirror in is not evidence that it still agrees with the owner of
 * record.
 *
 * This module re-reads the authoritative document at the point where money is
 * about to move and refuses the operation when the two disagree, when the
 * authoritative value is absent, or when it is malformed. It fails closed: an
 * unreadable gyms document is an error, never a reason to fall back to a
 * default prefix.
 *
 * Reads are cached per bound gym for the life of the session — the value is
 * immutable by design — and only successful reads are cached, so a transient
 * failure is retried rather than poisoning the rest of the session.
 */
export class TenantReceiptPrefixError extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'TenantReceiptPrefixError'
    this.code = reason
  }
}

const EMPTY = { gymId: null, prefix: null }

let cached = EMPTY
let inflight = null

/** Test-only: forget the cached authoritative prefix. */
export function __resetTenantReceiptPrefixCache() {
  cached = EMPTY
  inflight = null
}

/**
 * Does a settings document exist for this gym?
 *
 * Used ONLY to tell "no authority, no settings" (unprovisioned) apart from "no
 * authority, settings present" (state D, an inconsistency). Absence is reported
 * through the same `resource != null` read gate as everything else, so a
 * permission-denied here means the document is not there and is treated as
 * such; a denial is never taken as evidence that a document exists.
 */
async function settingsMirrorExists(gymId) {
  try {
    const snap = await getDoc(doc(db, 'gyms', gymId, 'settings', 'app'))
    return Boolean(snap?.exists?.())
  } catch {
    return false
  }
}

async function readAuthoritativePrefix(gymId) {
  let snap = null
  try {
    snap = await getDoc(doc(db, 'gyms', gymId))
  } catch {
    throw new TenantReceiptPrefixError(
      'unreadable',
      `This gym's receipt prefix could not be read from gyms/${gymId}, so receipts are refused rather than issued under a default.`
    )
  }
  if (!snap?.exists?.()) {
    throw new TenantReceiptPrefixError(
      'missing',
      `gyms/${gymId} carries no receipt prefix, so no receipt can be issued. Onboarding writes it, and the tenant-settings bootstrap writes it for pre-existing gyms.`
    )
  }
  const prefix = snap.data()?.receiptPrefix
  if (!isValidReceiptPrefix(prefix)) {
    // Distinguish "unprovisioned" (no authority, no settings — just not set up
    // yet) from state D (a settings document exists while the authority does
    // not). Only an unusable authority can be confused with a mirror, so the
    // mirror is consulted here and nowhere else, and only on the failure path:
    // the happy path still costs exactly one read.
    const mirrorPresent = await settingsMirrorExists(gymId)
    if (mirrorPresent) {
      throw new TenantReceiptPrefixError(
        'inconsistent',
        classifyPrefixConsistency({
          gymId,
          authority: prefix,
          mirror: null,
          settingsExists: true,
        }).message
      )
    }
    throw new TenantReceiptPrefixError(
      'invalid',
      `gyms/${gymId}.receiptPrefix is absent or malformed, so receipts are refused.`
    )
  }
  return prefix
}

/**
 * The authoritative receipt prefix for the gym bound to this session, or `null`
 * when there is no tenant authority to consult (Firebase not configured, or no
 * gym bound yet). Never returns a made-up value: absence of tenancy means "not
 * applicable", not "invent one".
 */
export async function resolveTenantReceiptPrefix() {
  if (!isFirebaseConfigured || !db) return null
  const gymId = getGymId()
  if (!gymId) return null
  if (cached.gymId === gymId) return cached.prefix

  if (!inflight || inflight.gymId !== gymId) {
    inflight = { gymId, promise: readAuthoritativePrefix(gymId) }
  }
  try {
    const prefix = await inflight.promise
    cached = { gymId, prefix }
    return prefix
  } catch (err) {
    if (inflight?.gymId === gymId) inflight = null
    throw err
  }
}

/**
 * Validate a caller-supplied receipt prefix and return the prefix the receipt
 * must actually be issued under.
 *
 * Every layer that can start a payment — the UI call site that holds the
 * settings mirror, and the service entry that writes — runs this, so a direct
 * service call bypassing the UI is guarded just as tightly as the UI itself.
 *
 * Behaviour by situation:
 *
 * - No tenant authority (demo mode, or Firebase configured but no gym bound
 *   yet): the supplied value is validated against the canonical policy and
 *   returned unchanged. Nothing can be cross-checked, and refusing here would
 *   break the offline demo path that has no tenant to disagree with.
 * - Tenant authority present: the authoritative document is read and any
 *   supplied value must equal it exactly. A drifted mirror, a stale caller or a
 *   hand-rolled prefix all fail loudly before a single write happens.
 */
export async function requireReceiptPrefix(supplied, where = '') {
  const given = supplied === undefined ? null : supplied
  if (given !== null) assertValidReceiptPrefix(given, where)

  const authoritative = await resolveTenantReceiptPrefix()
  if (authoritative === null) return given === null ? undefined : given

  if (given !== null && given !== authoritative) {
    throw new TenantReceiptPrefixError(
      'mismatch',
      `${where || 'requireReceiptPrefix'}: receipt prefix "${given}" does not match this gym's authoritative prefix "${authoritative}" on gyms/${getGymId()}.`
    )
  }
  return authoritative
}
