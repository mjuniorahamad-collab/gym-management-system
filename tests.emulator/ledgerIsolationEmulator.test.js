/**
 * LEDGER ISOLATION — the figures a money transaction writes are not stale.
 *
 * `recordPayment`, `deletePayment`, `deleteMembershipPeriod` and
 * `renewMembership` are atomic: their writes commit together or not at all.
 * Atomicity alone does not make the FIGURES right, because the ledger is a
 * query and the web SDK's transaction cannot run one: the history is read
 * before the transaction opens. Two terminals could each read the same history,
 * compute different snapshots, and the later commit would silently overwrite
 * the earlier one.
 *
 * The guard is a per-member `ledgerRevision` on the member document: read with
 * the history, re-checked as the transaction's FIRST read, incremented by the
 * same commit that writes the snapshots. This suite proves it against the real
 * `firestore.rules` (no rules are modified here):
 *
 *   1. A commit carrying figures computed from an older read is REFUSED, and
 *      the snapshot written by the concurrent payment survives untouched.
 *   2. Two payments recorded at the same time both land, and the stored
 *      snapshot equals the ledger computed from the payments on record — the
 *      invariant the whole guard exists for.
 *
 * Runs in the shared `demo-himalye-gym` emulator project and gives every test
 * its own gym, so the receipt counter (and therefore the receipt number) is
 * deterministic without clearing another suite's data.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { computeMemberLedger } from '@/utils/dues'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const OWNER = 'iso-owner'
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

vi.mock('@/services/projection', () => ({
  requestReprojection: async () => ({ ok: true }),
  requestReprojectionAndConfirm: async () => ({ ok: true, trusted: true }),
}))

const { setGymId } = await import('@/services/ownerContext')
const { commitAtomically } = await import('@/services/firestore')
const { assertLedgerFresh, readLedgerSnapshot } = await import('@/services/memberLedger')
const { recordPayment, refreshMembershipSnapshots } = await import('@/services/payments')
const { editMembershipPeriod } = await import('@/services/memberships')
const { __resetReceiptSeedCache } = await import('@/services/receipts')
const { __resetTenantReceiptPrefixCache } = await import('@/services/receiptPrefixGuard')

let env
let seq = 0

function freshIds() {
  seq += 1
  return {
    gymId: `iso-gym-${seq}`,
    memberId: `iso-member-${seq}`,
    planId: `iso-plan-${seq}`,
    periodId: `iso-period-${seq}`,
  }
}

async function seed(ids) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${ids.gymId}`).set({
      ownerUid: OWNER,
      name: 'Isolation Gym',
      receiptPrefix: PREFIX,
      createdAt: new Date(),
    })
    await fs.doc(`users/${OWNER}`).set({ role: 'owner', gymId: ids.gymId })
    await fs.doc(`members/${ids.memberId}`).set({
      name: 'Imran Shah',
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

/** Read straight from the emulator, bypassing the rules under test. */
async function readRaw(path) {
  let row = null
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), path))
    row = snap.exists() ? { id: snap.id, ...snap.data() } : null
  })
  return row
}

const paymentValues = (ids, extra) => ({
  amount: PRICE / 2,
  memberId: ids.memberId,
  membershipId: ids.periodId,
  date: '2026-01-05',
  method: 'Cash',
  ...extra,
})

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
})

describe('ledger isolation — the figures cannot be stale', () => {
  it('refuses a commit built on an older ledger read, and the newer snapshot survives', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    // 1. A terminal reads the ledger: no payments, period fully due, revision 0.
    const stale = await readLedgerSnapshot(ids.memberId)
    expect(stale.revision).toBe(0)
    expect(stale.payments).toHaveLength(0)

    // 2. Another terminal takes a payment before that terminal commits.
    await recordPayment({
      values: paymentValues(ids),
      memberName: 'Imran Shah',
      receiptPrefix: PREFIX,
    })
    expect(await readRaw(`members/${ids.memberId}`)).toMatchObject({ ledgerRevision: 1 })
    expect(await readRaw(`memberships/${ids.periodId}`)).toMatchObject({
      amountPaid: PRICE / 2,
      paymentStatus: 'partial',
    })

    // 3. The stale commit tries to write the figures it computed from step 1 —
    //    "this period is entirely unpaid". It must be rejected, not applied.
    await expect(
      commitAtomically(async (tx) => {
        await assertLedgerFresh(tx, ids.memberId, stale.revision)
        tx.update('memberships', ids.periodId, {
          amountPaid: 0,
          amountDue: PRICE,
          paymentStatus: 'due',
        })
      })
    ).rejects.toThrow(/ledger moved from revision 0 to 1/)

    // 4. Nothing moved: the payment's snapshot is still the stored one.
    expect(await readRaw(`memberships/${ids.periodId}`)).toMatchObject({
      amountPaid: PRICE / 2,
      amountDue: PRICE / 2,
      paymentStatus: 'partial',
    })
    expect(await readRaw(`members/${ids.memberId}`)).toMatchObject({ ledgerRevision: 1 })
  })

  it('lands two simultaneous payments and stores a snapshot equal to the resulting ledger', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    // Both terminals read the same history and commit at the same time. One of
    // them may see the revision move and retry; neither may lose the other's
    // payment or leave a snapshot that ignores it.
    const results = await Promise.all([
      recordPayment({
        values: paymentValues(ids, { amount: 500 }),
        memberName: 'Imran Shah',
        receiptPrefix: PREFIX,
      }),
      recordPayment({
        values: paymentValues(ids, { amount: 500 }),
        memberName: 'Imran Shah',
        receiptPrefix: PREFIX,
      }),
    ])

    // Distinct receipts, from the same per-gym counter.
    const receipts = results.map((r) => r.receiptNo).sort()
    expect(receipts).toEqual([`${PREFIX}-000001`, `${PREFIX}-000002`])

    // Two payments on record.
    const payments = await getDocs(
      query(collection(fb.db, 'payments'), where('gymId', '==', ids.gymId))
    )
    expect(payments.size).toBe(2)

    // The stored snapshot is exactly what the ledger says it should be — this
    // is the assertion atomicity alone could not make.
    const member = await readRaw(`members/${ids.memberId}`)
    const period = await readRaw(`memberships/${ids.periodId}`)
    const plan = await readRaw(`membershipPlans/${ids.planId}`)
    const ledger = computeMemberLedger({
      member,
      plans: [plan],
      payments: payments.docs.map((d) => ({ id: d.id, ...d.data() })),
      memberships: [period],
    })
    const expected = ledger.periods.find((p) => p.id === ids.periodId)
    expect(period).toMatchObject({
      amountPaid: expected.paid,
      amountDue: expected.due,
      paymentStatus: expected.status,
    })
    expect(period.amountPaid).toBe(1000)

    // Both writers took part in the revision protocol.
    expect(await readRaw(`members/${ids.memberId}`)).toMatchObject({ ledgerRevision: 2 })
  })

  it('commits a period edit together with the dues it implies, and bumps the revision', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    await editMembershipPeriod({ periodId: ids.periodId, memberId: ids.memberId, patch: { price: 2500 } })

    // The period's OWN dues follow the edit: before it was 2000, now 2500.
    expect(await readRaw(`memberships/${ids.periodId}`)).toMatchObject({
      price: 2500,
      amountPaid: 0,
      amountDue: 2500,
      paymentStatus: 'due',
    })
    expect(await readRaw(`members/${ids.memberId}`)).toMatchObject({ ledgerRevision: 1 })
  })

  it("refuses to edit another member's period", async () => {
    const ids = freshIds()
    await seed(ids)
    const otherMemberId = `${ids.memberId}-other`
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`members/${otherMemberId}`).set({
        name: 'Other Member',
        gymId: ids.gymId,
        membershipPlanId: ids.planId,
        joinDate: '2026-01-01',
        createdAt: new Date(),
      })
    })
    setGymId(ids.gymId)

    // Same gym, different member: the period is not in that member's ledger, so
    // it must not be re-priced (nor their dues recomputed from it).
    await expect(
      editMembershipPeriod({ periodId: ids.periodId, memberId: otherMemberId, patch: { price: 9999 } })
    ).rejects.toThrow(/Membership period not found/)

    expect(await readRaw(`memberships/${ids.periodId}`)).toMatchObject({
      price: PRICE,
      amountDue: PRICE,
    })
    // Nothing was written, so no revision bump either.
    expect((await readRaw(`members/${otherMemberId}`))?.ledgerRevision).toBeUndefined()
  })

  it('does not let a price edit overwrite a payment taken at the same time', async () => {
    const ids = freshIds()
    await seed(ids)
    setGymId(ids.gymId)

    // The operator re-prices the period while the desk takes ₹1000 for it.
    await Promise.all([
      recordPayment({
        values: paymentValues(ids, { amount: 1000 }),
        memberName: 'Imran Shah',
        receiptPrefix: PREFIX,
      }),
      editMembershipPeriod({ periodId: ids.periodId, memberId: ids.memberId, patch: { price: 2500 } }),
    ])

    // Whichever landed first, the stored figures describe BOTH facts: the new
    // price and the money actually received. A pre-payment recompute would have
    // said "2500 due, nothing paid".
    const period = await readRaw(`memberships/${ids.periodId}`)
    expect(period).toMatchObject({ price: 2500, amountPaid: 1000, amountDue: 1500, paymentStatus: 'partial' })

    const payments = await getDocs(
      query(collection(fb.db, 'payments'), where('gymId', '==', ids.gymId))
    )
    const ledger = computeMemberLedger({
      member: await readRaw(`members/${ids.memberId}`),
      plans: [await readRaw(`membershipPlans/${ids.planId}`)],
      payments: payments.docs.map((d) => ({ id: d.id, ...d.data() })),
      memberships: [period],
    })
    const expected = ledger.periods.find((p) => p.id === ids.periodId)
    expect(period.amountPaid).toBe(expected.paid)
    expect(period.amountDue).toBe(expected.due)
  })

  it('repairs a drifted snapshot on the same guard, and a no-op refresh writes nothing', async () => {
    const ids = freshIds()
    await seed(ids)
    // A snapshot that does not match the ledger: the period claims ₹500 paid,
    // but there is no payment on record.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`memberships/${ids.periodId}`).update({
        amountPaid: 500,
        amountDue: 1500,
        paymentStatus: 'partial',
      })
    })
    setGymId(ids.gymId)

    const written = await refreshMembershipSnapshots(ids.memberId)
    expect(written).toEqual([{ id: ids.periodId, amountPaid: 0, amountDue: PRICE, paymentStatus: 'due' }])
    expect(await readRaw(`members/${ids.memberId}`)).toMatchObject({ ledgerRevision: 1 })

    // Already correct: no writes, so no revision bump for other terminals to
    // retry against.
    expect(await refreshMembershipSnapshots(ids.memberId)).toEqual([])
    expect(await readRaw(`members/${ids.memberId}`)).toMatchObject({ ledgerRevision: 1 })
  })
})
