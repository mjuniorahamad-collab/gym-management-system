/**
 * Tenant settings bootstrap — reusable planning and apply logic.
 *
 * WHY THIS IS NOT IN `scripts/`
 *   `scripts/init-tenant-settings.mjs` cannot call the Admin SDK: the root
 *   package deliberately does not depend on `firebase-admin`, because the only
 *   trusted writer already owns it under `functions/`. Rather than add a second
 *   copy at the root, the write path lives HERE, next to `admin.js`, and is
 *   reached by importing that module. One `initializeApp`, one dependency, one
 *   place where the Admin SDK is touched.
 *
 *   This module imports NOTHING from the Admin SDK itself. The Firestore handle
 *   and the timestamp sentinel are injected, which is what makes the logic
 *   testable in plain Node with no credentials and no emulator.
 *
 * WHAT IT WILL NEVER DO
 *   - Overwrite, merge into, or partially update an existing settings document.
 *     Writes go through `create()`, which fails rather than clobbering.
 *   - Write a `receiptPrefix`. It is printed on receipts AND persisted onto
 *     payment records, so it is an owner decision, not a bootstrap default.
 *   - Write a logo path/URL, a PT surcharge, or a WhatsApp link.
 *   - Write anything at all for a gym whose settings state or member count it
 *     cannot establish. "I do not know" is treated as "no".
 *
 * NOT DEPLOYED
 *   `functions/build.mjs` bundles only `projection/engine.entry.js`, and nothing
 *   in `functions/` imports this file, so it is absent from the deployed bundle.
 *   It is operator tooling that happens to live where its dependency lives.
 */

/** Sub-path appended to a gym document id. Matches tenantSettings.js. */
export const SETTINGS_PATH_SUFFIX = '/settings/app'

/**
 * Second, deliberate acknowledgement required for any write.
 *
 * Kept in this module (not the CLI) so the guard is covered by the same unit
 * tests as the rest of the policy.
 */
export const CONFIRM_TOKEN = 'INIT-TENANT-SETTINGS'

/**
 * Normalises a snapshot into the shape the pure planner expects.
 *
 * Accepts the Phase 4B read-only snapshot shape:
 *   { gyms: [{ path, id, data: { name, tagline, ownerUid } }] }
 *
 * `memberCount` and `settingsDoc` are optional per gym. Absence of
 * `memberCount` is UNKNOWN and blocks the write for that gym.
 * `settingsDoc: null` must be stated explicitly to mean "read, absent"; an
 * omitted key means "not checked", which also blocks the write.
 */
export function normaliseSnapshot(raw) {
  const gyms = Array.isArray(raw?.gyms) ? raw.gyms : []
  if (!gyms.length) throw new Error('Snapshot contains no gyms; refusing to plan an empty set.')

  return gyms.map((entry) => {
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry || {}
    const memberCount = Number.isInteger(entry?.memberCount) ? entry.memberCount : null
    const settingsKnown = Object.prototype.hasOwnProperty.call(entry || {}, 'settingsDoc')

    return {
      id: typeof entry?.id === 'string' ? entry.id : '',
      name: typeof data.name === 'string' ? data.name : '',
      tagline: typeof data.tagline === 'string' ? data.tagline : '',
      memberCount,
      settingsDoc: settingsKnown ? entry.settingsDoc ?? null : undefined,
      settingsKnown,
    }
  })
}

/**
 * Applies the safety gates the pure planner does not own.
 *
 * Every one of these defaults to "do not write". A row is writable only when its
 * classification is an explicit seed, its member count is a known positive
 * number, and the snapshot positively established that settings/app is absent.
 */
export function gateRows(rows) {
  return rows.map((row) => {
    const gates = []
    if (row.classification === 'refused-no-activity') {
      gates.push('no members: presumed abandoned onboarding attempt or duplicate')
    }
    if (row.memberCount === null) {
      gates.push('member count unknown in snapshot')
    }
    if (row.settingsChecked !== true) {
      gates.push('existence of settings/app was not established in the snapshot')
    }
    return { ...row, blockedBy: gates, writable: gates.length === 0 && !!row.write }
  })
}

/**
 * Guards the write path. Returns a reason string instead of throwing so the CLI
 * can exit with a clean message and the tests can assert on the wording.
 *
 * @returns {string|null} the reason writes are refused, or null to proceed.
 */
export function guardWrite({ apply, project, confirm } = {}) {
  if (!apply) return null
  if (!project) return '--apply requires --project=<firebase-project-id>.'
  if (confirm !== CONFIRM_TOKEN) {
    return `--apply requires an explicit --confirm=${CONFIRM_TOKEN}. Nothing was written.`
  }
  return null
}

/** Full document path for a gym's tenant settings. */
export function settingsPath(gymId) {
  return `gyms/${gymId}${SETTINGS_PATH_SUFFIX}`
}

/**
 * Creates the missing tenant settings documents for the writable rows.
 *
 * `db` is any Firestore-compatible handle exposing `doc(path)` with `get()` and
 * `create()`, which is the Admin SDK surface and trivially faked in tests.
 *
 * @param {object[]} rows        gated plan rows
 * @param {object}   deps
 * @param {object}   deps.db           Firestore handle (required for a write)
 * @param {Function} deps.serverTimestamp  returns a server timestamp sentinel
 * @param {Function} [deps.log]        progress reporter
 * @returns {Promise<{applied: object[], skipped: object[], failed: object[]}>}
 */
export async function applyPlan(rows, { db, serverTimestamp, log = () => {} } = {}) {
  if (!db) {
    throw new Error('applyPlan requires a Firestore handle; refusing to write without one.')
  }
  if (typeof serverTimestamp !== 'function') {
    throw new Error('applyPlan requires a serverTimestamp() factory.')
  }

  const applied = []
  const skipped = []
  const failed = []

  for (const row of rows.filter((r) => r.writable)) {
    const path = settingsPath(row.id)
    try {
      const ref = db.doc(path)

      // Re-check immediately before writing. The snapshot may be stale, and this
      // is the last point at which an overwrite can still be prevented.
      const current = await ref.get()
      if (current.exists) {
        skipped.push({ path, reason: 'settings/app already exists; left untouched' })
        log(`SKIP  ${path} — already exists`)
        continue
      }

      // `create()` fails if the document now exists, so this cannot clobber even
      // under a race with another operator.
      await ref.create({ ...row.write, createdAt: serverTimestamp() })
      applied.push({ path, payload: row.write })
      log(`WROTE ${path}`)
    } catch (err) {
      // One failure must not abandon the rest, but it is recorded and reported
      // rather than swallowed.
      failed.push({ path, error: err?.message || String(err) })
      log(`FAIL  ${path} — ${err?.message || err}`)
    }
  }

  return { applied, skipped, failed }
}

/**
 * Rollback description for the manifest.
 *
 * Everything this tool writes is a CREATE of a document that did not exist, so
 * rollback is delete-only and cannot lose owner data. The caller still has to
 * confirm no owner edited a document since.
 */
export function buildRollback(rows) {
  return {
    strategy: 'delete-only',
    paths: rows
      .filter((r) => r.writable)
      .map((r) => ({ path: settingsPath(r.id), payload: r.write })),
    notes: [
      'Only documents that did not previously exist are ever written.',
      'No existing document is modified, so rollback cannot lose owner data.',
      'Verify a document still matches `payload` before deleting it; an owner may have edited it since.',
    ],
    notTouched: [
      'settings/app (the shared legacy singleton) is left in place and remains unreadable by tenants.',
      'gyms/{gymId}/settings/pt and gyms/{gymId}/settings/whatsapp are never written.',
      'gyms/{gymId} documents themselves are never modified or deleted.',
    ],
  }
}