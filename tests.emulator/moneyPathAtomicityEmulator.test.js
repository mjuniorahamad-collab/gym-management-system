/**
 * ATOMICITY OF THE MONEY PATH — proven by forcing the SNAPSHOT write to fail.
 *
 * `recordPayment` and `deletePayment` stage the payment (or its deletion), the
 * receipt counter, and every changed period snapshot in ONE transaction. This
 * suite makes the last of those writes impossible and then checks the database:
 * if the transaction is doing its job, the payment and the counter must be
 * untouched, because a transaction cannot commit a part of itself.
 *
 * The failure is injected through the rules, not through a mock: the
 * `memberships` block keeps `create` but loses `update`, so a snapshot write is
 * rejected by the emulator exactly as a rules rejection would be in production.
 *
 * Runs in its own emulator project so the modified ruleset can never leak into
 * the suites that assert the real `firestore.rules`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym-atomicity'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')
// Only the memberships UPDATE permission is dropped; every other guard is the
// real one, and the anchor match fails loudly if the block is ever reshaped.
const NO_SNAPSHOT_UPDATE_RULES = RULES.replace(
  /(match \/memberships\/\{id\} \{[\s\S]*?)allow create, update:/,
  '$1allow create:'
)
if (NO_SNAPSHOT_UPDATE_RULES === RULES) {
  throw new Error('atomicity fixture: could not remove the memberships update permission')
}

const OWNER = 'atomic-owner'
const PREFIX = 'HWG'
const PRICE = 2000

const fb = { db: null, isFirebaseConfigured: true }
vi.mock('@/firebase', () => ({
  get db() {
    return fb.db
  },
  get isFirebaseConfigured() {
    return fb.isFirebaseConfigured
  },
}))

const { setGymId } = await import('@/services/ownerContext')
const { recordPayment, deletePayment } = await import('@/services/payments')
const { __resetReceiptSeedCache } = await import('@/services/receipts')
const { __resetTenantReceiptPrefixCache } = await import('@/services/receiptPrefixGuard')

let env
let seq = 0

function freshIds() {
  seq += 1
  return {
    gymId: `atomic-gym-${seq}`,
    memberId: `atomic-member-${seq}`,
    planId: `atomic-plan-${seq}`,
    periodId: `atomic-period-${seq}`,
  }
}

async function seed(ids) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${ids.gymId}`).set({
      ownerUid: OWNER,
      name: 'Atomicity Gym',
      receiptPrefix: PREFIX,
      createdAt: new Date(),
    })
    await fs.doc(`users/${OWNER}`).set({ role: 'owner', gymId: ids.gymId })
    await fs.doc(`members/${ids.memberId}`).set({
      name: 'Sana Malik',
      gymId: ids.gymId,
      membershipPlanId: ids.planId,
      joinDate: '2026-01-01',
      createdAt: new Date(),
    })
    await fs.doc(`membershipPlans/${ids.planId}`).set({
      name: 'Monthly',
      price: PRICE,
      durationDays: 30,
      gymId: ids.gymId,
      createdAt: new Date(),
    })
    await fs.doc(`memberships/${ids.periodId}`).set({
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
  })
}

/** Read straight from the emulator, bypassing the (deliberately broken) rules. */
async function readRaw(path) {
  let row = null
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), path))
    row = snap.exists() ? { id: snap.id, ...snap.data() } : null
  })
  return row
}

async function paymentCount(ids) {
  const snap = await getDocs(
    query(collection(fb.db, 'payments'), where('gymId', '==', ids.gymId))
  )
  return snap.size
}

const paymentValues = (ids, extra) => ({
  amount: PRICE,
  memberId: ids.memberId,
  membershipId: ids.periodId,
  date: '2026-01-05',
  method: 'Cash',
  ...extra,
})

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules: NO_SNAPSHOT_UPDATE_RULES },
  })
  fb.db = env.authenticatedContext(OWNER).firestore()
})

afterAll(async () => {
  await env.cleanup()
})

beforeEach(() => {
  __resetReceiptSeedCache()
  __resetTenantReceiptPrefixCache()
})

describe('atomicity — the snapshot write cannot be lost', () => {
  it('the injected ruleset still allows the payment and counter writes', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    // If THIS failed, the tests below would prove nothing: the payment would be
    // rejected on its own account rather than sharing a failed transaction.
    const { addDoc, collection: col, doc: docRef, setDoc } = await import('firebase/firestore')
    await expect(
      addDoc(col(fb.db, 'payments'), {
        amount: 100,
        memberId: ids.memberId,
        membershipId: ids.periodId,
        date: '2026-01-05',
        method: 'Cash',
        receiptNo: `${PREFIX}-000001`,
        type: 'membership',
        gymId: ids.gymId,
      })
    ).resolves.toBeTruthy()
    await expect(
      setDoc(docRef(fb.db, `counters/receiptNo_${ids.gymId}`), { value: 1, gymId: ids.gymId })
    ).resolves.toBeUndefined()
  })

  it('records no payment and burns no receipt number when the snapshot write is rejected', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    await expect(
      recordPayment({
        values: paymentValues(ids),
        memberName: 'Sana Malik',
        receiptPrefix: PREFIX,
      })
    ).rejects.toThrow(/permission-denied|PERMISSION_DENIED|Missing or insufficient permissions/i)

    // The payment write itself was legal — it is only absent because it shared
    // a transaction with a write that failed.
    expect(await paymentCount(ids)).toBe(0)
    // The counter was incremented in the same transaction, so it rolled back
    // with it: the next real payment still gets receipt HWG-000001.
    expect(await readRaw(`counters/receiptNo_${ids.gymId}`)).toBeNull()
    expect(await readRaw(`memberships/${ids.periodId}`)).toMatchObject({ amountPaid: 0 })
  })

  it('keeps the payment when the snapshot write on delete is rejected', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    // Seed a period that is already fully paid, so deleting its payment MUST
    // produce a snapshot patch — and that patch is what gets rejected.
    let paymentId
    const before = await readRaw(`memberships/${ids.periodId}`)
    expect(before).toBeTruthy()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      const ref = await fs.collection('payments').add({
        amount: PRICE,
        memberId: ids.memberId,
        membershipId: ids.periodId,
        date: '2026-01-05',
        method: 'Cash',
        receiptNo: `${PREFIX}-000009`,
        type: 'membership',
        gymId: ids.gymId,
        createdAt: new Date(),
      })
      paymentId = ref.id
      await fs.doc(`memberships/${ids.periodId}`).update({
        amountPaid: PRICE,
        amountDue: 0,
        paymentStatus: 'paid',
      })
    })

    await expect(
      deletePayment({
        payment: {
          id: paymentId,
          memberId: ids.memberId,
          amount: PRICE,
          membershipId: ids.periodId,
          memberName: 'Sana Malik',
        },
      })
    ).rejects.toThrow(/permission-denied|PERMISSION_DENIED|Missing or insufficient permissions/i)

    // The delete was staged in the same transaction as the rejected snapshot
    // write, so the cash is still on record.
    expect(await readRaw(`payments/${paymentId}`)).toMatchObject({ amount: PRICE })
    expect(await readRaw(`memberships/${ids.periodId}`)).toMatchObject({ amountPaid: PRICE })
  })
})
