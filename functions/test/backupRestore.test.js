/**
 * BACKUP / RESTORE DRILL.
 *
 * The daily job could always claim it backed up. What was never proven is that
 * the output can be put back: same ids, same values, nothing silently dropped.
 * These tests exercise the exact module the scheduled job now uses
 * (`exportAllCollections`), so a drill that passes is evidence about the real
 * backup and not about a parallel implementation.
 *
 * Each test works inside its own `pw-b-` namespace and only asserts on its own
 * ids — the emulator database is shared with the other function suites.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  compareBackup,
  exportAllCollections,
  restoreAllCollections,
} from '../projection/backup.js'
import { assertEmulatorReachable, db, suite } from './helpers.js'

const S = suite('pw-b-')
const { uid, cleanup } = S

beforeAll(async () => {
  await assertEmulatorReachable()
  await cleanup()
})

afterEach(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
})

/** Two documents of the same tenant, one with a nested field and a timestamp. */
async function seedFixture() {
  const memberId = uid('member')
  const paymentId = uid('payment')
  await db.doc(`members/${memberId}`).set({
    name: 'Backup Fixture',
    gymId: uid('gym'),
    notes: { source: 'drill', tags: ['a', 'b'] },
    joinedAt: new Date('2026-01-05T00:00:00Z'),
  })
  await db.doc(`payments/${paymentId}`).set({ amount: 1500, memberId, method: 'Cash' })
  return { memberId, paymentId }
}

/** The dump restricted to this suite's documents. */
async function ownDump() {
  const dump = await exportAllCollections(db)
  const pick = (rows = []) => rows.filter((row) => row.id.startsWith(S.prefix))
  return { members: pick(dump.members), payments: pick(dump.payments) }
}

describe('export', () => {
  it('exports every collection it can see, with document ids preserved', async () => {
    const { memberId } = await seedFixture()
    const dump = await exportAllCollections(db)

    expect(Array.isArray(dump.members)).toBe(true)
    const row = dump.members.find((entry) => entry.id === memberId)
    expect(row).toBeDefined()
    expect(row.id).toBe(memberId)
    expect(row.name).toBe('Backup Fixture')
    expect(row.notes).toEqual({ source: 'drill', tags: ['a', 'b'] })
  })
})

describe('restore', () => {
  it('puts a deleted document back at its original id with identical values', async () => {
    const { memberId } = await seedFixture()
    const dump = await ownDump()
    const before = dump.members.find((row) => row.id === memberId)

    await db.doc(`members/${memberId}`).delete()
    expect((await db.doc(`members/${memberId}`).get()).exists).toBe(false)

    const written = await restoreAllCollections(db, dump)
    expect(written.members).toBe(dump.members.length)

    const restored = await db.doc(`members/${memberId}`).get()
    expect(restored.exists).toBe(true)
    expect({ id: restored.id, ...restored.data() }).toEqual(before)
  })

  it('reports counts but writes nothing on a dry run', async () => {
    const { memberId } = await seedFixture()
    const dump = await ownDump()
    await db.doc(`members/${memberId}`).delete()

    const written = await restoreAllCollections(db, dump, { dryRun: true })
    expect(written.members).toBe(dump.members.length)
    // Evidence, not a write: the drill can be pointed at real data safely.
    expect((await db.doc(`members/${memberId}`).get()).exists).toBe(false)
  })

  it('refuses a row without a document id instead of inventing one', async () => {
    await expect(
      restoreAllCollections(db, { members: [{ name: 'no id' }] })
    ).rejects.toThrow(/no document id/)
  })
})

describe('comparison (the part a drill needs)', () => {
  it('reports no drift immediately after a restore', async () => {
    const { memberId } = await seedFixture()
    const dump = await ownDump()
    await db.doc(`members/${memberId}`).delete()
    await restoreAllCollections(db, dump)

    const diff = await compareBackup(db, dump)
    expect(diff.missing).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.total).toBe(dump.members.length + dump.payments.length)
  })

  it('reports a missing document', async () => {
    const { memberId } = await seedFixture()
    const dump = await ownDump()
    await db.doc(`members/${memberId}`).delete()

    const diff = await compareBackup(db, dump)
    expect(diff.missing).toContain(`members/${memberId}`)
  })

  it('reports a changed value', async () => {
    const { paymentId } = await seedFixture()
    const dump = await ownDump()
    await db.doc(`payments/${paymentId}`).update({ amount: 999 })

    const diff = await compareBackup(db, dump)
    expect(diff.changed).toContain(`payments/${paymentId}`)
  })

  it('is insensitive to field order, so a clean restore is not reported as change', async () => {
    const { memberId } = await seedFixture()
    const dump = await ownDump()
    const row = dump.members.find((entry) => entry.id === memberId)
    const reordered = Object.fromEntries(Object.entries(row).reverse())

    const diff = await compareBackup(db, { members: [reordered] })
    expect(diff.changed).toEqual([])
    expect(diff.missing).toEqual([])
  })
})
