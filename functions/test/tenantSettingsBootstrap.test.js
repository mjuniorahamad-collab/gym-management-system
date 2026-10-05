import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRM_TOKEN,
  applyPlan,
  buildRollback,
  gateRows,
  guardWrite,
  normaliseSnapshot,
  settingsPath,
} from '../projection/tenantSettingsBootstrap.js'

/**
 * The apply path takes an injected Firestore handle and a timestamp factory, so
 * the whole contract is testable here with no credentials, no emulator, and no
 * `firebase-admin` import. If `applyPlan` ever reaches for the Admin SDK
 * directly, this suite stops being runnable and that is the point.
 */



/** A row as `gateRows` would emit it: already gated, writable, nothing blocked. */
function row(overrides = {}) {
  return {
    id: 'gym-a',
    name: 'Asha Fitness',
    memberCount: 12,
    settingsChecked: true,
    sharesDisplayName: false,
    classification: 'seed-safe',
    write: { gymId: 'gym-a', currency: 'INR' },
    deferred: ['receiptPrefix'],
    reason: 'no existing settings document',
    blockedBy: [],
    writable: true,
    ...overrides,
  }
}

/** Minimal Firestore double: `doc()` returning `get`/`create`. */
function fakeDb(documents = {}) {
  const writes = []
  const db = {
    writes,
    doc(path) {
      return {
        path,
        get: vi.fn(async () => ({
          exists: Object.prototype.hasOwnProperty.call(documents, path),
        })),
        create: vi.fn(async (payload) => {
          writes.push({ path, payload })
          documents[path] = payload
        }),
      }
    },
  }
  return db
}

describe('settingsPath', () => {
  it('scopes the document under the gym', () => {
    expect(settingsPath('gym-a')).toBe('gyms/gym-a/settings/app')
  })
})

describe('normaliseSnapshot', () => {
  it('refuses an empty snapshot rather than planning nothing', () => {
    expect(() => normaliseSnapshot({ gyms: [] })).toThrow(/no gyms/i)
  })

  it('treats an omitted memberCount as unknown, not zero', () => {
    const [gym] = normaliseSnapshot({ gyms: [{ id: 'gym-a', data: { name: 'A' } }] })
    expect(gym.memberCount).toBeNull()
  })

  it('distinguishes "checked and absent" from "not checked"', () => {
    const [absent, unchecked] = normaliseSnapshot({
      gyms: [
        { id: 'gym-a', data: { name: 'A' }, memberCount: 1, settingsDoc: null },
        { id: 'gym-b', data: { name: 'B' }, memberCount: 1 },
      ],
    })
    expect(absent.settingsKnown).toBe(true)
    expect(absent.settingsDoc).toBeNull()
    expect(unchecked.settingsKnown).toBe(false)
    expect(unchecked.settingsDoc).toBeUndefined()
  })
})

describe('gateRows', () => {
  it('allows an explicitly seeded gym with a known member count', () => {
    const [gated] = gateRows([row()])
    expect(gated.writable).toBe(true)
    expect(gated.blockedBy).toEqual([])
  })

  it('blocks a gym with no members', () => {
    const [gated] = gateRows([row({ memberCount: 0, classification: 'refused-no-activity' })])
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/no members/i)
  })

  it('blocks a gym whose member count is unknown', () => {
    const [gated] = gateRows([row({ memberCount: null })])
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/member count unknown/i)
  })

  it('blocks when settings existence was never established', () => {
    const [gated] = gateRows([row({ settingsChecked: false })])
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/not established/i)
  })

  it('blocks an already-configured gym even if it somehow has a payload', () => {
    const [gated] = gateRows([row({ classification: 'already-configured', write: null })])
    expect(gated.writable).toBe(false)
  })

  it('blocks a gym with no usable identity', () => {
    const [gated] = gateRows([
      row({ id: '', name: '', classification: 'refused-unusable-identity', write: null }),
    ])
    expect(gated.writable).toBe(false)
  })
})

describe('guardWrite', () => {
  it('does not object to a dry run', () => {
    expect(guardWrite({ apply: false })).toBeNull()
  })

  it('requires a project id to apply', () => {
    expect(guardWrite({ apply: true, confirm: CONFIRM_TOKEN })).toMatch(/--project/)
  })

  it('requires the exact confirmation token', () => {
    const message = guardWrite({ apply: true, project: 'demo', confirm: 'yes' })
    expect(message).toMatch(/--confirm/)
    expect(message).toMatch(/Nothing was written/)
  })

  it('rejects a near-miss token rather than accepting a prefix', () => {
    expect(guardWrite({ apply: true, project: 'demo', confirm: 'INIT-TENANT-SETTING' })).toMatch(
      /--confirm/
    )
  })

  it('permits a fully specified apply', () => {
    expect(
      guardWrite({ apply: true, project: 'demo', confirm: CONFIRM_TOKEN })
    ).toBeNull()
  })
})

describe('applyPlan', () => {
  const ts = () => 'SERVER_TIMESTAMP'

  it('refuses to run without a Firestore handle', async () => {
    await expect(applyPlan([row()], { serverTimestamp: ts })).rejects.toThrow(
      /requires a Firestore handle/i
    )
  })

  it('refuses to run without a timestamp factory', async () => {
    await expect(applyPlan([row()], { db: fakeDb() })).rejects.toThrow(/serverTimestamp/i)
  })

  it('creates the document for a writable row', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], { db, serverTimestamp: ts })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].path).toBe('gyms/gym-a/settings/app')
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].payload.currency).toBe('INR')
  })

  it('stamps createdAt with the injected sentinel, not a local clock', async () => {
    const db = fakeDb()
    await applyPlan([row()], { db, serverTimestamp: ts })
    expect(db.writes[0].payload.createdAt).toBe('SERVER_TIMESTAMP')
  })

  it('uses create(), so an existing document is never overwritten', async () => {
    const db = fakeDb({ 'gyms/gym-a/settings/app': { currency: 'USD' } })
    const result = await applyPlan([row()], { db, serverTimestamp: ts })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(db.writes).toHaveLength(0)
    expect(db.doc('gyms/gym-a/settings/app').create).not.toHaveBeenCalled()
  })

  it('records a failure rather than swallowing it, and keeps going', async () => {
    const writes = []
    const db = {
      doc: (path) => ({
        get: vi.fn(async () => ({ exists: false })),
        create: vi.fn(async (payload) => {
          if (path.includes('/gym-a/')) throw new Error('PERMISSION_DENIED')
          writes.push({ path, payload })
        }),
      }),
    }
    const result = await applyPlan([row(), row({ id: 'gym-b' })], {
      db,
      serverTimestamp: ts,
    })

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error).toMatch(/PERMISSION_DENIED/)
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].path).toBe('gyms/gym-b/settings/app')
  })

  it('never writes a blocked row, even when it carries a payload', async () => {
    const db = fakeDb()
    const blocked = gateRows([row({ memberCount: null })])
    const result = await applyPlan(blocked, { db, serverTimestamp: ts })

    expect(result.applied).toHaveLength(0)
    expect(db.writes).toHaveLength(0)
  })

  it('writes nothing at all when every row is blocked', async () => {
    const db = fakeDb()
    const blocked = gateRows([row({ memberCount: 0, classification: 'refused-no-activity' })])
    const result = await applyPlan(blocked, { db, serverTimestamp: ts })
    expect(result.applied).toHaveLength(0)
    expect(db.writes).toHaveLength(0)
  })

  it('never carries a receiptPrefix, which is an owner decision', async () => {
    const db = fakeDb()
    await applyPlan([row()], { db, serverTimestamp: ts })
    expect(db.writes[0].payload).not.toHaveProperty('receiptPrefix')
  })
})

describe('buildRollback', () => {
  it('lists only writable rows', () => {
    const rows = gateRows([row(), row({ id: 'gym-b', memberCount: null })])
    const rollback = buildRollback(rows)
    expect(rollback.strategy).toBe('delete-only')
    expect(rollback.paths.map((p) => p.path)).toEqual(['gyms/gym-a/settings/app'])
  })

  it('states what the tool never touches', () => {
    expect(buildRollback([]).notTouched.join(' ')).toMatch(/never (modified|deleted)/)
  })
})

/**
 * The round trip through the real policy lives in the app suite, which runs
 * under the `@/` alias that `tenantSettings.js` needs for its gym-time imports.
 * Importing it here would drag Vite alias resolution into a plain-Node config
 * that is deliberately alias-free.
 */