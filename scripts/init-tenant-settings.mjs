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
 * WHERE THE WRITE PATH LIVES
 *   Planning and apply logic is in `functions/projection/tenantSettingsBootstrap.js`,
 *   because the root package has no `firebase-admin` dependency and must not gain
 *   one. That module takes an injected Firestore handle, imports no Admin code,
 *   and is unit tested in plain Node. This file is the thin CLI around it.
 *
 *   The `--apply` path reaches the Admin SDK through
 *   `functions/projection/admin.js`, the single place in this repository that
 *   calls `initializeApp`, so there is exactly one Admin app and one dependency.
 *   `functions/build.mjs` bundles only `projection/engine.entry.js`, and nothing
 *   in `functions/` imports the bootstrap module, so it is NOT deployed.
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
import {
  CONFIRM_TOKEN,
  buildRollback,
  gateRows,
  guardWrite,
  normaliseSnapshot,
  settingsPath,
} from '../functions/projection/tenantSettingsBootstrap.js'

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

function printPlan(rows, mode) {
  const label = mode === 'apply' ? 'APPLY' : 'DRY RUN'
  console.log(`\n=== tenant settings initialiser — ${label} ===\n`)

  for (const row of rows) {
    const target = settingsPath(row.id)
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
 * Applies the plan through the Admin SDK that `functions/` already owns.
 *
 * Both imports are lazy: a planning-only run must need no credentials and must
 * never initialise the app. The Firestore handle comes from
 * `functions/projection/admin.js`, the single place in this repository allowed
 * to call `initializeApp`, so this adds no dependency at the root and creates no
 * second Admin app.
 */
async function applyPlan(rows, projectId) {
  let bootstrap
  let adminBridge
  try {
    bootstrap = await import('../functions/projection/tenantSettingsBootstrap.js')
    adminBridge = await import('../functions/projection/admin.js')
  } catch (err) {
    throw new Error(
      'Could not reach the Admin SDK owned by functions/.\n' +
        'It is expected at functions/projection/admin.js; the root package has no\n' +
        'firebase-admin dependency and must not gain one. Check that functions/ is\n' +
        'present and its dependencies are installed (npm --prefix functions ci).\n' +
        `Underlying error: ${err?.message || err}`
    )
  }

  const db = adminBridge.firestore({ projectId })
  return bootstrap.applyPlan(rows, {
    db,
    serverTimestamp: adminBridge.serverTimestamp,
    log: (line) => console.log(line),
  })
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
  const refusal = guardWrite({ apply: args.apply, project: args.project, confirm: args.confirm })
  if (refusal) {
    console.error(refusal)
    process.exit(2)
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
    rollback: buildRollback(rows),
    rows,
  }

  let applied = []
  if (args.apply) {
    const result = await applyPlan(rows, args.project)
    applied = result.applied
    manifest.applied = applied
    manifest.skipped = result.skipped
    manifest.failed = result.failed
  }

  if (args.manifest) {
    writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`\nManifest written to ${args.manifest}`)
  }

  if (args.apply) {
    console.log(`\nApplied ${applied.length} document(s).`)
    if (manifest.failed?.length) {
      // Non-zero exit so a wrapper script or an operator notices a partial run
      // rather than reading exit 0 as "the apply finished".
      console.error(`${manifest.failed.length} document(s) FAILED. Review them before retrying.`)
      console.error('Each seeded gym now needs its owner to set a receipt prefix in Settings.')
      process.exit(1)
    }
    console.log('Each seeded gym now needs its owner to set a receipt prefix in Settings.')
  }
}

main().catch((err) => {
  console.error(`\nAborted: ${err?.message || err}`)
  process.exit(1)
})