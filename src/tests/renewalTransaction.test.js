import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * In-memory Firestore transaction emulator, modelled on the one in
 * attendanceSessions.test.js.
 *
 * `runTransaction` serialises callbacks and commits the staged writes only if
 * the callback returns. A throw discards them, which is the property the renewal
 * depends on: a period, its payment, the member update and the receipt counter
 * are either all visible or none are.
 *
 * Renewal's financial writes cannot be exercised through the sequential mock
 * store, because that store has no notion of a rollback — it would pass even if
 * the real transaction were broken.
 */
const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    collection: vi.fn((db, name) => ({ __collection: name })),
    doc: vi.fn((...args) => {
      // doc(collection(db, name)) -> auto-id reference. Firestore assigns the
      // id synchronously, so the mock must too, or the period could be written
      // without the payment id it needs to link to.
      if (args.length === 1) {
        const id = `${args[0].__collection}-${state.autoCounter++}`
        return { __collection: args[0].__collection, __autoId: true, id }
      }
      return { __collection: args[1], __path: `${args[1]}/${args[2]}`, id: args[2] }
    }),
    runTransaction: vi.fn(),
    getDoc: vi.fn(),
    createDoc: vi.fn(),
    updateDocById: vi.fn(),
    logAudit: vi.fn(),
    getGymId: vi.fn(() => 'gym-1'),
  },
  state: { docs: new Map(), autoCounter: 0, retries: 0 },
}))

vi.mock('firebase/firestore', () => ({
  collection: mocks.collection,
  doc: mocks.doc,
  runTransaction: mocks.runTransaction,
  getDoc: mocks.getDoc,
}))

vi.mock('@/firebase', () => ({ db: {}, isFirebaseConfigured: true }))
vi.mock('@/services/ownerContext', () => ({ getGymId: mocks.getGymId, DEMO_GYM_ID: 'demo' }))
vi.mock('@/services/audit', () => ({ logAudit: mocks.logAudit }))

// The sequential writes must never be reached once a gym is established. If a
// change routes a renewal back through them, these throw instead of quietly
// reintroducing the partial-write window this commit closes.
vi.mock('@/services/firestore', () => ({
  isReady: () => true,
  createDoc: (...args) => mocks.createDoc(...args),
  updateDocById: (...args) => mocks.updateDocById(...args),
  // Used only to seed the receipt counter above any legacy receipt numbers.
  // No legacy rows here, so the first receipt starts at 1.
  listAll: async () => [],
}))

const load = async () => import('@/services/renewals')

const pathOf = (ref) => (ref.__autoId ? `${ref.__collection}/${ref.id}` : ref.__path)

function installTransactionalFirestore({ failOn } = {}) {
  let chain = Promise.resolve()

  mocks.runTransaction.mockImplementation((db, callback) => {
    const run = async () => {
      const snapshot = new Map(state.docs)
      const staged = new Map()

      const tx = {
        get: async (ref) => {
          const key = pathOf(ref)
          const value = staged.has(key) ? staged.get(key) : snapshot.get(key)
          return { exists: () => value !== undefined && value !== null, data: () => value }
        },
        set: (ref, value, options) => {
          const key = pathOf(ref)
          if (failOn && key.startsWith(failOn)) {
            // Firestore evaluates the write against the server; a rejected write
            // aborts the whole transaction.
            throw new Error(`PERMISSION_DENIED: ${key}`)
          }
          // Honour `merge`, exactly as the server does. Without this the member
          // document would be replaced wholesale on renewal and the test would
          // "pass" while hiding the fact that joinDate survives only because of
          // the merge flag.
          const current = staged.get(key) ?? snapshot.get(key)
          staged.set(key, options?.merge ? { ...(current || {}), ...value } : value)
          return ref
        },
      }

      const result = await callback(tx)
      for (const [key, value] of staged) state.docs.set(key, value)
      return result
    }

    const next = chain.then(run, run)
    chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  })
}

const rows = (collection) =>
  [...state.docs.entries()]
    .filter(([k]) => k.startsWith(`${collection}/`))
    .map(([key, v]) => ({ id: key.slice(collection.length + 1), ...v }))

const counter = () => state.docs.get('counters/receiptNo_gym-1')

const plan = { id: 'plan-90', name: '3 Months', durationDays: 90, price: 3500, active: true }
const member = { id: 'm1', name: 'Zaid', status: 'expired', membershipPlanId: 'plan-90', joinDate: '2025-01-10' }

const renewal = (over = {}) => ({
  member,
  plan,
  currentExpiry: '2026-01-01',
  paidAmount: 3500,
  method: 'Cash',
  date: '2026-02-01',
  ...over,
})

describe('renewMembership transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.docs = new Map()
    state.autoCounter = 0
    mocks.getGymId.mockReturnValue('gym-1')
    mocks.logAudit.mockResolvedValue(undefined)
    mocks.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined })
    state.docs.set('members/m1', { ...member })
    installTransactionalFirestore()
  })

  it('writes the period, payment, member update and counter in one transaction', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())

    expect(mocks.runTransaction).toHaveBeenCalledTimes(1)
    // The sequential path must not run alongside the transaction.
    expect(mocks.createDoc).not.toHaveBeenCalled()
    expect(mocks.updateDocById).not.toHaveBeenCalled()

    expect(rows('memberships')).toHaveLength(1)
    expect(rows('payments')).toHaveLength(1)
    expect(counter().value).toBe(1)
  })

  it('links the period and payment to each other and share one receipt number', async () => {
    const { renewMembership } = await load()
    const result = await renewMembership(renewal())

    const [period] = rows('memberships')
    const [payment] = rows('payments')
    expect(period.paymentId).toBe(payment.id)
    expect(payment.membershipId).toBe(period.id)
    expect(period.receiptNo).toBe(payment.receiptNo)
    expect(period.receiptNo).toBe('HWG-000001')
    expect(result.membership.receiptNo).toBe('HWG-000001')
  })

  /**
   * The defect this replaces.
   *
   * joinDate is when the member joined the gym. Rewriting it on every renewal
   * made each renewal look like a new join, which inflated the dashboard and
   * Reports "new members this month" counts — both filter members on joinDate.
   */
  it('does not rewrite joinDate on renewal', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())
    expect(state.docs.get('members/m1').joinDate).toBe('2025-01-10')
  })

  it('backfills joinDate only when the member has none', async () => {
    state.docs.set('members/m2', { id: 'm2', name: 'New', membershipPlanId: 'plan-90', joinDate: '' })
    const { renewMembership } = await load()
    await renewMembership(renewal({ member: { ...member, id: 'm2', joinDate: '' }, effectiveStartDate: '2026-02-01' }))
    expect(state.docs.get('members/m2').joinDate).toBe('2026-02-01')
  })

  it('still advances the plan and activates the member', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())
    const stored = state.docs.get('members/m1')
    expect(stored.membershipPlanId).toBe('plan-90')
    expect(stored.status).toBe('active')
  })

  it('increments the counter once per renewal and never reuses a number', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())
    await renewMembership(renewal())
    await renewMembership(renewal())
    const numbers = rows('payments').map((p) => p.receiptNo)
    expect(numbers).toEqual(['HWG-000001', 'HWG-000002', 'HWG-000003'])
    expect(new Set(numbers).size).toBe(3)
  })

  it('leaves no trace when any write in the transaction is rejected', async () => {
    installTransactionalFirestore({ failOn: 'payments/' })
    const { renewMembership } = await load()

    // A fallback attempt is expected: the counter is a convenience, the payment
    // is the record. Both attempts fail on the payment, so nothing survives.
    await expect(renewMembership(renewal())).rejects.toThrow()

    expect(rows('memberships')).toHaveLength(0)
    expect(rows('payments')).toHaveLength(0)
    // The counter was never advanced, so no number is burned by a failed renewal.
    expect(counter()).toBeUndefined()
    expect(state.docs.get('members/m1').status).toBe('expired')
  })

  it('recovers when only the counter write is rejected', async () => {
    installTransactionalFirestore({ failOn: 'counters/' })
    const { renewMembership } = await load()
    const result = await renewMembership(renewal())

    // A payment is never refused because a receipt number could not be minted.
    expect(rows('memberships')).toHaveLength(1)
    expect(rows('payments')).toHaveLength(1)
    const [period] = rows('memberships')
    const [payment] = rows('payments')
    expect(period.receiptNo).toBe(payment.receiptNo)
    expect(period.receiptNo).toBeTruthy()
    expect(result.payment.receiptNo).toBe(period.receiptNo)
  })

  it('records the audit trail after the commit, not inside it', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())

    expect(mocks.logAudit).toHaveBeenCalledTimes(3)
    const entities = mocks.logAudit.mock.calls.map(([entry]) => entry.entity)
    expect(entities).toEqual(['payments', 'memberships', 'members'])
    // Each audit entry names a document that actually committed.
    for (const [entry] of mocks.logAudit.mock.calls) {
      expect(state.docs.has(`${entry.entity}/${entry.entityId}`)).toBe(true)
    }
  })

  it('refuses to renew before tenancy is established', async () => {
    mocks.getGymId.mockReturnValue(null)
    const { renewMembership } = await load()
    // No gym means the per-gym receipt counter cannot be addressed, so the
    // renewal must not silently fall back to a sequential write.
    await expect(renewMembership(renewal())).rejects.toThrow()
  })
})