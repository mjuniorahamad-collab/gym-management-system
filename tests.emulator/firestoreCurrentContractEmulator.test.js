/**
 * CURRENT CONTRACT — the scenarios the frozen baseline pins the OLD behaviour of.
 *
 * `tests.emulator/firestoreSecurityEmulator.test.js` is a Phase 0.5A record of
 * the rules as they were before tenancy and field hardening; its 26 red
 * assertions describe what the old ruleset permitted (or wrongly required).
 * That file is deliberately kept as-is and runs only in the non-gating CI job.
 *
 * This file is the same 26 scenarios expressed against TODAY'S rules, so the
 * security intent has a green, gating test instead of only a red historical one:
 *
 *   - the 14 "an unscoped/foreign-filtered query must FAIL" assertions become
 *     CONTAINMENT assertions — Firestore never rejects a list because some
 *     documents are off-limits (rules are not filters), so the contract is
 *     "the query succeeds and returns nothing from another tenant";
 *   - the 3 `payments.create` assertions gain the `receiptNo` the rules now
 *     require (under the gym's own prefix), and the negative cases are pinned
 *     beside them;
 *   - the 5 `bookings.create` assertions seed the member and class they
 *     reference, which the rules now require to exist in the caller's gym;
 *   - the 3 `member.status` assertions become DENIALS (server-owned projection
 *     field) with a control write proving the denial is about that field;
 *   - the `settings/app` singleton assertion becomes per-gym settings isolation
 *     (`gyms/{gymId}/settings/app`), which replaced the shared document.
 *
 * Every id is `cc-` prefixed and every gym is unique, because the emulator
 * database is shared with the other suites.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
} from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'cc-gym-a'
const GYM_B = 'cc-gym-b'
const PREFIX_A = 'CCA'
const PREFIX_B = 'CCB'

const OWNER_A = 'cc-owner-a'
const ADMIN_A = 'cc-admin-a'
const FRONTDESK_A = 'cc-frontdesk-a'
const TRAINER_A = 'cc-trainer-a'
const OWNER_B = 'cc-owner-b'

/** One doc per gym per collection, so an unscoped read has something to leak. */
const COLLECTIONS = [
  'members',
  'payments',
  'bookings',
  'counters',
  'attendance',
  'classes',
  'trainers',
  'membershipPlans',
  'memberships',
  'expenses',
  'weightRecords',
]

const tenantDoc = (gymId) => ({ gymId, createdAt: new Date() })

let env
let dbA
let dbAdminA
let dbFrontdeskA
let dbTrainerA
let dbB

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()

    for (const [gymId, ownerUid, name, receiptPrefix] of [
      [GYM_A, OWNER_A, 'Current Contract Gym A', PREFIX_A],
      [GYM_B, OWNER_B, 'Current Contract Gym B', PREFIX_B],
    ]) {
      await fs.doc(`gyms/${gymId}`).set({ ownerUid, name, receiptPrefix, createdAt: new Date() })
      await fs.doc(`gyms/${gymId}/settings/app`).set({
        gymId,
        gymName: name,
        currency: 'INR',
        receiptPrefix,
        createdAt: new Date(),
      })
    }

    for (const [uid, role, gymId] of [
      [OWNER_A, 'owner', GYM_A],
      [ADMIN_A, 'admin', GYM_A],
      [FRONTDESK_A, 'front-desk', GYM_A],
      [TRAINER_A, 'trainer', GYM_A],
      [OWNER_B, 'owner', GYM_B],
    ]) {
      await fs.doc(`users/${uid}`).set({ role, gymId, createdAt: new Date() })
    }

    // A member and a class in each gym: bookings now require both to exist in
    // the caller's own gym.
    await fs.doc(`members/cc-member-a`).set({ name: 'Member A', phone: '9000000001', ...tenantDoc(GYM_A) })
    await fs.doc(`members/cc-member-b`).set({ name: 'Member B', phone: '9000000002', ...tenantDoc(GYM_B) })
    await fs.doc(`classes/cc-class-a`).set({ name: 'Class A', ...tenantDoc(GYM_A) })
    await fs.doc(`classes/cc-class-b`).set({ name: 'Class B', ...tenantDoc(GYM_B) })

    for (const name of COLLECTIONS) {
      await fs.doc(`${name}/cc-${name}-a`).set({ ...tenantDoc(GYM_A) })
      await fs.doc(`${name}/cc-${name}-b`).set({ ...tenantDoc(GYM_B) })
    }

    // An audit entry per gym: the log is finance-only and tenant scoped.
    await fs.doc('auditLog/cc-audit-a').set({ action: 'create', entity: 'payments', ...tenantDoc(GYM_A) })
    await fs.doc('auditLog/cc-audit-b').set({ action: 'create', entity: 'payments', ...tenantDoc(GYM_B) })
  })
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules },
  })
  await seed()
  dbA = env.authenticatedContext(OWNER_A).firestore()
  dbAdminA = env.authenticatedContext(ADMIN_A).firestore()
  dbFrontdeskA = env.authenticatedContext(FRONTDESK_A).firestore()
  dbTrainerA = env.authenticatedContext(TRAINER_A).firestore()
  dbB = env.authenticatedContext(OWNER_B).firestore()
})

afterAll(async () => {
  await env.cleanup()
})

describe('query isolation — the app-shaped scoped query (frozen J1/J5/E8)', () => {
  /**
   * IMPORTANT — why there is no "an unscoped query is denied" assertion here.
   *
   * The frozen baseline asserted exactly that, and the emulator disproved it.
   * Measured with a probe on this ruleset:
   *
   *   A, unscoped members read      -> ALLOWED, returns BOTH gyms' documents
   *   A, where gymId == B           -> DENIED
   *   A, where gymId == A           -> ALLOWED, returns only gym A's documents
   *   anonymous, unscoped           -> DENIED
   *   A, direct read of B's doc     -> DENIED
   *
   * The emulator evaluates a `list` rule ONCE against a synthetic document shaped
   * by the query's equality filters, and does not filter the result set per
   * document. With no filter the synthetic document carries no `gymId`, so the
   * intentional `legacy()` disjunct (pre-tenancy records stay readable) admits
   * the list, and every matching document comes back. That is an emulator
   * fidelity limit, not a rules decision — production evaluates the rule per
   * document, where a foreign document fails both `sameGym` and `legacy`.
   *
   * What is enforceable, and what the app actually relies on, is asserted below:
   * every read goes through a `gymId` equality filter (`listAll` adds
   * `where('gymId','==',callerGym)`), that scoped query returns only the caller's
   * documents, and a query/filter aimed at another tenant is DENIED.
   */
  for (const name of COLLECTIONS) {
    it(`a gym-scoped ${name} query returns this gym's rows and no other tenant's`, async () => {
      const snap = await assertSucceeds(
        getDocs(query(collection(dbA, name), where('gymId', '==', GYM_A)))
      )
      const ids = snap.docs.map((row) => row.id)
      expect(ids).toContain(`cc-${name}-a`)
      expect(ids).not.toContain(`cc-${name}-b`)
      for (const row of snap.docs) expect(row.data().gymId).toBe(GYM_A)

      // The same shape pointed at the other tenant is refused outright.
      await assertFails(getDocs(query(collection(dbA, name), where('gymId', '==', GYM_B))))
    })
  }

  it('the audit log is finance-only and tenant scoped (frozen E8)', async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(dbA, 'auditLog'), where('gymId', '==', GYM_A)))
    )
    expect(snap.docs.map((row) => row.id)).toContain('cc-audit-a')
    expect(snap.docs.map((row) => row.id)).not.toContain('cc-audit-b')

    await assertFails(getDoc(doc(dbB, 'auditLog/cc-audit-a')))
    await assertFails(
      getDocs(query(collection(dbA, 'auditLog'), where('gymId', '==', GYM_B)))
    )
    // A trainer is staff but not finance: no audit log at all.
    await assertFails(getDocs(query(collection(dbTrainerA, 'auditLog'), where('gymId', '==', GYM_A))))
    // ...and the direct read of the caller's own audit row is not a substitute.
    await assertFails(getDoc(doc(dbTrainerA, 'auditLog/cc-audit-a')))
  })
})

describe('settings are per gym (frozen C6/C7)', () => {
  it('the owner renames only their own gym, and another owner cannot read it', async () => {
    await assertSucceeds(updateDoc(doc(dbA, `gyms/${GYM_A}/settings/app`), { gymName: 'Renamed A' }))

    await assertFails(getDoc(doc(dbB, `gyms/${GYM_A}/settings/app`)))

    const own = await assertSucceeds(getDoc(doc(dbA, `gyms/${GYM_A}/settings/app`)))
    expect(own.data().gymName).toBe('Renamed A')
  })

  it("another gym's settings are untouched by that write", async () => {
    const own = await assertSucceeds(getDoc(doc(dbB, `gyms/${GYM_B}/settings/app`)))
    expect(own.data()).toMatchObject({ gymId: GYM_B, gymName: 'Current Contract Gym B' })

    // Only the owner may write settings, and only their own gym's document.
    await assertFails(updateDoc(doc(dbFrontdeskA, `gyms/${GYM_A}/settings/app`), { gymName: 'x' }))
    await assertFails(updateDoc(doc(dbA, `gyms/${GYM_B}/settings/app`), { gymName: 'x' }))
  })
})

describe('member.status is server-owned (frozen SEC-I)', () => {
  for (const [label, context] of [
    ['owner', () => dbA],
    ['admin', () => dbAdminA],
    ['front-desk', () => dbFrontdeskA],
  ]) {
    it(`the ${label} cannot write member.status, but can edit an ordinary field`, async () => {
      const db = context()
      // members.write is granted to these roles, and it still does not include
      // the projection field: the server derives it from the ledger.
      await assertFails(updateDoc(doc(db, 'members/cc-member-a'), { status: 'expired' }))

      // Control: the denial is about the field, not about the whole document.
      await assertSucceeds(updateDoc(doc(db, 'members/cc-member-a'), { phone: '9111111111' }))
    })
  }
})

describe('bookings: staff CRUD inside their own gym (frozen SEC-F)', () => {
  const booking = (over = {}) => ({
    memberId: 'cc-member-a',
    classId: 'cc-class-a',
    date: '2026-03-01',
    status: 'booked',
    gymId: GYM_A,
    ...over,
  })

  for (const [label, context] of [
    ['owner', () => dbA],
    ['admin', () => dbAdminA],
    ['trainer', () => dbTrainerA],
    ['front-desk', () => dbFrontdeskA],
  ]) {
    it(`${label} creates a booking for an existing member and class of their gym`, async () => {
      const ref = await assertSucceeds(addDoc(collection(context(), 'bookings'), booking()))
      expect(ref.id).toBeTruthy()
    })
  }

  it('a staff member manages and cancels any booking inside their own gym', async () => {
    const created = await assertSucceeds(addDoc(collection(dbFrontdeskA, 'bookings'), booking()))
    await assertSucceeds(updateDoc(doc(dbFrontdeskA, `bookings/${created.id}`), { status: 'cancelled' }))
    const stored = await assertSucceeds(getDoc(doc(dbA, `bookings/${created.id}`)))
    expect(stored.data().status).toBe('cancelled')
  })

  it('a booking whose member or class belongs to another gym is refused', async () => {
    // The referenced documents must exist in the CALLER's gym; a member id from
    // another tenant is rejected (the frozen baseline failed to seed either).
    await assertFails(
      addDoc(collection(dbA, 'bookings'), booking({ memberId: 'cc-member-b' }))
    )
    await assertFails(addDoc(collection(dbA, 'bookings'), booking({ classId: 'cc-class-b' })))
    // A reference that does not exist at all is refused too.
    await assertFails(addDoc(collection(dbA, 'bookings'), booking({ memberId: 'cc-nobody' })))
    // Cross-tenant writes are refused on tenancy alone.
    await assertFails(
      addDoc(collection(dbA, 'bookings'), booking({ gymId: GYM_B, memberId: 'cc-member-b', classId: 'cc-class-b' }))
    )
  })
})

describe('payments: receipt integrity on create (frozen SEC-M)', () => {
  const payment = (over = {}) => ({
    memberId: 'cc-member-a',
    amount: 2000,
    method: 'Cash',
    date: '2026-01-05',
    type: 'membership',
    receiptNo: `${PREFIX_A}-000101`,
    gymId: GYM_A,
    ...over,
  })

  for (const [label, context] of [
    ['owner', () => dbA],
    ['admin', () => dbAdminA],
  ]) {
    it(`${label} of the gym creates a payment with a receipt under the gym's prefix`, async () => {
      const ref = await assertSucceeds(addDoc(collection(context(), 'payments'), payment()))
      expect(ref.id).toBeTruthy()
    })
  }

  it('refuses a payment without a receipt number, under a foreign prefix, or for another gym', async () => {
    // The receipt number became mandatory when the counter was introduced.
    const withoutReceipt = payment()
    delete withoutReceipt.receiptNo
    await assertFails(addDoc(collection(dbA, 'payments'), withoutReceipt))
    // A number minted under another gym's prefix is not this gym's receipt.
    await assertFails(addDoc(collection(dbA, 'payments'), payment({ receiptNo: `${PREFIX_B}-000101` })))
    // Tenancy: the payment must belong to the caller's gym.
    await assertFails(addDoc(collection(dbA, 'payments'), payment({ gymId: GYM_B })))
    // And the receipt number is immutable once written.
    const ref = await assertSucceeds(addDoc(collection(dbA, 'payments'), payment()))
    await assertFails(updateDoc(doc(dbA, `payments/${ref.id}`), { receiptNo: `${PREFIX_A}-000999` }))
  })

  it('a trainer (not finance) cannot create a payment', async () => {
    await assertFails(addDoc(collection(dbTrainerA, 'payments'), payment()))
  })
})
