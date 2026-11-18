/**
 * The pre-deploy index diff is the only thing standing between an index cleanup
 * and a deploy that silently deletes live indexes, so it is covered here rather
 * than trusted by inspection.
 *
 * The tests drive the real CLI (`node scripts/index-diff.mjs`) against a saved
 * `indexes.list` response, which is the `--live` path the script already supports
 * for offline review. That means no credentials, no project and no network, but
 * the exit code and the printed report are the ones the deploy workflow sees.
 *
 * The four behaviours the deploy job depends on:
 *   - a project index that is absent from the file is reported as a deletion and
 *     BLOCKS the run (exit 1) unless it was confirmed;
 *   - confirming lets the same run through (exit 0);
 *   - an index that only exists on the file side is reported as a creation;
 *   - single-field indexes never appear on either side, because Firestore
 *     maintains them and the deploy does not manage them.
 *
 * The desired side is the repository's real firestore.indexes.json, so these
 * tests also fail if that file stops being readable or well-formed.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexKey, normalise, readDesired } from '../../scripts/index-diff.mjs'

// Vitest runs from the project root. `import.meta.url` is not a file: URL under
// the jsdom environment, so the paths are resolved from the working directory.
const SCRIPT = resolve('scripts/index-diff.mjs')
const INDEX_FILE = resolve('firestore.indexes.json')

const DESIRED = readDesired(INDEX_FILE).indexes

let fixtureDir

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'index-diff-'))
})

/** A saved indexes.list response for these entries, as the API would return it. */
function savedResponse(entries, extra = []) {
  const indexes = entries.map((entry, i) => ({
    name: `projects/demo/databases/(default)/collectionGroups/${entry.collectionGroup}/indexes/${i}`,
    queryScope: entry.queryScope,
    fields: entry.fields,
  }))
  return { indexes: [...indexes, ...extra] }
}

/** Writes a fixture file and returns its path. */
function fixture(name, payload) {
  const path = join(fixtureDir, `${name}.json`)
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
  return path
}

/**
 * Runs the CLI the way the workflow does. CONFIRM_INDEX_DELETIONS and
 * GITHUB_STEP_SUMMARY are cleared first so a developer's shell cannot change the
 * result of a test.
 */
function runDiff(args, env = {}) {
  const clean = { ...process.env }
  delete clean.CONFIRM_INDEX_DELETIONS
  delete clean.GITHUB_STEP_SUMMARY
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Reads a `label : n` line out of the report. */
function count(stdout, label) {
  const line = stdout.split('\n').find((l) => l.includes(label))
  expect(line, `no "${label}" line in the report`).toBeDefined()
  return Number(line.split(':').pop().trim())
}

describe('index diff — comparison', () => {
  it('treats a file entry and its API counterpart as the same index', () => {
    const entry = DESIRED[0]
    const live = normalise({
      name: `projects/demo/databases/(default)/collectionGroups/${entry.collectionGroup}/indexes/1`,
      queryScope: entry.queryScope,
      fields: entry.fields,
    })
    expect(indexKey(live)).toBe(indexKey(entry))
  })

  it('separates indexes that differ only in field direction', () => {
    const asc = {
      collectionGroup: 'members',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'createdAt', order: 'ASCENDING' }],
    }
    const desc = {
      collectionGroup: 'members',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'createdAt', order: 'DESCENDING' }],
    }
    expect(indexKey(asc)).not.toBe(indexKey(desc))
  })

  it('reads collectionId entries and defaults the scope', () => {
    const path = fixture('collection-id', {
      indexes: [{ collectionId: 'members', fields: [{ fieldPath: 'gymId', order: 'ASCENDING' }] }],
    })
    const { indexes } = readDesired(path)
    expect(indexes[0].collectionGroup).toBe('members')
    expect(indexes[0].queryScope).toBe('COLLECTION')
  })

  it('refuses a file entry with no collection', () => {
    const path = fixture('no-collection', { indexes: [{ fields: [] }] })
    expect(() => readDesired(path)).toThrow(/no collectionGroup\/collectionId/)
  })
})

describe('index diff — report and gate', () => {
  it('reports no change when the project already matches the file', () => {
    const live = fixture('matching', savedResponse(DESIRED))
    const { code, stdout } = runDiff([`--live=${live}`])
    expect(code).toBe(0)
    expect(count(stdout, 'to create')).toBe(0)
    expect(count(stdout, 'to delete (DESTRUCTIVE)')).toBe(0)
    expect(stdout).toContain('already match the file')
  })

  it('reports a project-only index as a deletion and blocks without confirmation', () => {
    const legacy = {
      name: 'projects/demo/databases/(default)/collectionGroups/legacyStuff/indexes/99',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'gymId', order: 'ASCENDING' },
        { fieldPath: 'oldField', order: 'DESCENDING' },
      ],
    }
    const live = fixture('project-only', savedResponse(DESIRED, [legacy]))
    const { code, stdout, stderr } = runDiff([`--live=${live}`])
    expect(code).toBe(1)
    expect(count(stdout, 'to delete (DESTRUCTIVE)')).toBe(1)
    expect(stdout).toContain('legacyStuff [gymId:ASCENDING, oldField:DESCENDING]')
    expect(stderr).toContain('would DELETE 1 index')
  })

  it('lets the same deletions through once confirmed', () => {
    const legacy = {
      name: 'projects/demo/databases/(default)/collectionGroups/legacyStuff/indexes/99',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'gymId', order: 'ASCENDING' },
        { fieldPath: 'oldField', order: 'DESCENDING' },
      ],
    }
    const live = fixture('confirmed', savedResponse(DESIRED, [legacy]))
    const { code, stdout } = runDiff([`--live=${live}`], {
      CONFIRM_INDEX_DELETIONS: 'true',
    })
    expect(code).toBe(0)
    expect(stdout).toContain('Index diff check passed.')
  })

  it('reports a file-only index as a creation and does not block', () => {
    const live = fixture('file-only', savedResponse(DESIRED.slice(1)))
    const { code, stdout } = runDiff([`--live=${live}`])
    expect(code).toBe(0)
    expect(count(stdout, 'to create')).toBe(1)
    expect(count(stdout, 'to delete (DESTRUCTIVE)')).toBe(0)
    expect(stdout).toContain('Will be CREATED:')
  })

  it('never lists a single-field index as a deletion', () => {
    const singleField = {
      name: 'projects/demo/databases/(default)/collectionGroups/members/indexes/777',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'nicknameOnlyField', order: 'ASCENDING' }],
    }
    const live = fixture('single-field', savedResponse(DESIRED, [singleField]))
    const { code, stdout } = runDiff([`--live=${live}`])
    expect(code).toBe(0)
    expect(count(stdout, 'to delete (DESTRUCTIVE)')).toBe(0)
    expect(count(stdout, 'live single-field (ignored)')).toBe(1)
    expect(stdout).not.toContain('nicknameOnlyField')
  })

  it('exits 2 when the saved response cannot be read', () => {
    const { code, stderr } = runDiff([`--live=${join(fixtureDir, 'absent.json')}`])
    expect(code).toBe(2)
    expect(stderr).toContain('Aborted:')
  })
})

describe('index diff — arguments', () => {
  it('rejects an unknown option', () => {
    const { code, stderr } = runDiff(['--nope=1'])
    expect(code).toBe(2)
    expect(stderr).toContain('Unknown option --nope')
  })

  it('requires a project and token when no saved response is given', () => {
    const { code } = runDiff([])
    expect(code).toBe(2)
  })
})

describe('the index file the diff reads', () => {
  it('parses and has entries the diff can key', () => {
    expect(DESIRED.length).toBeGreaterThan(0)
    for (const entry of DESIRED) {
      expect(typeof entry.collectionGroup).toBe('string')
      expect(indexKey(entry)).toContain('|')
    }
    expect(readFileSync(INDEX_FILE, 'utf8')).toContain('"indexes"')
  })
})
