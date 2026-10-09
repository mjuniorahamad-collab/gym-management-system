import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: UID.owner, name: 'Gym A', receiptPrefix: 'HWG', createdAt: new Date().toISOString() })
    await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: 'other-owner-uid', name: 'Gym B', receiptPrefix: 'OXY', createdAt: new Date().toISOString() })
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
    // weight records: Gym A owns a record, Gym B owns another for cross-gym checks
    await fs.doc(`weightRecords/w-1`).set({ memberId: 'm-1', weight: 80, date: '2026-08-01', gymId: GYM_A })
    await fs.doc(`weightRecords/w-other`).set({ memberId: 'm-other', weight: 70, date: '2026-08-01', gymId: GYM_B })
    // a pre-tenancy legacy weight record with NO gymId tag (readable but not deletable)
    await fs.doc(`weightRecords/w-legacy`).set({ memberId: 'm-1', weight: 75, date: '2026-07-01' })
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
    await assertSucceeds(db(UID.owner).collection('payments').add(ownGymDoc({ amount: 200, memberId: 'm-1', receiptNo: 'HWG-000001' })))
    await assertSucceeds(db(UID.admin).doc('payments/p-1').update({ amount: 150 }))
  })

  it('lets any staff member update members (renewal links new period to member)', async () => {
    // A trainer editing a member's facts. `status` was removed from this
    // assertion deliberately: it is a server-owned projection field now, and a
    // trainer — or anyone — writing it from the client is precisely what the
    // projection-ownership tests below exist to deny.
    await assertSucceeds(db(UID.trainer).doc('members/m-1').update({ membershipPlanId: 'plan-2' }))
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

  it('gates weightRecords reads/writes to the caller gym', async () => {
    // own-gym read allowed
    await assertSucceeds(db(UID.admin).doc('weightRecords/w-1').get())
    // own-gym write (add + update) allowed
    await assertSucceeds(db(UID.admin).collection('weightRecords').add({ memberId: 'm-1', weight: 78, date: '2026-08-15', gymId: GYM_A }))
    await assertSucceeds(db(UID.admin).doc('weightRecords/w-1').update({ weight: 79 }))
    // any staff member can add a weight record
    await assertSucceeds(db(UID.frontDesk).collection('weightRecords').add({ memberId: 'm-1', weight: 77, date: '2026-08-20', gymId: GYM_A }))
  })

  it('denies cross-gym weightRecords access (tenant isolation)', async () => {
    // cross-gym read denied
    await assertFails(db(UID.admin).doc('weightRecords/w-other').get())
    // cross-gym create denied
    await assertFails(db(UID.admin).collection('weightRecords').add({ memberId: 'm-other', weight: 60, date: '2026-08-01', gymId: GYM_B }))
    // cross-gym update denied
    await assertFails(db(UID.admin).doc('weightRecords/w-other').update({ weight: 61 }))
    // cannot move an own-gym record into another gym
    await assertFails(db(UID.admin).doc('weightRecords/w-1').update({ gymId: GYM_B }))
  })

  it('scopes weightRecords deletes to admin/owner within the gym', async () => {
    // use a dedicated record so shared w-1/w-other stay intact for later tests
    const created = await db(UID.admin).collection('weightRecords').add({ memberId: 'm-1', weight: 84, date: '2026-08-25', gymId: GYM_A })
    // front-desk cannot delete an own-gym record
    await assertFails(db(UID.frontDesk).collection('weightRecords').doc(created.id).delete())
    // trainer cannot delete an own-gym record
    await assertFails(db(UID.trainer).collection('weightRecords').doc(created.id).delete())
    // admin can delete an own-gym record
    await assertSucceeds(db(UID.admin).collection('weightRecords').doc(created.id).delete())
    // owner can delete an own-gym record (regression: previously owner got PERMISSION_DENIED)
    const owned = await db(UID.owner).collection('weightRecords').add({ memberId: 'm-1', weight: 83, date: '2026-08-26', gymId: GYM_A })
    await assertSucceeds(db(UID.owner).collection('weightRecords').doc(owned.id).delete())
  })

  it('denies cross-gym weightRecords deletes for owner/admin (tenant isolation)', async () => {
    // w-other belongs to Gym B; a Gym A owner/admin must not delete it
    await assertFails(db(UID.owner).doc('weightRecords/w-other').delete())
    await assertFails(db(UID.admin).doc('weightRecords/w-other').delete())
    // own-gym record remains readable by owner right after the cross-gym denial
    await assertSucceeds(db(UID.owner).doc('weightRecords/w-1').get())
  })

  it('enforces the full weightRecords permission matrix (read/create/update/delete)', async () => {
    // own-gym read allowed for any staff
    await assertSucceeds(db(UID.admin).doc('weightRecords/w-1').get())
    await assertSucceeds(db(UID.frontDesk).doc('weightRecords/w-1').get())
    await assertSucceeds(db(UID.owner).doc('weightRecords/w-1').get())
    // own-gym create allowed for any staff
    await assertSucceeds(db(UID.trainer).collection('weightRecords').add({ memberId: 'm-1', weight: 76, date: '2026-08-22', gymId: GYM_A }))
    // own-gym update allowed for any staff
    await assertSucceeds(db(UID.frontDesk).doc('weightRecords/w-1').update({ weight: 79 }))
    // own-gym delete allowed for owner and admin (covered in the delete test above)
    const ownerDel = await db(UID.owner).collection('weightRecords').add({ memberId: 'm-1', weight: 82, date: '2026-08-27', gymId: GYM_A })
    await assertSucceeds(db(UID.owner).collection('weightRecords').doc(ownerDel.id).delete())
    // cross-gym read denied
    await assertFails(db(UID.owner).doc('weightRecords/w-other').get())
    await assertFails(db(UID.admin).doc('weightRecords/w-other').get())
    // cross-gym create denied
    await assertFails(db(UID.admin).collection('weightRecords').add({ memberId: 'm-other', weight: 60, date: '2026-08-01', gymId: GYM_B }))
    // cross-gym update denied
    await assertFails(db(UID.admin).doc('weightRecords/w-other').update({ weight: 61 }))
    // cross-gym delete denied
    await assertFails(db(UID.admin).doc('weightRecords/w-other').delete())
  })

  it('keeps pre-tenancy legacy weight records readable but NOT deletable (read-but-undeletable)', async () => {
    // A legacy (no-gymId) record is readable so existing data is never lost ...
    await assertSucceeds(db(UID.owner).doc('weightRecords/w-legacy').get())
    await assertSucceeds(db(UID.admin).doc('weightRecords/w-legacy').get())
    // ... but it cannot be deleted until tagged to a gym, because canDeleteTenant
    // requires an exact gymId match. This is exactly the production symptom where
    // a measurement is visible in the Progress tab yet delete returns
    // PERMISSION_DENIED. The fix is a data tag, NOT a rule weakening.
    await assertFails(db(UID.owner).doc('weightRecords/w-legacy').delete())
    await assertFails(db(UID.admin).doc('weightRecords/w-legacy').delete())
    // legacy records cannot be created (opaque legacy creates are forbidden)
    await assertFails(db(UID.owner).collection('weightRecords').add({ memberId: 'm-1', weight: 70, date: '2026-08-02' }))
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

describe('firestore rules — per-gym PT settings + member PT tenancy', () => {
  let env
  const PT_OWNER_A = 'pt-owner-a'
  const PT_OWNER_B = 'pt-owner-b'
  const PT_STAFF_A = 'pt-staff-a'

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: PT_OWNER_A })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: PT_OWNER_B })
      await fs.doc(`users/${PT_OWNER_A}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${PT_OWNER_B}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${PT_STAFF_A}`).set({ role: 'staff', gymId: GYM_A })
      // an owner whose profile exists but is not yet bound to a gym
      await fs.doc(`users/pt-unbound`).set({ role: 'owner' })
      await fs.doc(`members/member-a`).set({ name: 'A', gymId: GYM_A, isPT: false })
      await fs.doc(`members/member-b`).set({ name: 'B', gymId: GYM_B, isPT: false })
      // pre-provision each gym's PT settings doc with a matching gymId
      await fs.doc(`gyms/${GYM_A}/settings/pt`).set({ surcharge: 1000, gymId: GYM_A })
      await fs.doc(`gyms/${GYM_B}/settings/pt`).set({ surcharge: 500, gymId: GYM_B })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  const ownerA = () => env.authenticatedContext(PT_OWNER_A).firestore()
  const ownerB = () => env.authenticatedContext(PT_OWNER_B).firestore()
  const staffA = () => env.authenticatedContext(PT_STAFF_A).firestore()

  it('own-gym owner and staff can read their PT settings doc', async () => {
    await assertSucceeds(ownerA().doc(`gyms/${GYM_A}/settings/pt`).get())
    await assertSucceeds(staffA().doc(`gyms/${GYM_A}/settings/pt`).get())
  })

  it('a cross-gym owner cannot read another gym PT settings', async () => {
    await assertFails(ownerA().doc(`gyms/${GYM_B}/settings/pt`).get())
    await assertFails(ownerB().doc(`gyms/${GYM_A}/settings/pt`).get())
  })

  it('own-gym owner can CREATE a brand-new PT settings doc (non-existent path, matching gymId)', async () => {
    await assertSucceeds(
      ownerA().doc(`gyms/${GYM_A}/settings/pt-fresh`).set({ surcharge: 1500, gymId: GYM_A })
    )
  })

  it('own-gym owner can UPDATE their existing PT settings doc (matching gymId)', async () => {
    await assertSucceeds(ownerA().doc(`gyms/${GYM_A}/settings/pt`).update({ surcharge: 1200, gymId: GYM_A }))
  })

  it('owner cannot CREATE a PT settings doc in another gym (cross-gym create denied)', async () => {
    // a never-provisioned cross-gym id forces the create branch
    await assertFails(
      ownerA().doc(`gyms/${GYM_B}/settings/pt-cross`).set({ surcharge: 999, gymId: GYM_B })
    )
    // and the existing cross-gym doc cannot be written either (set + update)
    await assertFails(ownerA().doc(`gyms/${GYM_B}/settings/pt`).set({ surcharge: 999, gymId: GYM_B }))
    await assertFails(ownerA().doc(`gyms/${GYM_B}/settings/pt`).update({ surcharge: 999, gymId: GYM_B }))
  })

  it('owner cannot create/update their own PT settings with a forged gymId (path mismatch)', async () => {
    // create at caller's own gym path but payload claims another gym
    await assertFails(ownerA().doc(`gyms/${GYM_A}/settings/pt-forge`).set({ surcharge: 111, gymId: GYM_B }))
    // update on existing doc with a forged gymId
    await assertFails(ownerA().doc(`gyms/${GYM_A}/settings/pt`).update({ surcharge: 111, gymId: GYM_B }))
  })

  it('a non-owner staff member cannot write PT settings (owner-only)', async () => {
    await assertFails(staffA().doc(`gyms/${GYM_A}/settings/pt`).update({ surcharge: 2000, gymId: GYM_A }))
  })

  it('unbound and unauthenticated users cannot read or write any PT settings', async () => {
    // unbound owner (profile exists but no gymId yet) cannot access PT settings
    const unboundCtx = env.authenticatedContext('pt-unbound').firestore()
    await assertFails(unboundCtx.doc(`gyms/${GYM_A}/settings/pt`).get())
    await assertFails(unboundCtx.doc(`gyms/${GYM_A}/settings/pt`).set({ surcharge: 1, gymId: GYM_A }))
    // unauthenticated access is denied too
    await assertFails(env.unauthenticatedContext().firestore().doc(`gyms/${GYM_A}/settings/pt`).get())
    await assertFails(env.unauthenticatedContext().firestore().doc(`gyms/${GYM_A}/settings/pt`).set({ surcharge: 1, gymId: GYM_A }))
  })

  it('PT settings deletes are always denied', async () => {
    await assertFails(ownerA().doc(`gyms/${GYM_A}/settings/pt`).delete())
  })

  it('owner can toggle member isPT within their own gym only', async () => {
    await assertSucceeds(ownerA().doc('members/member-a').update({ isPT: true }))
    // cross-gym member isPT toggling is denied by tenancy
    await assertFails(ownerA().doc('members/member-b').update({ isPT: true }))
  })

  it('owner can set a member PT surcharge override within their own gym only', async () => {
    await assertSucceeds(ownerA().doc('members/member-a').update({ ptSurchargeOverride: 400 }))
    await assertSucceeds(ownerA().doc('members/member-a').update({ ptSurchargeOverride: 0 }))
    await assertSucceeds(ownerA().doc('members/member-a').update({ ptSurchargeOverride: null }))
    // cross-gym member override write is denied by tenancy
    await assertFails(ownerA().doc('members/member-b').update({ ptSurchargeOverride: 400 }))
    await assertFails(ownerB().doc('members/member-a').update({ ptSurchargeOverride: 400 }))
  })
})

describe('firestore rules — per-gym WhatsApp group setting', () => {
  let env
  const WA_OWNER_A = 'wa-owner-a'
  const WA_OWNER_B = 'wa-owner-b'
  const WA_STAFF_A = 'wa-staff-a'

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: WA_OWNER_A })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: WA_OWNER_B })
      await fs.doc(`users/${WA_OWNER_A}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${WA_OWNER_B}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${WA_STAFF_A}`).set({ role: 'staff', gymId: GYM_A })
      // an owner whose profile exists but is not yet bound to a gym
      await fs.doc(`users/wa-unbound`).set({ role: 'owner' })
      // pre-provision each gym's WhatsApp settings doc with a matching gymId
      await fs.doc(`gyms/${GYM_A}/settings/whatsapp`).set({
        link: 'https://chat.whatsapp.com/gym-a-group',
        gymId: GYM_A,
      })
      await fs.doc(`gyms/${GYM_B}/settings/whatsapp`).set({
        link: 'https://chat.whatsapp.com/gym-b-group',
        gymId: GYM_B,
      })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  const ownerA = () => env.authenticatedContext(WA_OWNER_A).firestore()
  const ownerB = () => env.authenticatedContext(WA_OWNER_B).firestore()
  const staffA = () => env.authenticatedContext(WA_STAFF_A).firestore()

  it('own-gym owner and staff can READ their WhatsApp settings doc', async () => {
    await assertSucceeds(ownerA().doc(`gyms/${GYM_A}/settings/whatsapp`).get())
    await assertSucceeds(staffA().doc(`gyms/${GYM_A}/settings/whatsapp`).get())
  })

  it('a cross-gym owner cannot READ another gym WhatsApp settings (tenant isolation)', async () => {
    await assertFails(ownerA().doc(`gyms/${GYM_B}/settings/whatsapp`).get())
    await assertFails(ownerB().doc(`gyms/${GYM_A}/settings/whatsapp`).get())
  })

  it('own-gym owner can CREATE a brand-new WhatsApp settings doc (non-existent path, matching gymId)', async () => {
    await assertSucceeds(
      ownerA().doc(`gyms/${GYM_A}/settings/whatsapp-fresh`).set({
        link: 'https://chat.whatsapp.com/fresh',
        gymId: GYM_A,
      })
    )
  })

  it('own-gym owner can UPDATE the existing WhatsApp settings doc (matching gymId)', async () => {
    await assertSucceeds(
      ownerA().doc(`gyms/${GYM_A}/settings/whatsapp`).update({
        link: 'https://chat.whatsapp.com/gym-a-updated',
        gymId: GYM_A,
      })
    )
    // clearing via update (empty link) is allowed — this is how Disable works
    await assertSucceeds(
      ownerA().doc(`gyms/${GYM_A}/settings/whatsapp`).update({ link: '', gymId: GYM_A })
    )
  })

  it('owner cannot CREATE a WhatsApp settings doc in another gym (cross-gym create denied)', async () => {
    await assertFails(
      ownerA().doc(`gyms/${GYM_B}/settings/whatsapp-cross`).set({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_B,
      })
    )
    await assertFails(
      ownerA().doc(`gyms/${GYM_B}/settings/whatsapp`).set({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_B,
      })
    )
    await assertFails(
      ownerA().doc(`gyms/${GYM_B}/settings/whatsapp`).update({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_B,
      })
    )
  })

  it('owner cannot write their own WhatsApp settings with a forged gymId (path mismatch)', async () => {
    await assertFails(
      ownerA().doc(`gyms/${GYM_A}/settings/whatsapp-forge`).set({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_B,
      })
    )
    await assertFails(
      ownerA().doc(`gyms/${GYM_A}/settings/whatsapp`).update({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_B,
      })
    )
  })

  it('a non-owner staff member cannot write WhatsApp settings (owner-only)', async () => {
    await assertFails(
      staffA().doc(`gyms/${GYM_A}/settings/whatsapp`).update({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_A,
      })
    )
  })

  it('unbound and unauthenticated users cannot read or write any WhatsApp settings', async () => {
    const unboundCtx = env.authenticatedContext('wa-unbound').firestore()
    await assertFails(unboundCtx.doc(`gyms/${GYM_A}/settings/whatsapp`).get())
    await assertFails(
      unboundCtx.doc(`gyms/${GYM_A}/settings/whatsapp`).set({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_A,
      })
    )
    await assertFails(env.unauthenticatedContext().firestore().doc(`gyms/${GYM_A}/settings/whatsapp`).get())
    await assertFails(
      env.unauthenticatedContext().firestore().doc(`gyms/${GYM_A}/settings/whatsapp`).set({
        link: 'https://chat.whatsapp.com/x',
        gymId: GYM_A,
      })
    )
  })

  it('WhatsApp settings deletes are always denied (clearing is done via update)', async () => {
    await assertFails(ownerA().doc(`gyms/${GYM_A}/settings/whatsapp`).delete())
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

// ===========================================================================
// PROJECTION FIELD OWNERSHIP
//
// The member projection (`status`, `membershipStart`, `effectiveExpiry`,
// `freezeUntil`) is an output of the canonical engine over `memberships` +
// `membershipFreezes`. It is written by the trusted server writer via the Admin
// SDK, which does not consult these rules at all.
//
// These tests assert the CLIENT side of that boundary. They are the reason the
// field lists in firestore.rules and functions/projection/sources.js
// (PROJECTED_FIELDS) must stay in step: if either list grows a field and the
// other does not, a client can write a value the server believes it owns.
// ===========================================================================
// The per-role `members.status` denials and the "legitimate fields stay
  // writable" guarantees are additionally covered as individually named tests
  // in tests.emulator/firestoreSecurityRemediation.test.js, with the rationale
  // for the three obsolete SEC-I assertions in the frozen evidence suite.
  describe('firestore rules — projection fields are server-owned', () => {
  // Mirrors PROJECTED_FIELDS in functions/projection/sources.js. `isFrozen` is in
  // this list because only the engine can see the freeze records: a client that
  // could set it could put a member in the Frozen filter and show the Frozen badge
  // without a single membershipFreezes document behind it.
  const PROJECTION_FIELDS = ['status', 'membershipStart', 'effectiveExpiry', 'freezeUntil', 'isFrozen']

  /** A member whose projection the server has already written. */
  const PROJECTED = {
    status: 'expiring',
    membershipStart: '2026-01-01',
    effectiveExpiry: '2026-09-01',
    freezeUntil: null,
    isFrozen: false,
  }

  /** The client fields staff must still be able to edit. */
  const FACTS = {
    name: 'A Member',
    phone: '9800000000',
    notes: 'called about PT',
    isPT: true,
    membershipPlanId: 'plan-2',
    joinDate: '2026-01-01',
    ptSurchargeOverride: 250,
  }

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await seed()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      // Server-written projections, as the Admin SDK would have left them.
      await fs.doc('members/proj-1').set({ name: 'Projected', gymId: GYM_A, ...PROJECTED })
      await fs.doc('members/proj-2').set({ name: 'Never Projected', gymId: GYM_A })
      // A foreign-tenant member carrying a projection, to prove tenancy and
      // projection ownership are independent guards.
      await fs.doc('members/proj-other').set({ name: 'Other', gymId: GYM_B, ...PROJECTED })
    })
  })

  afterAll(async () => {
    await testEnv.cleanup()
  })

  describe('no client may change a projected value', () => {
    // Only roles that are otherwise ALLOWED to write this member. If a
    // cross-tenant or unbound role appeared here, the write would be denied by
    // tenancy even if the projection guard were deleted, and the test would
    // still pass — proving nothing. Those cases are covered separately below,
    // where the reason for the denial is unambiguous.
    const STAFF = { owner: UID.owner, admin: UID.admin, frontDesk: UID.frontDesk, trainer: UID.trainer }

    for (const [role, uid] of Object.entries(STAFF)) {
      for (const field of PROJECTION_FIELDS) {
        it(`denies ${role} changing ${field}`, async () => {
          const value = field === 'status' ? 'active' : '2026-12-25'
          await assertFails(db(uid).doc('members/proj-1').update({ [field]: value }))
        })
      }
    }

    it('denies a client setting all four at once', async () => {
      await assertFails(
        db(UID.owner).doc('members/proj-1').update({
          status: 'active',
          membershipStart: '2020-01-01',
          effectiveExpiry: '2030-01-01',
          freezeUntil: '2030-06-01',
        })
      )
    })

    it('denies a client smuggling a projection field in with legitimate edits', async () => {
      // The realistic attack: hide the projection write inside a normal-looking
      // profile edit so a reviewer skims past it.
      await assertFails(db(UID.admin).doc('members/proj-1').update({ ...FACTS, status: 'active' }))
    })

    it('denies a merge that changes a projected value', async () => {
      // updateDoc(..., { merge: true }) must not be a way around the invariant.
      await assertFails(db(UID.admin).doc('members/proj-1').set({ status: 'active' }, { merge: true }))
    })

    it('denies a client re-asserting the SAME value in a way that also adds another', async () => {
      // Writing a projection field with its current value is harmless in itself,
      // and is allowed below. It must not become a carrier for a second change.
      await assertFails(
        db(UID.owner).doc('members/proj-1').update({ status: 'expiring', effectiveExpiry: '2030-01-01' })
      )
    })
  })

  describe('no client may initialize a projection on create', () => {
    const STAFF = { owner: UID.owner, admin: UID.admin, frontDesk: UID.frontDesk, trainer: UID.trainer }

    for (const [role, uid] of Object.entries(STAFF)) {
      for (const field of PROJECTION_FIELDS) {
        it(`denies ${role} creating a member with ${field}`, async () => {
          const value = field === 'status' ? 'active' : '2026-12-25'
          await assertFails(db(uid).collection('members').add(ownGymDoc({ name: 'Sneaky', [field]: value })))
        })
      }
    }

    it('denies creating a member whose projection is all nulls', async () => {
      // null is not "no value" to Firestore. Handing the server a pre-nulled
      // projection is still the client deciding the answer.
      await assertFails(
        db(UID.owner).collection('members').add(
          ownGymDoc({ name: 'Pre-nulled', status: null, membershipStart: null, effectiveExpiry: null, freezeUntil: null })
        )
      )
    })

    it('allows creating a member with no projection fields at all', async () => {
      // The real client path: MemberForm no longer submits `status`, and the
      // server derives the projection afterwards.
      await assertSucceeds(db(UID.frontDesk).collection('members').add(ownGymDoc({ name: 'Legit New' })))
    })

    it('allows creating a member with client-owned fact fields', async () => {
      await assertSucceeds(db(UID.frontDesk).collection('members').add(ownGymDoc(FACTS)))
    })
  })

  describe('legitimate edits still work', () => {
    it('allows an owner to edit every client-owned fact field', async () => {
      await assertSucceeds(db(UID.owner).doc('members/proj-1').update({ ...FACTS }))
    })

    it('allows front-desk to edit a member', async () => {
      await assertSucceeds(db(UID.frontDesk).doc('members/proj-1').update({ phone: '9811111111' }))
    })

    it('allows re-writing a projection field with the value the server already set', async () => {
      // Harmless, and deliberately permitted: a client that round-trips a whole
      // document must not start failing. No projection VALUE changes, so the
      // server's answer still stands.
      await assertSucceeds(db(UID.owner).doc('members/proj-1').update({ ...PROJECTED }))
    })

    it('leaves the stored projection untouched after a legitimate edit', async () => {
      await assertSucceeds(db(UID.owner).doc('members/proj-1').update({ notes: 'checked in' }))
      let stored
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const snap = await ctx.firestore().doc('members/proj-1').get()
        stored = snap.data()
      })
      expect(stored.status).toBe('expiring')
      expect(stored.effectiveExpiry).toBe('2026-09-01')
      expect(stored.notes).toBe('checked in')
    })

    it('allows a trainer to set fitness facts on an unprojected member', async () => {
      await assertSucceeds(db(UID.trainer).doc('members/proj-2').update({ fitnessGoal: 'build muscle' }))
    })

    it('allows a trainer to backfill an absent plan id but not a projected field', async () => {
      await assertSucceeds(db(UID.trainer).doc('members/proj-2').update({ membershipPlanId: 'plan-3' }))
      await assertFails(db(UID.trainer).doc('members/proj-2').update({ status: 'active' }))
    })
  })

  describe('the projection guard does not weaken tenancy', () => {
    it('denies a foreign-gym admin writing a projected member', async () => {
      await assertFails(db(UID.otherGymAdmin).doc('members/proj-1').update({ status: 'active' }))
    })

    it('denies an unauthenticated client writing a projection', async () => {
      await assertFails(db(null).doc('members/proj-1').update({ status: 'active' }))
    })

    it('denies an unbound (no-gym) admin writing a projection', async () => {
      await assertFails(db(UID.untagged).doc('members/proj-1').update({ status: 'active' }))
    })

    it('still denies a foreign-gym admin the ordinary fact edit too', async () => {
      // Guards against the projection rule accidentally becoming the ONLY thing
      // being checked, which would mask a tenancy regression.
      await assertFails(db(UID.otherGymAdmin).doc('members/proj-1').update({ phone: '9800000000' }))
    })

    it('denies creating a member in a foreign gym with a projection', async () => {
      await assertFails(
        db(UID.otherGymAdmin).collection('members').add({ gymId: GYM_B, name: 'X', status: 'active' })
      )
    })

    it('denies a foreign-gym admin forging isFrozen on a projected member', async () => {
      // Tenancy and projection ownership must both hold for the new field: an
      // `isFrozen` forged from another tenant would put a member in the wrong
      // gym's Frozen filter as well as inventing a freeze that never existed.
      await assertFails(db(UID.otherGymAdmin).doc('members/proj-1').update({ isFrozen: true }))
    })

    it('denies a foreign-gym admin creating a member with isFrozen', async () => {
      await assertFails(
        db(UID.otherGymAdmin).collection('members').add({ gymId: GYM_B, name: 'X', isFrozen: true })
      )
    })
  })

  describe('isFrozen cannot be invented without a freeze record', () => {
    it('denies every role setting isFrozen true on a member with no freeze', async () => {
      // The whole point of storing the flag server-side: staff cannot mark a
      // member frozen by hand. If any of these passed, the Frozen filter and the
      // Frozen badge would both be forgeable from the client.
      for (const uid of [UID.owner, UID.admin, UID.frontDesk, UID.trainer]) {
        await assertFails(db(uid).doc('members/proj-2').update({ isFrozen: true }))
      }
    })

    it('denies clearing isFrozen as well as setting it', async () => {
      // A client that could only clear the flag could also hide a real freeze
      // from staff. Both directions are server-owned.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('members/frozen-1').set({ name: 'Really Frozen', gymId: GYM_A, ...PROJECTED, isFrozen: true })
      })
      for (const uid of [UID.owner, UID.admin, UID.frontDesk]) {
        await assertFails(db(uid).doc('members/frozen-1').update({ isFrozen: false }))
      }
    })

    it('allows an edit that reasserts isFrozen without changing it', async () => {
      // Same harmless-restatement policy as the other four fields: re-sending the
      // server's own value alongside a legitimate edit must not fail the save.
      await assertSucceeds(
        db(UID.admin).doc('members/frozen-1').update({ isFrozen: true, phone: '9800000009' })
      )
      await assertSucceeds(db(UID.owner).doc('members/proj-1').update({ isFrozen: false, name: 'Projected' }))
    })

    it('allows a legitimate edit on an unprojected member that omits isFrozen', async () => {
      // The absence case matters: staff editing a member the sweep has not reached
      // must not be blocked by a field they are not allowed to write.
      await assertSucceeds(db(UID.owner).doc('members/proj-2').update({ phone: '9800000007' }))
    })

    it('denies forging isFrozen in the same write as a legitimate change', async () => {
      await assertFails(db(UID.admin).doc('members/proj-1').update({ phone: '9800000008', isFrozen: true }))
    })

    it('lets the Frozen filter see only genuine server-written flags', async () => {
      // The read side of the same guarantee: a client-written member carries no
      // `isFrozen` at all, so `where('isFrozen', '==', true)` cannot return it.
      // This is what keeps the staff filter a projection of real freeze records
      // rather than of whatever a compromised client felt like submitting.
      const results = await testEnv.authenticatedContext(UID.admin).firestore()
        .collection('members')
        .where('isFrozen', '==', true)
        .get()

      expect(results.docs.map((d) => d.id)).toEqual(['frozen-1'])
      expect(results.docs[0].data().status).toBe('expiring')
    })

    it('keeps a frozen member active, since freeze is orthogonal to currency', async () => {
      // Not a rules assertion but a contract one: `frozen` must not have crept
      // back in as a status. If it had, this projection could no longer be
      // active-and-frozen at the same time.
      const snap = await db(UID.owner).doc('members/frozen-1').get()
      const stored = snap.data()
      expect(stored.isFrozen).toBe(true)
      expect(stored.status).toBe('expiring')
      expect(['active', 'expiring', 'expired', null]).toContain(stored.status)
      expect(stored.status).not.toBe('frozen')
    })

    it('a client cannot make itself appear in the Frozen filter', async () => {
      // The filter query is the read side of the guarantee. A client that writes
      // its own `isFrozen` value must not thereby change what the query returns
      // for staff, so this asserts the attempt fails AND that the admin's
      // subsequent Frozen query still sees only the server-written member.
      await assertFails(db(UID.frontDesk).doc('members/proj-2').update({ isFrozen: true }))

      const results = await testEnv.authenticatedContext(UID.owner).firestore()
        .collection('members')
        .where('isFrozen', '==', true)
        .get()

      expect(results.docs.map((d) => d.id).sort()).toEqual(['frozen-1'])
    })

    })

  describe('client-owned fields that look like projections', () => {
    it('allows writing members.isPT, which is a fact and not the projected field', async () => {
      // `isPT` shares a name with a value the engine derives from the current
      // PERIOD. On the member document it is a separate, staff-editable pricing
      // attribute. Locking it under the projection guard would break the PT
      // toggle and the repricing it drives — so this test exists to stop a
      // future "harmonisation" from silently removing a real capability.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('members/pt-fact').set({ name: 'PT Fact', gymId: GYM_A })
      })
      // A trainer may backfill it once on a member with no financial state.
      await assertSucceeds(db(UID.trainer).doc('members/pt-fact').update({ isPT: true }))
      // Having done so, the trainer may no longer alter it. This is the
      // pre-existing trainer restriction (a financially significant field that
      // now exists may not be changed), NOT the projection guard — the value
      // `isPT` holds here was written by a client and is being read back by the
      // same rule family.
      await assertFails(db(UID.trainer).doc('members/pt-fact').update({ isPT: false }))
      // A role holding members.write may change it freely.
      await assertSucceeds(db(UID.admin).doc('members/pt-fact').update({ isPT: false }))
      await assertSucceeds(db(UID.owner).doc('members/pt-fact').update({ isPT: true }))
    })

    it('allows writing members.membershipPlanId and joinDate', async () => {
      await assertSucceeds(db(UID.owner).doc('members/proj-1').update({ membershipPlanId: 'plan-9', joinDate: '2026-02-01' }))
    })
  })
})
