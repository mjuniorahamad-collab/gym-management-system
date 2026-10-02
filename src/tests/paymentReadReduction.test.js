import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mocks, captured } = vi.hoisted(() => ({
  captured: [],
  mocks: {
    getById: vi.fn(),
    listAll: vi.fn(),
    createDoc: vi.fn(),
    updateDocById: vi.fn(),
    removeDoc: vi.fn(),
    logAudit: vi.fn(),
  },
}))

vi.mock('@/services/firestore', () => ({
  getById: mocks.getById,
  listAll: mocks.listAll,
  createDoc: mocks.createDoc,
  updateDocById: mocks.updateDocById,
  removeDoc: mocks.removeDoc,
}))

vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))

// Call through to the real implementation while recording what
// deleteMembershipPeriod hands it, so the override is observed rather than
// re-derived inside the test.
vi.mock('@/services/payments', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    refreshMembershipSnapshots: (...args) => {
      captured.push(args)
      return actual.refreshMembershipSnapshots(...args)
    },
  }
})

const { refreshMembershipSnapshots } = await import('@/services/payments')
const { deleteMembershipPeriod } = await import('@/services/memberships')

const PLAN = { id: 'p1', name: 'Monthly', price: 1000, durationDays: 30, gymId: 'g1' }
const MEMBER = { id: 'm1', name: 'Javed', joinDate: '2026-01-01', membershipPlanId: 'p1', gymId: 'g1' }

const PERIODS = [
  { id: 'ms1', memberId: 'm1', planId: 'p1', planName: 'Monthly', startDate: '2026-01-01', expiryDate: '2026-01-31', price: 1000, gymId: 'g1' },
  { id: 'ms2', memberId: 'm1', planId: 'p1', planName: 'Monthly', startDate: '2026-02-01', expiryDate: '2026-03-02', price: 1000, gymId: 'g1' },
]

const PAYMENTS = [
  { id: 'pay1', memberId: 'm1', membershipId: 'ms1', amount: 1000, date: '2026-01-05', gymId: 'g1' },
  { id: 'pay2', memberId: 'm1', membershipId: 'ms2', amount: 250, date: '2026-02-05', gymId: 'g1' },
]

let remainingMemberships = PERIODS.map((p) => ({ ...p }))

function stubCollections() {
  mocks.getById.mockImplementation(async (name, id) =>
    name === 'members' ? { ...MEMBER, id } : null
  )
  mocks.listAll.mockImplementation(async (name) => {
    if (name === 'payments') return PAYMENTS.map((p) => ({ ...p }))
    if (name === 'memberships') return remainingMemberships.map((p) => ({ ...p }))
    if (name === 'membershipPlans') return [PLAN]
    return []
  })
}

const paymentReads = () => mocks.listAll.mock.calls.filter((c) => c[0] === 'payments').length
const collectionsRead = () => mocks.listAll.mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.clearAllMocks()
  captured.length = 0
  remainingMemberships = PERIODS.map((p) => ({ ...p }))
  stubCollections()
  mocks.updateDocById.mockResolvedValue()
  mocks.removeDoc.mockResolvedValue()
  mocks.logAudit.mockResolvedValue()
})

describe('refreshMembershipSnapshots payment reads', () => {
  it('reads the payments collection when no override is supplied', async () => {
    await refreshMembershipSnapshots('m1')
    expect(paymentReads()).toBe(1)
  })

  it('does not read payments when the caller supplies them', async () => {
    await refreshMembershipSnapshots('m1', { payments: PAYMENTS.map((p) => ({ ...p })) })
    expect(paymentReads()).toBe(0)
  })

  it('still reads memberships and plans when payments are supplied', async () => {
    await refreshMembershipSnapshots('m1', { payments: [] })
    const names = collectionsRead()
    expect(names).toContain('memberships')
    expect(names).toContain('membershipPlans')
    expect(names).not.toContain('payments')
  })

  it('writes identical snapshots with and without the override', async () => {
    const supplied = await refreshMembershipSnapshots('m1', {
      payments: PAYMENTS.map((p) => ({ ...p })),
    })
    const suppliedWrites = mocks.updateDocById.mock.calls.map((c) => c.slice(0, 3))

    vi.clearAllMocks()
    mocks.updateDocById.mockResolvedValue()
    stubCollections()
    const fetched = await refreshMembershipSnapshots('m1')
    const fetchedWrites = mocks.updateDocById.mock.calls.map((c) => c.slice(0, 3))

    expect(supplied).toEqual(fetched)
    expect(suppliedWrites).toEqual(fetchedWrites)
    expect(suppliedWrites.length).toBeGreaterThan(0)
  })

  it('returns without reading anything for a missing member id', async () => {
    expect(await refreshMembershipSnapshots('')).toEqual([])
    expect(await refreshMembershipSnapshots(undefined)).toEqual([])
    expect(mocks.listAll).not.toHaveBeenCalled()
  })
})

describe('deleteMembershipPeriod payment reads', () => {
  beforeEach(() => {
    mocks.removeDoc.mockImplementation(async (name, id) => {
      if (name === 'memberships') {
        remainingMemberships = remainingMemberships.filter((p) => p.id !== id)
      }
    })
  })

  it('reads the payments collection once instead of twice', async () => {
    await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })
    expect(paymentReads()).toBe(1)
  })

  it('unlinks only the payments that targeted the deleted period', async () => {
    const result = await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })
    expect(result.affectedPayments.map((p) => p.id)).toEqual(['pay1'])
    expect(mocks.updateDocById).toHaveBeenCalledWith('payments', 'pay1', { membershipId: '' })
    expect(mocks.updateDocById).not.toHaveBeenCalledWith('payments', 'pay2', expect.anything())
  })

  it('hands the refresh a payments copy with the deleted period unlinked', async () => {
    await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })

    expect(captured).toHaveLength(1)
    const [, options] = captured[0]
    expect(options).toBeDefined()
    // Mirrors the state a fresh read would observe: the deleted period's id no
    // longer appears as a membershipId, and no other payment is disturbed.
    expect(options.payments).toEqual([
      { ...PAYMENTS[0], membershipId: '' },
      PAYMENTS[1],
    ])
    // The override must be the whole collection, never pre-filtered to a member,
    // because the ledger does its own memberId filtering.
    expect(options.payments).toHaveLength(PAYMENTS.length)
  })

  it('leaves other members payments untouched in the override', async () => {
    const other = { id: 'pay9', memberId: 'm2', membershipId: 'msX', amount: 500, date: '2026-01-06', gymId: 'g1' }
    mocks.listAll.mockImplementation(async (name) => {
      if (name === 'payments') return [...PAYMENTS.map((p) => ({ ...p })), { ...other }]
      if (name === 'memberships') return remainingMemberships.map((p) => ({ ...p }))
      if (name === 'membershipPlans') return [PLAN]
      return []
    })

    await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })

    const [, options] = captured[0]
    expect(options.payments).toContainEqual(other)
    expect(options.payments).not.toContainEqual(expect.objectContaining({ id: 'pay1', membershipId: 'ms1' }))
  })

  it('recomputes snapshots after the delete, not before', async () => {
    await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })
    expect(mocks.removeDoc).toHaveBeenCalledWith('memberships', 'ms1')
    const removeOrder = mocks.removeDoc.mock.invocationCallOrder[0]
    expect(remainingMemberships.map((p) => p.id)).toEqual(['ms2'])
    expect(removeOrder).toBeLessThan(mocks.updateDocById.mock.invocationCallOrder.at(-1))
  })

  it('still requires both ids', async () => {
    await expect(deleteMembershipPeriod({ memberId: 'm1' })).rejects.toThrow(/period ID/)
    await expect(deleteMembershipPeriod({ periodId: 'ms1' })).rejects.toThrow(/member ID/)
    expect(mocks.listAll).not.toHaveBeenCalled()
  })
})