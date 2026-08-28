import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'gym-abc'
const GYM_B = 'gym-xyz'

const UID = {
  owner: 'owner-uid',
  admin: 'admin-uid',
  frontDesk: 'front-uid',
  trainer: 'trainer-uid',
  otherGymAdmin: 'other-admin-uid',
  untagged: 'untagged-uid',
}

let testEnv

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    // owner-of-record docs (provisioned out-of-band, never client-writable)
    await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: UID.owner, name: 'Gym A', createdAt: new Date().toISOString() })
    await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: 'other-owner-uid', name: 'Gym B', createdAt: new Date().toISOString() })
    await fs.doc(`gyms/gym-untagged`).set({ ownerUid: UID.untagged, name: 'Untagged Gym', createdAt: new Date().toISOString() })

    // staff profiles (the source of role + tenancy)
    await fs.doc(`users/${UID.owner}`).set({ role: 'owner', gymId: GYM_A })
    await fs.doc(`users/${UID.admin}`).set({ role: 'admin', gymId: GYM_A })
    await fs.doc(`users/${UID.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
    await fs.doc(`users/${UID.trainer}`).set({ role: 'trainer', gymId: GYM_A })
    await fs.doc(`users/${UID.otherGymAdmin}`).set({ role: 'admin', gymId: GYM_B })
    // untagged user has no gymId yet — eligible for a one-time owner-gated bind
    await fs.doc(`users/${UID.untagged}`).set({ role: 'admin' })

    // business records within Gym A
    await fs.doc(`members/m-1`).set({ name: 'A Member', gymId: GYM_A })
    await fs.doc(`memberships/ms-1`).set({ plan: 'monthly', price: 100, gymId: GYM_A })
    await fs.doc(`payments/p-1`).set({ amount: 100, memberId: 'm-1', gymId: GYM_A })
    await fs.doc(`counters/memberNumber`).set({ value: 5, gymId: GYM_A })
    // a member belonging to Gym B (for cross-gym tenancy checks)
    await fs.doc(`members/m-other`).set({ name: 'Other Member', gymId: GYM_B })
  })
}

function db(uid) {
  return uid ? testEnv.authenticatedContext(uid).firestore() : testEnv.unauthenticatedContext().firestore()
}

const ownGymDoc = (extra) => ({ gymId: GYM_A, ...extra })

describe('firestore rules — emulator verification (renewal write path)', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await seed()
  })

  afterAll(async () => {
    await testEnv.cleanup()
  })

  it('lets owner/admin create and update memberships (renewal writes)', async () => {
    await assertSucceeds(db(UID.admin).collection('memberships').add(ownGymDoc({ plan: 'monthly', price: 120 })))
    await assertSucceeds(db(UID.owner).doc('memberships/ms-1').update({ price: 150 }))
  })

  it('denies non-finance staff from writing financial memberships', async () => {
    await assertFails(db(UID.frontDesk).collection('memberships').add(ownGymDoc({ plan: 'monthly', price: 120 })))
  })

  it('lets owner/admin create and update payments', async () => {
    await assertSucceeds(db(UID.owner).collection('payments').add(ownGymDoc({ amount: 200, memberId: 'm-1' })))
    await assertSucceeds(db(UID.admin).doc('payments/p-1').update({ amount: 150 }))
  })

  it('lets any staff member update members (renewal links new period to member)', async () => {
    await assertSucceeds(db(UID.trainer).doc('members/m-1').update({ status: 'active' }))
    await assertSucceeds(db(UID.frontDesk).collection('members').add(ownGymDoc({ name: 'New Member' })))
  })

  it('lets staff read/create/update the counters collection (member number sequence)', async () => {
    await assertSucceeds(db(UID.trainer).doc('counters/memberNumber').get())
    await assertSucceeds(db(UID.frontDesk).doc('counters/memberNumber').update({ value: 6 }))
    await assertSucceeds(db(UID.trainer).collection('counters').add({ value: 1, gymId: GYM_A }))
  })

  it('keeps audit log append-only by staff', async () => {
    const created = await db(UID.frontDesk).collection('auditLog').add(ownGymDoc({ action: 'renew', entity: 'membership' }))
    await assertSucceeds(created)
    await assertFails(db(UID.admin).collection('auditLog').doc(created.id).update({ action: 'tampered' }))
    await assertFails(db(UID.admin).collection('auditLog').doc(created.id).delete())
  })

  it('denies unauthenticated access and any unconditional/if-true rules', async () => {
    await assertFails(db().doc('members/m-1').get())
    await assertFails(db().collection('memberships').add(ownGymDoc({ plan: 'monthly' })))
  })

  it('scopes reads and writes to the caller gym (tenancy)', async () => {
    // cross-gym read denied
    await assertFails(db(UID.admin).doc('members/m-other').get())
    // own-gym read allowed
    await assertSucceeds(db(UID.admin).doc('members/m-1').get())
    // cross-gym write denied
    await assertFails(db(UID.admin).collection('members').add({ name: 'X', gymId: GYM_B }))
    // attempt to move an own-gym doc into another gym denied
    await assertFails(db(UID.admin).doc('members/m-1').update({ gymId: GYM_B }))
  })

  it('scopes members deletes to admin/owner within the gym', async () => {
    const memberRef = db(UID.admin).collection('members').doc('m-del')
    await assertSucceeds(memberRef.set({ name: 'To Delete', gymId: GYM_A }))
    // front-desk cannot delete (even in-gym)
    await assertFails(db(UID.frontDesk).doc('members/m-del').delete())
    // admin can delete their own-gym member
    await assertSucceeds(db(UID.admin).doc('members/m-del').delete())
  })

  it('never lets a client create or mutate a gyms owner-of-record doc', async () => {
    await assertFails(db(UID.owner).doc('gyms/gym-abc').set({ ownerUid: UID.owner }))
    await assertFails(db(UID.owner).doc('gyms/gym-abc').update({ name: 'Hijacked' }))
    await assertFails(db(UID.owner).doc('gyms/new-gym').set({ ownerUid: UID.owner }))
  })

  it('freezes gymId on a users doc after it is bound (owner-gated one-time bind)', async () => {
    const ownerMatch = testEnv.authenticatedContext(UID.untagged).firestore()
    // one-time owner-gated bind succeeds
    await assertSucceeds(ownerMatch.doc(`users/${UID.untagged}`).set({ role: 'admin', gymId: 'gym-untagged' }))
    // frozen afterwards — cannot re-bind or move gym
    await assertFails(ownerMatch.doc(`users/${UID.untagged}`).set({ role: 'admin', gymId: GYM_A }))
    // a non-owner can never bind a gym they do not own
    await assertFails(db(UID.admin).doc(`users/${UID.admin}`).set({ role: 'admin', gymId: 'gym-untagged' }))
  })
})

describe('firestore rules — cross-tenant isolation (owner-level)', () => {
  let env
  const OWNER_A = 'owner-a'
  const OWNER_B = 'owner-b'
  const UNBOUND = 'unbound-owner'

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: OWNER_A, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: OWNER_B, name: 'Gym B' })
      await fs.doc(`users/${OWNER_A}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${OWNER_B}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'owner' })
      await fs.doc(`members/member-a`).set({ name: 'A', gymId: GYM_A })
      await fs.doc(`members/member-b`).set({ name: 'B', gymId: GYM_B })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  const a = () => env.authenticatedContext(OWNER_A).firestore()
  const b = () => env.authenticatedContext(OWNER_B).firestore()
  const unbound = () => env.authenticatedContext(UNBOUND).firestore()

  it('Owner A can read and write members within Gym A', async () => {
    await assertSucceeds(a().doc('members/member-a').get())
    await assertSucceeds(a().doc('members/member-a').update({ name: 'A2' }))
    await assertSucceeds(a().collection('members').add({ name: 'New A', gymId: GYM_A }))
  })

  it('Owner A cannot read Gym B members (tenant isolation)', async () => {
    await assertFails(a().doc('members/member-b').get())
  })

  it('Owner A cannot write or create Gym B members', async () => {
    await assertFails(a().doc('members/member-b').update({ name: 'Hijack' }))
    await assertFails(a().doc('members/member-b').delete())
    await assertFails(a().collection('members').add({ name: 'X', gymId: GYM_B }))
  })

  it('Owner B is isolated from Gym A (reads and writes)', async () => {
    await assertFails(b().doc('members/member-a').get())
    await assertFails(b().doc('members/member-a').update({ name: 'Hijack' }))
    await assertSucceeds(b().doc('members/member-b').get())
  })

  it('an unbound owner is denied reads and writes until a gym is bound', async () => {
    await assertFails(unbound().doc('members/member-a').get())
    await assertFails(unbound().collection('members').add({ name: 'X', gymId: GYM_A }))
    // a gymId-bearing write by an unbound owner whose profile has no gymId fails
    await assertFails(unbound().doc('members/member-b').update({ name: 'Y' }))
  })

  it('a scoped query cannot escape the caller gym', async () => {
    // Owner A must never see Gym B records via a scoped collection query
    await assertSucceeds(a().collection('members').where('gymId', '==', GYM_A).get())
    await assertFails(a().collection('members').where('gymId', '==', GYM_B).get())
  })

  it('freezes gymId on an already-bound owner profile', async () => {
    await assertFails(a().doc(`users/${OWNER_A}`).update({ gymId: GYM_B }))
    await assertFails(b().doc(`users/${OWNER_A}`).update({ gymId: GYM_B }))
  })
})

describe('firestore rules — member-number counter tenancy (member creation path)', () => {
  let env
  const OWNER_A = 'cnt-owner-a'
  const OWNER_B = 'cnt-owner-b'
  const UNBOUND = 'cnt-unbound'
  const COUNTER_A = 'memberNo_gym-abc'
  const COUNTER_B = 'memberNo_gym-xyz'

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: OWNER_A })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: OWNER_B })
      await fs.doc(`users/${OWNER_A}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${OWNER_B}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'owner' })
      // Gym A's counter is pre-provisioned (as the migration/seed would do)
      await fs.doc(`counters/${COUNTER_A}`).set({ value: 14, gymId: GYM_A })
      await fs.doc(`members/member-a`).set({ name: 'A', gymId: GYM_A })
      await fs.doc(`members/member-b`).set({ name: 'B', gymId: GYM_B })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  const a = () => env.authenticatedContext(OWNER_A).firestore()
  const b = () => env.authenticatedContext(OWNER_B).firestore()
  const unbound = () => env.authenticatedContext(UNBOUND).firestore()

  it('owner can read their own provisioned member-number counter', async () => {
    await assertSucceeds(a().doc(`counters/${COUNTER_A}`).get())
  })

  it('owner can create their OWN counter doc (provisioning path) with a matching gymId', async () => {
    // create at an id that does not yet exist for this owner
    await assertSucceeds(b().doc(`counters/${COUNTER_B}`).set({ value: 0, gymId: GYM_B }))
  })

  it('owner cannot provision/create a counter with another gymId (no tenant forgery)', async () => {
    await assertFails(a().doc(`counters/new-${GYM_B}`).set({ value: 0, gymId: GYM_B }))
    // overwriting another gym's existing counter is denied
    await assertFails(a().doc(`counters/${COUNTER_A}`).update({ value: 999, gymId: GYM_B }))
  })

  it('an unbound owner cannot read, create or write any counter', async () => {
    await assertFails(unbound().doc(`counters/${COUNTER_A}`).get())
    await assertFails(unbound().doc(`counters/new-gym`).set({ value: 1, gymId: GYM_A }))
  })

  it('owner can create a member in their own gym with the matching gymId (member creation path)', async () => {
    await assertSucceeds(a().collection('members').add({ name: 'New A', gymId: GYM_A, memberNo: 'MEM-0015' }))
  })

  it('owner cannot create a member in another gym (cross-tenant member create denied)', async () => {
    await assertFails(a().collection('members').add({ name: 'Sneaky', gymId: GYM_B, memberNo: 'MEM-0001' }))
  })

  it('owner can update and delete only their own gym members', async () => {
    await assertSucceeds(a().doc('members/member-a').update({ name: 'A2' }))
    await assertFails(a().doc('members/member-b').update({ name: 'Hijack' }))
    await assertSucceeds(a().doc('members/member-a').delete())
    await assertFails(a().doc('members/member-b').delete())
  })
})

describe('firestore rules — owner gym self-provisioning (onboarding)', () => {
  let testEnv2
  const AUTO_ID_LEN = 20

  function randomAutoId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
    let out = ''
    for (let i = 0; i < AUTO_ID_LEN; i += 1) {
      out += chars[Math.floor(Math.random() * chars.length)]
    }
    return out
  }

  beforeAll(async () => {
    testEnv2 = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await testEnv2.withSecurityRulesDisabled(async (ctx) => {
      // An existing provisioned gym (out-of-band) that must never be claimed.
      await ctx.firestore().doc('gyms/gym-abc').set({ ownerUid: 'existing-owner' })
    })
  })

  afterAll(async () => {
    await testEnv2.cleanup()
  })

  it('lets a signed-in user self-provision a new gym they own (random auto-id)', async () => {
    const uid = 'new-owner'
    const ctx = testEnv2.authenticatedContext(uid)
    // add() generates a genuine Firestore auto-id; ownerUid must equal the caller.
    await assertSucceeds(ctx.firestore().collection('gyms').add({ ownerUid: uid, name: 'My Gym' }))
    await ctx.cleanup()
  })

  it('denies self-provision unless the created gym is owned by the caller', async () => {
    const ctx = testEnv2.authenticatedContext('mismatch-uid')
    await assertFails(ctx.firestore().collection('gyms').add({ ownerUid: 'someone-else', name: 'Theft' }))
    await ctx.cleanup()
  })

  it('denies provisioning at a user-chosen (non-auto) id — no slug squatting', async () => {
    const ctx = testEnv2.authenticatedContext('slug-uid')
    await assertFails(ctx.firestore().doc('gyms/short-name').set({ ownerUid: 'slug-uid', name: 'Gym' }))
    // a 20-char but predictable id is still not a genuine auto-id (charset differs)
    await assertFails(ctx.firestore().doc('gyms/myverypredictableidslug').set({ ownerUid: 'slug-uid', name: 'Gym' }))
    await ctx.cleanup()
  })

  it('never lets a client overwrite, mutate or delete an existing (provisioned) gym', async () => {
    const ctx = testEnv2.authenticatedContext('existing-owner')
    await assertFails(ctx.firestore().doc('gyms/gym-abc').set({ ownerUid: 'existing-owner', name: 'Overwrite' }))
    await assertFails(ctx.firestore().doc('gyms/gym-abc').update({ name: 'Mutate' }))
    await assertFails(ctx.firestore().doc('gyms/gym-abc').delete())
    await ctx.cleanup()
  })

  it('chains self-provision into a one-time owner-gated profile bind', async () => {
    // Simulates the onboarding write path: create the random-id gym, then bind
    // the creator's users/{uid} profile to it via canBindGymId.
    const uid = 'chain-owner'
    const gymId = randomAutoId()
    await testEnv2.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`gyms/${gymId}`).set({ ownerUid: uid })
    })
    const ctx = testEnv2.authenticatedContext(uid)
    await assertSucceeds(ctx.firestore().doc(`users/${uid}`).set({ role: 'owner', gymId }))
    await ctx.cleanup()
  })
})
