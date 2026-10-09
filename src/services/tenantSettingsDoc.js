import { doc, runTransaction, updateDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { assertValidReceiptPrefix } from '@/utils/receiptPrefix'
import { TENANT_SETTINGS_DOC, buildTenantSettingsSeed } from './tenantSettings'

/**
 * Settings are tenant-scoped at `gyms/{gymId}/settings/app`.
 *
 * The former global `settings/app` singleton was readable and writable by ANY
 * signed-in user regardless of gym, which meant one tenant's branding,
 * currency and receipt prefix were visible to — and overwritable by — every
 * other tenant. That path is deliberately NOT used as a fallback anywhere: a
 * silent fallback would keep exposing the insecure singleton whenever the
 * scoped document is missing or unreadable, which is exactly the failure the
 * scoped document exists to remove. A missing or denied settings document is
 * surfaced as a loud, explicit error instead.
 */
export function settingsRef(gymId) {
  return doc(db, 'gyms', gymId, 'settings', TENANT_SETTINGS_DOC)
}

/**
 * The fields `updateSettings` is allowed to write.
 *
 * `receiptPrefix` is dropped here, in one place, so no caller can forget it:
 * it is an immutable property of the `gyms/{gymId}` owner-of-record and only
 * the create-only `provisionTenantSettings` or the controlled CLI migration
 * may ever write it.
 */
export function settingsUpdatePayload(data) {
  const { receiptPrefix: _ignoredPrefix, ...writable } = data || {}
  return writable
}

/**
 * UPDATE ONLY. The single client-side way an EXISTING settings document is
 * modified.
 *
 * Deliberately `updateDoc` and not `setDoc`: `updateDoc` fails with NOT_FOUND
 * when the document is absent, so a save can never become the silent create
 * that the create-only provisioning path exists to guard. The scoped document
 * must carry the owning gymId, which the security rules reject a write without.
 */
export async function persistSettingsUpdate({ gymId, data }) {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Firebase is not configured')
  }
  if (typeof gymId !== 'string' || !gymId) {
    throw new Error('No gym is assigned to this account, so settings cannot be saved.')
  }
  await updateDoc(settingsRef(gymId), { ...settingsUpdatePayload(data), gymId })
}

/**
 * CREATE ONLY. The single client-side way a `settings/app` document comes into
 * existence.
 *
 * `updateSettings` never creates, and nothing here ever updates: an existing
 * document makes this throw instead of being overwritten. The prefix is a
 * required argument with no default and must be the value declared on the
 * immutable `gyms/{gymId}` owner-of-record document — never an invented one,
 * and never one read from the shared global singleton.
 *
 * The existence check and the create run inside ONE transaction. A plain
 * read-then-`setDoc` had a window in which a second writer — another tab, the
 * CLI bootstrap — could create the document between the two steps, after which
 * this client would overwrite it. The transaction re-reads inside the write
 * conflict window, so whichever writer loses the race loses it by refusing
 * rather than by clobbering.
 *
 * There is no fallback write. Every branch either creates a document that was
 * proven absent, or throws.
 */
export async function provisionTenantSettings({ gymId, gym = null, receiptPrefix }) {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Firebase is not configured')
  }
  if (typeof gymId !== 'string' || !gymId) {
    throw new Error('No gym is assigned to this account, so settings cannot be provisioned.')
  }
  assertValidReceiptPrefix(receiptPrefix, 'provisionTenantSettings')

  const seed = buildTenantSettingsSeed({ gymId, gym, existing: null })
  if (!seed.write) throw new Error(seed.reason)

  const ref = settingsRef(gymId)
  const payload = { ...seed.write, receiptPrefix }

  await runTransaction(db, async (tx) => {
    // Read the owner-of-record first. It was already proven readable by
    // buildTenantSettingsSeed a moment ago, and Firestore requires a
    // transaction to have completed at least one read before it may write —
    // the settings read below may not produce one (see the catch), so this one
    // is not optional.
    await tx.get(doc(db, 'gyms', gymId))

    // firestore.rules gates the settings read on `resource != null`, so a
    // MISSING document is reported as permission-denied rather than as a
    // non-existent one. For the owner-of-record that denial is only reachable
    // when the document is absent; any other failure must not be mistaken for
    // permission to write.
    let snap = null
    try {
      snap = await tx.get(ref)
    } catch (err) {
      if (err?.code !== 'permission-denied') throw err
    }
    if (snap?.exists()) {
      const err = new Error(
        `A settings document already exists for gyms/${gymId}/settings/${TENANT_SETTINGS_DOC}; it must not be re-provisioned.`
      )
      err.code = 'settings-exists'
      throw err
    }

    tx.set(ref, payload)
  })

  return payload
}
