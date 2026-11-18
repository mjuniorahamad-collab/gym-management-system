/**
 * MONEY PATH — END TO END AGAINST THE EMULATOR.
 *
 * Every other emulator suite talks to Firestore through the raw client SDK and
 * asks "are the rules right?". This one goes one level up: it calls the REAL
 * service functions the UI calls (`recordPayment`, `deletePayment`,
 * `deleteMembershipPeriod`) with the real `firestore.rules` enforced, and then
 * reads the database back to check the MONEY landed correctly:
 *
 *   - a receipt number is minted under the gym's own prefix, from the per-gym
 *     counter (so the second payment cannot reuse the first number),
 *   - the payment is attributed to the period it was recorded against,
 *   - the period's stored snapshot (amountPaid / amountDue / paymentStatus) is
 *     recomputed from the ledger rather than trusted from the form,
 *   - deleting a period unlinks its payments and FIFO-reallocates that cash onto
 *     the member's remaining period,
 *   - deleting the payment reverts the snapshot to "due",
 *   - each step appends an audit entry and asks for a reprojection.
 *
 * It also pins the READ SHAPE those services depend on: the filtered
 * (`memberId` / `membershipId`) reads go through Firestore and return the right
 * rows. The emulator does NOT enforce index requirements, so this suite proves
 * the queries are CORRECT, not that they are index-covered in production — that
 * is settled separately (all added queries are equality-only, served by
 * Firestore's automatic single-field indexes; see the audit report §11).
 *
 * The services are wired to the test client through a `@/firebase` stand-in
 * (`db` is the rules-testing client, so every write still passes the rules).
 * Reprojection is stubbed: it is a Cloud Functions call that deliberately never
 * throws, and there is no Functions emulator in this suite — the assertion here
 * is that it was ASKED for, once per mutation.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const OWNER = 'mp-owner'
const PREFIX = 'HWG'
const PRICE = 2000

// The services read `db` / `isFirebaseConfigured` at call time, so a mutable
// holder lets `beforeAll` hand them the rules-testing client instance.
const fb = { db: null, isFirebaseConfigured: true }
vi.mock('@/firebase', () => ({
  get db() {
    return fb.db
  },
  get isFirebaseConfigured() {
    return fb.isFirebaseConfigured
  },
}))

const reprojections = []
vi.mock('@/services/projection', () => ({
  requestReprojection: async (memberId) => {
    reprojections.push(memberId)
    return { ok: true }
  },
  requestReprojectionAndConfirm: async (memberId) => {
    reprojections.push(memberId)
    return { ok: true, trusted: true }
  },
}))

const { setGymId } = await import('@/services/ownerContext')
const { recordPayment, deletePayment } = await import('@/services/payments')
const { deleteMembershipPeriod } = await import('@/services/memberships')
const { __resetReceiptSeedCache } = await import('@/services/receipts')
const { __resetTenantReceiptPrefixCache } = await import('@/services/receiptPrefixGuard')

let env

/**
 * Unique ids per test. The emulator (and its database) is shared with the other
 * suites, so nothing here may clear or reuse another suite's documents — and a
 * fresh gym per test also gives each test its own receipt counter, which is what
 * makes `HWG-000001` a deterministic assertion instead of a race.
 */
let seq = 0
function freshIds() {
  seq += 1
  return {
    gymId: `mp-gym-${seq}`,
    memberId: `mp-member-${seq}`,
    planId: `mp-plan-${seq}`,
    periodA: `mp-period-${seq}-a`,
    periodB: `mp-period-${seq}-b`,
  }
}

/** Seed one gym, one plan, one member and (optionally) a second period. */
async function seed(ids, { secondPeriod = false } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${ids.gymId}`).set({
      ownerUid: OWNER,
      name: 'Money Path Gym',
      receiptPrefix: PREFIX,
      createdAt: new Date(),
    })
    await fs.doc(`users/${OWNER}`).set({ role: 'owner', gymId: ids.gymId })
    await fs.doc(`members/${ids.memberId}`).set({
      name: 'Aarav Khan',
      gymId: ids.gymId,
      membershipPlanId: ids.planId,
      joinDate: '2026-01-01',
      isPT: false,
      status: 'active',
      createdAt: new Date(),
    })
    await fs.doc(`membershipPlans/${ids.planId}`).set({
      name: 'Monthly',
      price: PRICE,
      durationDays: 30,
      gymId: ids.gymId,
      createdAt: new Date(),
    })
    await fs.doc(`memberships/${ids.periodA}`).set({
      memberId: ids.memberId,
      planId: ids.planId,
      planName: 'Monthly',
      price: PRICE,
      startDate: '2026-01-01',
      expiryDate: '2026-01-31',
      amountPaid: 0,
      amountDue: PRICE,
      paymentStatus: 'due',
      gymId: ids.gymId,
      createdAt: new Date(),
    })
    if (secondPeriod) {
      await fs.doc(`memberships/${ids.periodB}`).set({
        memberId: ids.memberId,
        planId: ids.planId,
        planName: 'Monthly',
        price: PRICE,
        startDate: '2026-02-01',
        expiryDate: '2026-02-28',
        amountPaid: 0,
        amountDue: PRICE,
        paymentStatus: 'due',
        gymId: ids.gymId,
        createdAt: new Date(),
      })
    }
  })
}

/**
 * Read a document back through the caller's client, so every assertion also
 * proves a finance reader can see what the money path wrote.
 *
 * A `getDoc` of a document that no longer exists is DENIED rather than empty:
 * the rule is evaluated against `resource == null`, which the tenant guard
 * rejects. For the "was it deleted?" assertions that denial IS the answer, so
 * it is mapped to null here and anything else is rethrown.
 */
async function read(path) {
  let snap
  try {
    snap = await getDoc(doc(fb.db, path))
  } catch (e) {
    if (e?.code === 'permission-denied') return null
    throw e
  }
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

async function auditEntries(ids) {
  const snap = await getDocs(
    query(collection(fb.db, 'auditLog'), where('gymId', '==', ids.gymId))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

function paymentValues(ids, extra) {
  return {
    amount: PRICE,
    memberId: ids.memberId,
    membershipId: ids.periodA,
    date: '2026-01-05',
    method: 'Cash',
    ...extra,
  }
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules },
  })
  fb.db = env.authenticatedContext(OWNER).firestore()
})

afterAll(async () => {
  await env.cleanup()
})

beforeEach(() => {
  __resetReceiptSeedCache()
  __resetTenantReceiptPrefixCache()
  reprojections.length = 0
})

describe('money path — recordPayment', () => {
  it('records a partial payment: cash lands, receipt is minted under the gym prefix, snapshot follows', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    const result = await recordPayment({
      values: paymentValues(ids, { amount: 500 }),
      memberName: 'Aarav Khan',
      planName: 'Monthly',
      receiptPrefix: PREFIX,
    })

    // Receipt comes from the per-gym counter, under the authoritative prefix.
    expect(result.receiptNo).toBe(`${PREFIX}-000001`)
    expect(result.amount).toBe(500)

    const payment = await read(`payments/${result.id}`)
    expect(payment).toMatchObject({
      amount: 500,
      memberId: ids.memberId,
      membershipId: ids.periodA,
      receiptNo: `${PREFIX}-000001`,
      type: 'membership',
      memberName: 'Aarav Khan',
      planName: 'Monthly',
      gymId: ids.gymId,
    })
    expect(payment.createdAt).toBeTruthy()

    // The stored snapshot is recomputed from the ledger, not copied from input.
    const period = await read(`memberships/${ids.periodA}`)
    expect(period).toMatchObject({
      amountPaid: 500,
      amountDue: PRICE - 500,
      paymentStatus: 'partial',
    })

    // Counter is a real document, so the next receipt cannot collide.
    const counter = await read(`counters/receiptNo_${ids.gymId}`)
    expect(counter.value).toBe(1)

    const audit = await auditEntries(ids)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'create', entity: 'payments', entityId: result.id })

    // Recording a payment writes the ledger snapshots itself; it does not ask
    // the server to reproject (that belongs to period edits/deletions).
    expect(reprojections).toEqual([])
  })

  it('a second payment settles the period, with the next receipt number', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    const first = await recordPayment({
      values: paymentValues(ids, { amount: 500 }),
      memberName: 'Aarav Khan',
      receiptPrefix: PREFIX,
    })
    const second = await recordPayment({
      values: paymentValues(ids, { amount: PRICE - 500 }),
      memberName: 'Aarav Khan',
      receiptPrefix: PREFIX,
    })

    expect(first.receiptNo).toBe(`${PREFIX}-000001`)
    expect(second.receiptNo).toBe(`${PREFIX}-000002`)
    expect(second.membership).toMatchObject({
      id: ids.periodA,
      amountPaid: PRICE,
      amountDue: 0,
      paymentStatus: 'paid',
    })

    const period = await read(`memberships/${ids.periodA}`)
    expect(period).toMatchObject({ amountPaid: PRICE, amountDue: 0, paymentStatus: 'paid' })
  })

  it('refuses a receipt prefix that does not match the gym authority, writing nothing', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    await expect(
      recordPayment({
        values: paymentValues(ids),
        memberName: 'Aarav Khan',
        receiptPrefix: 'XYZ',
      })
    ).rejects.toThrow(/does not match this gym's authoritative prefix/)

    // No payment, no counter movement, no snapshot change.
    const payments = await getDocs(
      query(collection(fb.db, 'payments'), where('memberId', '==', ids.memberId))
    )
    expect(payments.size).toBe(0)
    expect(await read(`counters/receiptNo_${ids.gymId}`)).toBeNull()
    expect((await read(`memberships/${ids.periodA}`)).amountPaid).toBe(0)
  })
})

describe('money path — deleteMembershipPeriod', () => {
  it('unlinks the period payments and FIFO-reallocates that cash onto the remaining period', async () => {
    const ids = freshIds()
    await seed(ids, { secondPeriod: true })

    // Period B is paid in full by one payment; period A has nothing yet.
    let paidPaymentId
    await env.withSecurityRulesDisabled(async (ctx) => {
      const ref = await ctx.firestore().collection('payments').add({
        amount: PRICE,
        memberId: ids.memberId,
        membershipId: ids.periodB,
        date: '2026-02-05',
        method: 'Cash',
        receiptNo: `${PREFIX}-000009`,
        type: 'membership',
        gymId: ids.gymId,
        createdAt: new Date(),
      })
      paidPaymentId = ref.id
      await ctx.firestore().doc(`memberships/${ids.periodB}`).update({
        amountPaid: PRICE,
        amountDue: 0,
        paymentStatus: 'paid',
      })
    })
    setGymId(ids.gymId)

    const result = await deleteMembershipPeriod({ periodId: ids.periodB, memberId: ids.memberId })

    // Only period B's payment was touched — the filtered read found exactly it.
    expect(result.affectedPayments).toHaveLength(1)
    expect(result.affectedPayments[0].id).toBe(paidPaymentId)

    // The period is gone and its payment is now unallocated cash.
    expect(await read(`memberships/${ids.periodB}`)).toBeNull()
    expect(await read(`payments/${paidPaymentId}`)).toMatchObject({
      membershipId: '',
      amount: PRICE,
    })

    // The ledger's FIFO pass attributed the freed cash to the remaining period.
    const periodA = await read(`memberships/${ids.periodA}`)
    expect(periodA).toMatchObject({ amountPaid: PRICE, amountDue: 0, paymentStatus: 'paid' })

    const audit = await auditEntries(ids)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'delete', entity: 'memberships', entityId: ids.periodB })

    expect(reprojections).toEqual([ids.memberId])
  })
})

describe('money path — deletePayment', () => {
  it('reverts the period snapshot when its payment is deleted', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    const recorded = await recordPayment({
      values: paymentValues(ids),
      memberName: 'Aarav Khan',
      receiptPrefix: PREFIX,
    })
    expect(await read(`memberships/${ids.periodA}`)).toMatchObject({
      amountPaid: PRICE,
      paymentStatus: 'paid',
    })

    await deletePayment({
      payment: { id: recorded.id, memberId: ids.memberId, amount: PRICE, membershipId: ids.periodA },
    })

    expect(await read(`payments/${recorded.id}`)).toBeNull()
    expect(await read(`memberships/${ids.periodA}`)).toMatchObject({
      amountPaid: 0,
      amountDue: PRICE,
      paymentStatus: 'due',
    })

    // Both mutations are audited. The delete entry used to vanish: its details
    // carried `memberName || undefined`, and Firestore rejects undefined — the
    // entry was dropped silently because logAudit never throws.
    const audit = await auditEntries(ids)
    expect(audit.map((a) => a.action).sort()).toEqual(['create', 'delete'])
    const deletion = audit.find((a) => a.action === 'delete')
    expect(deletion).toMatchObject({ entity: 'payments', entityId: recorded.id })
    expect(deletion.details).toMatchObject({ amount: PRICE, membershipId: ids.periodA })
    expect('member' in deletion.details).toBe(false)
  })
})
