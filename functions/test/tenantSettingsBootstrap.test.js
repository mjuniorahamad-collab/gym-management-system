import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRM_TOKEN,
  SERVER_GENERATED_FIELDS,
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
} from '../projection/tenantSettingsBootstrap.js'

/**
 * The apply path takes an injected Firestore handle, a timestamp factory and an
 * injected `readGym` revalidation handle, so the whole contract is testable
 * here with no credentials, no emulator, and no `firebase-admin` import. If
 * `applyPlan` ever reaches for the Admin SDK directly, this suite stops being
 * runnable and that is the point.
 */

const APPROVALS = { 'gym-a': 'CRY' }

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
    declaredPrefix: null,
    approvedPrefix: 'CRY',
    blockedBy: [],
    writable: true,
    ...overrides,
  }
}

/** Minimal Firestore double: `doc()` returning `get`/`create`/`set`. */
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
          writes.push({ path, payload, op: 'create' })
          documents[path] = payload
        }),
        set: vi.fn(async (payload) => {
          writes.push({ path, payload, op: 'set' })
          documents[path] = { ...(documents[path] || {}), ...payload }
        }),
      }
    },
  }
  return db
}

/** The live owner-of-record every write is revalidated against. */
function liveGym(overrides = {}) {
  return vi.fn(async () => ({
    exists: true,
    name: 'Asha Fitness',
    memberCount: 12,
    receiptPrefix: null,
    ...overrides,
  }))
}

const ts = () => 'SERVER_TIMESTAMP'

function writesTo(db, path) {
  return db.writes.filter((w) => w.path === path)
}

describe('settingsPath', () => {
  it('scopes the document under the gym', () => {
    expect(settingsPath('gym-a')).toBe('gyms/gym-a/settings/app')
  })
})

describe('buildEffectiveSettingsPayload', () => {
  it('carries every planner field plus the approved prefix', () => {
    const payload = buildEffectiveSettingsPayload(row(), 'CRY')
    expect(payload).toEqual({ gymId: 'gym-a', currency: 'INR', receiptPrefix: 'CRY' })
  })

  it('never invents, defaults or normalises a prefix', () => {
    for (const bad of [undefined, null, '', '  ', 'CRY-1', 'TOOLONGPREFIX', 123]) {
      expect(() => buildEffectiveSettingsPayload(row(), bad), JSON.stringify(bad)).toThrow(
        /owner-approved receipt prefix/
      )
    }
  })

  it('is deterministic key-for-key across repeated builds', () => {
    const first = buildEffectiveSettingsPayload(row(), 'CRY')
    const second = buildEffectiveSettingsPayload(row(), 'CRY')
    expect(second).toEqual(first)
    expect(Object.keys(second)).toEqual(Object.keys(first))
  })

  it('returns null for a row with no payload rather than an empty document', () => {
    expect(buildEffectiveSettingsPayload(row({ write: null }), 'CRY')).toBeNull()
    expect(buildEffectiveSettingsPayload(null, 'CRY')).toBeNull()
  })
})

describe('buildPlannedAuthority', () => {
  it('enumerates one single-field authority write per writable gym', () => {
    const plan = buildPlannedAuthority([row(), row({ id: 'gym-b', approvedPrefix: 'OXY' })])
    expect(plan).toEqual([
      {
        path: 'gyms/gym-a',
        gymId: 'gym-a',
        field: 'receiptPrefix',
        value: 'CRY',
        operation: 'add-field',
        documentReplaced: false,
      },
      {
        path: 'gyms/gym-b',
        gymId: 'gym-b',
        field: 'receiptPrefix',
        value: 'OXY',
        operation: 'add-field',
        documentReplaced: false,
      },
    ])
  })

  it('plans no authority write for a gym that already declares the prefix', () => {
    expect(buildPlannedAuthority([row({ declaredPrefix: 'CRY' })])).toEqual([])
  })

  it('plans nothing for refused, blocked or unapproved rows', () => {
    expect(buildPlannedAuthority([row({ writable: false })])).toEqual([])
    expect(buildPlannedAuthority([row({ approvedPrefix: null })])).toEqual([])
    expect(buildPlannedAuthority([])).toEqual([])
  })

  it('never marks the gym document as replaced, only the one field added', () => {
    const plan = buildPlannedAuthority([row(), row({ id: 'gym-b', approvedPrefix: 'OXY' })])
    expect(plan.every((w) => w.documentReplaced === false)).toBe(true)
    expect(plan.every((w) => w.field === 'receiptPrefix' && w.operation === 'add-field')).toBe(true)
  })
})

describe('plannedAuthorityLines', () => {
  it('renders each planned write as path.field = value', () => {
    const lines = plannedAuthorityLines(
      buildPlannedAuthority([row(), row({ id: 'gym-b', approvedPrefix: 'OXY' })])
    )
    expect(lines).toEqual([
      '  gyms/gym-a.receiptPrefix = CRY',
      '  gyms/gym-b.receiptPrefix = OXY',
    ])
  })

  it('renders an explicit none line rather than silence', () => {
    expect(plannedAuthorityLines([])).toEqual([
      '  (none — no gyms/{gymId}.receiptPrefix will be added)',
    ])
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

  it('omits the settingsDoc key entirely when it was never checked', () => {
    const [, unchecked] = normaliseSnapshot({
      gyms: [
        { id: 'gym-a', data: { name: 'A' }, memberCount: 1, settingsDoc: null },
        { id: 'gym-b', data: { name: 'B' }, memberCount: 1 },
      ],
    })
    expect(unchecked).not.toHaveProperty('settingsDoc')
  })

  it('carries a declared receipt prefix through for display', () => {
    const [declared, undeclared] = normaliseSnapshot({
      gyms: [
        { id: 'gym-a', data: { name: 'A', receiptPrefix: 'CRY' }, memberCount: 1, settingsDoc: null },
        { id: 'gym-b', data: { name: 'B' }, memberCount: 1, settingsDoc: null },
      ],
    })
    expect(declared.declaredPrefix).toBe('CRY')
    expect(undeclared.declaredPrefix).toBeNull()
  })
})

describe('parsePrefixApprovals', () => {
  it('accepts a flat gym id -> prefix map', () => {
    const { approvals, error } = parsePrefixApprovals(
      JSON.stringify({ 'gym-a': 'CRY', 'gym-b': '001' })
    )
    expect(error).toBeNull()
    expect(approvals).toEqual({ 'gym-a': 'CRY', 'gym-b': '001' })
  })

  it('rejects an empty file', () => {
    expect(parsePrefixApprovals('   ').error).toMatch(/empty/i)
  })

  it('rejects input that is not JSON', () => {
    expect(parsePrefixApprovals('not json').error).toMatch(/not valid JSON/)
  })

  it('rejects a JSON value that is not an object', () => {
    expect(parsePrefixApprovals('["CRY"]').error).toMatch(/must be a JSON object/)
    expect(parsePrefixApprovals('"CRY"').error).toMatch(/must be a JSON object/)
  })

  it('rejects an object that approves nothing', () => {
    expect(parsePrefixApprovals('{}').error).toMatch(/approves nothing/)
  })

  it('rejects a value that is not a valid prefix rather than normalising it', () => {
    for (const bad of ['  CRY', 'CRY ', 'CRY-1', 'HWG!', '', null, 123]) {
      const { approvals, error } = parsePrefixApprovals(JSON.stringify({ 'gym-a': bad }))
      expect(approvals, JSON.stringify(bad)).toBeNull()
      expect(error, JSON.stringify(bad)).toMatch(/not a valid receipt prefix/)
    }
  })

  it('rejects the whole file when a single entry is bad', () => {
    const { approvals } = parsePrefixApprovals(
      JSON.stringify({ 'gym-a': 'CRY', 'gym-b': 'nope!' })
    )
    expect(approvals).toBeNull()
  })
})

describe('gateRows', () => {
  it('allows an explicitly seeded gym with a known member count and approval', () => {
    const [gated] = gateRows([row()], APPROVALS)
    expect(gated.writable).toBe(true)
    expect(gated.blockedBy).toEqual([])
  })

  it('blocks a gym with no members', () => {
    const [gated] = gateRows(
      [row({ memberCount: 0, classification: 'refused-no-activity' })],
      APPROVALS
    )
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/no members/i)
  })

  it('blocks a gym whose member count is unknown', () => {
    const [gated] = gateRows([row({ memberCount: null })], APPROVALS)
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/member count unknown/i)
  })

  it('blocks when settings existence was never established', () => {
    const [gated] = gateRows([row({ settingsChecked: false })], APPROVALS)
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/not established/i)
  })

  it('blocks an already-configured gym even if it somehow has a payload', () => {
    const [gated] = gateRows(
      [row({ classification: 'already-configured', write: null })],
      APPROVALS
    )
    expect(gated.writable).toBe(false)
  })

  it('blocks a gym with no usable identity', () => {
    const [gated] = gateRows(
      [row({ id: '', name: '', classification: 'refused-unusable-identity', write: null })],
      APPROVALS
    )
    expect(gated.writable).toBe(false)
  })

  it('blocks a row that carries a payload but has no approved prefix', () => {
    const [gated] = gateRows([row()], {})
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/no approved receipt prefix/i)
  })

  it('blocks a declared prefix that disagrees with the approval', () => {
    const [gated] = gateRows([row({ declaredPrefix: 'HWG' })], APPROVALS)
    expect(gated.writable).toBe(false)
    expect(gated.blockedBy.join(' ')).toMatch(/already HWG/)
  })

  it('allows a declared prefix that matches the approval', () => {
    const [gated] = gateRows([row({ declaredPrefix: 'CRY' })], APPROVALS)
    expect(gated.writable).toBe(true)
    expect(gated.approvedPrefix).toBe('CRY')
  })

  it('does not demand an approval for a row that writes nothing', () => {
    const [gated] = gateRows(
      [row({ write: null, classification: 'already-configured' })],
      {}
    )
    expect(gated.blockedBy).toEqual([])
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
    const message = guardWrite({ apply: true, project: 'demo', confirm: 'INIT-TENANT-SETTING' })
    expect(message).toMatch(/--confirm/)
  })

  it('requires the prefix approvals to apply', () => {
    const message = guardWrite({
      apply: true,
      project: 'demo',
      confirm: CONFIRM_TOKEN,
    })
    expect(message).toMatch(/--prefix-approvals/)
    expect(message).toMatch(/Nothing was written/)
  })

  it('rejects an empty approvals map', () => {
    const message = guardWrite({
      apply: true,
      project: 'demo',
      confirm: CONFIRM_TOKEN,
      approvals: {},
    })
    expect(message).toMatch(/--prefix-approvals/)
  })

  it('permits a fully specified apply', () => {
    expect(
      guardWrite({
        apply: true,
        project: 'demo',
        confirm: CONFIRM_TOKEN,
        approvals: APPROVALS,
      })
    ).toBeNull()
  })
})

describe('applyPlan', () => {
  it('refuses to run without a Firestore handle', async () => {
    await expect(
      applyPlan([row()], { serverTimestamp: ts, readGym: liveGym(), approvals: APPROVALS })
    ).rejects.toThrow(/requires a Firestore handle/i)
  })

  it('refuses to run without a timestamp factory', async () => {
    await expect(
      applyPlan([row()], { db: fakeDb(), readGym: liveGym(), approvals: APPROVALS })
    ).rejects.toThrow(/serverTimestamp/i)
  })

  it('refuses to run without a live revalidation handle', async () => {
    await expect(
      applyPlan([row()], { db: fakeDb(), serverTimestamp: ts, approvals: APPROVALS })
    ).rejects.toThrow(/readGym/i)
  })

  it('refuses to run without an approvals map', async () => {
    await expect(
      applyPlan([row()], { db: fakeDb(), serverTimestamp: ts, readGym: liveGym() })
    ).rejects.toThrow(/approvals map/i)
  })

  it('creates the document for a writable row', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].path).toBe('gyms/gym-a/settings/app')
    expect(writesTo(db, 'gyms/gym-a/settings/app')).toHaveLength(1)
    expect(writesTo(db, 'gyms/gym-a/settings/app')[0].payload.currency).toBe('INR')
  })

  it('stamps createdAt with the injected sentinel, not a local clock', async () => {
    const db = fakeDb()
    await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })
    expect(writesTo(db, 'gyms/gym-a/settings/app')[0].payload.createdAt).toBe('SERVER_TIMESTAMP')
  })

  it('uses create(), so an existing document is never overwritten', async () => {
    const db = fakeDb({ 'gyms/gym-a/settings/app': { currency: 'USD' } })
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(writesTo(db, 'gyms/gym-a/settings/app')).toHaveLength(0)
  })

  it('writes no authority prefix when the settings document already exists', async () => {
    const db = fakeDb({ 'gyms/gym-a/settings/app': { currency: 'USD' } })
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: null }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    // The existence check precedes the authority write, so an existing settings
    // document leaves gyms/{gymId} untouched as well.
    expect(db.writes).toHaveLength(0)
    expect(result.authorityWritten).toEqual([])
  })

  it('records a failure rather than swallowing it, and keeps going', async () => {
    const writes = []
    const db = {
      writes,
      doc: (path) => ({
        get: vi.fn(async () => ({ exists: false })),
        create: vi.fn(async (payload) => {
          if (path.includes('/gym-a/')) throw new Error('PERMISSION_DENIED')
          writes.push({ path, payload })
        }),
        set: vi.fn(async () => {}),
      }),
    }
    const result = await applyPlan([row(), row({ id: 'gym-b' })], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: { ...APPROVALS, 'gym-b': 'CRY' },
    })

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error).toMatch(/PERMISSION_DENIED/)
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].path).toBe('gyms/gym-b/settings/app')
  })

  it('never writes a blocked row, even when it carries a payload', async () => {
    const db = fakeDb()
    const blocked = gateRows([row({ memberCount: null })], APPROVALS)
    const result = await applyPlan(blocked, {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(db.writes).toHaveLength(0)
  })

  it('writes nothing at all when every row is blocked', async () => {
    const db = fakeDb()
    const blocked = gateRows(
      [row({ memberCount: 0, classification: 'refused-no-activity' })],
      APPROVALS
    )
    const result = await applyPlan(blocked, {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })
    expect(result.applied).toHaveLength(0)
    expect(db.writes).toHaveLength(0)
  })

  it('writes the approved prefix, never an invented one', async () => {
    const db = fakeDb()
    await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })
    expect(writesTo(db, 'gyms/gym-a/settings/app')[0].payload.receiptPrefix).toBe('CRY')
    expect(writesTo(db, 'gyms/gym-a/settings/app')[0].payload.receiptPrefix).not.toBe('HWG')
  })

  it('adds the prefix to gyms/{gymId} when none is declared, and records it', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: null }),
      approvals: APPROVALS,
    })

    expect(writesTo(db, 'gyms/gym-a')).toHaveLength(1)
    expect(writesTo(db, 'gyms/gym-a')[0].op).toBe('set')
    expect(writesTo(db, 'gyms/gym-a')[0].payload).toEqual({ receiptPrefix: 'CRY' })
    expect(result.applied[0].prefixWritten).toBe(true)
  })

  it('never rewrites a prefix that is already declared', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: 'CRY' }),
      approvals: APPROVALS,
    })

    expect(writesTo(db, 'gyms/gym-a')).toHaveLength(0)
    expect(result.applied[0].prefixWritten).toBe(false)
  })

  it('skips a gym whose owner-of-record has disappeared', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ exists: false }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped[0].reason).toMatch(/no longer exists/)
    expect(db.writes).toHaveLength(0)
  })

  it('skips a gym whose owner-of-record has no usable identity', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ name: '  ' }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped[0].reason).toMatch(/no usable identity/)
    expect(db.writes).toHaveLength(0)
  })

  it('rechecks the member count against live data, not the snapshot', async () => {
    const db = fakeDb()
    const result = await applyPlan([row({ memberCount: 12 })], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ memberCount: 0 }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped[0].reason).toMatch(/live member count/)
    expect(db.writes).toHaveLength(0)
  })

  it('skips when the live declared prefix disagrees with the approval', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: 'HWG' }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped[0].reason).toMatch(/does not match the approved/)
    expect(db.writes).toHaveLength(0)
  })

  it('skips when a row carries no approved prefix at write time', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: {},
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped[0].reason).toMatch(/no approved receipt prefix/)
    expect(db.writes).toHaveLength(0)
  })
})

describe('effective payload consistency (dry run, apply, rollback)', () => {
  it('creates exactly the shared payload plus a server timestamp', async () => {
    const db = fakeDb()
    await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })

    const effective = buildEffectiveSettingsPayload(row(), 'CRY')
    expect(writesTo(db, 'gyms/gym-a/settings/app')[0].payload).toEqual({
      ...effective,
      createdAt: 'SERVER_TIMESTAMP',
    })
  })

  it('records in rollback the same fields the apply path wrote', async () => {
    const db = fakeDb()
    const rows = gateRows([row()], APPROVALS)
    const rollback = buildRollback(rows)
    const result = await applyPlan(rows, {
      db,
      serverTimestamp: ts,
      readGym: liveGym(),
      approvals: APPROVALS,
    })

    const recorded = rollback.paths[0].payload
    const effective = buildEffectiveSettingsPayload(rows[0], rows[0].approvedPrefix)
    expect(recorded).toEqual(effective)
    expect(recorded.receiptPrefix).toBe('CRY')
    // The rollback payload names every non-server field the create wrote...
    expect(Object.keys(result.applied[0].payload).sort()).toEqual(
      Object.keys(recorded).sort()
    )
    // ...and the create adds only the server-generated field on top of it.
    expect(writesTo(db, 'gyms/gym-a/settings/app')[0].payload).toEqual({
      ...recorded,
      createdAt: 'SERVER_TIMESTAMP',
    })
  })

  it('records the approved prefix in the planned rollback even before apply', () => {
    const rollback = buildRollback(gateRows([row()], APPROVALS))
    expect(rollback.paths).toHaveLength(1)
    expect(rollback.paths[0].payload.receiptPrefix).toBe('CRY')
  })
})

describe('planned authority vs actual writes (dry run)', () => {
  const PLAN_APPROVALS = {
    'gym-a': 'GMS',
    'gym-b': 'OXY',
    'gym-c': 'CRY',
    'ghost-1': 'GHO',
    'ghost-2': 'GHO',
  }

  function scenario() {
    const settingsRow = (id) => row({ id, write: { gymId: id, currency: 'INR' } })
    return gateRows(
      [
        settingsRow('gym-a'),
        settingsRow('gym-b'),
        settingsRow('gym-c'),
        row({
          id: 'ghost-1',
          memberCount: 0,
          classification: 'refused-no-activity',
          write: { gymId: 'ghost-1', currency: 'INR' },
        }),
        row({
          id: 'ghost-2',
          memberCount: 0,
          classification: 'refused-no-activity',
          write: { gymId: 'ghost-2', currency: 'INR' },
        }),
      ],
      PLAN_APPROVALS
    )
  }

  it('lists every planned authority field write in the dry run', () => {
    const lines = plannedAuthorityLines(buildPlannedAuthority(scenario()))
    expect(lines).toEqual([
      '  gyms/gym-a.receiptPrefix = GMS',
      '  gyms/gym-b.receiptPrefix = OXY',
      '  gyms/gym-c.receiptPrefix = CRY',
    ])
  })

  it('records no actual authority write during a dry run', () => {
    const rows = scenario()
    const rollback = buildRollback(rows)
    expect(rollback.authority).toEqual([])
    expect(rollback.authorityNotes.join(' ')).toMatch(/No gyms/)
    // The plan is non-empty, proving the empty list is about ACTUAL writes only.
    expect(buildPlannedAuthority(rows)).toHaveLength(3)
  })

  it('matches every planned id and prefix to its settings payload', () => {
    const rows = scenario()
    const planned = buildPlannedAuthority(rows)
    const payloadByGymId = new Map(
      buildRollback(rows).paths.map((p) => [p.payload.gymId, p.payload])
    )

    expect(planned.map((w) => w.gymId)).toEqual(['gym-a', 'gym-b', 'gym-c'])
    for (const write of planned) {
      const payload = payloadByGymId.get(write.gymId)
      expect(payload, write.gymId).toBeDefined()
      expect(payload.gymId).toBe(write.gymId)
      expect(payload.receiptPrefix).toBe(write.value)
    }
  })

  it('keeps both zero-member gyms refused and out of the plan', () => {
    const rows = scenario()
    const ghosts = rows.filter((r) => r.id.startsWith('ghost'))
    expect(ghosts).toHaveLength(2)
    expect(ghosts.every((r) => r.writable === false)).toBe(true)
    expect(ghosts.every((r) => /no members/i.test(r.blockedBy.join(' ')))).toBe(true)

    const plannedIds = buildPlannedAuthority(rows).map((w) => w.gymId)
    expect(plannedIds).not.toContain('ghost-1')
    expect(plannedIds).not.toContain('ghost-2')
  })

  it('reconciles planned and actual once an apply actually writes', async () => {
    const rows = gateRows(
      [row({ id: 'gym-a', write: { gymId: 'gym-a', currency: 'INR' } })],
      { 'gym-a': 'GMS' }
    )
    const planned = buildPlannedAuthority(rows)
    const db = fakeDb()
    const result = await applyPlan(rows, {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: null }),
      approvals: { 'gym-a': 'GMS' },
    })

    expect(planned).toEqual([
      {
        path: 'gyms/gym-a',
        gymId: 'gym-a',
        field: 'receiptPrefix',
        value: 'GMS',
        operation: 'add-field',
        documentReplaced: false,
      },
    ])
    expect(result.authorityWritten).toEqual([
      { path: 'gyms/gym-a', gymId: 'gym-a', prefix: 'GMS' },
    ])
    expect(buildRollback(rows, result.authorityWritten).authority).toEqual([
      { path: 'gyms/gym-a', prefix: 'GMS' },
    ])
  })

  it('describes planned vs actual and never claims the prefix is left unset', () => {
    const rollback = buildRollback(scenario())
    const text = [...rollback.notes, ...rollback.notTouched].join(' ')
    expect(text).not.toMatch(/left unset/i)
    expect(text).toMatch(/plannedAuthority/)
    expect(text).toMatch(/only the receiptPrefix field/)
    expect(text).toMatch(/never replaced/)
  })
})

describe('applyPlan — partial failure bookkeeping (CF-4)', () => {
  /** A handle where the settings CREATE throws but the gyms write succeeds. */
  function createFailsDb() {
    const writes = []
    return {
      writes,
      doc(path) {
        return {
          path,
          get: vi.fn(async () => ({ exists: false })),
          create: vi.fn(async () => {
            const err = new Error('PERMISSION_DENIED: missing or insufficient permissions')
            err.code = 'permission-denied'
            throw err
          }),
          set: vi.fn(async (payload) => {
            writes.push({ path, payload, op: 'set' })
          }),
        }
      },
    }
  }

  /** A handle where the gyms write itself throws, so nothing lands at all. */
  function authorityFailsDb() {
    const writes = []
    return {
      writes,
      doc(path) {
        return {
          path,
          get: vi.fn(async () => ({ exists: false })),
          create: vi.fn(async () => {
            throw new Error('never reached')
          }),
          set: vi.fn(async () => {
            const err = new Error('PERMISSION_DENIED: missing or insufficient permissions')
            err.code = 'permission-denied'
            throw err
          }),
        }
      },
    }
  }

  it('records the authority write even when the settings create fails', async () => {
    const db = createFailsDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: null }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].path).toBe('gyms/gym-a/settings/app')
    // The prefix DID go down, so the failed row must say so — otherwise a
    // rollback built from the results would leave the authority write behind.
    expect(result.failed[0].prefixWritten).toBe(true)
    expect(result.authorityWritten).toEqual([
      { path: 'gyms/gym-a', gymId: 'gym-a', prefix: 'CRY' },
    ])
    expect(writesTo(db, 'gyms/gym-a')).toHaveLength(1)
  })

  it('records every authority prefix when several settings creates fail', async () => {
    const db = createFailsDb()
    const result = await applyPlan(
      [row(), row({ id: 'gym-b' }), row({ id: 'gym-c' })],
      {
        db,
        serverTimestamp: ts,
        readGym: liveGym({ receiptPrefix: null }),
        approvals: { 'gym-a': 'CRY', 'gym-b': 'OXY', 'gym-c': 'PLT' },
      }
    )

    expect(result.applied).toHaveLength(0)
    expect(result.failed).toHaveLength(3)
    expect(result.failed.every((f) => f.prefixWritten)).toBe(true)
    expect(result.authorityWritten).toEqual([
      { path: 'gyms/gym-a', gymId: 'gym-a', prefix: 'CRY' },
      { path: 'gyms/gym-b', gymId: 'gym-b', prefix: 'OXY' },
      { path: 'gyms/gym-c', gymId: 'gym-c', prefix: 'PLT' },
    ])
    expect(writesTo(db, 'gyms/gym-a')).toHaveLength(1)
    expect(writesTo(db, 'gyms/gym-b')).toHaveLength(1)
    expect(writesTo(db, 'gyms/gym-c')).toHaveLength(1)
  })

  it('claims no authority write when the authority write itself failed', async () => {
    const db = authorityFailsDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ receiptPrefix: null }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].prefixWritten).toBe(false)
    expect(result.authorityWritten).toEqual([])
    expect(writesTo(db, 'gyms/gym-a')).toHaveLength(0)
  })

  it('records nothing for a row it skipped before writing', async () => {
    const db = fakeDb()
    const result = await applyPlan([row()], {
      db,
      serverTimestamp: ts,
      readGym: liveGym({ memberCount: 0 }),
      approvals: APPROVALS,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.authorityWritten).toEqual([])
  })
})

describe('buildRollback', () => {
  it('lists only writable rows', () => {
    const rows = gateRows([row(), row({ id: 'gym-b', memberCount: null })], APPROVALS)
    const rollback = buildRollback(rows)
    expect(rollback.strategy).toBe('delete-created-documents-and-remove-added-prefix')
    expect(rollback.paths.map((p) => p.path)).toEqual(['gyms/gym-a/settings/app'])
  })

  it('states what the tool never touches', () => {
    expect(buildRollback([]).notTouched.join(' ')).toMatch(/never (modified|deleted)/)
  })

  it('tells the operator how the added prefix is undone', () => {
    expect(buildRollback([]).notes.join(' ')).toMatch(/prefixWritten/)
  })

  it('lists every authority prefix the run added, from the write results', () => {
    const rows = gateRows([row()], APPROVALS)
    const rollback = buildRollback(rows, [
      { path: 'gyms/gym-a', gymId: 'gym-a', prefix: 'CRY' },
    ])
    expect(rollback.authority).toEqual([{ path: 'gyms/gym-a', prefix: 'CRY' }])
    expect(rollback.authorityNotes.join(' ')).toMatch(/gyms\/gym-a\.receiptPrefix/)
    expect(rollback.authorityNotes.join(' ')).toMatch(/CRY/)
  })

  it('reports an empty undo list when no authority write happened', () => {
    const rollback = buildRollback(gateRows([row()], APPROVALS))
    expect(rollback.authority).toEqual([])
    expect(rollback.authorityNotes.join(' ')).toMatch(/No gyms/)
  })

  it('names the server-generated fields instead of serialising a sentinel', () => {
    const rollback = buildRollback(gateRows([row()], APPROVALS))

    expect(SERVER_GENERATED_FIELDS).toContain('createdAt')
    expect(rollback.serverGeneratedFields).toContain('createdAt')
    // The server timestamp sentinel is never written as ordinary JSON.
    const serialised = JSON.stringify(rollback)
    expect(serialised).not.toContain('SERVER_TIMESTAMP')
    expect(serialised).not.toContain('serverTimestamp')
    // createdAt is described, not stored as a value.
    expect(rollback.paths[0].payload).not.toHaveProperty('createdAt')
    expect(rollback.notes.join(' ')).toMatch(/serverGeneratedFields/)
  })

  it('records the effective payload, so it can tell an owner edit from migration fields', () => {
    const rollback = buildRollback(gateRows([row()], APPROVALS))
    const payload = rollback.paths[0].payload

    // Every field the create writes except the server-generated one is present.
    expect(payload).toEqual(
      expect.objectContaining({ gymId: 'gym-a', currency: 'INR', receiptPrefix: 'CRY' })
    )
    const known = new Set([...Object.keys(payload), ...rollback.serverGeneratedFields])
    // A field the migration never wrote is therefore detectable as an edit.
    expect(known.has('logoUrl')).toBe(false)
    expect(known.has('createdAt')).toBe(true)
  })
})

/**
 * The round trip through the real policy lives in the app suite, which runs
 * under the `@/` alias that `tenantSettings.js` needs for its gym-time imports.
 * Importing it here would drag Vite alias resolution into a plain-Node config
 * that is deliberately alias-free.
 */
