#!/usr/bin/env node
/**
 * Firestore JSON backup and restore — the free path.
 *
 * WHY IT EXISTS
 *   Nothing exports the production database: `functions/dailyBackup` was written but
 *   never deployed (it needs Blaze and a Storage bucket), and `gcloud firestore
 *   export` needs billing too. Meanwhile every gym's members, payments, attendance
 *   and audit log live in a single database whose loss is unrecoverable. Reading
 *   documents through the Admin SDK stays inside the free quotas, so a dump costs
 *   nothing — it just has to be written down somewhere that survives the project.
 *
 * WHAT IT WRITES
 *   <out>/documents.ndjson   one JSON line per document: {"path","data"}
 *   <out>/_manifest.json     project, timestamp, per-collection counts, format
 *
 *   Firestore value types do not survive plain JSON. A Timestamp would come back as
 *   `{_seconds,_nanoseconds}`, and writing that back stores a MAP where a timestamp
 *   belongs — silent corruption. So every non-JSON type is tagged on the way out and
 *   rebuilt on the way in: timestamp, geopoint, reference, bytes.
 *
 * SUBCOLLECTIONS
 *   The walk is recursive. The schema has no subcollections today (every collection
 *   is top-level with a `gymId` field), but a backup that silently skips them would
 *   only be wrong after the schema changed.
 *
 * USAGE
 *   node scripts/backup-firestore.mjs --out=backups/2026-11-24
 *   node scripts/backup-firestore.mjs --restore=backups/2026-11-24 --dry-run
 *   node scripts/backup-firestore.mjs --restore=backups/2026-11-24 --project=demo-himalye-gym
 *
 *   --out=<dir>        write a dump
 *   --restore=<dir>    write a dump back (REPLACES documents at the same paths)
 *   --dry-run          with --restore: count what would be written, write nothing
 *   --project=<id>     project id (default: `projects.default` in .firebaserc)
 *   --help
 *
 *   Needs `npm ci --prefix functions` (the Admin SDK lives there) and Application
 *   Default Credentials: GOOGLE_APPLICATION_CREDENTIALS, a logged-in gcloud, or
 *   FIRESTORE_EMULATOR_HOST for a rehearsal.
 *
 * EXIT  0 done · 2 could not run (usage, credentials, unreadable dump)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { firestore } from '../functions/projection/admin.js'
import { defaultProject } from './check-live-rules.mjs'

// firebase-admin is installed under functions/, not at the repository root, so the
// value constructors used by the decoder are resolved from that package.json.
const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const admin = requireFromFunctions('firebase-admin')

const FORMAT = 'firestore-json-tagged/v1'
const BATCH_SIZE = 400
const DOCUMENTS_FILE = 'documents.ndjson'
const MANIFEST_FILE = '_manifest.json'

function usage() {
  console.log(
    [
      'Firestore JSON backup / restore (free path — no bucket, no Blaze)',
      '',
      '  --out=<dir>        write a dump to <dir>',
      '  --restore=<dir>    write a dump back into the project',
      '  --dry-run          with --restore: count only, write nothing',
      '  --project=<id>     project id (default: projects.default in .firebaserc)',
      '  --help',
      '',
      'Needs npm ci --prefix functions and Application Default Credentials.',
      'Exit 0 = done · 2 = could not run',
    ].join('\n')
  )
}

/** CLI flags → what `main` needs. Exported so a harness can pin the parsing. */
export function parseArgs(argv, env = process.env) {
  const args = { out: '', restore: '', dryRun: false, project: env.FIREBASE_PROJECT_ID || '' }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    if (key === 'help') args.help = true
    else if (key === 'out' && value) args.out = value
    else if (key === 'restore' && value) args.restore = value
    else if (key === 'project' && value) args.project = value
    else if (key === 'dry-run') args.dryRun = true
    else throw new Error(`Unknown option --${key}${value ? '' : ' (a value is required)'}`)
  }
  if (args.out && args.restore) throw new Error('--out and --restore are separate runs; pass one')
  return args
}

const isTimestamp = (value) =>
  typeof value?.toDate === 'function' &&
  typeof value._seconds === 'number' &&
  typeof value._nanoseconds === 'number'

const isGeoPoint = (value) =>
  typeof value?._latitude === 'number' && typeof value?._longitude === 'number'

const isReference = (value) =>
  typeof value?.path === 'string' &&
  typeof value?.id === 'string' &&
  typeof value?.firestore === 'object'

const isBytes = (value) => value instanceof Uint8Array

/**
 * Firestore value → JSON that the decoder can rebuild exactly.
 *
 * Tags are objects with a `__type` key, which cannot collide with a real field name
 * because Firestore field names starting with `__` are reserved.
 */
export function encodeValue(value) {
  if (value === null || value === undefined) return value ?? null
  if (isTimestamp(value)) {
    return { __type: 'timestamp', seconds: value._seconds, nanoseconds: value._nanoseconds }
  }
  if (isGeoPoint(value)) {
    return { __type: 'geopoint', latitude: value._latitude, longitude: value._longitude }
  }
  if (isReference(value)) return { __type: 'reference', path: value.path }
  if (isBytes(value)) return { __type: 'bytes', base64: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) out[key] = encodeValue(nested)
    return out
  }
  return value
}

/** The inverse of `encodeValue`. `db` is needed to rebuild document references. */
export function decodeValue(value, db) {
  if (Array.isArray(value)) return value.map((nested) => decodeValue(nested, db))
  if (value && typeof value === 'object') {
    if (value.__type === 'timestamp') {
      return new admin.firestore.Timestamp(value.seconds, value.nanoseconds)
    }
    if (value.__type === 'geopoint')
      return new admin.firestore.GeoPoint(value.latitude, value.longitude)
    if (value.__type === 'reference') return db.doc(value.path)
    if (value.__type === 'bytes') return Buffer.from(value.base64, 'base64')
    const out = {}
    for (const [key, nested] of Object.entries(value)) out[key] = decodeValue(nested, db)
    return out
  }
  return value
}

/** Every document under one collection, subcollections included, as {path,data}. */
async function walk(collectionRef, rows) {
  const snapshot = await collectionRef.get()
  for (const doc of snapshot.docs) {
    rows.push({ path: doc.ref.path, data: encodeValue(doc.data()) })
    for (const sub of await doc.ref.listCollections()) await walk(sub, rows)
  }
}

/** Read the whole database into memory. Small by design; a gym is thousands of docs. */
export async function dumpDatabase(db) {
  const rows = []
  for (const collection of await db.listCollections()) await walk(collection, rows)
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return rows
}

/** `{ collection: count }` for a dump, counting only top-level collection roots. */
export function countCollections(rows) {
  const counts = {}
  for (const row of rows) {
    const name = row.path.split('/')[0]
    counts[name] = (counts[name] || 0) + 1
  }
  return counts
}

/** Write a dump directory. Returns the manifest that was written. */
export function writeDump(dir, rows, project) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, DOCUMENTS_FILE), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const manifest = {
    format: FORMAT,
    project,
    dumpedAt: new Date().toISOString(),
    documents: rows.length,
    collections: countCollections(rows),
  }
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/** Read a dump directory back. Throws a message naming the problem. */
export function readDump(dir) {
  let raw
  try {
    raw = readFileSync(join(dir, DOCUMENTS_FILE), 'utf8')
  } catch (err) {
    throw new Error(`no ${DOCUMENTS_FILE} in ${dir}: ${err?.message || err}`)
  }
  const rows = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`${DOCUMENTS_FILE} line ${index + 1} is not JSON — the dump is truncated`)
      }
    })
  for (const row of rows) {
    if (typeof row?.path !== 'string' || !row.path.includes('/')) {
      throw new Error(`${DOCUMENTS_FILE} has a row without a document path`)
    }
  }
  return rows
}

/** Write a dump back, id-for-id. Returns `{ collection: count }` actually written. */
export async function restoreDatabase(db, rows, { dryRun = false } = {}) {
  const written = {}
  let batch = db.batch()
  let queued = 0
  for (const row of rows) {
    const name = row.path.split('/')[0]
    written[name] = (written[name] || 0) + 1
    if (dryRun) continue
    batch.set(db.doc(row.path), decodeValue(row.data, db))
    queued += 1
    if (queued === BATCH_SIZE) {
      await batch.commit()
      batch = db.batch()
      queued = 0
    }
  }
  if (queued) await batch.commit()
  return written
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
    return
  }
  if (!args.out && !args.restore) {
    console.error('✗ pass --out=<dir> to dump or --restore=<dir> to restore')
    usage()
    process.exit(2)
  }

  const project = args.project || defaultProject()
  const db = firestore(project ? { projectId: project } : {})
  const target = project || '(project resolved from credentials)'

  if (args.out) {
    const rows = await dumpDatabase(db)
    const manifest = writeDump(args.out, rows, project)
    console.log(`✓ dumped ${manifest.documents} documents to ${args.out}`)
    for (const [name, count] of Object.entries(manifest.collections)) {
      console.log(`  ${name}: ${count}`)
    }
    return
  }

  const rows = readDump(args.restore)
  const written = await restoreDatabase(db, rows, { dryRun: args.dryRun })
  const total = Object.values(written).reduce((sum, count) => sum + count, 0)
  console.log(
    args.dryRun
      ? `✓ dry run: would write ${total} documents to ${target} (nothing was written)`
      : `✓ restored ${total} documents into ${target}`
  )
  for (const [name, count] of Object.entries(written)) console.log(`  ${name}: ${count}`)
}

// Imported by rehearsal harnesses, which never want the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nAborted: ${err?.message || err}`)
    process.exit(2)
  })
}
