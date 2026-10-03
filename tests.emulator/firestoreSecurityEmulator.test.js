/**
 * PHASE 0.5A — AUTOMATED BEHAVIORAL SECURITY ATTACK-PATH TESTS
 *
 * Every test here performs a REAL Firestore operation against the emulator as
 * an authenticated / unauthenticated attacker or a legitimate staff user.
 * Nothing inspects firestore.rules as text. `assertSucceeds` / `assertFails`
 * are the only assertion primitives used.
 *
 * These tests are EXPECTED TO FAIL wherever the current rules are vulnerable.
 * The failing tests are the deliverable: a reproducible vulnerable baseline.
 * Do not "fix" firestore.rules to make them pass.
 *
 * Architecture mirrors tests.emulator/firestoreRulesEmulator.test.js exactly:
 *   - rules read from firestore.rules at runtime
 *   - emulator host from FIRESTORE_EMULATOR_HOST (demo project only)
 *   - one initializeTestEnvironment per suite, seeded in beforeAll
 *     inside withSecurityRulesDisabled, cleaned up in afterAll
 *   - never calls clearFirestore(); every gym / user / document id is
 *     `sec-`-prefixed so this file can never disturb the original suite
 *     (vitest may run both files in parallel against the single emulator).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'sec-gym-a'
const GYM_B = 'sec-gym-b'

const A = {
  owner: 'sec-owner-a',
  admin: 'sec-admin-a',
  trainer: 'sec-trainer-a',
  frontDesk: 'sec-front-desk-a',
}
const B = {
  owner: 'sec-owner-b',
  admin: 'sec-admin-b',
}

// Two flavours of "no tenancy": `ghost` has NO users/{uid} document at all,
// `unbound` has a users/{uid} document that carries a role but no gymId.
const GHOST = 'sec-ghost-no-profile'
const UNBOUND = 'sec-unbound-no-gymid'

// A gym whose owner-of-record is a brand-new user with no profile yet, used by
// the onboarding suites.
const GYM_NEW = 'sec-gym-newcomer'

/** A gym the newcomer legitimately owns, so canBindGymId can succeed for them. */
function autoIdFor(uid) {
  return `sec-auto-${uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}`.slice(0, 20)
}

function makeEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules },
  })
}

function client(env, uid) {
  return env.authenticatedContext(uid).firestore()
}

function anon(env) {
  return env.unauthenticatedContext().firestore()
}

const TODAY = '2026-10-02'

// Representative legacy (pre-tenancy) documents: realistic but with NO gymId
// field, which is exactly what legacy() keys on.
const LEGACY_DOCS = {
  members: {
    name: 'Legacy Member',
    phone: '9800000001',
    membershipPlanId: 'plan-monthly',
    status: 'active',
    joinDate: '2026-01-15',
  },
  payments: { memberId: 'legacy-member', amount: 4500, method: 'Cash', date: '2026-02-01' },
  memberships: { memberId: 'legacy-member', planId: 'plan-monthly', price: 4500 },
  attendance: { memberId: 'legacy-member', date: '2026-02-01', checkIn: '06:30' },
  classes: { name: 'Legacy Yoga', dayOfWeek: 'Monday', startTime: '07:00', capacity: 20 },
  bookings: { classId: 'legacy-class', memberId: 'legacy-member', status: 'booked' },
  trainers: { name: 'Legacy Trainer', specialization: 'Strength', hourlyRate: 800 },
  membershipPlans: { name: 'Legacy Plan', durationDays: 30, price: 4500 },
  weightRecords: { memberId: 'legacy-member', weight: 78.4, date: '2026-02-10' },
  auditLog: { action: 'create', entity: 'members', entityId: 'legacy-member' },
  counters: { value: 3 },
}

/** Independent untagged document id per operation, to keep tests order-free. */
function legacyId(op, collection) {
  return `sec-legacy-${op}-${collection}`
}

/*
 * APPROVED LEGACY POSTURE
 * ----------------------
 * A pre-tenancy (untagged) document is READ-allowed on purpose so that existing
 * data is never lost; the original suite states this explicitly at
 * firestoreRulesEmulator.test.js:175-185 ("readable but NOT deletable").
 * Firestore rules cannot distinguish "read my own legacy record" from "read
 * somebody else's legacy record", so the read side is genuinely AMBIGUOUS and is
 * RECORDED as an observation instead of being asserted as a denial.
 *
 * What must never be tolerated is CAPTURE: adding a gymId to an untagged
 * document silently transfers pre-tenancy data to whichever tenant acts first.
 * Every claim / mutation / delete on an untagged document therefore stays a hard
 * DENY assertion.
 */
const legacyReadObservations = []

/** Runs one ambiguous legacy READ, records the outcome, and never fails. */
async function recordLegacyRead(actor, label, op) {
  let outcome
  let detail = ''
  try {
    const snap = await op()
    outcome = 'ALLOWED'
    const docs = snap?.docs
    if (Array.isArray(docs)) detail = `${docs.length} doc(s): ${docs.map((d) => d.id).join(', ')}`
    else detail = snap?.exists ? 'document returned' : 'no document'
  } catch (e) {
    outcome = e?.code === 'permission-denied' ? 'DENIED' : `ERR:${e?.code ?? 'unknown'}`
    detail = e?.message ?? String(e)
  }
  legacyReadObservations.push({ actor, label, outcome, detail })
  return outcome
}

/** Prints and clears the legacy-read table. Call from a suite's afterAll. */
function printLegacyReads(header) {
  if (!legacyReadObservations.length) return
  console.log(`\n===== ${header} =====`)
  for (const o of legacyReadObservations) {
    console.log(
      `${o.actor.padEnd(12)} | ${o.label.padEnd(46)} | ${o.outcome.padEnd(7)} | ${o.detail}`
    )
  }
  legacyReadObservations.length = 0
  console.log('===== end =====\n')
}

/** Seed one throwaway document for a single matrix cell, bypassing rules. */
function seedCell(env, collection, id, data) {
  return env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`${collection}/${id}`).set(data)
  })
}

/**
 * Read a document with rules bypassed.
 * NOTE: withSecurityRulesDisabled() resolves to undefined (it discards the
 * callback's return value), so the snapshot has to be captured explicitly.
 */
async function peekDoc(env, path) {
  let data = null
  let exists = false
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(path).get()
    exists = snap.exists
    data = snap.exists ? snap.data() : null
  })
  return { exists, data }
}

// ===========================================================================
// GROUP A — ROLE ESCALATION
// ===========================================================================
describe('SEC-A — role escalation on users/{uid}', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A, name: 'Owner A' })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A, name: 'Admin A' })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A, name: 'Trainer A' })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A, name: 'Desk A' })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B, name: 'Owner B' })
      await fs.doc(`users/${B.admin}`).set({ role: 'admin', gymId: GYM_B, name: 'Admin B' })
      // a plain, non-staff, fully bound member-account user
      await fs.doc('users/sec-plain-user').set({ role: 'member', gymId: GYM_A, name: 'Plain' })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  // Every escalation attempt gets its OWN throwaway attacker/victim pair. If an
  // escalation is (insecurely) ALLOWed it mutates only documents no later test
  // reads, so each test is judged purely on its own first request.
  let seq = 0
  async function pair(gym, roles) {
    seq += 1
    const made = roles.map((role, i) => ({ uid: `sec-a-p${seq}-${i}`, role }))
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      for (const { uid, role } of made) {
        await fs.doc(`users/${uid}`).set({ role, gymId: gym, name: uid })
      }
    })
    return made
  }

  it('A1 — admin cannot self-assign role=owner via update()', async () => {
    const [attacker] = await pair(GYM_A, ['admin'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${attacker.uid}`).update({ role: 'owner' })
    )
  })

  it('A1b — admin cannot self-assign role=owner via a full set() that preserves gymId', async () => {
    const [attacker] = await pair(GYM_A, ['admin'])
    await assertFails(
      client(env, attacker.uid)
        .doc(`users/${attacker.uid}`)
        .set({ role: 'owner', gymId: GYM_A, name: 'Admin A' })
    )
  })

  it('A2 — admin cannot promote an in-gym front-desk user to owner', async () => {
    const [attacker, victim] = await pair(GYM_A, ['admin', 'front-desk'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${victim.uid}`).update({ role: 'owner' })
    )
  })

  it('A3 — admin cannot change the role of the gym owner', async () => {
    const [attacker, owner] = await pair(GYM_A, ['admin', 'owner'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${owner.uid}`).update({ role: 'trainer' })
    )
  })

  it('A4 — trainer cannot change their own role', async () => {
    const [attacker] = await pair(GYM_A, ['trainer'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${attacker.uid}`).update({ role: 'admin' })
    )
  })

  it('A4b — trainer cannot change another in-gym user role', async () => {
    const [attacker, victim] = await pair(GYM_A, ['trainer', 'front-desk'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${victim.uid}`).update({ role: 'owner' })
    )
  })

  it('A5 — front-desk cannot change their own role', async () => {
    const [attacker] = await pair(GYM_A, ['front-desk'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${attacker.uid}`).update({ role: 'admin' })
    )
  })

  it('A5b — front-desk cannot change another in-gym user role', async () => {
    const [attacker, victim] = await pair(GYM_A, ['front-desk', 'admin'])
    await assertFails(
      client(env, attacker.uid).doc(`users/${victim.uid}`).update({ role: 'owner' })
    )
  })

  it('A6 — a bound non-staff user cannot change their own role', async () => {
    const [plain] = await pair(GYM_A, ['member'])
    await assertFails(client(env, plain.uid).doc(`users/${plain.uid}`).update({ role: 'owner' }))
  })

  it('A7 — changing only the role field while gymId stays bound must still be denied', async () => {
    const [desk] = await pair(GYM_A, ['front-desk'])
    const [trainer] = await pair(GYM_A, ['trainer'])
    await assertFails(client(env, desk.uid).doc(`users/${desk.uid}`).update({ role: 'owner' }))
    await assertFails(
      client(env, trainer.uid).doc(`users/${trainer.uid}`).update({ role: 'admin' })
    )
  })

  it('A8 — role smuggled together with unrelated safe fields must still be denied', async () => {
    const [trainer] = await pair(GYM_A, ['trainer'])
    const [desk] = await pair(GYM_A, ['front-desk'])
    await assertFails(
      client(env, trainer.uid)
        .doc(`users/${trainer.uid}`)
        .update({ role: 'owner', name: 'Totally New Name', email: 'attacker@evil.test' })
    )
    await assertFails(
      client(env, desk.uid)
        .doc(`users/${desk.uid}`)
        .update({ role: 'admin', name: 'Desk A', phone: '9800000111' })
    )
  })

  it('A9 — rewriting the payload with the caller own gymId still cannot escalate', async () => {
    const [desk] = await pair(GYM_A, ['front-desk'])
    await assertFails(
      client(env, desk.uid)
        .doc(`users/${desk.uid}`)
        .set({ role: 'owner', gymId: GYM_A, name: 'Desk A' })
    )
  })

  it('A9b — moving to another gym while escalating is denied on both axes', async () => {
    const [adminA] = await pair(GYM_A, ['admin'])
    await assertFails(
      client(env, adminA.uid)
        .doc(`users/${adminA.uid}`)
        .set({ role: 'owner', gymId: GYM_B, name: 'Admin A' })
    )
  })

  it('A10 — admin cannot change a role on a user of another gym', async () => {
    const [adminA] = await pair(GYM_A, ['admin'])
    const [adminB, ownerB] = await pair(GYM_B, ['admin', 'owner'])
    await assertFails(client(env, adminA.uid).doc(`users/${adminB.uid}`).update({ role: 'owner' }))
    await assertFails(
      client(env, adminA.uid).doc(`users/${ownerB.uid}`).update({ role: 'trainer' })
    )
  })

  it('A10b — Gym B admin cannot change a role on a Gym A user', async () => {
    const [adminB] = await pair(GYM_B, ['admin'])
    const [deskA] = await pair(GYM_A, ['front-desk'])
    await assertFails(client(env, adminB.uid).doc(`users/${deskA.uid}`).update({ role: 'owner' }))
  })

  it('A11 — a role may not be set to an undefined/privileged-by-typo value', async () => {
    const [adminA] = await pair(GYM_A, ['admin'])
    const [deskA] = await pair(GYM_A, ['front-desk'])
    const [ownerA] = await pair(GYM_A, ['owner'])
    const [trainerA] = await pair(GYM_A, ['trainer'])
    await assertFails(
      client(env, adminA.uid).doc(`users/${adminA.uid}`).update({ role: 'superadmin' })
    )
    await assertFails(client(env, adminA.uid).doc(`users/${deskA.uid}`).update({ role: 'OWNER' }))
    await assertFails(client(env, ownerA.uid).doc(`users/${trainerA.uid}`).update({ role: 'root' }))
  })

  it('A12 — an owner must not be able to delete the owner profile that binds the tenant', async () => {
    // Deleting the only owner profile destroys the gym binding for everyone.
    const [ownerA] = await pair(GYM_A, ['owner'])
    await assertFails(client(env, ownerA.uid).doc(`users/${ownerA.uid}`).delete())
  })

  it('A12b — an owner must not be able to delete an in-gym admin profile (privilege revocation)', async () => {
    const [ownerA, adminA] = await pair(GYM_A, ['owner', 'admin'])
    await assertFails(client(env, ownerA.uid).doc(`users/${adminA.uid}`).delete())
  })

  it('A13 — a user profile cannot be deleted by an admin or front-desk', async () => {
    const [adminA, victim] = await pair(GYM_A, ['admin', 'front-desk'])
    const [deskA] = await pair(GYM_A, ['front-desk'])
    await assertFails(client(env, adminA.uid).doc(`users/${victim.uid}`).delete())
    await assertFails(client(env, deskA.uid).doc(`users/${victim.uid}`).delete())
  })
})

// ===========================================================================
// GROUP B — SELF-ASSIGNED ROLE / TENANCY DURING ONBOARDING
// ===========================================================================
describe('SEC-B — onboarding: self-assigned gymId and role', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`gyms/${GYM_NEW}`).set({ ownerUid: 'sec-newcomer', name: 'Newcomer Gym' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      // legacy unbound profile: a role but no gymId
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin', name: 'Unbound' })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  for (const role of ['owner', 'admin', 'trainer', 'front-desk']) {
    it(`B1 — a brand-new user cannot self-assign gymId=${GYM_A} with role=${role}`, async () => {
      const uid = `sec-new-${role}`
      await assertFails(
        client(env, uid).doc(`users/${uid}`).set({ role, gymId: GYM_A, name: 'Attacker' })
      )
    })
  }

  it('B1b — a brand-new user cannot bind themselves to a gym that does not exist', async () => {
    const uid = 'sec-new-nogym'
    await assertFails(
      client(env, uid).doc(`users/${uid}`).set({ role: 'owner', gymId: 'sec-gym-does-not-exist' })
    )
  })

  it('B2 — the legitimate onboarding payload for a real owner-of-record is allowed (role=owner)', async () => {
    const uid = 'sec-newcomer'
    await assertSucceeds(
      client(env, uid).doc(`users/${uid}`).set({ role: 'owner', gymId: GYM_NEW, name: 'Newcomer' })
    )
  })

  it('B3 — an owner-of-record must not be able to bind with an arbitrary/undefined role', async () => {
    // Gym B belongs to sec-owner-b; give a second owner-of-record a gym to test.
    const uid = 'sec-rogue-owner'
    const gymId = autoIdFor(uid)
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`gyms/${gymId}`).set({ ownerUid: uid, name: 'Rope Gym' })
    })
    await assertFails(client(env, uid).doc(`users/${uid}`).set({ role: 'superadmin', gymId }))
    await assertFails(client(env, uid).doc(`users/${uid}`).set({ role: 'trainer', gymId }))
  })

  it('B4 — an existing unbound profile cannot attach itself to a foreign gym', async () => {
    await assertFails(
      client(env, UNBOUND).doc(`users/${UNBOUND}`).set({ role: 'owner', gymId: GYM_A })
    )
  })

  it('B5 — a brand-new user cannot create a privileged profile for a DIFFERENT uid', async () => {
    await assertFails(
      client(env, 'sec-new-attacker2')
        .doc(`users/${A.frontDesk}`)
        .set({ role: 'owner', gymId: GYM_NEW, name: 'Owned' })
    )
  })

  it('B6 — a brand-new user cannot create a profile for another uid that mirrors their own', async () => {
    await assertFails(
      client(env, 'sec-new-attacker3')
        .doc('users/sec-new-attacker3-alias')
        .set({ role: 'owner', gymId: GYM_NEW })
    )
  })

  it('B7 — a bound staff user cannot re-open the onboarding path to switch gyms', async () => {
    await assertFails(
      client(env, A.admin).doc(`users/${A.admin}`).set({ role: 'owner', gymId: GYM_B })
    )
  })
})

// ===========================================================================
// GROUP C — GLOBAL settings/app CROSS-TENANT ACCESS
// ===========================================================================
describe('SEC-C — global settings/app singleton is cross-tenant', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      await fs.doc('settings/app').set({
        gymName: 'Himalye Wonders Gym',
        tagline: 'Strength • Discipline • Growth',
        currency: 'INR',
        dateFormat: 'MMM D, YYYY',
        receiptPrefix: 'HWG',
        gymId: GYM_A,
      })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('C1 — ownerA can read settings/app (baseline allowed behaviour)', async () => {
    await assertSucceeds(client(env, A.owner).doc('settings/app').get())
  })

  it("C2 — ownerB must NOT be able to read another tenant's settings", async () => {
    await assertFails(client(env, B.owner).doc('settings/app').get())
  })

  it('C3 — adminA reads settings/app (own tenant)', async () => {
    await assertSucceeds(client(env, A.admin).doc('settings/app').get())
  })

  it('C4 — trainerA reads settings/app (own tenant)', async () => {
    await assertSucceeds(client(env, A.trainer).doc('settings/app').get())
  })

  it('C5 — frontDeskA reads settings/app (own tenant)', async () => {
    await assertSucceeds(client(env, A.frontDesk).doc('settings/app').get())
  })

  it('C6/C7 — ownerA changing gymName/currency/receiptPrefix must not change what ownerB reads', async () => {
    await assertSucceeds(
      client(env, A.owner)
        .doc('settings/app')
        .update({ gymName: 'Gym A Renamed', currency: 'NPR', receiptPrefix: 'GYMA' })
    )
    const seenByB = await client(env, B.owner).doc('settings/app').get()
    expect(seenByB.exists).toBe(true)
    // SECURITY REQUIREMENT: tenant A's write must not be visible to tenant B.
    expect({
      gymName: seenByB.data()?.gymName,
      currency: seenByB.data()?.currency,
      receiptPrefix: seenByB.data()?.receiptPrefix,
    }).toEqual({
      gymName: 'Himalye Wonders Gym',
      currency: 'INR',
      receiptPrefix: 'HWG',
    })
  })

  it("C8 — ownerB must not be able to overwrite ownerA's tenant settings", async () => {
    await assertFails(
      client(env, B.owner)
        .doc('settings/app')
        .update({ gymName: 'Gym B Hijack', currency: 'USD', receiptPrefix: 'GYMZ' })
    )
  })

  it('C8b — Gym B owner must not be able to create the global settings document', async () => {
    await assertFails(
      client(env, B.owner).doc('settings/attacker').set({ gymName: 'Injected', gymId: GYM_B })
    )
  })

  it('C9 — admin / trainer / front-desk cannot update or delete settings/app', async () => {
    for (const uid of [A.admin, A.trainer, A.frontDesk]) {
      await assertFails(client(env, uid).doc('settings/app').update({ gymName: 'Hijacked' }))
      await assertFails(client(env, uid).doc('settings/app').delete())
    }
  })

  it('C10 — unauthenticated access to settings/app is denied', async () => {
    await assertFails(anon(env).doc('settings/app').get())
    await assertFails(anon(env).doc('settings/app').set({ gymName: 'Anon' }))
    await assertFails(anon(env).doc('settings/app').update({ gymName: 'Anon' }))
    await assertFails(anon(env).doc('settings/app').delete())
  })

  it('C11 — an unbound (no gymId) user must NOT read tenant settings', async () => {
    await assertFails(client(env, UNBOUND).doc('settings/app').get())
  })

  it('C12 — an owner of one tenant must not be able to delete the shared settings document', async () => {
    await assertFails(client(env, A.owner).doc('settings/app').delete())
  })

  it('C13 — lower roles must not be able to enumerate the settings collection', async () => {
    await assertFails(client(env, A.trainer).collection('settings').get())
    await assertFails(anon(env).collection('settings').get())
  })
})

// ===========================================================================
// GROUP D — LEGACY (UNTAGGED) DOCUMENT ACCESS
// ===========================================================================
describe('SEC-D — legacy documents with no gymId (pre-tenancy records)', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      // One INDEPENDENT untagged copy per operation per actor, so that a rule
      // gap in one operation can never mask or manufacture the result of
      // another test. (A shared doc would let an allowed claim re-tag the
      // record and silently turn a later read/delete check into a false pass.)
      for (const [collection, data] of Object.entries(LEGACY_DOCS)) {
        await fs.doc(`${collection}/${legacyId('read', collection)}`).set(data)
        await fs.doc(`${collection}/${legacyId('claim-a', collection)}`).set(data)
        await fs.doc(`${collection}/${legacyId('claim-b', collection)}`).set(data)
        await fs.doc(`${collection}/${legacyId('delete', collection)}`).set(data)
      }
      // a second untagged copy used for the claim-race demonstration
      await fs.doc('members/sec-legacy-race').set({ name: 'Race Member', status: 'active' })
    })
  })

  afterAll(async () => {
    printLegacyReads('SEC-D legacy reads (recorded, ambiguous by design)')
    await env.cleanup()
  })

  for (const collection of Object.keys(LEGACY_DOCS)) {
    it(`D1/D2 — records whether an untagged ${collection} doc is readable by either tenant's owner`, async () => {
      // Ambiguous by design (approved legacy posture): recorded, not asserted.
      await recordLegacyRead('A.owner', `${collection}/${legacyId('read', collection)}`, () =>
        client(env, A.owner)
          .doc(`${collection}/${legacyId('read', collection)}`)
          .get()
      )
      await recordLegacyRead('B.owner', `${collection}/${legacyId('read', collection)}`, () =>
        client(env, B.owner)
          .doc(`${collection}/${legacyId('read', collection)}`)
          .get()
      )
    })
  }

  for (const collection of Object.keys(LEGACY_DOCS)) {
    it(`D3/D4 — an untagged ${collection} doc must not be claimable by any tenant (add gymId)`, async () => {
      await assertFails(
        client(env, A.owner)
          .doc(`${collection}/${legacyId('claim-a', collection)}`)
          .update({ gymId: GYM_A })
      )
      await assertFails(
        client(env, B.owner)
          .doc(`${collection}/${legacyId('claim-b', collection)}`)
          .update({ gymId: GYM_B })
      )
    })
  }

  for (const collection of Object.keys(LEGACY_DOCS)) {
    it(`D5/D6 — an untagged ${collection} doc must not be deletable by either tenant`, async () => {
      await assertFails(
        client(env, A.owner)
          .doc(`${collection}/${legacyId('delete', collection)}`)
          .delete()
      )
      await assertFails(
        client(env, B.owner)
          .doc(`${collection}/${legacyId('delete', collection)}`)
          .delete()
      )
    })
  }

  it('D7/D8 — a legacy record must not be first-come-first-served claimed by whoever acts first', async () => {
    // Whichever tenant claims the untagged record first silently takes ownership
    // of pre-tenancy data that may belong to the other tenant.
    await assertFails(client(env, A.owner).doc('members/sec-legacy-race').update({ gymId: GYM_A }))
    const after = await peekDoc(env, 'members/sec-legacy-race')
    expect(after.data.gymId ?? null).toBeNull()
  })

  it('D9 — a brand-new untagged document cannot be created (opaque legacy creates stay forbidden)', async () => {
    await assertFails(
      client(env, A.owner).collection('members').add({ name: 'Opaque Legacy Create' })
    )
  })
})

// ===========================================================================
// GROUP E — AUDIT LOG TENANT SAFETY
// ===========================================================================
describe('SEC-E — auditLog tenant safety', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc('users/sec-gym-b-lower').set({ role: 'admin', gymId: GYM_B })
      // untagged audit entry written before tenancy existed: one independent
      // copy per operation so an allowed claim cannot mask the read result
      for (const id of [
        'sec-legacy-entry-read',
        'sec-legacy-entry-claim-a',
        'sec-legacy-entry-claim-b',
      ]) {
        await fs.doc(`auditLog/${id}`).set({
          action: 'create',
          entity: 'members',
          entityId: 'sec-legacy-member',
          actor: { name: 'Someone', role: 'owner' },
        })
      }
      // properly scoped entries
      await fs
        .doc('auditLog/sec-entry-a')
        .set({ action: 'create', entity: 'members', gymId: GYM_A })
      await fs
        .doc('auditLog/sec-entry-b')
        .set({ action: 'create', entity: 'members', gymId: GYM_B })
    })
  })

  afterAll(async () => {
    printLegacyReads('SEC-E legacy reads (recorded, ambiguous by design)')
    await env.cleanup()
  })

  it('E1 — records whether an untagged auditLog entry is readable by a foreign tenant owner', async () => {
    // Ambiguous legacy read: recorded, not asserted. E5/E8 keep the hard
    // claim/enumeration guarantees.
    await recordLegacyRead('B.owner', 'auditLog/sec-legacy-entry-read', () =>
      client(env, B.owner).doc('auditLog/sec-legacy-entry-read').get()
    )
  })

  it('E2 — the owning tenant can still read its own scoped audit entries', async () => {
    await assertSucceeds(client(env, A.owner).doc('auditLog/sec-entry-a').get())
  })

  it('E3 — a scoped auditLog entry is not readable cross-tenant', async () => {
    await assertFails(client(env, B.owner).doc('auditLog/sec-entry-a').get())
    await assertFails(client(env, A.owner).doc('auditLog/sec-entry-b').get())
  })

  it('E4 — the audit log stays append-only (no update, no delete, by anyone)', async () => {
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk, B.owner]) {
      await assertFails(client(env, uid).doc('auditLog/sec-entry-a').update({ action: 'tampered' }))
      await assertFails(client(env, uid).doc('auditLog/sec-entry-a').delete())
    }
  })

  it('E5 — an untagged auditLog entry cannot be claimed or written by any tenant', async () => {
    await assertFails(
      client(env, A.owner).doc('auditLog/sec-legacy-entry-claim-a').update({ gymId: GYM_A })
    )
    await assertFails(
      client(env, B.owner).doc('auditLog/sec-legacy-entry-claim-b').update({ gymId: GYM_B })
    )
  })

  it("E6 — audit entries may only be appended with the caller's own gymId", async () => {
    await assertSucceeds(
      client(env, A.trainer)
        .collection('auditLog')
        .add({ action: 'create', entity: 'bookings', gymId: GYM_A, timestamp: TODAY })
    )
    await assertFails(
      client(env, A.trainer)
        .collection('auditLog')
        .add({ action: 'create', entity: 'bookings', gymId: GYM_B, timestamp: TODAY })
    )
    await assertFails(
      client(env, A.trainer)
        .collection('auditLog')
        .add({ action: 'create', entity: 'bookings', timestamp: TODAY })
    )
  })

  it('E7 — only owner/admin may read the audit log (trainer and front-desk are denied)', async () => {
    await assertFails(client(env, A.trainer).doc('auditLog/sec-entry-a').get())
    await assertFails(client(env, A.frontDesk).doc('auditLog/sec-entry-a').get())
  })

  it('E8 — the audit log cannot be enumerated unscoped or cross-tenant', async () => {
    await assertFails(client(env, A.owner).collection('auditLog').get())
    await assertFails(client(env, A.owner).collection('auditLog').where('gymId', '==', GYM_B).get())
  })
})

// ===========================================================================
// GROUP F — BOOKINGS
// ===========================================================================
// Expected role behaviour is derived from the application permission model:
// `src/pages/Classes.jsx:211-222` renders "Manage bookings" for every staff
// role that can open the Classes page (nav permission `members.view`), while
// `firestore.rules:261-265` grants bookings CRUD to all staff. Booking writes
// are therefore EXPECTED to succeed for owner/admin/trainer/front-desk, and the
// only non-negotiable requirement is TENANT ISOLATION.
describe('SEC-F — bookings tenant isolation', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc('members/sec-member-a').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('members/sec-member-b').set({ name: 'B Member', gymId: GYM_B })
      await fs.doc('bookings/sec-booking-a').set({
        classId: 'sec-class-a',
        memberId: 'sec-member-a',
        status: 'booked',
        date: TODAY,
        gymId: GYM_A,
      })
      await fs.doc('bookings/sec-booking-b').set({
        classId: 'sec-class-b',
        memberId: 'sec-member-b',
        status: 'booked',
        date: TODAY,
        gymId: GYM_B,
      })
      await fs.doc('bookings/sec-booking-legacy').set({
        classId: 'sec-class-old',
        memberId: 'sec-legacy-member',
        status: 'booked',
      })
    })
  })

  afterAll(async () => {
    printLegacyReads('SEC-F legacy reads (recorded, ambiguous by design)')
    await env.cleanup()
  })

  const ownBooking = (extra) => ({
    classId: 'sec-class-a',
    memberId: 'sec-member-a',
    status: 'booked',
    date: TODAY,
    gymId: GYM_A,
    ...extra,
  })

  for (const [label, uid] of [
    ['owner', A.owner],
    ['admin', A.admin],
    ['trainer', A.trainer],
    ['frontDesk', A.frontDesk],
  ]) {
    it(`F1–F4 — ${label} can create a booking inside their own gym (app parity)`, async () => {
      await assertSucceeds(client(env, uid).collection('bookings').add(ownBooking()))
    })
  }

  for (const [label, uid] of [
    ['owner', A.owner],
    ['admin', A.admin],
    ['trainer', A.trainer],
    ['frontDesk', A.frontDesk],
  ]) {
    it(`F5 — ${label} cannot create a booking forged with gymId=${GYM_B}`, async () => {
      await assertFails(
        client(env, uid).collection('bookings').add({
          classId: 'sec-class-b',
          memberId: 'sec-member-b',
          status: 'booked',
          date: TODAY,
          gymId: GYM_B,
        })
      )
    })

    it(`F6 — ${label} cannot update a Gym B booking`, async () => {
      await assertFails(
        client(env, uid).doc('bookings/sec-booking-b').update({ status: 'cancelled' })
      )
    })

    it(`F7 — ${label} cannot delete a Gym B booking`, async () => {
      await assertFails(client(env, uid).doc('bookings/sec-booking-b').delete())
    })
  }

  it('F8 — a booking created on an own-gym path with a forged gymId is denied', async () => {
    await assertFails(
      client(env, A.trainer)
        .doc('bookings/sec-forged')
        .set({ classId: 'sec-class-a', memberId: 'sec-member-a', status: 'booked', gymId: GYM_B })
    )
    await assertFails(client(env, A.trainer).doc('bookings/sec-booking-a').update({ gymId: GYM_B }))
  })

  it('F9 — bookings are not readable cross-tenant (direct read and query)', async () => {
    await assertFails(client(env, A.owner).doc('bookings/sec-booking-b').get())
    await assertFails(client(env, A.owner).collection('bookings').where('gymId', '==', GYM_B).get())
    await assertFails(client(env, A.owner).collection('bookings').get())
  })

  it('F10 — records whether an untagged booking is readable by a foreign tenant', async () => {
    // Ambiguous legacy read: recorded, not asserted. F11 keeps the claim denial.
    await recordLegacyRead('B.owner', 'bookings/sec-booking-legacy', () =>
      client(env, B.owner).doc('bookings/sec-booking-legacy').get()
    )
  })

  it('F11 — a booking must not be claimable by any tenant (add gymId to an untagged one)', async () => {
    await assertFails(
      client(env, A.owner).doc('bookings/sec-booking-legacy').update({ gymId: GYM_A })
    )
    await assertFails(
      client(env, B.owner).doc('bookings/sec-booking-legacy').update({ gymId: GYM_B })
    )
  })

  it('F12 — staff may manage and cancel any booking inside their own gym (app parity)', async () => {
    const created = await client(env, A.trainer).collection('bookings').add(ownBooking())
    await assertSucceeds(
      client(env, A.trainer).doc(`bookings/${created.id}`).update({ status: 'cancelled' })
    )
    await assertSucceeds(client(env, A.trainer).doc(`bookings/${created.id}`).delete())
  })

  it("F13 — a booking may not be created that references another gym's member", async () => {
    await assertFails(
      client(env, A.owner).collection('bookings').add({
        classId: 'sec-class-a',
        memberId: 'sec-member-b',
        status: 'booked',
        date: TODAY,
        gymId: GYM_A,
      })
    )
  })
})

// ===========================================================================
// GROUP G — UNBOUND / MISSING PROFILE
// ===========================================================================
describe('SEC-G — unbound users (no gymId) and missing profiles (no users doc)', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin', name: 'Unbound' })
      // GHOST deliberately has NO users/{uid} document at all
      await fs.doc('settings/app').set({ gymName: 'Gym A', currency: 'INR', gymId: GYM_A })
      await fs.doc('members/sec-m-a').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('memberships/sec-ms-a').set({ planId: 'p1', price: 100, gymId: GYM_A })
      await fs.doc('payments/sec-p-a').set({ amount: 100, memberId: 'sec-m-a', gymId: GYM_A })
      await fs.doc('weightRecords/sec-w-a').set({ memberId: 'sec-m-a', weight: 70, gymId: GYM_A })
      await fs.doc('bookings/sec-bk-a').set({ memberId: 'sec-m-a', status: 'booked', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  const actors = [
    ['unbound (users doc, no gymId)', UNBOUND],
    ['ghost (no users doc at all)', GHOST],
  ]

  const protectedOps = [
    ['G1 read members', (db) => db.doc('members/sec-m-a').get()],
    ['G2 create member', (db) => db.collection('members').add({ name: 'X', gymId: GYM_A })],
    ['G3 update member', (db) => db.doc('members/sec-m-a').update({ name: 'Y' })],
    ['G4 delete member', (db) => db.doc('members/sec-m-a').delete()],
    ['G5 read membership', (db) => db.doc('memberships/sec-ms-a').get()],
    ['G6 create payment', (db) => db.collection('payments').add({ amount: 1, gymId: GYM_A })],
    ['G7 update payment', (db) => db.doc('payments/sec-p-a').update({ amount: 2 })],
    ['G8 read settings/app', (db) => db.doc('settings/app').get()],
    ['G9 write settings/app', (db) => db.doc('settings/app').update({ gymName: 'Hijacked' })],
    ['G10 read weight record', (db) => db.doc('weightRecords/sec-w-a').get()],
    ['G11 access bookings (read)', (db) => db.doc('bookings/sec-bk-a').get()],
    [
      'G11b access bookings (create)',
      (db) => db.collection('bookings').add({ memberId: 'x', gymId: GYM_A }),
    ],
  ]

  for (const [label, uid] of actors) {
    for (const [opLabel, op] of protectedOps) {
      it(`${label} is denied: ${opLabel}`, async () => {
        await assertFails(op(client(env, uid)))
      })
    }
  }

  it("G12 — a no-profile user cannot read another user's profile", async () => {
    await assertFails(client(env, GHOST).doc(`users/${A.owner}`).get())
    await assertFails(client(env, UNBOUND).doc(`users/${A.owner}`).get())
  })

  it('G13 — a no-profile user cannot read the member-number counter or any collection query', async () => {
    await assertFails(client(env, GHOST).collection('members').get())
    await assertFails(client(env, UNBOUND).collection('members').where('gymId', '==', GYM_A).get())
  })

  it('G14 — a no-profile user cannot bind itself to any gym via the onboarding path', async () => {
    await assertFails(client(env, GHOST).doc(`users/${GHOST}`).set({ role: 'owner', gymId: GYM_A }))
  })
})

/**
 * Diagnostic harness for Group G.
 *
 * It performs the same denied operations and records the exact error object
 * each one produced, so the report can distinguish
 *   (a) a clean policy denial, from
 *   (b) a RULES EVALUATION ERROR
 *       (e.g. `role()` dereferencing users/{uid} on a non-existent document).
 * Firestore surfaces both as PERMISSION_DENIED, so the SDK cannot tell them
 * apart by itself — this harness captures everything the SDK does expose, and
 * the emulator's own debug log supplies the rule line.
 *
 * It asserts only the stable, documented contract (PERMISSION_DENIED) and
 * prints the observed detail table. It never converts a denial into a pass.
 */
describe('SEC-G-diagnostic — denial error classification for unbound / missing profiles', () => {
  let env
  const observations = []

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin', name: 'Unbound' })
      await fs.doc('settings/app').set({ gymName: 'Gym A', currency: 'INR', gymId: GYM_A })
      await fs.doc('members/sec-d-m').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('payments/sec-d-p').set({ amount: 100, gymId: GYM_A })
    })
  })

  afterAll(async () => {
    if (observations.length) {
      console.log('\n===== SEC-G-diagnostic: observed denial detail =====')
      for (const o of observations) {
        console.log(
          `${o.actor.padEnd(8)} | ${o.operation.padEnd(22)} | ${o.outcome.padEnd(9)} | code=${o.code} | ${o.message}`
        )
      }
      console.log('===== end SEC-G-diagnostic =====\n')
    }
    await env.cleanup()
  })

  const probes = [
    ['members', 'read member', (db) => db.doc('members/sec-d-m').get()],
    ['members', 'create member', (db) => db.collection('members').add({ name: 'X', gymId: GYM_A })],
    [
      'payments',
      'create payment',
      (db) => db.collection('payments').add({ amount: 1, gymId: GYM_A }),
    ],
    ['settings', 'read settings/app', (db) => db.doc('settings/app').get()],
    [
      'settings',
      'update settings/app',
      (db) => db.doc('settings/app').update({ gymName: 'Hacked' }),
    ],
    ['gyms', 'read gym doc', (db) => db.doc(`gyms/${GYM_A}`).get()],
  ]

  for (const [actor, uid] of [
    ['unbound', UNBOUND],
    ['ghost', GHOST],
    ['anon', null],
  ]) {
    for (const [operation, label, op] of probes) {
      it(`diagnostic: ${actor} — ${operation} — ${label}`, async () => {
        const db = uid ? client(env, uid) : anon(env)
        let outcome
        let code = 'none'
        let message = ''
        try {
          await op(db)
          outcome = 'ALLOWED'
        } catch (e) {
          outcome = 'DENIED'
          code = e?.code ?? 'no-code'
          message = e?.message ?? String(e)
          expect(code).toBe('permission-denied')
        }
        observations.push({ actor, operation: label, outcome, code, message })
      })
    }
  }
})

// ===========================================================================
// GROUP H — GYM-ID FREEZING
// ===========================================================================
describe('SEC-H — gymId freezing on users/{uid}', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  for (const [label, uid] of [
    ['admin', A.admin],
    ['trainer', A.trainer],
    ['front-desk', A.frontDesk],
  ]) {
    it(`H1 — ${label} cannot change their own bound gymId`, async () => {
      await assertFails(client(env, uid).doc(`users/${uid}`).update({ gymId: GYM_B }))
      await assertFails(client(env, uid).doc(`users/${uid}`).set({ role: 'trainer', gymId: GYM_B }))
    })
  }

  it('H1b — owner cannot move their own profile to another gym', async () => {
    await assertFails(client(env, A.owner).doc(`users/${A.owner}`).update({ gymId: GYM_B }))
  })

  for (const [label, uid] of [
    ['admin', A.admin],
    ['trainer', A.trainer],
    ['front-desk', A.frontDesk],
  ]) {
    it(`H2 — ${label} cannot change gymId and role in the same write`, async () => {
      await assertFails(
        client(env, uid).doc(`users/${uid}`).update({ gymId: GYM_B, role: 'owner' })
      )
      await assertFails(client(env, uid).doc(`users/${uid}`).set({ role: 'owner', gymId: GYM_B }))
    })
  }

  it('H3 — an admin cannot move another in-gym user to a different gym', async () => {
    await assertFails(client(env, A.admin).doc(`users/${A.frontDesk}`).update({ gymId: GYM_B }))
    await assertFails(client(env, A.admin).doc(`users/${A.trainer}`).update({ gymId: GYM_B }))
  })

  it('H4 — a bound gymId cannot be cleared (set to null or removed from the payload)', async () => {
    await assertFails(client(env, A.frontDesk).doc(`users/${A.frontDesk}`).update({ gymId: null }))
    await assertFails(
      client(env, A.frontDesk).doc(`users/${A.frontDesk}`).set({ role: 'front-desk' })
    )
    await assertFails(
      client(env, A.frontDesk).doc(`users/${A.frontDesk}`).set({ role: 'owner', gymId: null })
    )
  })

  it('H5 — a bound user cannot be re-bound A -> B by writing B first then A', async () => {
    await assertFails(
      client(env, A.trainer).doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_B })
    )
    const after = await peekDoc(env, `users/${A.trainer}`)
    expect(after.exists).toBe(true)
    expect(after.data.gymId).toBe(GYM_A)
  })

  it('H6 — an owner cannot reassign an in-gym user into another gym', async () => {
    await assertFails(client(env, A.owner).doc(`users/${A.frontDesk}`).update({ gymId: GYM_B }))
    await assertFails(
      client(env, A.owner).doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_B })
    )
  })

  it('H7 — an unbound profile cannot bind to a gym owned by someone else', async () => {
    await assertFails(client(env, UNBOUND).doc(`users/${UNBOUND}`).update({ gymId: GYM_A }))
  })

  it('H8 — a bind must target a gym document that actually exists', async () => {
    const uid = 'sec-bind-missing-gym'
    await assertFails(
      client(env, uid).doc(`users/${uid}`).set({ role: 'owner', gymId: 'sec-nonexistent-gym' })
    )
  })

  it('H9 — the gyms owner-of-record document can never be rewritten or re-pointed', async () => {
    await assertFails(
      client(env, B.owner).doc(`gyms/${GYM_A}`).set({ ownerUid: B.owner, name: 'Stolen' })
    )
    await assertFails(client(env, B.owner).doc(`gyms/${GYM_B}`).update({ ownerUid: A.owner }))
    await assertFails(client(env, A.owner).doc(`gyms/${GYM_A}`).delete())
  })
})

// ===========================================================================
// GROUP I — PRIVILEGE SEPARATION ON MEMBER FIELDS
// ===========================================================================
// Baseline from the application permission model (src/utils/constants.js):
//   members.write = owner, admin, front-desk   (trainer EXCLUDED)
//   finance.write = owner, admin              (front-desk and trainer EXCLUDED)
// The rules use a blanket `isStaff()` for members, so any mismatch below is a
// rules/app privilege inconsistency rather than an invented policy.
describe('SEC-I — member field privilege separation vs finance privileges', () => {
  let env

  const financiallySignificant = {
    membershipPlanId: 'plan-quarterly',
    isPT: true,
    ptSurchargeOverride: 0,
    joinDate: '2026-01-01',
    status: 'expired',
  }

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs
        .doc('membershipPlans/sec-plan')
        .set({ name: 'Quarterly', price: 12000, gymId: GYM_A })
      for (const [key, uid] of Object.entries(A)) {
        await fs.doc(`members/sec-m-${key}`).set({
          name: `Member ${key}`,
          membershipPlanId: 'plan-quarterly',
          status: 'active',
          joinDate: '2026-02-02',
          isPT: false,
          ptSurchargeOverride: null,
          gymId: GYM_A,
        })
        void uid
      }
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  for (const [label, uid] of [
    ['owner', A.owner],
    ['admin', A.admin],
    ['front-desk', A.frontDesk],
  ]) {
    for (const [field, value] of Object.entries(financiallySignificant)) {
      it(`I — ${label} may change member.${field} (app grants members.write)`, async () => {
        await assertSucceeds(
          client(env, uid)
            .doc('members/sec-m-owner')
            .update({ [field]: value })
        )
      })
    }
  }

  for (const [field, value] of Object.entries(financiallySignificant)) {
    it(`I — trainer must NOT change member.${field} (app excludes trainer from members.write)`, async () => {
      await assertFails(
        client(env, A.trainer)
          .doc('members/sec-m-trainer')
          .update({ [field]: value })
      )
    })
  }

  it('I — trainer must NOT be able to create a member (app excludes trainer from members.write)', async () => {
    await assertFails(
      client(env, A.trainer)
        .collection('members')
        .add({ name: 'Trainer Made', status: 'active', gymId: GYM_A })
    )
  })

  it('I — trainer must NOT be able to delete a member', async () => {
    await assertFails(client(env, A.trainer).doc('members/sec-m-trainer').delete())
  })

  it('I — front-desk and trainer must NOT write financial collections (app: finance.write)', async () => {
    for (const uid of [A.frontDesk, A.trainer]) {
      await assertFails(
        client(env, uid)
          .collection('payments')
          .add({ amount: 100, memberId: 'sec-m-owner', gymId: GYM_A })
      )
      await assertFails(
        client(env, uid)
          .collection('memberships')
          .add({ planId: 'sec-plan', price: 100, gymId: GYM_A })
      )
      await assertFails(
        client(env, uid)
          .collection('membershipPlans')
          .add({ name: 'Cheat', price: 1, gymId: GYM_A })
      )
      await assertFails(
        client(env, uid).collection('expenses').add({ title: 'Cheat', amount: 1, gymId: GYM_A })
      )
    }
  })

  it('I — the privilege split is observable: a role may reprice a member but not record the money', async () => {
    // front-desk can set a per-member PT surcharge override (financial) while
    // being unable to create the payment that would record it.
    await assertSucceeds(
      client(env, A.frontDesk).doc('members/sec-m-frontDesk').update({ ptSurchargeOverride: 5000 })
    )
    await assertFails(
      client(env, A.frontDesk)
        .collection('payments')
        .add({ amount: 5000, memberId: 'sec-m-frontDesk', gymId: GYM_A })
    )
  })

  it('I — membership plan pricing stays finance-only (owner/admin) on every tenant', async () => {
    await assertSucceeds(
      client(env, A.admin).doc('membershipPlans/sec-plan').update({ price: 13000 })
    )
    await assertFails(client(env, A.frontDesk).doc('membershipPlans/sec-plan').update({ price: 1 }))
    await assertFails(client(env, A.trainer).doc('membershipPlans/sec-plan').update({ price: 1 }))
  })

  it('I — members are never writable across the tenant boundary regardless of role', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('members/sec-m-b').set({ name: 'B Member', gymId: GYM_B })
    })
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk]) {
      await assertFails(client(env, uid).doc('members/sec-m-b').update({ status: 'frozen' }))
      await assertFails(client(env, uid).doc('members/sec-m-b').delete())
    }
  })
})

// ===========================================================================
// GROUP J — CROSS-TENANT QUERY SAFETY
// ===========================================================================
describe('SEC-J — cross-tenant query isolation', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs
        .doc('members/secq-m-a')
        .set({ name: 'Query A', memberNo: 'MEM-0001', gymId: GYM_A, createdAt: TODAY })
      await fs
        .doc('members/secq-m-b')
        .set({ name: 'Query B', memberNo: 'MEM-0002', gymId: GYM_B, createdAt: TODAY })
      await fs.doc('members/secq-m-legacy').set({ name: 'Query A', memberNo: 'MEM-0003' })
      await fs.doc('payments/secq-p-a').set({ amount: 100, memberId: 'secq-m-a', gymId: GYM_A })
      await fs.doc('payments/secq-p-b').set({ amount: 200, memberId: 'secq-m-b', gymId: GYM_B })
      await fs.doc('bookings/secq-bk-a').set({ memberId: 'secq-m-a', gymId: GYM_A })
      await fs.doc('counters/secq-c-a').set({ value: 1, gymId: GYM_A })
      await fs.doc('auditLog/secq-al-a').set({ action: 'create', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    printLegacyReads('SEC-J legacy reads (recorded, ambiguous by design)')
    await env.cleanup()
  })

  const collections = [
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

  for (const collection of collections) {
    it(`J1 — an unscoped ${collection} collection read is denied`, async () => {
      await assertFails(client(env, A.owner).collection(collection).get())
      await assertFails(client(env, A.trainer).collection(collection).get())
    })
  }

  it("J2 — a gymId-filtered query returns only the caller's own tenant (never the other gym)", async () => {
    const snap = await client(env, A.owner).collection('members').where('gymId', '==', GYM_A).get()
    const ids = snap.docs.map((d) => d.id)
    // Other suites legitimately seed members in Gym A, so the invariant is
    // containment (own data present) plus absence (no foreign / legacy data).
    expect(ids).toContain('secq-m-a')
    expect(ids).not.toContain('secq-m-b')
    expect(ids).not.toContain('secq-m-legacy')
    console.log(
      `J2 observed: gymId==${GYM_A} returned ${ids.length} member(s): ${ids.sort().join(', ')}`
    )
  })

  it('J3 — a query filtered to the other gym is denied', async () => {
    await assertFails(client(env, A.owner).collection('members').where('gymId', '==', GYM_B).get())
    await assertFails(client(env, A.owner).collection('payments').where('gymId', '==', GYM_B).get())
    await assertFails(client(env, A.owner).collection('auditLog').where('gymId', '==', GYM_B).get())
    await assertFails(client(env, A.owner).collection('counters').where('gymId', '==', GYM_B).get())
  })

  it('J4 — an "in" query spanning two gyms cannot be used to leak the other tenant', async () => {
    await assertFails(
      client(env, A.owner).collection('members').where('gymId', 'in', [GYM_A, GYM_B]).get()
    )
  })

  it('J5 — a non-tenancy filter aimed at a foreign-tenant doc is denied', async () => {
    // memberNo === 'MEM-0002' belongs to secq-m-b (Gym B). This target is
    // unambiguous, so it stays a hard DENY. The legacy-matching sibling filter
    // moved to J6 so it can no longer mask this assertion.
    await assertFails(
      client(env, A.owner).collection('members').where('memberNo', '==', 'MEM-0002').get()
    )
  })

  it('J6 — records what a filter matching an untagged legacy doc returns', async () => {
    // name === 'Query A' matches secq-m-a (own tenant) AND secq-m-legacy
    // (untagged). Firestore cannot prove the legacy disjunct away, so this read
    // is the same approved ambiguity as D1/D2: recorded with the exact result
    // set, never asserted as a denial.
    await recordLegacyRead('A.owner', 'members where name == "Query A"', () =>
      client(env, A.owner).collection('members').where('name', '==', 'Query A').get()
    )
  })

  it('J7 — the app-shaped list query (gymId filter + orderBy + limit) works for the caller gym', async () => {
    const q = client(env, A.admin)
      .collection('members')
      .where('gymId', '==', GYM_A)
      .orderBy('createdAt', 'desc')
      .limit(20)
    await assertSucceeds(q.get())
  })

  it('J8 — the users collection cannot be enumerated', async () => {
    await assertFails(client(env, A.owner).collection('users').get())
    await assertFails(client(env, A.owner).collection('users').where('gymId', '==', GYM_A).get())
  })

  it('J9 — onboarding gym discovery (query gyms by ownerUid) does not leak foreign gyms', async () => {
    // AuthContext.bootstrapProfile relies on this query (src/context/AuthContext.jsx:100)
    const snap = await client(env, A.owner)
      .collection('gyms')
      .where('ownerUid', '==', A.owner)
      .get()
    expect(snap.docs.map((d) => d.id)).toEqual([GYM_A])
  })

  it('J10 — the gyms collection cannot be enumerated unscoped', async () => {
    await assertFails(client(env, A.owner).collection('gyms').get())
  })

  it('J11 — a scoped query from the other tenant returns only its own documents', async () => {
    const snap = await client(env, B.owner).collection('members').where('gymId', '==', GYM_B).get()
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('secq-m-b')
    expect(ids).not.toContain('secq-m-a')
    expect(ids).not.toContain('secq-m-legacy')
  })
})

// ===========================================================================
// GROUP K — COUNTERS
// ===========================================================================
describe('SEC-K — counters tenancy (gap coverage only)', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      await fs.doc('counters/sec-c-a').set({ value: 7, gymId: GYM_A })
      await fs.doc('counters/sec-c-b').set({ value: 3, gymId: GYM_B })
      await fs.doc('counters/sec-c-legacy').set({ value: 99 })
      await fs.doc('counters/sec-c-legacy-claim').set({ value: 98 })
    })
  })

  afterAll(async () => {
    printLegacyReads('SEC-K legacy reads (recorded, ambiguous by design)')
    await env.cleanup()
  })

  it('K1 — trainer and front-desk can read and advance their own gym counter (app parity)', async () => {
    await assertSucceeds(client(env, A.trainer).doc('counters/sec-c-a').get())
    await assertSucceeds(client(env, A.trainer).doc('counters/sec-c-a').update({ value: 8 }))
    await assertSucceeds(client(env, A.frontDesk).doc('counters/sec-c-a').update({ value: 9 }))
  })

  it('K2 — a counter write may never carry a forged gymId', async () => {
    await assertFails(
      client(env, A.trainer).doc('counters/sec-c-a').update({ value: 10, gymId: GYM_B })
    )
    await assertFails(client(env, A.trainer).collection('counters').add({ value: 1, gymId: GYM_B }))
    await assertFails(
      client(env, A.frontDesk).doc('counters/sec-c-b').update({ value: 4, gymId: GYM_A })
    )
  })

  it('K3 — cross-tenant counter reads and updates are denied for every role', async () => {
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk]) {
      await assertFails(client(env, uid).doc('counters/sec-c-b').get())
      await assertFails(client(env, uid).doc('counters/sec-c-b').update({ value: 99 }))
      await assertFails(client(env, uid).doc('counters/sec-c-b').delete())
    }
  })

  it('K4 — a counter document can never have its gymId re-pointed', async () => {
    await assertFails(client(env, A.owner).doc('counters/sec-c-a').update({ gymId: GYM_B }))
    await assertFails(client(env, A.owner).doc('counters/sec-c-a').set({ value: 1, gymId: GYM_B }))
  })

  it('K5 — counters are never deletable from a client (no delete rule exists)', async () => {
    for (const uid of [A.owner, A.admin, B.owner]) {
      await assertFails(client(env, uid).doc('counters/sec-c-a').delete())
    }
  })

  it('K6 — an unbound profile and an anonymous client cannot touch counters', async () => {
    await assertFails(client(env, UNBOUND).doc('counters/sec-c-a').get())
    await assertFails(client(env, UNBOUND).doc('counters/sec-c-a').update({ value: 0 }))
    await assertFails(anon(env).doc('counters/sec-c-a').get())
    await assertFails(anon(env).doc('counters/sec-c-a').update({ value: 0 }))
  })

  it('K7 — records whether an untagged counter is readable by either tenant', async () => {
    // Ambiguous legacy read: recorded, not asserted. K8 keeps the claim denial.
    await recordLegacyRead('A.owner', 'counters/sec-c-legacy', () =>
      client(env, A.owner).doc('counters/sec-c-legacy').get()
    )
    await recordLegacyRead('B.owner', 'counters/sec-c-legacy', () =>
      client(env, B.owner).doc('counters/sec-c-legacy').get()
    )
  })

  it('K8 — an untagged counter must not be claimable by any tenant', async () => {
    await assertFails(
      client(env, A.owner).doc('counters/sec-c-legacy-claim').update({ gymId: GYM_A })
    )
    await assertFails(
      client(env, B.owner).doc('counters/sec-c-legacy-claim').update({ gymId: GYM_B })
    )
  })

  it('K8 — counter writes may not smuggle role or tenancy fields', async () => {
    await assertSucceeds(
      client(env, A.admin)
        .doc('counters/sec-c-a')
        .update({ value: 10, gymId: GYM_A, role: 'owner' })
    )
    // the smuggled field is inert: it must not grant the caller anything
    await assertFails(client(env, A.trainer).doc('counters/sec-c-b').get())
  })
})

// ===========================================================================
// GROUP L — UNAUTHENTICATED ACCESS
// ===========================================================================
describe('SEC-L — unauthenticated access is denied everywhere', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc('settings/app').set({ gymName: 'Gym A', currency: 'INR', gymId: GYM_A })
      await fs.doc('members/secl-m').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('payments/secl-p').set({ amount: 100, gymId: GYM_A })
      await fs.doc('memberships/secl-ms').set({ price: 100, gymId: GYM_A })
      await fs.doc('weightRecords/secl-w').set({ weight: 70, gymId: GYM_A })
      await fs.doc('bookings/secl-bk').set({ status: 'booked', gymId: GYM_A })
      await fs.doc('auditLog/secl-al').set({ action: 'create', gymId: GYM_A })
      await fs.doc('counters/secl-c').set({ value: 1, gymId: GYM_A })
      await fs.doc('classes/secl-cl').set({ name: 'Class', gymId: GYM_A })
      await fs.doc('trainers/secl-t').set({ name: 'Trainer', gymId: GYM_A })
      await fs.doc('attendance/secl-at').set({ memberId: 'secl-m', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  const surfaces = [
    ['settings/app', 'get', (db) => db.doc('settings/app').get()],
    ['settings/app', 'set', (db) => db.doc('settings/app').set({ gymName: 'Anon' })],
    ['settings/app', 'update', (db) => db.doc('settings/app').update({ gymName: 'Anon' })],
    ['settings/app', 'delete', (db) => db.doc('settings/app').delete()],
    ['users/{self}', 'get', (db) => db.doc(`users/${A.owner}`).get()],
    [
      'users/{other}',
      'set',
      (db) => db.doc('users/anon-created').set({ role: 'owner', gymId: GYM_A }),
    ],
    ['users/{other}', 'delete', (db) => db.doc(`users/${A.owner}`).delete()],
    ['users collection', 'query', (db) => db.collection('users').get()],
    ['auditLog', 'get', (db) => db.doc('auditLog/secl-al').get()],
    ['auditLog', 'add', (db) => db.collection('auditLog').add({ action: 'x', gymId: GYM_A })],
    ['auditLog', 'update', (db) => db.doc('auditLog/secl-al').update({ action: 'tampered' })],
    ['auditLog', 'delete', (db) => db.doc('auditLog/secl-al').delete()],
    ['bookings', 'get', (db) => db.doc('bookings/secl-bk').get()],
    ['bookings', 'add', (db) => db.collection('bookings').add({ status: 'booked', gymId: GYM_A })],
    ['bookings', 'update', (db) => db.doc('bookings/secl-bk').update({ status: 'cancelled' })],
    ['bookings', 'delete', (db) => db.doc('bookings/secl-bk').delete()],
    ['bookings', 'query', (db) => db.collection('bookings').get()],
    ['members', 'get', (db) => db.doc('members/secl-m').get()],
    ['members', 'add', (db) => db.collection('members').add({ name: 'X', gymId: GYM_A })],
    ['members', 'update', (db) => db.doc('members/secl-m').update({ name: 'X' })],
    ['members', 'delete', (db) => db.doc('members/secl-m').delete()],
    ['members', 'query', (db) => db.collection('members').get()],
    ['payments', 'get', (db) => db.doc('payments/secl-p').get()],
    ['payments', 'add', (db) => db.collection('payments').add({ amount: 1, gymId: GYM_A })],
    ['payments', 'update', (db) => db.doc('payments/secl-p').update({ amount: 1 })],
    ['payments', 'delete', (db) => db.doc('payments/secl-p').delete()],
    ['memberships', 'get', (db) => db.doc('memberships/secl-ms').get()],
    ['memberships', 'add', (db) => db.collection('memberships').add({ price: 1, gymId: GYM_A })],
    ['memberships', 'update', (db) => db.doc('memberships/secl-ms').update({ price: 1 })],
    ['weightRecords', 'get', (db) => db.doc('weightRecords/secl-w').get()],
    [
      'weightRecords',
      'add',
      (db) => db.collection('weightRecords').add({ weight: 60, gymId: GYM_A }),
    ],
    ['weightRecords', 'update', (db) => db.doc('weightRecords/secl-w').update({ weight: 60 })],
    ['counters', 'get', (db) => db.doc('counters/secl-c').get()],
    ['counters', 'update', (db) => db.doc('counters/secl-c').update({ value: 2 })],
    ['classes', 'get', (db) => db.doc('classes/secl-cl').get()],
    ['classes', 'add', (db) => db.collection('classes').add({ name: 'X', gymId: GYM_A })],
    ['trainers', 'get', (db) => db.doc('trainers/secl-t').get()],
    ['trainers', 'add', (db) => db.collection('trainers').add({ name: 'X', gymId: GYM_A })],
    ['attendance', 'get', (db) => db.doc('attendance/secl-at').get()],
    ['attendance', 'add', (db) => db.collection('attendance').add({ memberId: 'x', gymId: GYM_A })],
    ['gyms', 'get', (db) => db.doc(`gyms/${GYM_A}`).get()],
    ['gyms', 'add', (db) => db.collection('gyms').add({ ownerUid: 'anon' })],
    ['gyms', 'delete', (db) => db.doc(`gyms/${GYM_A}`).delete()],
  ]

  for (const [surface, verb, op] of surfaces) {
    it(`L — anonymous ${verb} on ${surface} is denied`, async () => {
      await assertFails(op(anon(env)))
    })
  }
})

// ===========================================================================
// GROUP M — ROLE / GYM MATRIX
// ===========================================================================
// Members (staff-writable) fully crossed: 7 actors x 3 scopes x 4 operations.
// Payments (finance-only) trimmed: 6 actors x 2 scopes x 4 operations.
//
// `ownIndex` is the index into the seeded document pair that belongs to the
// actor's own gym (0 = Gym A, 1 = Gym B, null = the actor has no bound gym and
// therefore owns nothing in either tenant).
const MATRIX_ACTORS = [
  { label: 'owner of Gym A', uid: A.owner, tier: 'owner', ownIndex: 0 },
  { label: 'owner of Gym B', uid: B.owner, tier: 'owner', ownIndex: 1 },
  { label: 'admin of Gym A', uid: A.admin, tier: 'admin', ownIndex: 0 },
  { label: 'trainer of Gym A', uid: A.trainer, tier: 'trainer', ownIndex: 0 },
  { label: 'front-desk of Gym A', uid: A.frontDesk, tier: 'front-desk', ownIndex: 0 },
  { label: 'unbound (no gymId)', uid: UNBOUND, tier: null, ownIndex: null },
  { label: 'anonymous', uid: null, tier: null, ownIndex: null },
]

const MATRIX_ACTORS_FINANCE = MATRIX_ACTORS.filter((a) => a.label !== 'unbound (no gymId)')

// The one security invariant the matrix encodes: a document may be touched ONLY
// by staff whose bound gymId equals the document's gymId (or, for create, by
// staff of the gym named in their own payload). Untagged and foreign-gym
// documents are never allowed for anybody.
const MATRIX_MEMBERS = [
  ['sec-mm-a', { name: 'Matrix A', gymId: GYM_A }],
  ['sec-mm-b', { name: 'Matrix B', gymId: GYM_B }],
  ['sec-mm-legacy', { name: 'Matrix Legacy' }],
]

const MATRIX_PAYMENTS = [
  ['sec-mp-a', { amount: 100, gymId: GYM_A }],
  ['sec-mp-b', { amount: 200, gymId: GYM_B }],
]

/**
 * Builds the three scopes for one actor:
 *   'own'    -> the document that belongs to the actor's own gym
 *   'other'  -> the document that belongs to the OTHER tenant
 *   'untagged' -> the pre-tenancy document with no gymId
 * Actors with no bound gym get Gym A documents in both the 'own' and 'other'
 * slots, because neither is theirs — every cell must be denied.
 */
function scopesFor(actor, docs, { withUntagged = true } = {}) {
  const ownIdx = actor.ownIndex ?? 0
  const otherIdx = actor.ownIndex === null ? 1 : 1 - actor.ownIndex
  const scopes = [
    { scope: 'own gym data', docId: docs[ownIdx][0], doc: docs[ownIdx][1], isOwn: true },
    { scope: 'other gym data', docId: docs[otherIdx][0], doc: docs[otherIdx][1], isOwn: false },
  ]
  if (withUntagged) {
    scopes.push({ scope: 'untagged data', docId: docs[2][0], doc: docs[2][1], isOwn: false })
  }
  return scopes
}

function memberExpectation(actor, isOwn, verb) {
  if (!isOwn || actor.tier === null) return false
  if (verb === 'delete') return actor.tier === 'owner' || actor.tier === 'admin'
  return true // read / create / update for any staff of the same gym
}

function paymentExpectation(actor, isOwn, verb) {
  if (!isOwn || actor.tier === null) return false
  if (verb === 'delete') return actor.tier === 'owner'
  return actor.tier === 'owner' || actor.tier === 'admin' // isFinance()
}

const MATRIX_OPS = {
  read: (db, id) => db.doc(`members/${id}`).get(),
  create: (db, id, doc) => db.collection('members').add(doc),
  update: (db, id, doc) => db.doc(`members/${id}`).update(doc),
  delete: (db, id) => db.doc(`members/${id}`).delete(),
}

const PAYMENT_OPS = {
  read: (db, id) => db.doc(`payments/${id}`).get(),
  create: (db, id, doc) => db.collection('payments').add(doc),
  update: (db, id, doc) => db.doc(`payments/${id}`).update(doc),
  delete: (db, id) => db.doc(`payments/${id}`).delete(),
}

describe('SEC-M — role / gym / operation matrix (members)', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${B.admin}`).set({ role: 'admin', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      for (const [id, data] of MATRIX_MEMBERS) await fs.doc(`members/${id}`).set(data)
    })
  })

  afterAll(async () => {
    printLegacyReads('SEC-M untagged reads (recorded, ambiguous by design)')
    await env.cleanup()
  })

  for (const [actorIndex, actor] of MATRIX_ACTORS.entries()) {
    for (const [scopeIndex, { scope, doc, isOwn }] of scopesFor(actor, MATRIX_MEMBERS).entries()) {
      for (const verb of ['read', 'create', 'update', 'delete']) {
        const recorded = scope === 'untagged data' && verb === 'read'
        const allow = memberExpectation(actor, isOwn, verb)
        const expectation = recorded ? 'RECORD (ambiguous legacy read)' : allow ? 'ALLOW' : 'DENY'
        it(`M — ${actor.label} / ${scope} / members.${verb} → expect ${expectation}`, async () => {
          const db = actor.uid ? client(env, actor.uid) : anon(env)
          // A dedicated document per cell: an ALLOWed delete in one cell can
          // never remove the document a later cell depends on.
          const cellId = `sec-mm-c${actorIndex}${scopeIndex}-${verb}`
          await seedCell(env, 'members', cellId, doc)
          if (recorded) {
            // Approved legacy posture: read-allowed, recorded not asserted.
            // Claims/mutations on this same untagged doc stay hard DENY below.
            await recordLegacyRead(actor.label, `members.${verb} (untagged)`, () =>
              MATRIX_OPS[verb](db, cellId, doc)
            )
            return
          }
          if (allow) {
            if (verb === 'create') {
              // creates are point-in-time; tag them so no two cells collide
              await assertSucceeds(
                db.collection('members').add({ ...doc, matrixCell: `${actor.label}/${scope}` })
              )
            } else {
              await assertSucceeds(MATRIX_OPS[verb](db, cellId, doc))
            }
          } else {
            await assertFails(MATRIX_OPS[verb](db, cellId, doc))
          }
        })
      }
    }
  }
})

describe('SEC-M — role / gym / operation matrix (payments, finance collection)', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${B.admin}`).set({ role: 'admin', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      for (const [id, data] of MATRIX_PAYMENTS) await fs.doc(`payments/${id}`).set(data)
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  for (const [actorIndex, actor] of MATRIX_ACTORS_FINANCE.entries()) {
    for (const [scopeIndex, { scope, doc, isOwn }] of scopesFor(actor, MATRIX_PAYMENTS, {
      withUntagged: false,
    }).entries()) {
      for (const verb of ['read', 'create', 'update', 'delete']) {
        const allow = paymentExpectation(actor, isOwn, verb)
        it(`M — ${actor.label} / ${scope} / payments.${verb} → expect ${allow ? 'ALLOW' : 'DENY'}`, async () => {
          const db = actor.uid ? client(env, actor.uid) : anon(env)
          const cellId = `sec-mp-c${actorIndex}${scopeIndex}-${verb}`
          await seedCell(env, 'payments', cellId, doc)
          if (allow) {
            if (verb === 'create') {
              await assertSucceeds(
                db.collection('payments').add({ ...doc, matrixCell: `${actor.label}/${scope}` })
              )
            } else {
              await assertSucceeds(PAYMENT_OPS[verb](db, cellId, doc))
            }
          } else {
            await assertFails(PAYMENT_OPS[verb](db, cellId, doc))
          }
        })
      }
    }
  }
})

// ===========================================================================
// GROUP N — OBSERVATION HARNESS
// ===========================================================================
/**
 * Records the ACTUAL outcome of every role x gym x operation cell and prints it
 * as a markdown table. This suite deliberately asserts nothing: it is the
 * evidence table for the report, not a pass/fail gate. It never swallows a
 * failure silently — each cell's outcome and error code are printed.
 */
describe('SEC-N — observed behaviour matrix (records actual outcomes, asserts nothing)', () => {
  let env
  const rows = []

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${B.admin}`).set({ role: 'admin', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      for (const [id, data] of MATRIX_MEMBERS) await fs.doc(`members/${id}`).set(data)
      for (const [id, data] of MATRIX_PAYMENTS) await fs.doc(`payments/${id}`).set(data)
    })
  })

  afterAll(async () => {
    console.log('\n===== SEC-N: observed behaviour matrix (members) =====')
    console.log('| actor | scope | read | create | update | delete |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    for (const row of rows) {
      console.log(
        `| ${row.actor} | ${row.scope} | ${row.read} | ${row.create} | ${row.update} | ${row.delete} |`
      )
    }
    console.log('===== end SEC-N =====\n')
    await env.cleanup()
  })

  async function observe(op) {
    try {
      await op()
      return 'ALLOWED'
    } catch (e) {
      return e?.code === 'permission-denied' ? 'DENIED' : `ERR:${e?.code ?? 'unknown'}`
    }
  }

  const OBS_ACTORS = [
    ...MATRIX_ACTORS,
    { label: 'admin of Gym B', uid: B.admin, tier: 'admin', ownIndex: 1 },
    { label: 'ghost (no profile)', uid: GHOST, tier: null, ownIndex: null },
  ]

  for (const actor of OBS_ACTORS) {
    it(`observe: ${actor.label}`, async () => {
      const db = actor.uid ? client(env, actor.uid) : anon(env)
      for (const { scope, docId, doc } of scopesFor(actor, MATRIX_MEMBERS)) {
        const cells = {
          read: await observe(() => db.doc(`members/${docId}`).get()),
          create: await observe(() =>
            db.collection('members').add({ ...doc, observed: `${actor.label}/${scope}` })
          ),
          update: await observe(() =>
            db.doc(`members/${docId}`).update({ ...doc, observedAt: TODAY })
          ),
          delete: await observe(() => db.doc(`members/${docId}`).delete()),
        }
        rows.push({
          actor: actor.label,
          scope: scope === 'own gym data' ? 'own gym data' : scope,
          ...cells,
        })
      }
    })
  }
})

// ===========================================================================
// GROUP O — RENEWAL TRANSACTION PAYLOAD (real shape from src/services/renewals.js)
// ===========================================================================
/**
 * `renewMembership` writes its period and its payment with raw
 * DocumentReferences inside one transaction, deliberately bypassing the
 * `createDoc` helper that stamps `gymId` on every other client write in the
 * app. That makes the payload shape itself a security-relevant invariant:
 * `canWriteTenant` denies ANY document that does not carry the caller's own
 * gymId, on a create exactly as on an update.
 *
 * Every other suite in this file writes synthetic one-field documents with an
 * explicit gymId, so none of them would notice if a refactor dropped the stamp
 * from the renewal payloads. These cases pin the real field set produced by
 * renewMembership, so that regression fails here — as ALLOWED-vs-DENIED against
 * the real rules — instead of silently breaking renewals in production while
 * every unit test and the rest of this suite stay green.
 *
 * The `...(gymId === undefined ? {} : { gymId })` spread is what makes the
 * unstamped variant genuinely absent the field, rather than present-and-null:
 * `canWriteTenant` tests `'gymId' in request.resource.data`, so a null value
 * would satisfy the `in` check and quietly not model the defect at all.
 */
describe('SEC-O — renewal transaction payload carries the caller gymId', () => {
  let env

  /** Mirrors `membershipData` in src/services/renewals.js. */
  const renewalPeriod = (gymId) => ({
    memberId: 'sec-o-m',
    planId: 'sec-o-plan',
    planName: '3 Months',
    startDate: '2026-02-01',
    expiryDate: '2026-05-01',
    price: 3500,
    basePrice: 3500,
    ptSurcharge: 0,
    isPT: false,
    freezeTailDays: 0,
    freezeTailAmount: 0,
    freezeTailSettledFor: null,
    totalCharged: 3500,
    amountPaid: 3500,
    amountDue: 0,
    paymentStatus: 'paid',
    paymentId: 'sec-o-pay',
    receiptNo: 'HWG-000001',
    ...(gymId === undefined ? {} : { gymId }),
  })

  /** Mirrors `paymentData` in src/services/renewals.js. */
  const renewalPayment = (gymId) => ({
    memberId: 'sec-o-m',
    planId: 'sec-o-plan',
    memberName: 'A Member',
    planName: '3 Months',
    amount: 3500,
    basePrice: 3500,
    ptSurcharge: 0,
    freezeTailDays: 0,
    freezeTailAmount: 0,
    isPT: false,
    method: 'Cash',
    date: '2026-02-01',
    note: 'Renewal - 3 Months',
    type: 'renewal',
    startDate: '2026-02-01',
    expiryDate: '2026-05-01',
    paymentStatus: 'paid',
    membershipId: 'sec-o-ms',
    receiptNo: 'HWG-000001',
    ...(gymId === undefined ? {} : { gymId }),
  })

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc('members/sec-o-m').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('membershipPlans/sec-o-plan').set({
        name: '3 Months',
        durationDays: 90,
        price: 3500,
        gymId: GYM_A,
      })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('O1 owner commits the renewal period stamped with its own gymId', async () => {
    await assertSucceeds(
      client(env, A.owner).collection('memberships').add(renewalPeriod(GYM_A))
    )
  })

  it('O2 owner commits the renewal payment stamped with its own gymId', async () => {
    await assertSucceeds(client(env, A.owner).collection('payments').add(renewalPayment(GYM_A)))
  })

  it('O3 admin commits both — the renewal gate is isFinance, so admin qualifies', async () => {
    const db = client(env, A.admin)
    await assertSucceeds(db.collection('memberships').add(renewalPeriod(GYM_A)))
    await assertSucceeds(db.collection('payments').add(renewalPayment(GYM_A)))
  })

  it('O4 the SAME period with no gymId field at all is denied', async () => {
    await assertFails(
      client(env, A.owner).collection('memberships').add(renewalPeriod(undefined))
    )
  })

  it('O5 the SAME payment with no gymId field at all is denied', async () => {
    await assertFails(client(env, A.owner).collection('payments').add(renewalPayment(undefined)))
  })

  it('O6 a period stamped with the other gym is denied', async () => {
    await assertFails(client(env, A.owner).collection('memberships').add(renewalPeriod(GYM_B)))
  })

  it('O7 a payment stamped with the other gym is denied', async () => {
    await assertFails(client(env, A.owner).collection('payments').add(renewalPayment(GYM_B)))
  })

  it('O8 front-desk cannot commit the renewal period even correctly stamped', async () => {
    await assertFails(
      client(env, A.frontDesk).collection('memberships').add(renewalPeriod(GYM_A))
    )
  })

  it('O9 the other gym owner cannot commit a period into Gym A', async () => {
    await assertFails(client(env, B.owner).collection('memberships').add(renewalPeriod(GYM_A)))
  })
})
