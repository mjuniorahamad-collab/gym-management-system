#!/usr/bin/env node
/**
 * Tenant settings initialiser — PLANNING TOOL, with an explicit apply mode.
 *
 * WHAT IT DOES
 *   Creates missing `gyms/{gymId}/settings/app` documents so a gym is never
 *   left relying on the shared `settings/app` singleton. Every non-prefix value
 *   it writes is derived from that gym's own owner-of-record document, plus
 *   product defaults that every reader already assumes.
 *
 *   The `receiptPrefix` is the exception: it is printed on receipts AND
 *   persisted onto payment records, so it is an owner decision. It is taken
 *   verbatim from `--prefix-approvals` — a JSON file mapping a gym id to the
 *   prefix that gym's owner chose — and is written to `gyms/{gymId}` only when
 *   that document declares none. Nothing here derives, defaults or normalises a
 *   prefix, and a gym whose declared prefix disagrees with the approval is
 *   skipped rather than reconciled.
 *
 * WHAT IT WILL NEVER DO
 *   - Overwrite, merge into, or partially update an existing settings document.
 *   - Write a prefix that no approval record names, or change one that is
 *     already declared.
 *   - Write a logo path/URL, a PT surcharge, or a WhatsApp link.
 *   - Seed a gym with no members (see ACTIVITY GATE below).
 *   - Run on its own. There is no cron, no npm hook, and no CI step that calls it.
 *
 * USAGE
 *   # Plan only. Reads a local snapshot, touches no network, writes no data.
 *   npx vite-node scripts/init-tenant-settings.mjs \
 *     --snapshot=path/to/snapshot.json \
 *     --prefix-approvals=path/to/approvals.json
 *
 *   # Apply, against a live project. Requires BOTH flags, the approval file,
 *   # and a second operator.
 *   npx vite-node scripts/init-tenant-settings.mjs \
 *     --snapshot=path/to/snapshot.json \
 *     --prefix-approvals=path/to/approvals.json \
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
 *   The app creates settings for a gym whose owner declared a prefix at
 *   onboarding using src/services/tenantSettings.js. This script calls the SAME
 *   module, so the offline plan and the in-app behaviour cannot drift apart.
 *
 * ACTIVITY GATE
 *   A `gyms/{gymId}` document with no members is, on the Phase 4C evidence, most
 *   likely an abandoned self-provisioning attempt or an onboarding duplicate. The
 *   script refuses to seed those, and refuses any gym whose member count it
 *   cannot establish from the snapshot. "I do not know" is treated as "no". The
 *   same check is repeated against LIVE data immediately before each write.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'
import {
  CONFIRM_TOKEN,
  applyPlan,
  buildEffectiveSettingsPayload,
  buildPlannedAuthority,
  buildRollback,
  gateRows,
  guardWrite,
  normaliseSnapshot,
  parsePrefixApprovals,
  plannedAuthorityLines,
  settingsPath,
} from '../functions/projection/tenantSettingsBootstrap.js'

let policy
try {
  policy = await import('@/services/tenantSettings')
} catch (err) {
  console.error(
    'Could not load the tenant-settings policy.\n' +
      'Run this script through vite-node so the "@/" alias resolves:\n' +
      '  npx vite-node scripts/init-tenant-settings.mjs --snapshot=<file> --prefix-approvals=<file>\n' +
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
      case 'prefix-approvals':
        args.prefixApprovals = value
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
    console.log(`        declared prefix: ${row.declaredPrefix || '(none declared on gyms/{gymId})'}`)
    console.log(`        approved       : ${row.approvedPrefix || '(none)'}`)
    // Same builder the apply path uses, so what is shown is exactly what would
    // be created. Only WRITABLE rows are previewed: a refused or blocked row
    // will not be created, and showing a payload for it (with a prefix) would
    // read as a planned write that is not actually planned.
    if (row.writable) {
      const payload = buildEffectiveSettingsPayload(row, row.approvedPrefix)
      console.log(`        payload        : ${JSON.stringify(payload)}`)
    }
    console.log(`        still unset    : ${row.deferred.filter((f) => f !== 'receiptPrefix').join(', ') || '(nothing)'}`)
    for (const gate of row.blockedBy) console.log(`        BLOCKED        : ${gate}`)
    console.log(`        why            : ${row.reason}\n`)
  }

  const plannedAuthority = buildPlannedAuthority(rows)
  console.log(
    '\nPlanned authoritative field writes (each adds ONE field to an existing document; ' +
      'the gyms/{gymId} document is not replaced):'
  )
  for (const line of plannedAuthorityLines(plannedAuthority)) console.log(line)
  if (mode !== 'apply') {
    console.log(
      '  These are PLANNED only. Nothing has been written and no authority write is recorded; ' +
        'rollback.authority stays empty until an --apply run performs them.'
    )
  }

  const writes = rows.filter((r) => r.writable)
  const skipped = rows.filter((r) => !r.writable)
  console.log(`\n--- ${writes.length} to write, ${skipped.length} to skip`)

  if (writes.length) {
    console.log(
      '\nreceiptPrefix on every payload above comes verbatim from --prefix-approvals.\n' +
        'Confirm each one against the owner\u2019s choice before applying: it is printed on\n' +
        'receipts and persisted onto payment records, and it cannot be changed later.\n'
    )
  }
  if (mode !== 'apply') {
    console.log(
      '\nNo data was written. Re-run with --apply --prefix-approvals=<file> --project=<id> --confirm=' +
        CONFIRM_TOKEN +
        ' to write.'
    )
  }
  return writes
}

/**
 * Applies the plan through the Admin SDK that `functions/` already owns.
 *
 * The Admin import is lazy: a planning-only run must need no credentials and
 * must never initialise the app. The Firestore handle comes from
 * `functions/projection/admin.js`, the single place in this repository allowed
 * to call `initializeApp`, so this adds no dependency at the root and creates no
 * second Admin app.
 *
 * `readGym` re-reads the owner-of-record and the live member count for each gym
 * through the same handle, so the last check before every write is against live
 * data rather than against the snapshot.
 */
async function applyViaAdmin(rows, projectId, approvals) {
  let adminBridge
  try {
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

  const readGym = async (gymId) => {
    const snap = await db.doc(`gyms/${gymId}`).get()
    if (!snap.exists) return { exists: false }
    const data = snap.data() || {}
    const count = await db.collection('members').where('gymId', '==', gymId).count().get()
    return {
      exists: true,
      name: typeof data.name === 'string' ? data.name : '',
      memberCount: count.data().count,
      receiptPrefix: typeof data.receiptPrefix === 'string' ? data.receiptPrefix : null,
    }
  }

  return applyPlan(rows, {
    db,
    serverTimestamp: adminBridge.serverTimestamp,
    readGym,
    approvals,
    log: (line) => console.log(line),
  })
}

function usage() {
  console.log(
    [
      'tenant settings initialiser',
      '',
      '  --snapshot=<file>          read-only gym snapshot to plan from (required)',
      '  --prefix-approvals=<file>  JSON object mapping a gym id to the receipt prefix',
      '                             its owner chose; required with --apply (required)',
      '  --project=<id>             Firebase project id; required with --apply',
      '  --gym=<id>                 restrict to one gym',
      '  --manifest=<file>          write the plan/result manifest as JSON',
      '  --apply                    perform writes (otherwise dry run)',
      `  --confirm=${CONFIRM_TOKEN}`,
      '                            second, deliberate acknowledgement for --apply',
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

  let approvals = null
  if (args.prefixApprovals) {
    const parsed = parsePrefixApprovals(readFileSync(args.prefixApprovals, 'utf8'))
    if (parsed.error) {
      console.error(parsed.error)
      process.exit(2)
    }
    approvals = parsed.approvals
  }

  let rows = classifyGymsForBootstrap(normaliseSnapshot(snapshot))
  if (args.gym) rows = rows.filter((r) => r.id === args.gym)
  if (!rows.length) {
    console.error('No gyms matched. Nothing to do.')
    process.exit(2)
  }

  rows = gateRows(rows, approvals || {})

  const mode = args.apply ? 'apply' : 'dry-run'
  const refusal = guardWrite({
    apply: args.apply,
    project: args.project,
    confirm: args.confirm,
    approvals,
  })
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
    prefixApprovalsPath: args.prefixApprovals || null,
    approvals,
    // The intended authoritative field writes, from the plan alone. This is NOT
    // a record of writes that happened: `rollback.authority` is that. Each entry
    // merges one field into an existing gyms/{gymId} document (the document is
    // never replaced), and only rows whose snapshot declares no prefix appear.
    plannedAuthority: buildPlannedAuthority(rows),
    planNotes: [
      '`plannedAuthority` lists the intended `gyms/{gymId}.receiptPrefix` writes; each adds ONE field to an existing document (documentReplaced: false) and never replaces the document.',
      '`rollback.authority` lists only writes that ACTUALLY happened, so it is empty for a dry run and is populated from the live apply results after --apply.',
      'A gyms/{gymId} document that already declares the approved prefix is not a planned authority write, because apply would not overwrite it.',
    ],
    // The settings documents this tool writes are CREATEs of documents that did
    // not exist. Rollback is therefore: delete the listed paths, after confirming
    // no gym owner has since edited them. Comparing the live document against
    // `payload` field-by-field tells you whether an edit happened; `createdAt` is
    // a serverTimestamp, so the manifest records the intended payload only.
    rollback: buildRollback(rows),
    rows,
  }

  let applied = []
  if (args.apply) {
    const result = await applyViaAdmin(rows, args.project, approvals)
    applied = result.applied
    manifest.applied = applied
    manifest.skipped = result.skipped
    manifest.failed = result.failed
    // Rebuilt from the LIVE write results, not from the plan: the undo list has
    // to include every gyms/{gymId}.receiptPrefix that actually landed, which
    // includes rows whose settings CREATE failed and so never reached `applied`.
    manifest.rollback = buildRollback(rows, result.authorityWritten)
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
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error(`\nAborted: ${err?.message || err}`)
  process.exit(1)
})