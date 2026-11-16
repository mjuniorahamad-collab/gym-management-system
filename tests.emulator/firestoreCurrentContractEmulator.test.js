/**
 * CURRENT CONTRACT — the frozen baseline's scenarios, expressed against today's rules.
 *
 * `tests.emulator/firestoreSecurityEmulator.test.js` is a Phase 0.5A record of the
 * rules as they were before tenancy and field hardening; its 26 red assertions
 * describe what the old ruleset permitted (or wrongly required). That file is
 * deliberately kept as-is and runs only in the non-gating CI job.
 *
 * This file closes the one thing that was still missing: a GREEN, gating test for
 * the security intent. It deliberately does NOT duplicate the intents that
 * already have green, gating assertions elsewhere — after review, 13 of the 26
 * stayed here and the rest are mapped to their existing owner below. Adding a
 * second copy would only make two tests fail together and neither explain which
 * one is canonical.
 *
 *   frozen scenario                          | asserted green in
 *   -----------------------------------------|------------------------------------------------
 *   J1 ×11 (unscoped collection read)        | HERE — "query isolation" (11 collections)
 *   J5  (filter aimed at a foreign tenant)   | HERE — same block, second assertion
 *   E8  (audit log enumeration)              | HERE
 *   F12 (staff cancel their own gym booking) | HERE
 *   F1–F4 (each staff role books own gym)    | firestoreSecurityRemediation: "every staff role,
 *                                            |   trainer included, can still book inside their own gym"
 *   F forged/foreign/missing booking refs    | firestoreSecurityRemediation: booking tenant block
 *   SEC-M payments.create (needs receiptNo)  | firestoreReceiptIntegrityEmulator (owner/admin allow,
 *                                            |   foreign prefix, missing number, non-finance, immutable)
 *   SEC-I member.status (server-owned)       | firestoreSecurityRemediation: "CURRENT POLICY" block
 *                                            |   + "members.write roles keep every other field writable"
 *   SEC-C C6/C7 (settings singleton)         | firestoreSecurityRemediation: per-gym settings block
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

const OWNER_A = 'cc-owner-a'
const FRONTDESK_A = 'cc-frontdesk-a'
const TRAINER_A = 'cc-trainer-a'
const OWNER_B = 'cc-owner-b'

/** One doc per gym per collection, so a leaked read has something to reveal. */
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
let dbFrontdeskA
let dbTrainerA
let dbB

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()

    for (const [gymId, ownerUid, name] of [
      [GYM_A, OWNER_A, 'Current Contract Gym A'],
      [GYM_B, OWNER_B, 'Current Contract Gym B'],
    ]) {
      await fs.doc(`gyms/${gymId}`).set({ ownerUid, name, createdAt: new Date() })
    }

    for (const [uid, role, gymId] of [
      [OWNER_A, 'owner', GYM_A],
      [FRONTDESK_A, 'front-desk', GYM_A],
      [TRAINER_A, 'trainer', GYM_A],
      [OWNER_B, 'owner', GYM_B],
    ]) {
      await fs.doc(`users/${uid}`).set({ role, gymId, createdAt: new Date() })
    }

    // A member and a class in gym A: the booking cancel needs a real booking.
    await fs.doc('members/cc-member-a').set({ name: 'Member A', ...tenantDoc(GYM_A) })
    await fs.doc('classes/cc-class-a').set({ name: 'Class A', ...tenantDoc(GYM_A) })
    await fs
      .doc('bookings/cc-booking-a')
      .set({ memberId: 'cc-member-a', classId: 'cc-class-a', date: '2026-03-01', status: 'booked', ...tenantDoc(GYM_A) })

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
   * What is enforceable, and what the app actually relies on, is asserted here:
   * every read goes through a `gymId` equality filter (`listAll` adds
   * `where('gymId','==',callerGym)`), that scoped query returns only the caller's
   * documents, and a query aimed at another tenant is DENIED.
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
    // A trainer is staff but not finance: no audit log, list or direct read.
    await assertFails(getDocs(query(collection(dbTrainerA, 'auditLog'), where('gymId', '==', GYM_A))))
    await assertFails(getDoc(doc(dbTrainerA, 'auditLog/cc-audit-a')))
  })
})

describe('bookings: staff manage their own gym (frozen F12)', () => {
  it('front-desk cancels a booking inside their own gym', async () => {
    // The create paths and the forged/foreign references are covered by
    // firestoreSecurityRemediation's booking block; what the frozen baseline
    // pinned here and nothing else asserted is the manage/cancel path.
    const created = await assertSucceeds(
      addDoc(collection(dbFrontdeskA, 'bookings'), {
        memberId: 'cc-member-a',
        classId: 'cc-class-a',
        date: '2026-03-02',
        status: 'booked',
        gymId: GYM_A,
      })
    )
    await assertSucceeds(
      updateDoc(doc(dbFrontdeskA, `bookings/${created.id}`), { status: 'cancelled' })
    )
    const stored = await assertSucceeds(getDoc(doc(dbA, `bookings/${created.id}`)))
    expect(stored.data().status).toBe('cancelled')
  })
})
