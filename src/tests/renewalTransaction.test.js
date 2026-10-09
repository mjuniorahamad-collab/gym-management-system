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
    // The post-commit projection request. Mocked so a renewal can assert the
    // ORDER of operations without a live Functions backend; the real client is
    // covered in projectionClient.test.js.
    requestReprojection: vi.fn(async () => ({ ok: true, status: 'ok' })),
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
vi.mock('@/services/projection', () => ({ requestReprojection: mocks.requestReprojection }))

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

/**
 * Point reads outside a transaction.
 *
 * `gyms/{gymId}` is the authoritative home of the receipt prefix and is read by
 * the receipt-prefix guard before a renewal may start, so it must answer with
 * the same canonical value the fixture passes in. Everything else (the receipt
 * counter, in particular) is absent, which is what sends `prepareReceiptFloor`
 * down its legacy-sequence seed path.
 */
function answerReads() {
  mocks.getDoc.mockImplementation(async (ref) => {
    if (ref?.__collection === 'gyms') {
      return { exists: () => true, data: () => ({ receiptPrefix: 'HWG' }) }
    }
    return { exists: () => false, data: () => undefined }
  })
}

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
  receiptPrefix: 'HWG',
  ...over,
})

describe('renewMembership transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.docs = new Map()
    state.autoCounter = 0
    mocks.getGymId.mockReturnValue('gym-1')
    mocks.logAudit.mockResolvedValue(undefined)
    answerReads()
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
   * `canWriteTenant` (firestore.rules) requires every written document to carry
   * the caller's own gymId, on a create exactly as on an update. The demo path
   * gets this stamped by createDoc, but the transactional path writes raw
   * DocumentReferences and bypasses that helper, so it has to add the field
   * itself. Without it the rules reject the period AND the payment, and the
   * whole renewal fails with an opaque PERMISSION_DENIED.
   */
  it('stamps the bound gymId on the period and on the payment', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())

    const [period] = rows('memberships')
    const [payment] = rows('payments')
    expect(period.gymId).toBe('gym-1')
    expect(payment.gymId).toBe('gym-1')
  })

  it('stamps whichever gym is bound rather than a fixed one', async () => {
    mocks.getGymId.mockReturnValue('gym-9')
    const { renewMembership } = await load()
    await renewMembership(renewal())

    expect(rows('memberships')[0].gymId).toBe('gym-9')
    expect(rows('payments')[0].gymId).toBe('gym-9')
  })

  it('still carries gymId when the receipt counter fails and the fallback path runs', async () => {
    const { renewMembership } = await load()
    installTransactionalFirestore({ failOn: (c) => c === 'counters' })
    await renewMembership(renewal())

    expect(rows('memberships')[0].gymId).toBe('gym-1')
    expect(rows('payments')[0].gymId).toBe('gym-1')
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

  /**
 * The defect this replaces.
 *
 * The renewal used to write `status: 'active'` to the member INSIDE the payment
 * transaction. That put a cache field into the same atomic unit as the money:
 *
 * - the payment could only commit if the projection field was permitted, so a
 *   rules change on a cache field could start refusing real payments;
 * - 'active' was asserted regardless of whether the new period had even
 *   started, so a renewal booked for next month labelled the member active;
 * - any error deriving the field was, by construction, an error in taking money.
 *
 * Status is now derived server-side from the periods and requested after the
 * commit. The authoritative transaction must leave it completely alone.
 */
it('advances the plan but never writes the projection inside the transaction', async () => {
  const { renewMembership } = await load()
  // A stale cached value, standing in for whatever drift the document already had.
  state.docs.set('members/m1', { ...state.docs.get('members/m1'), status: 'expired' })

  await renewMembership(renewal())

  const stored = state.docs.get('members/m1')
  expect(stored.membershipPlanId).toBe('plan-90')
  // Untouched: the transaction has no opinion about a member's status.
  expect(stored.status).toBe('expired')
  // And it never invented the other projection fields either.
  expect(stored.effectiveExpiry).toBeUndefined()
  expect(stored.membershipStart).toBeUndefined()
  expect(stored.freezeUntil).toBeUndefined()
})

/**
 * The freshness sequence the whole design rests on: the authoritative write
 * commits first, and only then is the projection recompute requested.
 */
it('requests a reprojection after the commit, not inside it', async () => {
  const { renewMembership } = await load()
  const result = await renewMembership(renewal())

  expect(mocks.requestReprojection).toHaveBeenCalledWith('m1')
  // The result tells the caller whether `status` can now be trusted.
  expect(result).toHaveProperty('projectionFresh')
  expect(typeof result.projectionFresh).toBe('boolean')
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

/**
 * Commit C: the preserved post-expiry portion of a freeze is settled by the next
 * renewal.
 *
 * The property under test is that ONE payment carries both components while the
 * new PERIOD keeps only its own price. If the tail leaked into `price` the ledger
 * would bill those days again on every recompute; if it leaked only into the
 * payment the revenue would be unattributable to anything.
 */
describe('renewMembership freeze-tail settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.docs = new Map()
    state.autoCounter = 0
    mocks.getGymId.mockReturnValue('gym-1')
    mocks.logAudit.mockResolvedValue(undefined)
    answerReads()
    state.docs.set('members/m1', { ...member })
    installTransactionalFirestore()
  })

  // 3500 / 90 days = 38.888..., so 10 days = 388.888... -> 388.89.
  const tailBasis = { total: 3500, durationDays: 90 }
  const withTail = (over = {}) =>
    renewal({ freezeTailDays: 10, freezeTailBasis: tailBasis, freezeTailSettledFor: 'm-old', paidAmount: 3888.89, ...over })

  it('charges the tail in the same payment as the period', async () => {
    const { renewMembership } = await load()
    await renewMembership(withTail())

    const [payment] = rows('payments')
    expect(payment.amount).toBe(3888.89)
    expect(payment.freezeTailAmount).toBe(388.89)
    expect(payment.freezeTailDays).toBe(10)
  })

  it('keeps the tail OUT of the period price so the ledger cannot re-bill it', async () => {
    const { renewMembership } = await load()
    await renewMembership(withTail())

    const [period] = rows('memberships')
    // This is the load-bearing assertion of the whole design: `price` is what
    // dues.js keeps billing, so the extension days must never appear in it.
    expect(period.price).toBe(3500)
    expect(period.freezeTailAmount).toBe(388.89)
    expect(period.totalCharged).toBe(3888.89)
  })

  it('names the period it settled, so the charge is attributable and one-off', async () => {
    const { renewMembership } = await load()
    await renewMembership(withTail())

    const [period] = rows('memberships')
    expect(period.freezeTailSettledFor).toBe('m-old')
  })

  it('reports both components back without asking the caller to re-derive them', async () => {
    const { renewMembership } = await load()
    const result = await renewMembership(withTail())

    expect(result.freezeTail).toEqual({ days: 10, amount: 388.89 })
    expect(result.totals).toEqual({ periodPrice: 3500, tailAmount: 388.89, total: 3888.89 })
  })

  it('prices the tail from the frozen period snapshot, not a repriced plan', async () => {
    const { renewMembership } = await load()
    // The plan now costs 7000 (doubled). The snapshot says 3500/90, so the tail
    // must still be 10 days at the original rate.
    await renewMembership(withTail({ plan: { ...plan, price: 7000 } }))

    const [payment] = rows('payments')
    expect(payment.freezeTailAmount).toBe(388.89)
  })

  it('falls back to the granting plan when the period has no price snapshot', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal({ freezeTailDays: 10, freezeTailSettledFor: 'm-old', tailPricePlan: plan, paidAmount: 3888.89 }))

    const [payment] = rows('payments')
    expect(payment.freezeTailAmount).toBe(388.89)
  })

  /**
   * The failure mode this guards: an unpriceable tail resolving to zero would be
   * a write-off wearing a disguise — the member gets the days, the gym gets
   * nothing, and nothing in the data says so.
   */
  it('refuses the renewal when the tail exists but cannot be priced', async () => {
    const { renewMembership } = await load()
    // No snapshot and no granting plan: 10 days of entitlement, no way to value it.
    await expect(renewMembership(renewal({ freezeTailDays: 10, freezeTailSettledFor: 'm-old' }))).rejects.toThrow(/freeze extension/i)

    expect(rows('memberships')).toHaveLength(0)
    expect(rows('payments')).toHaveLength(0)
  })

  it('does not withhold a renewal that has no tail at all', async () => {
    // The unpriceable guard must be inert in the common case, including when the
    // granting plan has been deleted - there is nothing to price.
    const { renewMembership } = await load()
    await expect(renewMembership(renewal({ freezeTailDays: 0, tailPricePlan: null }))).resolves.toBeTruthy()
    expect(rows('payments')).toHaveLength(1)
  })

  it('rolls the whole renewal back when the tail pricing rejects it', async () => {
    const { renewMembership } = await load()
    await expect(renewMembership(withTail({ freezeTailBasis: { total: 0, durationDays: 90 } }))).rejects.toThrow()

    // No period, no payment, no member update: the member must not silently
    // become active on a renewal that never happened.
    expect(rows('memberships')).toHaveLength(0)
    expect(state.docs.get('members/m1').status).toBe('expired')
  })

  it('records the tail in the audit trail so the split survives the fact', async () => {
    const { renewMembership } = await load()
    await renewMembership(withTail())

    const [paymentAudit, periodAudit] = mocks.logAudit.mock.calls.map(([e]) => e)
    expect(paymentAudit.details.freezeTailAmount).toBe(388.89)
    expect(periodAudit.details.freezeTailAmount).toBe(388.89)
    expect(periodAudit.details.totalCharged).toBe(3888.89)
  })

  it('leaves a tail-free period snapshot free of settlement markers', async () => {
    const { renewMembership } = await load()
    await renewMembership(renewal())

    const [period] = rows('memberships')
    expect(period.freezeTailDays).toBe(0)
    expect(period.freezeTailAmount).toBe(0)
    expect(period.freezeTailSettledFor).toBeNull()
  })
})