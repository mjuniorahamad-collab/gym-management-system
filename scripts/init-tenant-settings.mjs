#!/usr/bin/env node
/**
 * Tenant settings initialiser — PLANNING TOOL. Not a migration runner.
 *
 * WHAT IT DOES
 *   Creates missing `gyms/{gymId}/settings/app` documents so a gym is never
 *   left relying on the shared `settings/app` singleton. Every value it writes is
 *   derived from that gym's own owner-of-record document, plus product defaults
 *   that every reader already assumes.
 *
 * WHAT IT WILL NEVER DO
 *   - Overwrite, merge into, or partially update an existing settings document.
 *   - Write a `receiptPrefix`. It appears on customer receipts AND on persisted
 *     payment records, so it is an owner decision, not a bootstrap default.
 *     Gyms it seeds are left visibly unconfigured until the owner sets it.
 *   - Write a logo path/URL, a PT surcharge, or a WhatsApp link.
 *   - Seed a gym with no members (see ACTIVITY GATE below).
 *   - Run on its own. There is no cron, no npm hook, and no CI step that calls it.
 *
 * USAGE
 *   # Plan only. Reads a local snapshot, touches no network, writes no data.
 *   npx vite-node scripts/init-tenant-settings.mjs --snapshot=path/to/snapshot.json
 *
 *   # Apply, against a live project. Requires BOTH flags and a second operator.
 *   npx vite-node scripts/init-tenant-settings.mjs \
 *     --snapshot=path/to/snapshot.json \
 *     --project=<firebase-project-id> \
 *     --apply --confirm=INIT-TENANT-SETTINGS
 *
 * WHY `vite-node` AND NOT `node`
 *   The policy is imported from src/ and resolves the `@/` alias configured in
 *   vite.config.js. vite-node is already present as a vitest dependency, so this
 *   adds no dependency. Running under plain `node` fails closed with a message
 *   rather than silently diverging from the app's copy of the policy.
 *
 * WHY THE POLICY IS IMPORTED RATHER THAN REIMPLEMENTED
 *   The app bootstraps settings on an owner's first sign-in using
 *   src/services/tenantSettings.js. This script calls the SAME module, so the
 *   offline plan and the in-app behaviour cannot drift apart.
 *
 * ACTIVITY GATE
 *   A `gyms/{gymId}` document with no members is, on the Phase 4C evidence, most
 *   likely an abandoned self-provisioning attempt or an onboarding duplicate. The
 *   script refuses to seed those, and refuses any gym whose member count it
 *   cannot establish from the snapshot. "I do not know" is treated as "no".
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'

const CONFIRM_TOKEN = 'INIT-TENANT-SETTINGS'
const SETTINGS_PATH_SUFFIX = '/settings/app'

let policy
try {
  policy = await import('@/services/tenantSettings')
} catch (err) {
  console.error(
    'Could not load the tenant-settings policy.\n' +
      'Run this script through vite-node so the "@/" alias resolves:\n' +
      '  npx vite-node scripts/init-tenant-settings.mjs --snapshot=<file>\n' +
      `Underlying error: ${err?.message || err}`
  )
  process.exit(2)
}

const { classifyGymsForBootstrap } = policy

function parseArgs(argv) {
  const args = { gym: '', manifest: '' }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    switch (key) {
      case 'snapshot':
        args.snapshot = value
        break
      case 'project':
        args.project = value
        break
      case 'gym':
        args.gym = value
        break
      case 'manifest':
        args.manifest = value
        break
      case 'apply':
        args.apply = true
        break
      case 'confirm':
        args.confirm = value
        break
      case 'help':
        args.help = true
        break
      default:
        throw new Error(`Unknown option --${key}`)
    }
  }
  return args
}

/**
 * Normalises a snapshot into the shape the pure planner expects.
 *
 * Accepts the Phase 4B read-only snapshot shape:
 *   { gyms: [{ path, id, data: { name, tagline, ownerUid } }] }
 *
 * `memberCount` and `settingsDoc` are optional per gym. Absence of
 * `memberCount` is treated as UNKNOWN and blocks the write for that gym.
 * `settingsDoc: null` must be stated explicitly to mean "read, absent"; an
 * omitted key means "not checked", which also blocks the write.
 */
function normaliseSnapshot(raw) {
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

/** Applies the script-level safety gates the pure planner does not own. */
function gateRows(rows) {
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

function printPlan(rows, mode) {
  const label = mode === 'apply' ? 'APPLY' : 'DRY RUN'
  console.log(`\n=== tenant settings initialiser — ${label} ===\n`)

  for (const row of rows) {
    const target = `gyms/${row.id}${SETTINGS_PATH_SUFFIX}`
    console.log(`${row.writable ? 'WRITE ' : 'SKIP  '} ${target}`)
    console.log(`        classification : ${row.classification}`)
    console.log(`        gym            : ${row.name || '(no usable name)'}`)
    console.log(`        members        : ${row.memberCount ?? 'unknown'}`)
    console.log(`        shares a name  : ${row.sharesDisplayName ? 'yes (tenancy is by id, so this is informational)' : 'no'}`)
    if (row.write) {
      console.log(`        payload        : ${JSON.stringify(row.write)}`)
    }
    console.log(`        still unset    : ${row.deferred.join(', ') || '(nothing)'}`)
    for (const gate of row.blockedBy) console.log(`        BLOCKED        : ${gate}`)
    console.log(`        why            : ${row.reason}\n`)
  }

  const writes = rows.filter((r) => r.writable)
  const skipped = rows.filter((r) => !r.writable)
  console.log(`--- ${writes.length} to write, ${skipped.length} to skip`)

  if (writes.length) {
    console.log(
      '\nreceiptPrefix is intentionally absent from every payload above. Each seeded gym\n' +
        'stays flagged as needing configuration until its owner sets one in Settings.\n'
    )
  }
  if (mode !== 'apply') {
    console.log('\nNo data was written. Re-run with --apply --confirm=' + CONFIRM_TOKEN + ' to write.')
  }
  return writes
}

/**
 * Applies the plan. Imported lazily so a planning-only run needs no Firebase
 * credentials and no admin SDK.
 */
async function applyPlan(rows, projectId) {
  let admin
  try {
    admin = await import('firebase-admin/firestore')
  } catch {
    throw new Error(
      'The apply path needs the Firebase Admin SDK, which is not installed.\n' +
        'Review the dry-run plan first, then install it deliberately:\n' +
        '  npm i -D firebase-admin\n' +
        'and re-run. Do not install it as part of an unreviewed change.'
    )
  }

  const { getFirestore } = admin
  const db = getFirestore(projectId)
  const applied = []

  for (const row of rows.filter((r) => r.writable)) {
    const ref = db.doc(`gyms/${row.id}${SETTINGS_PATH_SUFFIX}`)

    // Re-check immediately before writing. The snapshot may be stale, and this
    // is the last point at which an overwrite can still be prevented.
    const current = await ref.get()
    if (current.exists) {
      console.log(`SKIP  gyms/${row.id}${SETTINGS_PATH_SUFFIX} — appeared since the snapshot`)
      continue
    }

    // `create()` fails if the document now exists, so this cannot clobber even
    // under a race.
    await ref.create({ ...row.write, createdAt: admin.FieldValue.serverTimestamp() })
    applied.push({ path: `gyms/${row.id}${SETTINGS_PATH_SUFFIX}`, payload: row.write })
    console.log(`WROTE gyms/${row.id}${SETTINGS_PATH_SUFFIX}`)
  }

  return applied
}

function usage() {
  console.log(
    [
      'tenant settings initialiser',
      '',
      '  --snapshot=<file>   read-only gym snapshot to plan from (required)',
      '  --project=<id>      Firebase project id; required with --apply',
      '  --gym=<id>          restrict to one gym',
      '  --manifest=<file>   write the plan/result manifest as JSON',
      '  --apply             perform writes (otherwise dry run)',
      `  --confirm=${CONFIRM_TOKEN}`,
      '                     second, deliberate acknowledgement for --apply',
      '  --help',
    ].join('\n')
  )
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    usage()
    process.exit(2)
  }

  if (args.help || !args.snapshot) {
    usage()
    process.exit(args.help ? 0 : 2)
  }

  const snapshotRaw = readFileSync(args.snapshot)
  const snapshotSha = createHash('sha256').update(snapshotRaw).digest('hex')
  const snapshot = JSON.parse(snapshotRaw.toString('utf8'))

  let rows = classifyGymsForBootstrap(normaliseSnapshot(snapshot))
  if (args.gym) rows = rows.filter((r) => r.id === args.gym)
  if (!rows.length) {
    console.error('No gyms matched. Nothing to do.')
    process.exit(2)
  }

  rows = gateRows(rows)

  const mode = args.apply ? 'apply' : 'dry-run'
  if (args.apply) {
    if (!args.project) {
      console.error('--apply requires --project=<firebase-project-id>.')
      process.exit(2)
    }
    if (args.confirm !== CONFIRM_TOKEN) {
      console.error(
        `--apply requires an explicit --confirm=${CONFIRM_TOKEN}. Nothing was written.`
      )
      process.exit(2)
    }
  }

  printPlan(rows, mode)

  const manifest = {
    tool: 'init-tenant-settings',
    generatedAt: new Date().toISOString(),
    mode,
    project: args.project || null,
    snapshotPath: args.snapshot,
    snapshotSha256: snapshotSha,
    // Everything this tool writes is a CREATE of a document that did not exist.
    // Rollback is therefore: delete the listed paths, after confirming no gym
    // owner has since edited them. Comparing the live document against `payload`
    // field-by-field tells you whether an edit happened; `createdAt` is a
    // serverTimestamp, so the manifest records the intended payload only.
    rollback: {
      strategy: 'delete-only',
      paths: rows
        .filter((r) => r.writable)
        .map((r) => ({ path: `gyms/${r.id}${SETTINGS_PATH_SUFFIX}`, payload: r.write })),
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
    },
    rows,
  }

  let applied = []
  if (args.apply) {
    applied = await applyPlan(rows, args.project)
    manifest.applied = applied
  }

  if (args.manifest) {
    writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`\nManifest written to ${args.manifest}`)
  }

  if (args.apply) {
    console.log(`\nApplied ${applied.length} document(s).`)
    console.log('Each seeded gym now needs its owner to set a receipt prefix in Settings.')
  }
}

main().catch((err) => {
  console.error(`\nAborted: ${err?.message || err}`)
  process.exit(1)
})