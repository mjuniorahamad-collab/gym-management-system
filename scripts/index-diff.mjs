#!/usr/bin/env node
/**
 * Pre-deploy Firestore index diff — READ ONLY.
 *
 * WHY IT EXISTS
 *   `firebase deploy --only firestore:indexes` treats firestore.indexes.json as
 *   the whole truth: every composite index that exists in the project but is
 *   absent from the file is DELETED, including ones created in the console.
 *   After an index cleanup that is destructive by design, so this tool prints
 *   what the deploy would create and delete before it runs, and stops the job
 *   when deletions were not confirmed.
 *
 * WHAT IT NEVER DOES
 *   - Write, create or delete anything. The only project call is indexes.list.
 *   - Compare single-field indexes: Firestore maintains those itself and the
 *     deploy does not manage them, so counting them would invent deletions.
 *   - Diff `fieldOverrides`. It is reported when the file declares any.
 *
 * HOW INDEXES ARE COMPARED
 *   The API always appends the document-name field (`__name__`) to every
 *   composite index it returns, and that field is not part of the definition
 *   anyone writes. Both sides are therefore compared without it: otherwise every
 *   live index looks different from its own definition and every single-field
 *   index looks composite, which turns a no-op deploy into a page of deletions.
 *
 * USAGE
 *   node scripts/index-diff.mjs --project=<id> --access-token=<oauth token>
 *   node scripts/index-diff.mjs --live=<saved indexes.list response>   # offline
 *
 *   --indexes=<file>            index file, default firestore.indexes.json
 *   CONFIRM_INDEX_DELETIONS=true  allow a deploy that deletes indexes
 *   GITHUB_STEP_SUMMARY=<path>    also write the report as Markdown
 *
 * EXIT  0 no deletions (or confirmed) · 1 deletions not confirmed · 2 could not run
 */

import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const API_ROOT = 'https://firestore.googleapis.com/v1'
const DEFAULT_DATABASE = '(default)'

function parseArgs(argv) {
  const args = { indexes: 'firestore.indexes.json', live: '', project: '', token: '' }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    if (key === 'help') args.help = true
    else if (key === 'project') args.project = value
    else if (key === 'access-token') args.token = value
    else if (key === 'live') args.live = value
    else if (key === 'indexes' && value) args.indexes = value
    else throw new Error(`Unknown option --${key}`)
  }
  return args
}

function usage() {
  console.log(
    [
      'Firestore index diff (read-only)',
      '',
      '  --project=<id>        project id (required unless --live)',
      '  --access-token=<tok>  OAuth token for the project (required unless --live)',
      '  --live=<file>         compare against a saved indexes.list response instead',
      '  --indexes=<file>      index definition file (default firestore.indexes.json)',
      '  --help',
    ].join('\n')
  )
}

/** The part of a field that defines the index it belongs to. */
export function fieldKey(field) {
  return `${field.fieldPath}:${field.order || field.arrayConfig || 'ASCENDING'}`
}

/**
 * The declared fields of an index, without the trailing `__name__` the API adds.
 * An index ending in `__name__` is the same index whether or not the file spells
 * that field out, so it is dropped on both sides of the comparison.
 */
export function declaredFields(fields) {
  const trimmed = [...(fields || [])]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].fieldPath === '__name__') {
    trimmed.pop()
  }
  return trimmed
}

/** Two indexes are the same index when scope, collection and fields all match. */
export function indexKey(index) {
  return `${index.queryScope}|${index.collectionGroup}|${index.fields.map(fieldKey).join(',')}`
}

function describe(index) {
  return `${index.collectionGroup} [${index.fields.map(fieldKey).join(', ')}] (${index.queryScope})`
}

/** The local definition file, reduced to what the diff compares. */
export function readDesired(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const indexes = (parsed.indexes || []).map((index) => {
    const collectionGroup = index.collectionGroup || index.collectionId
    if (!collectionGroup) {
      throw new Error(`${path}: an index entry has no collectionGroup/collectionId`)
    }
    return {
      collectionGroup,
      queryScope: index.queryScope || 'COLLECTION',
      fields: declaredFields(index.fields),
    }
  })
  return { indexes, fieldOverrides: (parsed.fieldOverrides || []).length }
}

/** One indexes.list entry, reduced to the same shape as readDesired(). */
export function normalise(item) {
  const match = /\/collectionGroups\/([^/]+)\/indexes\//.exec(item.name || '')
  const fields = declaredFields(item.fields)
  return {
    collectionGroup: match ? decodeURIComponent(match[1]) : '(unknown)',
    queryScope: item.queryScope || 'COLLECTION',
    fields,
    singleField: fields.length <= 1,
  }
}

/** Lists every index in the project. The only project call in this tool. */
async function listIndexes(project, token) {
  const parent = `projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(
    DEFAULT_DATABASE
  )}`
  const items = []
  let pageToken = ''
  do {
    // No pageSize: a Firestore Enterprise edition database rejects any non-zero
    // value with `400 Invalid page size. Only 0 is supported.` The server default
    // page is fine because the nextPageToken loop below walks every page.
    const url = new URL(`${API_ROOT}/${parent}/collectionGroups/-/indexes`)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500)
      throw new Error(`indexes.list failed: HTTP ${res.status} ${body}`)
    }
    const body = await res.json()
    items.push(...(body.indexes || []))
    pageToken = body.nextPageToken || ''
  } while (pageToken)
  return items
}

/** A saved indexes.list response, for reviewing the diff without credentials. */
function readSavedResponse(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(parsed) ? parsed : parsed.indexes || []
}

function report({ project, desired, live, fieldOverrides }) {
  const desiredKeys = new Map(desired.map((index) => [indexKey(index), index]))
  const liveComposite = live.filter((index) => !index.singleField)
  const liveKeys = new Map(liveComposite.map((index) => [indexKey(index), index]))

  const toCreate = [...desiredKeys].filter(([key]) => !liveKeys.has(key))
  const toDelete = [...liveKeys].filter(([key]) => !desiredKeys.has(key))
  const singleField = live.length - liveComposite.length

  const lines = [
    `Firestore index diff — project: ${project}`,
    'Read-only: this tool lists indexes and never writes, creates or deletes one.',
    `  desired (index file)        : ${desired.length}`,
    `  live composite in project   : ${liveComposite.length}`,
    `  unchanged                   : ${desiredKeys.size - toCreate.length}`,
    `  to create                   : ${toCreate.length}`,
    `  to delete (DESTRUCTIVE)     : ${toDelete.length}`,
  ]
  if (singleField > 0) lines.push(`  live single-field (ignored) : ${singleField}`)
  if (fieldOverrides > 0) {
    lines.push(`  fieldOverrides in file      : ${fieldOverrides} (not diffed by this tool)`)
  }

  if (toDelete.length > 0) {
    lines.push('', 'Will be DELETED by `firebase deploy --only firestore:indexes`:')
    for (const [, index] of toDelete) lines.push(`  - ${describe(index)}`)
  }
  if (toCreate.length > 0) {
    lines.push('', 'Will be CREATED:')
    for (const [, index] of toCreate) lines.push(`  + ${describe(index)}`)
  }
  if (toCreate.length === 0 && toDelete.length === 0) {
    lines.push('', 'Project indexes already match the file; the deploy would change nothing.')
  }

  const text = lines.join('\n')
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Firestore index diff\n\n\`\`\`\n${text}\n\`\`\`\n`
    )
  }
  return toDelete.length
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
  if (!args.live && (!args.project || !args.token)) {
    usage()
    process.exit(2)
  }

  const desired = readDesired(args.indexes)
  const items = args.live
    ? readSavedResponse(args.live)
    : await listIndexes(args.project, args.token)
  const deletions = report({
    project: args.live ? `(saved response ${args.live})` : args.project,
    desired: desired.indexes,
    live: items.map(normalise),
    fieldOverrides: desired.fieldOverrides,
  })

  if (deletions > 0 && process.env.CONFIRM_INDEX_DELETIONS !== 'true') {
    console.error(
      `\nRefusing to deploy: the index deploy above would DELETE ${deletions} index(es).\n` +
        'Review the list, then re-run with confirm_index_deletions=true to proceed.'
    )
    process.exit(1)
  }
  console.log('\nIndex diff check passed.')
}

// Imported by src/tests/indexDiff.test.js, which never wants the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nAborted: ${err?.message || err}`)
    process.exit(2)
  })
}
