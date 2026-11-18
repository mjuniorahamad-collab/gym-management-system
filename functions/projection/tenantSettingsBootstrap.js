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
 *   - Write a `receiptPrefix` that nobody approved. The prefix printed on
 *     receipts and persisted onto payment records is an owner decision: it is
 *     written only from an explicit `--prefix-approvals` record, never derived
 *     from a gym's name, never defaulted, and never changed when one is already
 *     declared on `gyms/{gymId}`.
 *   - Write a logo path/URL, a PT surcharge, or a WhatsApp link.
 *   - Write anything at all for a gym whose settings state, live member count
 *     or owner-of-record it cannot establish at write time. "I do not know" is
 *     treated as "no".
 *
 * NOT DEPLOYED
 *   `functions/build.mjs` bundles only `projection/engine.entry.js`, and nothing
 *   in `functions/` imports this file, so it is absent from the deployed bundle.
 *   It is operator tooling that happens to live where its dependency lives.
 */

import { isValidReceiptPrefix } from '../../src/utils/receiptPrefix.js'

/** Sub-path appended to a gym document id. Matches tenantSettings.js. */
export const SETTINGS_PATH_SUFFIX = '/settings/app'

/**
 * Second, deliberate acknowledgement required for any write.
 *
 * Kept in this module (not the CLI) so the guard is covered by the same unit
 * tests as the rest of the policy.
 */
export const CONFIRM_TOKEN = 'INIT-TENANT-SETTINGS'

/** Bounds mirror settingsSchema (schemas/validationSchemas.js). */
const NAME_MIN = 2
const NAME_MAX = 80

/**
 * Normalises a snapshot into the shape the pure planner expects.
 *
 * Accepts the read-only snapshot shape produced by
 * `scripts/snapshot-tenant-settings.mjs`:
 *   { gyms: [{ path, id, data: { name, tagline, ownerUid, receiptPrefix? },
 *              memberCount, settingsDoc }] }
 *
 * `memberCount` is optional per gym. Absence of `memberCount` is UNKNOWN and
 * blocks the write for that gym.
 *
 * TRI-STATE FOR `settingsDoc`: `null` means "read, absent", an object means
 * "read, present", and the KEY IS OMITTED ENTIRELY when the snapshot never
 * established it. Emitting the key with an undefined value would be a
 * bug: the planner distinguishes the three states with a hasOwnProperty check,
 * and a present-but-undefined key reads as "checked" and would silently
 * authorise a write that was never justified by evidence.
 */
export function normaliseSnapshot(raw) {
  const gyms = Array.isArray(raw?.gyms) ? raw.gyms : []
  if (!gyms.length) throw new Error('Snapshot contains no gyms; refusing to plan an empty set.')

  return gyms.map((entry) => {
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry || {}
    const memberCount = Number.isInteger(entry?.memberCount) ? entry.memberCount : null
    const settingsKnown = Object.prototype.hasOwnProperty.call(entry || {}, 'settingsDoc')

    const row = {
      id: typeof entry?.id === 'string' ? entry.id : '',
      name: typeof data.name === 'string' ? data.name : '',
      tagline: typeof data.tagline === 'string' ? data.tagline : '',
      memberCount,
      settingsKnown,
      declaredPrefix:
        typeof data.receiptPrefix === 'string' && data.receiptPrefix ? data.receiptPrefix : null,
    }
    if (settingsKnown) row.settingsDoc = entry.settingsDoc ?? null
    return row
  })
}

/**
 * Parses the `--prefix-approvals` file into the map `gateRows` and `applyPlan`
 * consult. Returns a reason string rather than throwing so the CLI can exit
 * with a clean message and the tests can assert on the wording.
 *
 * The file is the owner's decision record: a flat JSON object mapping a gym id
 * to the receipt prefix that gym's owner chose. Nothing here derives, defaults
 * or normalises a value — an entry is accepted only if it is already a valid
 * prefix, and a malformed entry rejects the whole file.
 *
 * @param {string} text file contents
 * @returns {{approvals: Record<string,string>|null, error: string|null}}
 */
export function parsePrefixApprovals(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { approvals: null, error: '--prefix-approvals file is empty; nothing was approved.' }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { approvals: null, error: `--prefix-approvals is not valid JSON: ${err?.message || err}` }
  }

  const source = parsed

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {
      approvals: null,
      error: '--prefix-approvals must be a JSON object mapping a gym id to a receipt prefix.',
    }
  }

  const approvals = {}
  for (const [gymId, value] of Object.entries(source)) {
    if (!isValidReceiptPrefix(value)) {
      return {
        approvals: null,
        error:
          `--prefix-approvals entry for "${gymId}" is not a valid receipt prefix: ` +
          `${JSON.stringify(value)}. Expected 1-8 letters or digits, exactly as chosen by the owner.`,
      }
    }
    approvals[gymId] = value
  }

  if (!Object.keys(approvals).length) {
    return { approvals: null, error: '--prefix-approvals approves nothing; nothing was approved.' }
  }

  return { approvals, error: null }
}

/**
 * Applies the safety gates the pure planner does not own.
 *
 * Every one of these defaults to "do not write". A row is writable only when
 * its classification is an explicit seed, its member count is a known positive
 * number, the snapshot positively established that settings/app is absent, and
 * an owner-approved receipt prefix exists for that exact gym.
 *
 * @param {object[]} rows
 * @param {Record<string,string>} [approvals] gym id -> owner-approved prefix
 */
export function gateRows(rows, approvals = {}) {
  const book = approvals && typeof approvals === 'object' ? approvals : {}
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

    const approved = isValidReceiptPrefix(book[row.id]) ? book[row.id] : null
    if (row.write && !approved) {
      gates.push('no approved receipt prefix for this gym in --prefix-approvals')
    } else if (row.write && row.declaredPrefix && row.declaredPrefix !== approved) {
      gates.push(
        `gyms/${row.id}.receiptPrefix is already ${row.declaredPrefix}, ` +
          `which does not match the approved prefix ${approved}`
      )
    }

    return { ...row, approvedPrefix: approved, blockedBy: gates, writable: gates.length === 0 && !!row.write }
  })
}

/**
 * Guards the write path. Returns a reason string instead of throwing so the CLI
 * can exit with a clean message and the tests can assert on the wording.
 *
 * @returns {string|null} the reason writes are refused, or null to proceed.
 */
export function guardWrite({ apply, project, confirm, approvals } = {}) {
  if (!apply) return null
  if (!project) return '--apply requires --project=<firebase-project-id>.'
  if (confirm !== CONFIRM_TOKEN) {
    return `--apply requires an explicit --confirm=${CONFIRM_TOKEN}. Nothing was written.`
  }
  if (!approvals || typeof approvals !== 'object' || !Object.keys(approvals).length) {
    return (
      '--apply requires --prefix-approvals=<file>, a JSON object mapping each gym id to the ' +
      `receipt prefix its owner chose. Nothing was written.`
    )
  }
  return null
}

/** Full document path for a gym's tenant settings. */
export function settingsPath(gymId) {
  return `gyms/${gymId}${SETTINGS_PATH_SUFFIX}`
}

/**
 * Fields the real `create()` call adds that are produced by Firestore rather
 * than chosen by this tool. They are deliberately absent from every recorded
 * `payload` (a `serverTimestamp()` sentinel is not serialisable and must never
 * be written to the manifest as an ordinary value); the rollback section names
 * them so an ownership check knows to allow them through instead of treating
 * them as an owner edit.
 */
export const SERVER_GENERATED_FIELDS = ['createdAt']

/**
 * The one place the effective settings payload is assembled.
 *
 * Apply, the CLI's dry-run display and the rollback manifest all call this, so
 * the fields written, shown and recorded can never drift apart. It is
 * deterministic: the same row and approved prefix always produce the same,
 * key-for-key payload.
 *
 * The approved prefix is attached here rather than invented. A caller that has
 * no valid owner-approved prefix must not call this at all: `write`/`apply`
 * already refuse such rows, and this function throws rather than defaulting to
 * a made-up value.
 *
 * @param {{write?: object|null}} row a gated plan row
 * @param {string} approved the owner-approved receipt prefix
 * @returns {object|null} the settings fields to create, or null if the row
 *          carries no payload
 */
export function buildEffectiveSettingsPayload(row, approved) {
  if (!row || typeof row !== 'object' || !row.write || typeof row.write !== 'object') {
    return null
  }
  if (!isValidReceiptPrefix(approved)) {
    throw new Error(
      'buildEffectiveSettingsPayload requires an owner-approved receipt prefix; ' +
        'refusing to invent one.'
    )
  }
  return { ...row.write, receiptPrefix: approved }
}

/**
 * The authoritative field writes this run INTENDS to make.
 *
 * `applyPlan` adds `gyms/{gymId}.receiptPrefix` only where the owner-of-record
 * declares none, so a writable row whose snapshot already declares the approved
 * prefix plans no authority write. This describes the PLAN and is deliberately
 * kept separate from `buildRollback(...).authority`, which lists only writes
 * that actually happened; a dry run therefore plans authority without recording
 * any as performed.
 *
 * Each entry names a single field to merge into an existing document. The
 * `gyms/{gymId}` document is never replaced: `documentReplaced: false` is
 * carried on every entry so a reviewer cannot mistake it for a whole-document
 * write.
 *
 * @param {object[]} rows gated plan rows
 * @returns {Array<{path: string, gymId: string, field: string, value: string,
 *          operation: string, documentReplaced: boolean}>}
 */
export function buildPlannedAuthority(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.writable && isValidReceiptPrefix(r.approvedPrefix) && !r.declaredPrefix)
    .map((r) => ({
      path: `gyms/${r.id}`,
      gymId: r.id,
      field: 'receiptPrefix',
      value: r.approvedPrefix,
      operation: 'add-field',
      documentReplaced: false,
    }))
}

/**
 * Renders the planned authority writes as terminal/manifest lines, so the same
 * text is produced whether it is printed during a dry run or recorded.
 *
 * @param {Array<{path: string, field: string, value: string}>} plannedAuthority
 * @returns {string[]} one `path.field = value` line per planned write, or a
 *          single explicit "none" line
 */
export function plannedAuthorityLines(plannedAuthority) {
  const list = Array.isArray(plannedAuthority) ? plannedAuthority : []
  if (!list.length) {
    return ['  (none — no gyms/{gymId}.receiptPrefix will be added)']
  }
  return list.map((w) => `  ${w.path}.${w.field} = ${w.value}`)
}

/**
 * Creates the missing tenant settings documents for the writable rows.
 *
 * `db` is any Firestore-compatible handle exposing `doc(path)` with `get()`,
 * `create()` and `set()`, which is the Admin SDK surface and trivially faked in
 * tests.
 *
 * Every row is revalidated against LIVE state immediately before writing. The
 * snapshot is only a planning aid: a gym may have gained members, lost its
 * identity, or already been configured by another operator since the snapshot
 * was taken.
 *
 * @param {object[]} rows        gated plan rows
 * @param {object}   deps
 * @param {object}   deps.db             Firestore handle (required for a write)
 * @param {Function} deps.serverTimestamp returns a server timestamp sentinel
 * @param {Function} deps.readGym        (gymId) => live owner-of-record snapshot,
 *                                        used to revalidate existence, identity,
 *                                        member count and the declared prefix
 * @param {object}   deps.approvals      gym id -> owner-approved receipt prefix
 * @param {Function} [deps.log]          progress reporter
 * @returns {Promise<{applied: object[], skipped: object[], failed: object[]}>}
 */
export async function applyPlan(
  rows,
  { db, serverTimestamp, readGym, approvals, log = () => {} } = {}
) {
  if (!db) {
    throw new Error('applyPlan requires a Firestore handle; refusing to write without one.')
  }
  if (typeof serverTimestamp !== 'function') {
    throw new Error('applyPlan requires a serverTimestamp() factory.')
  }
  if (typeof readGym !== 'function') {
    throw new Error('applyPlan requires a readGym(gymId) revalidation handle; refusing to write without one.')
  }
  if (!approvals || typeof approvals !== 'object') {
    throw new Error('applyPlan requires an approvals map; refusing to write without one.')
  }

  const applied = []
  const skipped = []
  const failed = []
  // Every `gyms/{gymId}.receiptPrefix` this run actually added, recorded at the
  // moment it is added. `applied[].prefixWritten` marks the same set but only
  // for rows that then COMPLETED, so a row whose settings create failed after
  // its prefix went down would be invisible to a rollback built from `applied`.
  const authorityWritten = []

  const skip = (path, reason) => {
    skipped.push({ path, reason })
    log(`SKIP  ${path} — ${reason}`)
  }

  for (const row of rows.filter((r) => r.writable)) {
    const path = settingsPath(row.id)
    // Declared BEFORE the try so a failure at any later point still reports
    // whether the authority write landed, instead of silently reporting false.
    let prefixWritten = false
    try {
      const live = await readGym(row.id)

      if (!live?.exists) {
        skip(path, 'gyms/{gymId} no longer exists')
        continue
      }
      const name = typeof live.name === 'string' ? live.name.trim() : ''
      if (name.length < NAME_MIN || name.length > NAME_MAX) {
        skip(path, 'owner-of-record has no usable identity')
        continue
      }
      if (!Number.isInteger(live.memberCount) || live.memberCount < 1) {
        skip(path, 'live member count is not a positive integer')
        continue
      }

      const approved = approvals[row.id]
      if (!isValidReceiptPrefix(approved)) {
        skip(path, 'no approved receipt prefix for this gym')
        continue
      }
      const declared =
        typeof live.receiptPrefix === 'string' && live.receiptPrefix ? live.receiptPrefix : null
      if (declared && declared !== approved) {
        skip(path, `declared prefix ${declared} does not match the approved prefix ${approved}`)
        continue
      }

      const ref = db.doc(path)

      // Re-check immediately before writing. The snapshot may be stale, and this
      // is the last point at which an overwrite can still be prevented.
      const current = await ref.get()
      if (current.exists) {
        skip(path, 'settings/app already exists; left untouched')
        continue
      }

      // The authoritative prefix goes down first, so a later failure leaves the
      // tenant with a declared prefix the client can self-heal from, rather than
      // a settings document whose prefix no owner record backs.
      if (!declared) {
        await db.doc(`gyms/${row.id}`).set({ receiptPrefix: approved }, { merge: true })
        prefixWritten = true
        authorityWritten.push({ path: `gyms/${row.id}`, gymId: row.id, prefix: approved })
      }

      const payload = buildEffectiveSettingsPayload(row, approved)
      // `create()` fails if the document now exists, so this cannot clobber even
      // under a race with another operator.
      await ref.create({ ...payload, createdAt: serverTimestamp() })
      applied.push({ path, payload, prefixWritten })
      log(`WROTE ${path}${prefixWritten ? ' (+ gyms receiptPrefix)' : ''}`)
    } catch (err) {
      // One failure must not abandon the rest, but it is recorded and reported
      // rather than swallowed. `prefixWritten` matters here: when it is true the
      // authority was written but the settings document was not, so the row
      // needs an UNDO rather than a delete.
      failed.push({ path, error: err?.message || String(err), prefixWritten })
      log(`FAIL  ${path} — ${err?.message || err}`)
    }
  }

  return { applied, skipped, failed, authorityWritten }
}

/**
 * Rollback description for the manifest.
 *
 * The settings documents this tool writes are CREATEs of documents that did
 * not exist, so rollback of those is delete-only. `gyms/{gymId}.receiptPrefix`
 * is the one field that is ever added to an existing document, and only when it
 * was absent — including on rows where the settings CREATE then failed, which
 * is why `authorityWritten` (not `applied`) is what tells rollback which gyms
 * to undo. Passing it in rather than keeping it inside `applyPlan` keeps this
 * function pure and makes the manifest's undo list reviewable before it is
 * written.
 *
 * `paths[].payload` is the effective settings payload from
 * `buildEffectiveSettingsPayload` — the same builder `applyPlan` uses — so it
 * names every field the CREATE actually wrote, including the approved
 * `receiptPrefix`. The one field it cannot contain is `createdAt`, which the
 * real write supplies through `serverTimestamp()`; `serverGeneratedFields`
 * records that so an ownership check compares the remaining fields and treats
 * any other unexpected field as a subsequent owner edit.
 *
 * @param {object[]} rows gated plan rows
 * @param {Array<{path: string, gymId: string, prefix: string}>} [authorityWritten]
 */
export function buildRollback(rows, authorityWritten = []) {
  const authority = (Array.isArray(authorityWritten) ? authorityWritten : []).map((w) => ({
    path: w?.path,
    prefix: w?.prefix,
  }))

  return {
    strategy: 'delete-created-documents-and-remove-added-prefix',
    serverGeneratedFields: [...SERVER_GENERATED_FIELDS],
    paths: rows
      .filter((r) => r.writable)
      .map((r) => ({
        path: settingsPath(r.id),
        payload: buildEffectiveSettingsPayload(r, r.approvedPrefix),
      })),
    authority,
    authorityNotes: authority.length
      ? authority.map(
          (w) =>
            `Remove ${w.path}.receiptPrefix only while it still equals "${w.prefix}"; ` +
            'an operator may have declared a different one since.'
        )
      : ['No gyms/{gymId}.receiptPrefix was written by this run.'],
    notes: [
      'Only documents that did not previously exist are ever written.',
      'No existing settings document is modified, so rollback cannot lose owner data.',
      '`payload` records the exact field values the CREATE wrote, including the approved `receiptPrefix`. The live document additionally carries the fields named in `serverGeneratedFields` (written by Firestore, not serialisable to the manifest); allow those through when comparing, and treat any field outside `payload` plus `serverGeneratedFields` as a subsequent owner edit.',
      '`authority` lists only the `gyms/{gymId}.receiptPrefix` writes that ACTUALLY happened (`applied[].prefixWritten` and `failed[].prefixWritten` mark the same set per row). The intended writes are reported separately as `plannedAuthority`, so a dry-run manifest records none here. Remove a written prefix only while it still equals the recorded value.',
    ],
    notTouched: [
      'settings/app (the shared legacy singleton) is left in place and remains unreadable by tenants.',
      'gyms/{gymId}/settings/pt and gyms/{gymId}/settings/whatsapp are never written.',
      'gyms/{gymId} documents are never deleted and are never replaced; only the receiptPrefix field is ever added (a merge), leaving every other field intact.',
    ],
  }
}