#!/usr/bin/env node
/**
 * Pre-deploy Firestore index diff — READ ONLY.
 *
 * WHY THIS EXISTS
 *   `firebase deploy --only firestore:indexes` treats firestore.indexes.json as
 *   the whole truth: every composite index that exists in the project but is
 *   absent from the file is DELETED. The first deploy after an index cleanup is
 *   therefore destructive by design. This tool prints exactly which indexes the
 *   deploy will create and which it will delete, before anything is deployed.
 *
 * WHAT IT DOES
 *   Reads the local firestore.indexes.json, lists the composite indexes that are
 *   live in the project, and reports the two set differences:
 *     to create  in the file, not live
 *     to delete  live, not in the file   <-- the destructive half
 *   Then it exits non-zero when there are deletions and confirmation was not
 *   given, which stops the deploy job before it runs.
 *
 * WHAT IT NEVER DOES
 *   - Write, create or delete an index. The only project call is indexes.list.
 *   - Compare single-field indexes. Firestore maintains those itself and the
 *     deploy does not manage them; counting them would report phantom deletions.
 *   - Compare `fieldOverrides`. It is reported when the file declares any, but
 *     not diffed.
 *
 * USAGE
 *   node scripts/index-diff.mjs \
 *     --project=<firebase-project-id> \
 *     --access-token=<oauth access token with clouddatastore.indexes.list> \
 *     [--indexes=firestore.indexes.json] \
 *     [--live=fixture.json]          # offline: compare against a saved list
 *     [--confirm-deletions]          # exit 0 even when deletions are planned
 *
 *   CONFIRM_INDEX_DELETIONS=true in the environment does the same as
 *   --confirm-deletions. GITHUB_STEP_SUMMARY, when set, gets a Markdown copy of
 *   the report.
 *
 * EXIT CODES
 *   0  no deletions planned, or deletions confirmed
 *   1  deletions planned and not confirmed
 *   2  bad arguments, unreadable file, or the project could not be read
 */

import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'

const API_ROOT = 'https://firestore.googleapis.com/v1'

function parseArgs(argv) {
  const args = { indexes: 'firestore.indexes.json', live: '', project: '', token: '' }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    switch (key) {
      case 'project':
        args.project = value
        break
      case 'access-token':
        args.token = value
        break
      case 'indexes':
        args.indexes = value || args.indexes
        break
      case 'live':
        args.live = value
        break
      case 'confirm-deletions':
        args.confirmDeletions = true
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
      'Firestore index diff (read-only)',
      '',
      '  --project=<id>        Firebase project id (required unless --live)',
      '  --access-token=<tok>  OAuth token for the project (required unless --live)',
      '  --indexes=<file>      index definition file (default firestore.indexes.json)',
      '  --live=<file>         compare against a saved indexes.list payload instead',
      '  --confirm-deletions   exit 0 even when deletions are planned',
      '  --help',
    ].join('\n')
  )
}

/** A single field of a composite index, reduced to the part that defines it. */
function fieldKey(field) {
  let config
  if (field.order) config = field.order
  else if (field.arrayConfig)
    config = field.arrayConfig === 'CONTAINS' ? 'ARRAY' : field.arrayConfig
  else if (field.vectorConfig) config = 'VECTOR'
  else config = 'ASCENDING'
  return `${field.fieldPath}:${config}`
}

/** Two indexes are the same index when scope, collection and fields all match. */
function indexKey(index) {
  const scope = index.queryScope || 'COLLECTION'
  return `${scope}|${index.collectionGroup}|${(index.fields || []).map(fieldKey).join(',')}`
}

function describe(index) {
  const fields = (index.fields || []).map(fieldKey).join(', ')
  return `${index.collectionGroup} [${fields}] (${index.queryScope || 'COLLECTION'})`
}

/** Reads the local index definition file. */
function readDesiredIndexes(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const indexes = (parsed.indexes || []).map((index) => ({
    collectionGroup: index.collectionGroup || index.collectionId,
    queryScope: index.queryScope || 'COLLECTION',
    fields: index.fields || [],
  }))
  for (const index of indexes) {
    if (!index.collectionGroup) {
      throw new Error(`An entry in ${path} has neither collectionGroup nor collectionId.`)
    }
  }
  return { indexes, fieldOverrideCount: (parsed.fieldOverrides || []).length }
}

/** Converts one indexes.list entry into the shape this tool compares. */
function normaliseLiveIndex(item) {
  const match = /\/collectionGroups\/([^/]+)\/indexes\//.exec(item.name || '')
  const entry = {
    collectionGroup: match ? decodeURIComponent(match[1]) : '(unknown)',
    queryScope: item.queryScope || 'COLLECTION',
    fields: item.fields || [],
  }
  // Firestore creates single-field indexes itself and the deploy does not
  // manage them, so they are excluded rather than reported as deletions.
  entry.singleField = entry.fields.length <= 1
  return entry
}

/** Lists every index in the project. The only project call in this tool. */
async function fetchLiveIndexes(project, token) {
  const parent = `projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(
    '(default)'
  )}`
  const indexes = []
  let pageToken = ''
  do {
    const url = new URL(`${API_ROOT}/${parent}/collectionGroups/-/indexes`)
    url.searchParams.set('pageSize', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    let res
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    } catch (err) {
      throw new Error(`Could not reach the Firestore Admin API: ${err?.message || err}`)
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500)
      throw new Error(`indexes.list failed: HTTP ${res.status} ${body}`)
    }
    const json = await res.json()
    for (const item of json.indexes || []) indexes.push(normaliseLiveIndex(item))
    pageToken = json.nextPageToken || ''
  } while (pageToken)
  return indexes
}

function readLiveFixture(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const items = Array.isArray(parsed) ? parsed : parsed.indexes || []
  // Accept both a raw indexes.list response and a pre-normalised array.
  return items.map((item) =>
    item.singleField === undefined || item.fields === undefined ? normaliseLiveIndex(item) : item
  )
}

function report({ project, source, desired, live, fieldOverrideCount }) {
  const desiredKeys = new Map(desired.map((index) => [indexKey(index), index]))
  // Single-field indexes are maintained by Firestore, not by the deploy, so
  // they are reported as ignored and never enter either set difference.
  const liveComposite = live.filter((index) => !index.singleField)
  const liveKeys = new Map(liveComposite.map((index) => [indexKey(index), index]))

  const toCreate = [...desiredKeys.entries()].filter(([key]) => !liveKeys.has(key))
  const toDelete = [...liveKeys.entries()].filter(([key]) => !desiredKeys.has(key))
  const unchanged = [...desiredKeys.keys()].filter((key) => liveKeys.has(key)).length
  const singleField = live.length - liveComposite.length
  const composites = liveComposite.length

  const lines = []
  lines.push(`Firestore index diff — project: ${project} (source: ${source})`)
  lines.push('Read-only: this tool lists indexes and never writes, creates or deletes one.')
  lines.push(`  desired (index file)        : ${desired.length}`)
  lines.push(`  live composite in project   : ${composites}`)
  lines.push(`  unchanged                   : ${unchanged}`)
  lines.push(`  to create                   : ${toCreate.length}`)
  lines.push(`  to delete (DESTRUCTIVE)     : ${toDelete.length}`)
  if (singleField > 0) {
    lines.push(`  live single-field (ignored) : ${singleField}`)
  }
  if (fieldOverrideCount > 0) {
    lines.push(`  fieldOverrides in file      : ${fieldOverrideCount} (not diffed by this tool)`)
  }

  if (toDelete.length > 0) {
    lines.push('')
    lines.push('Will be DELETED by `firebase deploy --only firestore:indexes`:')
    for (const [, index] of toDelete) lines.push(`  - ${describe(index)}`)
  }
  if (toCreate.length > 0) {
    lines.push('')
    lines.push('Will be CREATED:')
    for (const [, index] of toCreate) lines.push(`  + ${describe(index)}`)
  }
  if (toCreate.length === 0 && toDelete.length === 0) {
    lines.push('')
    lines.push('Project indexes already match the file; the deploy would change nothing.')
  }

  const text = lines.join('\n')
  console.log(text)

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['### Firestore index diff (before deploy)', '', '```', text, '```', '']
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'))
  }

  return { toCreate: toCreate.length, toDelete: toDelete.length }
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
  if (!args.live && (!args.project || !args.token)) {
    usage()
    process.exit(2)
  }

  let desired
  try {
    desired = readDesiredIndexes(args.indexes)
  } catch (err) {
    console.error(`Could not read index definitions: ${err?.message || err}`)
    process.exit(2)
  }

  let live
  let source
  if (args.live) {
    source = `fixture ${args.live}`
    try {
      live = readLiveFixture(args.live)
    } catch (err) {
      console.error(`Could not read live fixture: ${err?.message || err}`)
      process.exit(2)
    }
  } else {
    source = `live project ${args.project}`
    try {
      live = await fetchLiveIndexes(args.project, args.token)
    } catch (err) {
      console.error(`Could not read the project's indexes: ${err?.message || err}`)
      process.exit(2)
    }
  }

  const counts = report({
    project: args.live ? '(fixture)' : args.project,
    source,
    desired: desired.indexes,
    live,
    fieldOverrideCount: desired.fieldOverrideCount,
  })

  const confirmed =
    args.confirmDeletions || String(process.env.CONFIRM_INDEX_DELETIONS).toLowerCase() === 'true'

  if (counts.toDelete > 0 && !confirmed) {
    console.error(
      '\nRefusing to deploy: the index deploy above would DELETE ' +
        `${counts.toDelete} index(es).\n` +
        'Review the list, then re-run with confirm_index_deletions=true to proceed.'
    )
    process.exit(1)
  }
  console.log('\nIndex diff check passed.')
}

main().catch((err) => {
  console.error(`\nAborted: ${err?.message || err}`)
  process.exit(2)
})
