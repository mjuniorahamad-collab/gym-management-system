import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Read-shape contract for the two finance services after the collection-scan
 * removal.
 *
 * Both used to answer a one-member / one-period question by pulling the whole
 * `payments` and `memberships` collections. They now ask Firestore for exactly
 * what they need (`listAll(name, { where: { field, value } })`). This file pins
 * that shape, because a regression here is invisible in the UI and only shows
 * up as a Firestore bill and a slow screen once a gym has real history.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    getById: vi.fn(),
    listAll: vi.fn(),
    createDoc: vi.fn(),
    updateDocById: vi.fn(),
    removeDoc: vi.fn(),
    commitAtomically: vi.fn(),
    logAudit: vi.fn(),
  },
}))

vi.mock('@/services/firestore', () => ({
  getById: mocks.getById,
  listAll: mocks.listAll,
  createDoc: mocks.createDoc,
  updateDocById: mocks.updateDocById,
  removeDoc: mocks.removeDoc,
  commitAtomically: mocks.commitAtomically,
}))

vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))

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

/** Honours the new `listAll` options, exactly like the Firestore implementation. */
function stubCollections() {
  mocks.getById.mockImplementation(async (name, id) =>
    name === 'members' ? { ...MEMBER, id } : null
  )
  mocks.listAll.mockImplementation(async (name, options = {}) => {
    const rows =
      name === 'payments'
        ? PAYMENTS.map((p) => ({ ...p }))
        : name === 'memberships'
          ? remainingMemberships.map((p) => ({ ...p }))
          : name === 'membershipPlans'
            ? [{ ...PLAN }]
            : []
    const filter = options.where
    const filtered = filter ? rows.filter((d) => d && d[filter.field] === filter.value) : rows
    return options.limit ? filtered.slice(0, options.limit) : filtered
  })
}

const callsFor = (name) => mocks.listAll.mock.calls.filter((c) => c[0] === name)

beforeEach(() => {
  vi.clearAllMocks()
  remainingMemberships = PERIODS.map((p) => ({ ...p }))
  stubCollections()
  mocks.updateDocById.mockResolvedValue()
  mocks.removeDoc.mockResolvedValue()
  mocks.logAudit.mockResolvedValue()
})

describe('refreshMembershipSnapshots reads', () => {
  it("reads this member's payments and memberships once each, scoped by memberId", async () => {
    await refreshMembershipSnapshots('m1')

    expect(callsFor('payments')).toHaveLength(1)
    expect(callsFor('memberships')).toHaveLength(1)
    expect(callsFor('payments')[0][1]).toEqual({ where: { field: 'memberId', value: 'm1' } })
    expect(callsFor('memberships')[0][1]).toEqual({ where: { field: 'memberId', value: 'm1' } })
  })

  it('returns without reading anything for a missing member id', async () => {
    expect(await refreshMembershipSnapshots('')).toEqual([])
    expect(await refreshMembershipSnapshots(undefined)).toEqual([])
    expect(mocks.listAll).not.toHaveBeenCalled()
  })
})

/** Everything the service stages inside the one transaction. */
let staged = []

beforeEach(() => {
  staged = []
  mocks.commitAtomically.mockImplementation(async (apply) => {
    const tx = {
      get: async () => null,
      newId: (name) => `new-${name}`,
      create: (name, data, id) => staged.push({ op: 'create', name, id: id || `new-${name}`, data }),
      update: (name, id, data) => {
        staged.push({ op: 'update', name, id, data })
        if (name === 'memberships') {
          const doc = remainingMemberships.find((p) => p.id === id)
          if (doc) Object.assign(doc, data)
        }
      },
      remove: (name, id) => {
        staged.push({ op: 'remove', name, id })
        if (name === 'memberships') {
          remainingMemberships = remainingMemberships.filter((p) => p.id !== id)
        }
      },
    }
    return apply(tx)
  })
})

describe('deleteMembershipPeriod reads', () => {

  it('reads payments once, scoped to the deleted period', async () => {
    await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })

    const byPeriod = callsFor('payments').filter((c) => c[1]?.where?.field === 'membershipId')
    expect(byPeriod).toHaveLength(1)
    expect(byPeriod[0][1]).toEqual({ where: { field: 'membershipId', value: 'ms1' } })
    // No unfiltered payments read: the whole-collection scan is gone. (The
    // follow-up ledger refresh reads by memberId, never the collection.)
    expect(callsFor('payments').filter((c) => !c[1]?.where)).toHaveLength(0)
  })

  it('unlinks only the payments that targeted the deleted period', async () => {
    const result = await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })
    expect(result.affectedPayments.map((p) => p.id)).toEqual(['pay1'])

    const unlinks = staged.filter((s) => s.op === 'update' && s.name === 'payments')
    expect(unlinks).toEqual([{ op: 'update', name: 'payments', id: 'pay1', data: { membershipId: '' } }])
  })

  it('stages the unlink, the delete and the re-snapshots in ONE transaction', async () => {
    await deleteMembershipPeriod({ periodId: 'ms1', memberId: 'm1' })

    expect(mocks.commitAtomically).toHaveBeenCalledTimes(1)
    // The period delete and the unlinks are no longer separate writes...
    expect(staged.filter((s) => s.op === 'remove')).toEqual([
      { op: 'remove', name: 'memberships', id: 'ms1' },
    ])
    // ...and the snapshots they imply are staged in the same unit. pay1's 1000
    // is freed by the unlink, but it is dated BEFORE the remaining period, so
    // the ledger reconstructs an implicit origin period for it (utils/dues.js)
    // instead of overpaying ms2 — ms2 keeps only its own 250.
    expect(staged.filter((s) => s.op === 'update' && s.name === 'memberships')).toEqual([
      {
        op: 'update',
        name: 'memberships',
        id: 'ms2',
        data: { amountPaid: 250, amountDue: 750, paymentStatus: 'partial' },
      },
    ])
  })

  it('still requires both ids', async () => {
    await expect(deleteMembershipPeriod({ memberId: 'm1' })).rejects.toThrow(/period ID/)
    await expect(deleteMembershipPeriod({ periodId: 'ms1' })).rejects.toThrow(/member ID/)
    expect(mocks.listAll).not.toHaveBeenCalled()
  })
})
