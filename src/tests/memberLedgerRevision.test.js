import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ledger-revision guard's own contract.
 *
 * The emulator suite (`ledgerIsolationEmulator.test.js`) proves the guard works
 * against real Firestore with the real rules. This file pins the parts that do
 * not need a database: where the revision comes from, how many re-reads a
 * conflict costs, that a non-conflict error is never retried, and that the bump
 * merges into an existing member update instead of writing the document twice.
 */
const { mocks } = vi.hoisted(() => ({ mocks: { getById: vi.fn(), listAll: vi.fn() } }))

vi.mock('@/services/firestore', () => ({
  getById: mocks.getById,
  listAll: mocks.listAll,
}))

const { bumpLedgerRevision, LedgerConflictError, readLedgerSnapshot, withLedgerRevision } =
  await import('@/services/memberLedger')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listAll.mockResolvedValue([])
})

describe('readLedgerSnapshot', () => {
  it("takes the revision from the member document it already reads", async () => {
    mocks.getById.mockResolvedValue({ id: 'm1', ledgerRevision: 4 })
    const snapshot = await readLedgerSnapshot('m1')
    expect(snapshot.revision).toBe(4)
    // The member read is the ledger read, not an extra query for the revision.
    expect(mocks.getById).toHaveBeenCalledTimes(1)
    expect(mocks.getById).toHaveBeenCalledWith('members', 'm1')
  })

  it('treats an absent or unusable revision as 0', async () => {
    mocks.getById.mockResolvedValue({ id: 'm1' })
    expect((await readLedgerSnapshot('m1')).revision).toBe(0)
    mocks.getById.mockResolvedValue({ id: 'm1', ledgerRevision: 'not-a-number' })
    expect((await readLedgerSnapshot('m1')).revision).toBe(0)
  })
})

describe('withLedgerRevision', () => {
  it('re-reads the ledger and retries when a concurrent write bumped the revision', async () => {
    mocks.getById
      .mockResolvedValueOnce({ id: 'm1', ledgerRevision: 0 })
      .mockResolvedValueOnce({ id: 'm1', ledgerRevision: 1 })
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new LedgerConflictError('moved'))
      .mockImplementationOnce(async (inputs) => inputs.revision)

    await expect(withLedgerRevision('m1', attempt)).resolves.toBe(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    // The retry recomputes from a FRESH read, not the stale one.
    expect(mocks.getById).toHaveBeenCalledTimes(2)
  })

  it('gives up after three attempts and rethrows the conflict', async () => {
    mocks.getById.mockResolvedValue({ id: 'm1', ledgerRevision: 0 })
    const attempt = vi.fn().mockRejectedValue(new LedgerConflictError('moved'))

    await expect(withLedgerRevision('m1', attempt)).rejects.toBeInstanceOf(LedgerConflictError)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('never retries a non-conflict error', async () => {
    mocks.getById.mockResolvedValue({ id: 'm1', ledgerRevision: 0 })
    const denied = Object.assign(new Error('PERMISSION_DENIED'), { code: 'permission-denied' })
    const attempt = vi.fn().mockRejectedValue(denied)

    await expect(withLedgerRevision('m1', attempt)).rejects.toBe(denied)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('attempts once with null when the operation has no member', async () => {
    const attempt = vi.fn(async (inputs) => inputs)
    await expect(withLedgerRevision('', attempt)).resolves.toBeNull()
    await expect(withLedgerRevision(undefined, attempt)).resolves.toBeNull()
    expect(attempt).toHaveBeenCalledTimes(2)
    // No member means no ledger read at all.
    expect(mocks.getById).not.toHaveBeenCalled()
  })
})

describe('bumpLedgerRevision', () => {
  it('merges the bump into the caller patch, as ONE member write', () => {
    const writes = []
    bumpLedgerRevision({ update: (...args) => writes.push(args) }, 'm1', 2, { membershipPlanId: 'p9' })

    expect(writes).toEqual([
      ['members', 'm1', { membershipPlanId: 'p9', ledgerRevision: 3 }],
    ])
  })

  it('bumps on its own when there is no patch', () => {
    const writes = []
    bumpLedgerRevision({ update: (...args) => writes.push(args) }, 'm1', 0)
    expect(writes).toEqual([['members', 'm1', { ledgerRevision: 1 }]])
  })
})
