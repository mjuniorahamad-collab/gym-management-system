/**
 * PHASE P1 — DIRECT FIRESTORE RECEIPT INTEGRITY (behavioral, additive)
 *
 * Companion to the frozen baseline (`firestoreSecurityEmulator.test.js`) and the
 * remediation suite (`firestoreSecurityRemediation.test.js`). Like those files,
 * every assertion here performs a REAL Firestore operation through the emulator
 * and the real `firestore.rules`; nothing inspects the rules as text.
 *
 * What this suite protects: a finance client (owner/admin) must not be able to
 * mint an arbitrary receipt number by writing directly to `payments` via the
 * SDK. A new receipt number must be issued under the caller's OWN authoritative
 * `gyms/{gymId}.receiptPrefix`, and once written it is immutable.
 *
 * All ids are `rpi-`-prefixed so this suite can never disturb the other two
 * emulator files, which run against the single shared emulator.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { deleteField } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

// Gym A carries a provisioned authority; Gym B carries a different one.
const GYM_A = 'rpi-gym-a'
const GYM_B = 'rpi-gym-b'
// Gym C exists but has NO `receiptPrefix` field: an unprovisioned authority.
const GYM_C = 'rpi-gym-c'

const A = { owner: 'rpi-owner-a', admin: 'rpi-admin-a', frontDesk: 'rpi-front-a' }
const B = { owner: 'rpi-owner-b' }
const C = { owner: 'rpi-owner-c' }
// A profile with a finance role but no bound gym.
const UNBOUND = 'rpi-unbound'

const PREFIX_A = 'HWG'
const PREFIX_B = 'OXY'

// Historical receipts: a legacy numeric value with no separator, and a
// pre-existing branded value that happens to match today's authority.
const HIST_LEGACY = 'rpi-hist-legacy'
const HIST_BRANDED = 'rpi-hist-branded'

let env

function client(uid) {
  return env.authenticatedContext(uid).firestore()
}

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A', receiptPrefix: PREFIX_A })
    await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B', receiptPrefix: PREFIX_B })
    // Deliberately no receiptPrefix on Gym C.
    await fs.doc(`gyms/${GYM_C}`).set({ ownerUid: C.owner, name: 'Gym C' })
    await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
    await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
    await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
    await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
    await fs.doc(`users/${C.owner}`).set({ role: 'owner', gymId: GYM_C })
    await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
    await fs.doc('members/rpi-m-1').set({ name: 'A Member', gymId: GYM_A })
    // Historical payments in Gym A. `HIST_LEGACY` predates branded numbering.
    await fs.doc(`payments/${HIST_LEGACY}`).set({
      amount: 100,
      memberId: 'rpi-m-1',
      method: 'Cash',
      note: 'legacy receipt',
      gymId: GYM_A,
      receiptNo: '001',
    })
    await fs.doc(`payments/${HIST_BRANDED}`).set({
      amount: 200,
      memberId: 'rpi-m-1',
      method: 'Cash',
      note: 'branded receipt',
      gymId: GYM_A,
      receiptNo: `${PREFIX_A}-000001`,
    })
  })
}

/** A payment payload in the caller's own gym (gymId supplied explicitly). */
const payment = (gymId, extra) => ({ amount: 100, memberId: 'rpi-m-1', gymId, ...extra })

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules },
  })
  await seed()
})

afterAll(async () => {
  await env.cleanup()
})

// ===========================================================================
// Create: the receipt number must be issued under the caller's own authority.
// ===========================================================================
describe('P1 receipt integrity — creation', () => {
  it('owner may create a payment under their own authoritative prefix', async () => {
    await assertSucceeds(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-000002` }))
    )
  })

  it('admin may create a payment under their own authoritative prefix', async () => {
    await assertSucceeds(
      client(A.admin).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-000003` }))
    )
  })

  it('accepts the wider 13-digit epoch-ms fallback receipt format', async () => {
    await assertSucceeds(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-1800000000000` }))
    )
  })

  it("rejects a foreign tenant's prefix", async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_B}-000001` }))
    )
  })

  it('rejects an arbitrary invented prefix', async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: 'XYZ-000001' }))
    )
  })

  it('rejects a receipt number with no separator', async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}000001` }))
    )
  })

  it('rejects a receipt number with a non-numeric body', async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-ABC123` }))
    )
  })

  it('rejects a receipt number with an extra separator', async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-0000-01` }))
    )
  })

  it('rejects a pathologically long receipt number', async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-${'9'.repeat(40)}` }))
    )
  })

  it('rejects a missing receipt number', async () => {
    await assertFails(client(A.owner).collection('payments').add(payment(GYM_A)))
  })

  it('rejects a receipt number of the wrong type', async () => {
    await assertFails(
      client(A.owner).collection('payments').add(payment(GYM_A, { receiptNo: 12345 }))
    )
  })

  it('fails closed when the gym has no authoritative prefix (unprovisioned)', async () => {
    await assertFails(
      client(C.owner).collection('payments').add(payment(GYM_C, { receiptNo: `${PREFIX_A}-000001` }))
    )
  })

  it("rejects a different tenant stamping Gym A's prefix", async () => {
    // Same-prefix value, but the writer is bound to Gym B.
    await assertFails(
      client(B.owner).collection('payments').add(payment(GYM_B, { receiptNo: `${PREFIX_A}-000001` }))
    )
    // And B cannot stamp a Gym A payment at all (tenancy).
    await assertFails(
      client(B.owner).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_B}-000001` }))
    )
  })

  it('still denies non-finance staff even with a well-formed receipt number', async () => {
    await assertFails(
      client(A.frontDesk).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-000009` }))
    )
  })

  it('denies an unbound finance caller', async () => {
    await assertFails(
      client(UNBOUND).collection('payments').add(payment(GYM_A, { receiptNo: `${PREFIX_A}-000010` }))
    )
  })
})

// ===========================================================================
// Update: an existing receipt number is immutable.
// ===========================================================================
describe('P1 receipt integrity — update immutability', () => {
  it('rejects changing an existing receipt number', async () => {
    await assertFails(
      client(A.owner).doc(`payments/${HIST_BRANDED}`).update({ receiptNo: `${PREFIX_A}-999999` })
    )
  })

  it('rejects removing the receipt number with deleteField()', async () => {
    await assertFails(
      client(A.owner).doc(`payments/${HIST_BRANDED}`).update({ receiptNo: deleteField() })
    )
  })

  it('rejects setting the receipt number to null', async () => {
    await assertFails(
      client(A.owner).doc(`payments/${HIST_BRANDED}`).update({ receiptNo: null })
    )
  })

  it('allows a legitimate unrelated update that leaves receiptNo untouched', async () => {
    await assertSucceeds(
      client(A.admin).doc(`payments/${HIST_BRANDED}`).update({ amount: 250, method: 'Card', note: 'edited' })
    )
    let stored
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await ctx.firestore().doc(`payments/${HIST_BRANDED}`).get()
      stored = snap.data()
    })
    expect(stored.amount).toBe(250)
    expect(stored.receiptNo).toBe(`${PREFIX_A}-000001`)
  })
})

// ===========================================================================
// Historical compatibility: legacy receipt values stay updatable for unrelated
// fields but remain immutable in the receiptNo itself.
// ===========================================================================
describe('P1 receipt integrity — historical compatibility', () => {
  it('allows an unrelated update on a legacy receipt that does not match the current authority', async () => {
    // '001' does not satisfy the branded shape, yet the update arm only
    // compares receiptNo for equality, so an unrelated edit must still work.
    await assertSucceeds(
      client(A.owner).doc(`payments/${HIST_LEGACY}`).update({ amount: 150, note: 'backfilled' })
    )
  })

  it('still forbids changing a legacy receipt number', async () => {
    await assertFails(
      client(A.owner).doc(`payments/${HIST_LEGACY}`).update({ receiptNo: '002' })
    )
  })

  it('still forbids removing a legacy receipt number', async () => {
    await assertFails(
      client(A.owner).doc(`payments/${HIST_LEGACY}`).update({ receiptNo: deleteField() })
    )
  })

  it('preserves the legacy receipt value across an unrelated update', async () => {
    let stored
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await ctx.firestore().doc(`payments/${HIST_LEGACY}`).get()
      stored = snap.data()
    })
    expect(stored.receiptNo).toBe('001')
    expect(stored.amount).toBe(150)
  })
})
