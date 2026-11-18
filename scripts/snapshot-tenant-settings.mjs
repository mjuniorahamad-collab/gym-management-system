#!/usr/bin/env node
/**
 * Read-only tenant snapshot generator.
 *
 * Produces the `--snapshot` file that `scripts/init-tenant-settings.mjs` plans
 * from. Every call below is a read or a count aggregation: this tool cannot
 * write to Firestore, so a run is safe against any project.
 *
 * USAGE
 *   npx vite-node scripts/snapshot-tenant-settings.mjs \
 *     --project=<firebase-project-id> \
 *     --out=path/to/snapshot.json
 *
 * WHAT IT RECORDS PER GYM
 *   data           name / tagline / ownerUid / receiptPrefix (when declared)
 *   memberCount    live count of `members` where gymId == the gym id
 *   settingsDoc    the stored `gyms/{gymId}/settings/app`, or null when it is
 *                  absent. Always stated explicitly, so a reader can tell
 *                  "checked, absent" from "not checked".
 *
 * WHAT IT NEVER DOES
 *   - Write, create, update or delete anything. Every call below is a read or a
 *     count aggregation, and the Admin handle is only ever used to read.
 *   - Decide anything. The output is a fact record; the planner owns the
 *     decisions and the operator owns the approvals.
 */

import { writeFileSync } from 'node:fs'
import process from 'node:process'

function parseArgs(argv) {
  const args = {}
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    switch (key) {
      case 'project':
        args.project = value
        break
      case 'out':
        args.out = value
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

function usage() {
  console.log(
    [
      'tenant settings snapshot generator (read-only)',
      '',
      '  --project=<id>   Firebase project id (required)',
      '  --out=<file>     file to write the snapshot to (required)',
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

  if (args.help) {
    usage()
    process.exit(0)
  }
  if (!args.project || !args.out) {
    usage()
    process.exit(2)
  }

  let adminBridge
  try {
    adminBridge = await import('../functions/projection/admin.js')
  } catch (err) {
    console.error(
      'Could not reach the Admin SDK owned by functions/.\n' +
        'It is expected at functions/projection/admin.js; the root package has no\n' +
        'firebase-admin dependency and must not gain one. Check that functions/ is\n' +
        'present and its dependencies are installed (npm --prefix functions ci).\n' +
        `Underlying error: ${err?.message || err}`
    )
    process.exit(2)
  }

  const db = adminBridge.firestore({ projectId: args.project })
  const settingsPath = (id) => `gyms/${id}/settings/app`

  const gymsSnap = await db.collection('gyms').get()
  if (gymsSnap.empty) {
    console.error(`No gyms found in project ${args.project}. Nothing to snapshot.`)
    process.exit(2)
  }

  const gyms = []
  for (const doc of gymsSnap.docs.sort((a, b) => a.id.localeCompare(b.id))) {
    const data = doc.data() || {}
    const settingsSnap = await db.doc(settingsPath(doc.id)).get()
    const countSnap = await db
      .collection('members')
      .where('gymId', '==', doc.id)
      .count()
      .get()

    const entry = {
      path: `gyms/${doc.id}`,
      id: doc.id,
      data: {
        name: typeof data.name === 'string' ? data.name : '',
        tagline: typeof data.tagline === 'string' ? data.tagline : '',
        ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : '',
      },
      memberCount: countSnap.data().count,
      // Explicit null means "read it, it is not there". The key is never
      // omitted by this tool, so the planner can trust the tri-state.
      settingsDoc: settingsSnap.exists ? settingsSnap.data() : null,
    }
    if (typeof data.receiptPrefix === 'string' && data.receiptPrefix) {
      entry.data.receiptPrefix = data.receiptPrefix
    }
    gyms.push(entry)
  }

  const snapshot = {
    tool: 'snapshot-tenant-settings',
    generatedAt: new Date().toISOString(),
    project: args.project,
    readOnly: true,
    gyms,
  }

  writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${gyms.length} gym(s) to ${args.out} (read-only; no data was modified).`)
}

main().catch((err) => {
  console.error(`\nAborted: ${err?.message || err}`)
  process.exit(1)
})
