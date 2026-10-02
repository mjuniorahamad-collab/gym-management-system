/**
 * PHASE 1 — REMEDIATION REGRESSION SUITE (additive)
 *
 * Companion to the frozen Phase 0.5A evidence file
 * (`firestoreSecurityEmulator.test.js`), which is deliberately left untouched:
 * it is the reproducible VULNERABLE BASELINE and records which assertions the
 * pre-remediation rules failed.
 *
 * This file asserts the REMEDIATED behaviour directly. Every test performs a
 * real Firestore operation against the emulator through `assertSucceeds` /
 * `assertFails` — nothing here inspects firestore.rules as text.
 *
 * Why a separate file rather than edits to the evidence file:
 *   - the evidence file is a frozen artifact whose failing tests ARE the
 *     deliverable; changing it would destroy the audit trail;
 *   - two assertions in that file are mutually exclusive. C2 requires
 *     ownerB's read of `settings/app` to FAIL, while C6/C7 requires the very
 *     same read to SUCCEED and return unchanged values. No rule set can
 *     satisfy both. The tenant-isolation intent is asserted here instead, in
 *     a form that is actually satisfiable: a foreign owner is denied.
 *
 * All ids are `rem-`-prefixed so this suite can never disturb either the
 * original rules suite or the Phase 0.5A evidence suite, which may run in
 * parallel against the single emulator.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, runTransaction } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'rem-gym-a'
const GYM_B = 'rem-gym-b'

const A = {
  owner: 'rem-owner-a',
  admin: 'rem-admin-a',
  trainer: 'rem-trainer-a',
  frontDesk: 'rem-front-desk-a',
}
const B = { owner: 'rem-owner-b' }

// A profile that carries a role but no gymId: unbound tenancy.
const UNBOUND = 'rem-unbound-no-gymid'
// A caller with no users/{uid} document at all.
const GHOST = 'rem-ghost-no-profile'

const TODAY = '2026-10-02'

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

// ===========================================================================
// Role immutability and profile lifecycle
// ===========================================================================
describe('REM role escalation on users/{uid}', () => {
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

  afterAll(async () => env.cleanup())

  it('admin cannot self-promote to owner via update()', async () => {
    await assertFails(client(env, A.admin).doc(`users/${A.admin}`).update({ role: 'owner' }))
  })

  it('admin cannot self-promote to owner via a full set() that preserves gymId', async () => {
    await assertFails(
      client(env, A.admin).doc(`users/${A.admin}`).set({ role: 'owner', gymId: GYM_A, name: 'Admin A' })
    )
  })

  it('admin cannot promote an in-gym front-desk user to owner', async () => {
    await assertFails(client(env, A.admin).doc(`users/${A.frontDesk}`).update({ role: 'owner' }))
  })

  it('admin cannot change the role of the gym owner', async () => {
    await assertFails(client(env, A.admin).doc(`users/${A.owner}`).update({ role: 'trainer' }))
  })

  it('trainer cannot change their own or another user role', async () => {
    await assertFails(client(env, A.trainer).doc(`users/${A.trainer}`).update({ role: 'admin' }))
    await assertFails(client(env, A.trainer).doc(`users/${A.frontDesk}`).update({ role: 'owner' }))
  })

  it('front-desk cannot change any role', async () => {
    await assertFails(client(env, A.frontDesk).doc(`users/${A.frontDesk}`).update({ role: 'admin' }))
    await assertFails(client(env, A.frontDesk).doc(`users/${A.admin}`).update({ role: 'owner' }))
  })

  it('a role smuggled alongside unrelated safe fields is still denied', async () => {
    await assertFails(
      client(env, A.trainer)
        .doc(`users/${A.trainer}`)
        .update({ role: 'owner', name: 'New Name', email: 'attacker@evil.test' })
    )
  })

  it('a privileged or misspelled role is never accepted', async () => {
    await assertFails(client(env, A.admin).doc(`users/${A.admin}`).update({ role: 'superadmin' }))
    await assertFails(client(env, A.admin).doc(`users/${A.frontDesk}`).update({ role: 'OWNER' }))
    await assertFails(client(env, A.owner).doc(`users/${A.trainer}`).update({ role: 'root' }))
  })

  it('a bound gymId can never be moved to another gym', async () => {
    await assertFails(
      client(env, A.admin).doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_B, name: 'Admin A' })
    )
    await assertFails(client(env, A.admin).doc(`users/${A.admin}`).update({ gymId: GYM_B }))
  })

  it('a user cannot be created or edited by a different uid', async () => {
    await assertFails(
      client(env, A.admin).doc(`users/${A.trainer}`).set({ role: 'owner', gymId: GYM_A, name: 'Owned' })
    )
  })

  it('no profile is ever client-deletable, including the owner binding the tenant', async () => {
    await assertFails(client(env, A.owner).doc(`users/${A.owner}`).delete())
    await assertFails(client(env, A.owner).doc(`users/${A.admin}`).delete())
    await assertFails(client(env, A.admin).doc(`users/${A.frontDesk}`).delete())
    await assertFails(client(env, A.frontDesk).doc(`users/${A.admin}`).delete())
  })

  it('an owner may still edit a non-privileged field on an in-gym profile', async () => {
    await assertSucceeds(
      client(env, A.owner).doc(`users/${A.frontDesk}`).update({ name: 'Desk Renamed' })
    )
    await assertSucceeds(client(env, A.admin).doc(`users/${A.trainer}`).update({ phone: '9800000111' }))
  })

  it('a trainer cannot self-edit their profile (only an admin/owner path exists)', async () => {
    // The application has no self-service profile editor, so this has never
    // been a capability; the role-write-once invariant must not be the only
    // thing keeping it closed.
    await assertFails(client(env, A.trainer).doc(`users/${A.trainer}`).update({ phone: '9800000111' }))
  })
})

// ===========================================================================
// Self-assigned tenancy during onboarding
// ===========================================================================
describe('REM onboarding cannot self-assign a gym or a role', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc('gyms/rem-gym-newcomer').set({ ownerUid: 'rem-newcomer', name: 'Newcomer Gym' })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
    })
  })

  afterAll(async () => env.cleanup())

  it('a brand-new user cannot attach themselves to a gym they do not own', async () => {
    for (const role of ['owner', 'admin', 'trainer', 'front-desk']) {
      await assertFails(
        client(env, `rem-stranger-${role}`).doc(`users/rem-stranger-${role}`).set({
          role,
          gymId: GYM_A,
          name: 'Attacker',
        })
      )
    }
  })

  it('a brand-new user cannot bind a gym that does not exist', async () => {
    await assertFails(
      client(env, 'rem-nogym').doc('users/rem-nogym').set({ role: 'owner', gymId: 'rem-gym-missing' })
    )
  })

  it('the genuine owner-of-record can still create their own owner profile', async () => {
    await assertSucceeds(
      client(env, 'rem-newcomer')
        .doc('users/rem-newcomer')
        .set({ role: 'owner', gymId: 'rem-gym-newcomer', name: 'Newcomer' })
    )
  })

  it('owner-of-record status cannot be used to self-grant another role', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('gyms/rem-gym-rogue').set({ ownerUid: 'rem-rogue', name: 'Rope' })
    })
    await assertFails(
      client(env, 'rem-rogue').doc('users/rem-rogue').set({ role: 'superadmin', gymId: 'rem-gym-rogue' })
    )
    await assertFails(
      client(env, 'rem-rogue').doc('users/rem-rogue').set({ role: 'trainer', gymId: 'rem-gym-rogue' })
    )
  })

  it('an unbound profile cannot attach itself to a foreign gym', async () => {
    await assertFails(client(env, UNBOUND).doc(`users/${UNBOUND}`).set({ role: 'owner', gymId: GYM_A }))
  })

  it('a bound staff user cannot re-open the onboarding path to switch gyms', async () => {
    await assertFails(
      client(env, A.admin).doc(`users/${A.admin}`).set({ role: 'owner', gymId: GYM_B })
    )
  })
})

// ===========================================================================
// Legacy (pre-tenancy) documents must never be claimable
// ===========================================================================
describe('REM legacy untagged documents are never adopted by a client', () => {
  let env
  const COLLECTIONS = ['members', 'payments', 'classes', 'bookings', 'counters']

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      for (const name of COLLECTIONS) {
        await fs.doc(`${name}/rem-legacy-claim`).set({ name: 'Legacy', value: 1 })
        await fs.doc(`${name}/rem-legacy-del`).set({ name: 'Legacy', value: 1 })
      }
    })
  })

  afterAll(async () => env.cleanup())

  it('no tenant can stamp its gymId onto an untagged record', async () => {
    for (const name of COLLECTIONS) {
      await assertFails(
        client(env, A.owner).doc(`${name}/rem-legacy-claim`).update({ gymId: GYM_A })
      )
      await assertFails(
        client(env, B.owner).doc(`${name}/rem-legacy-claim`).update({ gymId: GYM_B })
      )
    }
  })

  it('an untagged record is never deletable by a tenant', async () => {
    for (const name of COLLECTIONS) {
      await assertFails(client(env, A.owner).doc(`${name}/rem-legacy-del`).delete())
      await assertFails(client(env, B.owner).doc(`${name}/rem-legacy-del`).delete())
    }
  })

  it('a brand-new untagged document cannot be created (opaque legacy creates stay forbidden)', async () => {
    // No gymId in the payload: a create must always carry the caller's own gym.
    await assertFails(client(env, A.owner).collection('members').add({ name: 'Opaque Legacy Create' }))
  })
})

// ===========================================================================
// Settings: tenant-scoped path, and the legacy global singleton isolated
// ===========================================================================
describe('REM settings tenant isolation', () => {
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
      await fs.doc(`gyms/${GYM_A}/settings/app`).set({
        gymName: 'Gym A',
        currency: 'NPR',
        receiptPrefix: 'GYMA',
        gymId: GYM_A,
      })
      await fs.doc(`gyms/${GYM_B}/settings/app`).set({
        gymName: 'Gym B',
        currency: 'USD',
        receiptPrefix: 'GYMZ',
        gymId: GYM_B,
      })
      // The pre-migration global singleton, carrying its owning gymId.
      await fs.doc('settings/app').set({
        gymName: 'Himalye Wonders Gym',
        currency: 'INR',
        receiptPrefix: 'HWG',
        gymId: GYM_A,
      })
    })
  })

  afterAll(async () => env.cleanup())

  it('each gym reads only its own scoped settings document', async () => {
    const a = await client(env, A.owner).doc(`gyms/${GYM_A}/settings/app`).get()
    expect(a.data().gymName).toBe('Gym A')

    await assertFails(client(env, B.owner).doc(`gyms/${GYM_A}/settings/app`).get())
    await assertFails(client(env, A.owner).doc(`gyms/${GYM_B}/settings/app`).get())
  })

  it('a non-owner staff member of the same gym may read that gym settings', async () => {
    await assertSucceeds(client(env, A.admin).doc(`gyms/${GYM_A}/settings/app`).get())
    await assertSucceeds(client(env, A.trainer).doc(`gyms/${GYM_A}/settings/app`).get())
  })

  it('only the owner of that gym may write its scoped settings', async () => {
    await assertSucceeds(
      client(env, A.owner).doc(`gyms/${GYM_A}/settings/app`).update({ gymName: 'Gym A Renamed' })
    )
    await assertFails(
      client(env, B.owner).doc(`gyms/${GYM_A}/settings/app`).update({ gymName: 'Hijacked' })
    )
    for (const uid of [A.admin, A.trainer, A.frontDesk]) {
      await assertFails(client(env, uid).doc(`gyms/${GYM_A}/settings/app`).update({ gymName: 'X' }))
    }
  })

  it('a scoped settings document is never client-deletable', async () => {
    await assertFails(client(env, A.owner).doc(`gyms/${GYM_A}/settings/app`).delete())
  })

  // The satisfiable form of the intent behind evidence C2/C6/C7: a foreign
  // tenant is DENIED, which is strictly stronger than "sees unchanged values".
  it('a foreign owner cannot read the legacy global settings singleton', async () => {
    await assertFails(client(env, B.owner).doc('settings/app').get())
  })

  it('the owning gym can still read and update the legacy global singleton', async () => {
    await assertSucceeds(client(env, A.owner).doc('settings/app').get())
    await assertSucceeds(client(env, A.admin).doc('settings/app').get())
    await assertSucceeds(
      client(env, A.owner).doc('settings/app').update({ currency: 'INR' })
    )
  })

  it('a foreign owner cannot overwrite the legacy global singleton', async () => {
    await assertFails(
      client(env, B.owner).doc('settings/app').update({ gymName: 'Gym B Hijack', currency: 'USD' })
    )
  })

  it('the legacy global singleton cannot be created or deleted by any client', async () => {
    await assertFails(
      client(env, B.owner).doc('settings/rem-injected').set({ gymName: 'Injected', gymId: GYM_B })
    )
    await assertFails(client(env, A.owner).doc('settings/app').delete())
  })

  it('an unbound caller cannot read tenant settings', async () => {
    await assertFails(client(env, UNBOUND).doc('settings/app').get())
    await assertFails(client(env, UNBOUND).doc(`gyms/${GYM_A}/settings/app`).get())
  })

  it('settings cannot be enumerated across tenants', async () => {
    await assertFails(client(env, A.trainer).collection('settings').get())
    await assertFails(anon(env).collection('settings').get())
  })

  it('unauthenticated access to settings is denied outright', async () => {
    await assertFails(anon(env).doc('settings/app').get())
    await assertFails(anon(env).doc('settings/app').set({ gymName: 'Anon' }))
    await assertFails(anon(env).doc(`gyms/${GYM_A}/settings/app`).get())
  })
})

// ===========================================================================
// Bookings: the tenant boundary is enforced from the referenced member,
// and the referenced class must be an existing document in the same gym
// ===========================================================================
describe('REM booking tenant isolation', () => {
  let env

  const ownBooking = (extra = {}) => ({
    classId: 'rem-class-a',
    memberId: 'rem-member-a',
    status: 'booked',
    date: TODAY,
    gymId: GYM_A,
    ...extra,
  })

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
      await fs.doc('members/rem-member-a').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('members/rem-member-b').set({ name: 'B Member', gymId: GYM_B })
      await fs.doc('members/rem-member-untagged').set({ name: 'Untagged Member' })
      await fs.doc('classes/rem-class-a').set({ name: 'A Class', gymId: GYM_A })
      await fs.doc('classes/rem-class-b').set({ name: 'B Class', gymId: GYM_B })
      await fs.doc('classes/rem-class-untagged').set({ name: 'Untagged Class' })
      await fs.doc('bookings/rem-booking-b').set({
        classId: 'rem-class-b',
        memberId: 'rem-member-b',
        status: 'booked',
        gymId: GYM_B,
      })
    })
  })

  afterAll(async () => env.cleanup())

  it('every staff role, trainer included, can still book inside their own gym', async () => {
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk]) {
      await assertSucceeds(client(env, uid).collection('bookings').add(ownBooking()))
    }
  })

  it('a booking cannot be forged for another gym by writing that gym id', async () => {
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk]) {
      await assertFails(
        client(env, uid)
          .collection('bookings')
          .add({
            classId: 'rem-class-b',
            memberId: 'rem-member-b',
            status: 'booked',
            date: TODAY,
            gymId: GYM_B,
          })
      )
    }
  })

  it('a booking cannot reference a member belonging to another gym', async () => {
    await assertFails(
      client(env, A.owner)
        .collection('bookings')
        .add(ownBooking({ memberId: 'rem-member-b', gymId: GYM_A }))
    )
  })

  it('a booking cannot reference a member that does not exist', async () => {
    await assertFails(client(env, A.owner).collection('bookings').add(ownBooking({ memberId: 'rem-nope' })))
    await assertFails(client(env, A.owner).collection('bookings').add(ownBooking({ memberId: '' })))
  })

  it('a booking cannot reference an untagged (pre-tenancy) member', async () => {
    await assertFails(
      client(env, A.owner).collection('bookings').add(ownBooking({ memberId: 'rem-member-untagged' }))
    )
  })

  it('a booking cannot reference a class belonging to another gym', async () => {
    await assertFails(client(env, A.owner).collection('bookings').add(ownBooking({ classId: 'rem-class-b' })))
  })

  it('a booking cannot reference a class document that does not exist', async () => {
    await assertFails(client(env, A.owner).collection('bookings').add(ownBooking({ classId: 'rem-absent-class' })))
  })

  it('a booking cannot reference an untagged (pre-tenancy) class', async () => {
    await assertFails(
      client(env, A.owner).collection('bookings').add(ownBooking({ classId: 'rem-class-untagged' }))
    )
  })

  it('a booking cannot be created with no class reference at all', async () => {
    await assertFails(
      client(env, A.owner)
        .collection('bookings')
        .add({ classId: '', memberId: 'rem-member-a', status: 'booked', date: TODAY, gymId: GYM_A })
    )
    await assertFails(
      client(env, A.owner)
        .collection('bookings')
        .add({ memberId: 'rem-member-a', status: 'booked', date: TODAY, gymId: GYM_A })
    )
  })

  it('a booking created in own gym cannot then be repointed at a foreign class', async () => {
    const created = await client(env, A.owner).collection('bookings').add(ownBooking())
    await assertFails(client(env, A.owner).doc(`bookings/${created.id}`).update({ classId: 'rem-class-b' }))
    await assertFails(client(env, A.owner).doc(`bookings/${created.id}`).update({ classId: 'rem-absent-class' }))
    await assertFails(client(env, A.owner).doc(`bookings/${created.id}`).update({ memberId: 'rem-member-b' }))
  })

  it('a booking cannot be created with no member reference at all', async () => {
    await assertFails(
      client(env, A.owner)
        .collection('bookings')
        .add({ classId: 'rem-class-a', status: 'booked', date: TODAY, gymId: GYM_A })
    )
  })

  it('a foreign booking cannot be read, updated or deleted', async () => {
    await assertFails(client(env, A.owner).doc('bookings/rem-booking-b').get())
    await assertFails(client(env, A.owner).doc('bookings/rem-booking-b').update({ status: 'cancelled' }))
    await assertFails(client(env, A.owner).doc('bookings/rem-booking-b').delete())
  })
})

// ===========================================================================
// Members: field-level privilege separation
// ===========================================================================
describe('REM member field privilege separation', () => {
  let env

  const SIGNIFICANT = {
    membershipPlanId: 'plan-quarterly',
    isPT: true,
    ptSurchargeOverride: 250,
    joinDate: '2026-01-01',
    status: 'expired',
  }

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
      for (const key of Object.keys(A)) {
        await fs.doc(`members/rem-m-${key}`).set({
          name: `Member ${key}`,
          membershipPlanId: 'plan-quarterly',
          status: 'active',
          joinDate: '2026-02-02',
          isPT: false,
          ptSurchargeOverride: null,
          gymId: GYM_A,
        })
      }
    })
  })

  afterAll(async () => env.cleanup())

  it('roles holding members.write may set every financially significant field', async () => {
    for (const uid of [A.owner, A.admin, A.frontDesk]) {
      for (const [field, value] of Object.entries(SIGNIFICANT)) {
        await assertSucceeds(client(env, uid).doc('members/rem-m-owner').update({ [field]: value }))
      }
    }
  })

  it('a trainer cannot alter an existing financially significant field', async () => {
    for (const [field, value] of Object.entries(SIGNIFICANT)) {
      await assertFails(client(env, A.trainer).doc('members/rem-m-trainer').update({ [field]: value }))
    }
  })

  // Firestore exposes only the post-merge document to rules, so it cannot
  // distinguish "the client sent this field with the same value" from "the
  // field was already there". The rule therefore keys on the field EXISTING
  // on the stored document. A practical consequence, documented rather than
  // papered over: because every later write re-sends the fields already
  // present, a trainer gets at most ONE backfill per member and only onto a
  // member that has no financial state yet. That is strictly more restrictive
  // than before, and no application path lets a trainer write members at all
  // (the UI gates member edits on can('members.write'), which excludes
  // trainer), so nothing legitimate is lost.
  it('a trainer may backfill a financially significant field that is absent', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('members/rem-m-blank').set({ name: 'Blank', gymId: GYM_A })
    })
    await assertSucceeds(client(env, A.trainer).doc('members/rem-m-blank').update({ status: 'active' }))
  })

  // The fitness-goal write path (src/services/weightRecords.js ->
  // updateDocById('members', …)) is gated in the UI by can('members.write'),
  // which excludes trainer, so roles that do hold it must keep full access.
  it('roles holding members.write keep the fitness-goal write path', async () => {
    for (const uid of [A.owner, A.admin, A.frontDesk]) {
      await assertSucceeds(client(env, uid).doc('members/rem-m-trainer').update({ fitnessGoal: 'muscle-gain' }))
      await assertSucceeds(client(env, uid).doc('members/rem-m-trainer').update({ targetWeight: 78 }))
    }
  })

  it('a trainer cannot create a member carrying a financially significant field', async () => {
    await assertFails(
      client(env, A.trainer)
        .collection('members')
        .add({ name: 'Trainer Made', status: 'active', gymId: GYM_A })
    )
  })

  it('a trainer may create a member with no financially significant field', async () => {
    await assertSucceeds(
      client(env, A.trainer)
        .collection('members')
        .add({ name: 'Trainer Made Plain', targetWeight: 70, gymId: GYM_A })
    )
  })

  it('a trainer cannot delete a member', async () => {
    await assertFails(client(env, A.trainer).doc('members/rem-m-trainer').delete())
  })

  it('a role holding members.write can reprice a member but cannot record the money', async () => {
    await assertSucceeds(
      client(env, A.frontDesk).doc('members/rem-m-frontDesk').update({ ptSurchargeOverride: 5000 })
    )
    await assertFails(
      client(env, A.frontDesk)
        .collection('payments')
        .add({ amount: 5000, memberId: 'rem-m-frontDesk', gymId: GYM_A })
    )
  })

  it('members are never writable across the tenant boundary regardless of role', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('members/rem-m-b').set({ name: 'B Member', gymId: GYM_B })
    })
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk]) {
      await assertFails(client(env, uid).doc('members/rem-m-b').update({ status: 'frozen' }))
      await assertFails(client(env, uid).doc('members/rem-m-b').delete())
    }
  })
})

// ===========================================================================
// Reserved migration ledger and null-safety
// ===========================================================================
describe('REM reserved tenancy ledger and null-safe helpers', () => {
  let env

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc('members/rem-own-member').set({ name: 'A Member', gymId: GYM_A })
      await fs.doc('tenancy/migrationState').set({ stage: 's3', gymId: GYM_A })
    })
  })

  afterAll(async () => env.cleanup())

  it('no client may read or write the migration ledger, at any depth', async () => {
    await assertFails(client(env, A.owner).doc('tenancy/migrationState').get())
    await assertFails(client(env, A.owner).doc('tenancy/migrationState').update({ stage: 's5' }))
    await assertFails(client(env, A.owner).doc('tenancy/migrationState').delete())
    await assertFails(client(env, A.owner).collection('tenancy').add({ stage: 'x' }))
    await assertFails(client(env, A.owner).doc('tenancy/backups/2026/app.json').get())
    await assertFails(client(env, A.admin).doc('tenancy/migrationState').get())
    await assertFails(anon(env).doc('tenancy/migrationState').get())
  })

  it('a caller with no profile document is denied everywhere rather than crashing', async () => {
    const ghost = client(env, GHOST)
    await assertFails(ghost.doc('members/rem-own-member').get())
    await assertFails(ghost.doc('members/rem-own-member').update({ status: 'expired' }))
    await assertFails(ghost.collection('members').add({ name: 'Ghost', gymId: GYM_A }))
    await assertFails(ghost.collection('bookings').get())
    await assertFails(ghost.doc(`gyms/${GYM_A}/settings/app`).get())
    await assertFails(ghost.doc(`users/${GHOST}`).update({ role: 'owner' }))
  })

  it('an unbound profile cannot read or write business data', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`users/${UNBOUND}`).set({ role: 'admin' })
    })
    const unbound = client(env, UNBOUND)
    await assertFails(unbound.doc('members/rem-own-member').get())
    await assertFails(unbound.collection('members').add({ name: 'Unbound', gymId: GYM_A }))
    // A point read, not a collection query: the emulator cannot prove a
    // query-level denial for a resource-independent rule, so that limitation
    // is covered by the documented evidence notes rather than asserted here.
    await assertFails(unbound.doc('bookings/rem-booking-b').get())
  })

  it('unauthenticated access to business data is denied', async () => {
    await assertFails(anon(env).doc('members/rem-own-member').get())
    await assertFails(anon(env).collection('members').add({ name: 'Anon', gymId: GYM_A }))
    await assertFails(anon(env).collection('members').get())
    await assertFails(anon(env).doc('settings/app').get())
  })
})

// ===========================================================================
// Member-number counter sequence
//
// The gymId backfill was removed from the client (see the note left in
// src/services/migration.js), and with it the helper that pre-provisioned a
// new gym's member-number counter. src/services/memberNumbers.js still
// self-initialises the counter inside a single transaction, so the rules must
// let a bound staff member point-read a counter that does not exist yet —
// otherwise the first member created in a new gym fails PERMISSION_DENIED.
//
// The relaxation is deliberately narrow and these tests pin every boundary it
// must NOT open.
// ===========================================================================
describe('REM member-number counter self-initialisation', () => {
  let env
  const MISSING = 'memberNo_rem_gym_a'
  const COUNTER_A = 'counters/rem-counter-a'
  const COUNTER_B = 'counters/rem-counter-b'

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      await fs.doc(COUNTER_A).set({ value: 7, gymId: GYM_A })
      await fs.doc(COUNTER_B).set({ value: 3, gymId: GYM_B })
    })
  })

  afterAll(async () => env.cleanup())

  it('bound staff may point-read a counter that does not exist yet', async () => {
    await assertSucceeds(client(env, A.trainer).doc(`counters/${MISSING}`).get())
  })

  it('the self-initialising transaction creates the counter for the caller gym', async () => {
    const db = client(env, A.trainer)
    const first = await runTransaction(db, async (tx) => {
      const ref = doc(db, 'counters', MISSING)
      const snap = await tx.get(ref)
      const next = (snap.data()?.value ?? 0) + 1
      tx.set(ref, { value: next, gymId: GYM_A }, { merge: true })
      return next
    })
    expect(first).toBe(1)

    // A second call must continue the sequence rather than reset it.
    const second = await runTransaction(db, async (tx) => {
      const ref = doc(db, 'counters', MISSING)
      const snap = await tx.get(ref)
      const next = (snap.data()?.value ?? 0) + 1
      tx.set(ref, { value: next, gymId: GYM_A }, { merge: true })
      return next
    })
    expect(second).toBe(2)

    const stored = await client(env, A.owner).doc(`counters/${MISSING}`).get()
    expect(stored.data().gymId).toBe(GYM_A)
  })

  it('cross-gym reads of a real counter stay denied', async () => {
    await assertFails(client(env, B.owner).doc(COUNTER_A).get())
    await assertFails(client(env, A.owner).doc(COUNTER_B).get())
    // Gym B cannot write into Gym A's sequence, nor rebind it to itself.
    await assertFails(client(env, B.owner).doc(COUNTER_A).update({ value: 99 }))
    await assertFails(client(env, B.owner).doc(COUNTER_A).update({ value: 99, gymId: GYM_B }))
  })

  it('the missing-document relaxation does not help an unbound profile', async () => {
    // No gymId, so `hasGym()` is false and even a missing doc stays closed.
    await assertFails(client(env, UNBOUND).doc(`counters/${MISSING}`).get())
    await assertFails(client(env, UNBOUND).doc(COUNTER_A).get())
  })

  it('the missing-document relaxation does not help anonymous or profile-less callers', async () => {
    await assertFails(anon(env).doc(`counters/${MISSING}`).get())
    await assertFails(anon(env).doc(COUNTER_A).get())
    await assertFails(client(env, GHOST).doc(`counters/${MISSING}`).get())
    await assertFails(client(env, GHOST).doc(COUNTER_A).get())
  })

  it('an untagged legacy counter is still not adoptable from a client', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('counters/rem-counter-legacy').set({ value: 99 })
    })
    await assertFails(client(env, A.owner).doc('counters/rem-counter-legacy').update({ gymId: GYM_A }))
    await assertFails(client(env, A.owner).doc('counters/rem-counter-legacy').update({ value: 1, gymId: GYM_A }))
  })
})