/**
 * STORAGE PHASE 2 — AUTOMATED BEHAVIORAL STORAGE SECURITY TESTS
 *
 * Every test here performs a REAL Cloud Storage operation against the emulator
 * as an authenticated / unauthenticated attacker or a legitimate staff user.
 * Nothing inspects storage.rules as text. `assertSucceeds` / `assertFails` are
 * the only assertion primitives used.
 *
 * ============================ READ THIS FIRST ============================
 * THESE TESTS ARE EXPECTED TO FAIL. That is the deliverable, not a defect.
 *
 * They assert what multi-tenant isolation REQUIRES, and storage.rules currently
 * provides none of it: it never reads Firestore, never checks a role, and never
 * bounds size or content type. Every failing test below is a reproducible
 * demonstration of a real vulnerability, and the red set is the punch-list the
 * next phase turns green.
 *
 * Do NOT "fix" storage.rules to make this file pass, and do NOT weaken or delete
 * these assertions. Do NOT mark them skipped. A green run of this file is only
 * meaningful AFTER the rules are hardened, and until then this file is the
 * evidence that they are not.
 *
 * The mirror-image file tests.emulator/storageBaselineEmulator.test.js pins
 * what the rules ACTUALLY permit and is expected to stay green.
 *
 * Architecture mirrors tests.emulator/firestoreSecurityEmulator.test.js:
 *   - rules read from storage.rules (and firestore.rules) at runtime
 *   - emulator hosts from FIREBASE_STORAGE_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST
 *   - one initializeTestEnvironment per suite, seeded in beforeAll inside
 *     withSecurityRulesDisabled, torn down with env.cleanup() in afterAll
 *   - never calls clearStorage() / clearFirestore(); every gym / user / member /
 *     object id is `exp-`-prefixed so this file cannot disturb the other suites
 *     (vitest runs the storage files sequentially against the single emulator).
 *
 * Firestore is booted purely as a FIXTURE STORE for the `users/{uid}` and
 * `members/{id}` documents that tenant-scoped rules are expected to consult.
 * The current rules ignore them entirely, which is precisely why so much of
 * this file is red.
 * ========================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  getMetadata,
  uploadBytes,
} from 'firebase/storage'

const PROJECT_ID = 'demo-himalye-gym'

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [FS_HOST, FS_PORT_RAW = '8080'] = firestoreHost.split(':')
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199'
const [ST_HOST, ST_PORT_RAW = '9199'] = storageHost.split(':')

const firestoreRules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')
const storageRules = readFileSync(join(process.cwd(), 'storage.rules'), 'utf8')

const GYM_A = 'exp-gym-a'
const GYM_B = 'exp-gym-b'

const A = {
  owner: 'exp-owner-a',
  admin: 'exp-admin-a',
  frontDesk: 'exp-front-desk-a',
  trainer: 'exp-trainer-a',
}
const B = {
  owner: 'exp-owner-b',
  admin: 'exp-admin-b',
  frontDesk: 'exp-front-desk-b',
  trainer: 'exp-trainer-b',
}

// Four flavours of "no usable tenancy context". The current rules consult none
// of them, so every one of these users is expected to reach gym A's data.
const GHOST = 'exp-ghost-no-profile' // no users/{uid} document at all
const UNBOUND = 'exp-unbound-no-gymid' // profile with a role but no gymId
const EMPTY_GYM = 'exp-emptygym-blank-gymid' // profile with gymId: ''
const NO_ROLE = 'exp-norole-gymid-only' // bound to a gym but carries no role

const M_A = 'exp-member-a' // belongs to GYM_A
const M_B = 'exp-member-b' // belongs to GYM_B
const M_MISSING = 'exp-member-does-not-exist' // never created

// Real PNG magic bytes, so the emulator stores a genuine image/* object.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const OVERSIZE = new Uint8Array(6 * 1024 * 1024) // 6 MB, above the intended cap

/** Current, unscoped production path for a member photo (storage.js:20). */
const photoPath = (memberId) => `memberPhotos/${memberId}`
/** Current, unscoped production path for a gym logo (storage.js:21). */
const logoPath = (name) => `logos/${name}`
/** The tenant-scoped shape Phase 3 is intended to adopt. */
const scopedPhotoPath = (gymId, memberId, file) => `gyms/${gymId}/memberPhotos/${memberId}/${file}`
const scopedLogoPath = (gymId, file) => `gyms/${gymId}/branding/${file}`

let env

function makeEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: FS_HOST, port: Number(FS_PORT_RAW), rules: firestoreRules },
    storage: { host: ST_HOST, port: Number(ST_PORT_RAW), rules: storageRules },
  })
}

/** A Storage reference bound to `uid`, going through the rules evaluator. */
const asUser = (uid, path) => env.authenticatedContext(uid).storage().ref(path)
/** A Storage reference with no authenticated user at all. */
const asAnon = (path) => env.unauthenticatedContext().storage().ref(path)

/**
 * Writes fixtures with the rules switched off. Used for the victims a test
 * attacks. Every test that mutates gets its OWN victim: a test whose attack is
 * (insecurely) allowed really does overwrite or delete the object, so a shared
 * victim would make a later read fail as `object-not-found` instead of as
 * `storage/unauthorized`, and the suite would report the wrong cause.
 */
async function seed(paths, data = PNG, contentType = 'image/png') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const p of paths) {
      await uploadBytes(ctx.storage().ref(p), data, { contentType })
    }
  })
}

// ===========================================================================
// SEC-S1 — UNAUTHENTICATED ACCESS
// ===========================================================================
describe('SEC-S1 — unauthenticated access to Storage', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seed([photoPath(M_A), logoPath('exp-s1-logo.png')])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S1.1 — unauthenticated read of a member photo is denied', async () => {
    await assertFails(getMetadata(asAnon(photoPath(M_A))))
  })

  it('S1.2 — unauthenticated byte download of a member photo is denied', async () => {
    await assertFails(getBytes(asAnon(photoPath(M_A))))
  })

  it('S1.3 — unauthenticated write of a member photo is denied', async () => {
    await assertFails(uploadBytes(asAnon(photoPath('exp-s1-new')), PNG, { contentType: 'image/png' }))
  })

  it('S1.4 — unauthenticated delete of a member photo is denied', async () => {
    const victim = photoPath('exp-s1-delete-victim')
    await seed([victim])
    await assertFails(deleteObject(asAnon(victim)))
  })

  // `allow read: if true` on /logos/{name}. A gym's branding is world-readable
  // to anyone who has never authenticated, on any network, with no token.
  it('S1.5 — unauthenticated read of a gym logo is denied', async () => {
    await assertFails(getMetadata(asAnon(logoPath('exp-s1-logo.png'))))
  })

  it('S1.6 — unauthenticated byte download of a gym logo is denied', async () => {
    await assertFails(getBytes(asAnon(logoPath('exp-s1-logo.png'))))
  })

  it('S1.7 — unauthenticated write of a gym logo is denied', async () => {
    await assertFails(uploadBytes(asAnon(logoPath('exp-s1-anon-write.png')), PNG, { contentType: 'image/png' }))
  })

  it('S1.8 — unauthenticated delete of a gym logo is denied', async () => {
    const victim = logoPath('exp-s1-logo-delete-victim.png')
    await seed([victim])
    await assertFails(deleteObject(asAnon(victim)))
  })
})

// ===========================================================================
// SEC-S2 — SAME-GYM ACCESS THAT MUST REMAIN ALLOWED
// These are the regression guards: hardening the rules must not lock the gym
// out of its own media.
//
// PHASE 3A.5 — RECONCILED ONTO THE SCOPED ARCHITECTURE.
// This group originally drove the REVOKED flat paths (memberPhotos/{memberId},
// logos/{name}) and asserted they succeed. That assertion described the
// pre-hardening ruleset and directly contradicted the locked architecture,
// which requires those prefixes to be denied. Each case below is unchanged in
// intent — same-gym staff must still reach their own media — but now addresses
// the gym-scoped path that serves production traffic. Revocation of the flat
// paths is asserted explicitly in SEC-S7 (S7.7-S7.9) and exhaustively in
// tests.emulator/storageScopedEmulator.test.js (SC-S6).
// ===========================================================================
describe('SEC-S2 — same-gym staff access is allowed', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    })
    await seed([scopedPhotoPath(GYM_A, M_A, 's2-photo.png'), scopedLogoPath(GYM_A, 's2-logo.png')])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S2.1 — owner reads their own gym’s member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.owner, scopedPhotoPath(GYM_A, M_A, 's2-photo.png'))))
  })

  it('S2.2 — admin reads their own gym’s member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.admin, scopedPhotoPath(GYM_A, M_A, 's2-photo.png'))))
  })

  it('S2.3 — front-desk reads their own gym’s member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.frontDesk, scopedPhotoPath(GYM_A, M_A, 's2-photo.png'))))
  })

  it('S2.4 — trainer reads their own gym’s member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.trainer, scopedPhotoPath(GYM_A, M_A, 's2-photo.png'))))
  })

  // members.write is ['owner','admin','front-desk'] (utils/constants.js:26).
  it('S2.5 — owner replaces their own gym’s member photo', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, scopedPhotoPath(GYM_A, M_A, 's2-photo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S2.6 — admin replaces their own gym’s member photo', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.admin, scopedPhotoPath(GYM_A, M_A, 's2-photo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S2.7 — front-desk replaces their own gym’s member photo', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.frontDesk, scopedPhotoPath(GYM_A, M_A, 's2-photo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S2.8 — owner reads their own gym’s logo', async () => {
    await assertSucceeds(getMetadata(asUser(A.owner, scopedLogoPath(GYM_A, 's2-logo.png'))))
  })

  it('S2.9 — owner replaces their own gym’s logo', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, scopedLogoPath(GYM_A, 's2-own.png')), PNG, { contentType: 'image/png' }),
    )
  })
})

// ===========================================================================
// SEC-S3 — CROSS-GYM ACCESS
// The central multi-tenant requirement. storage.rules has no gymId anywhere in
// its paths, so every one of these is currently allowed.
// ===========================================================================
describe('SEC-S3 — cross-gym access is denied', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${B.admin}`).set({ role: 'admin', gymId: GYM_B })
      await fs.doc(`users/${B.frontDesk}`).set({ role: 'front-desk', gymId: GYM_B })
      await fs.doc(`users/${B.trainer}`).set({ role: 'trainer', gymId: GYM_B })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
      await fs.doc(`members/${M_B}`).set({ name: 'Member B', gymId: GYM_B })
    })
    await seed([photoPath(M_A), photoPath(M_B), logoPath('exp-s3-gym-a-logo.png'), logoPath('exp-s3-gym-b-logo.png')])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S3.1 — gym B owner cannot read gym A’s member photo', async () => {
    await assertFails(getMetadata(asUser(B.owner, photoPath(M_A))))
  })

  it('S3.2 — gym B owner cannot byte-download gym A’s member photo', async () => {
    await assertFails(getBytes(asUser(B.owner, photoPath(M_A))))
  })

  it('S3.3 — gym B admin cannot read gym A’s member photo', async () => {
    await assertFails(getMetadata(asUser(B.admin, photoPath(M_A))))
  })

  it('S3.4 — gym B trainer cannot read gym A’s member photo', async () => {
    await assertFails(getMetadata(asUser(B.trainer, photoPath(M_A))))
  })

  it('S3.5 — gym B front-desk cannot read gym A’s member photo', async () => {
    await assertFails(getMetadata(asUser(B.frontDesk, photoPath(M_A))))
  })

  it('S3.6 — gym B owner cannot overwrite gym A’s member photo', async () => {
    const victim = photoPath('exp-s3-write-victim-a')
    await seed([victim])
    await assertFails(uploadBytes(asUser(B.owner, victim), PNG, { contentType: 'image/png' }))
  })

  it('S3.7 — gym B admin cannot overwrite gym A’s member photo', async () => {
    const victim = photoPath('exp-s3-write-victim-b')
    await seed([victim])
    await assertFails(uploadBytes(asUser(B.admin, victim), PNG, { contentType: 'image/png' }))
  })

  it('S3.8 — gym B owner cannot delete gym A’s member photo', async () => {
    const victim = photoPath('exp-s3-delete-victim-a')
    await seed([victim])
    await assertFails(deleteObject(asUser(B.owner, victim)))
  })

  it('S3.9 — gym B admin cannot delete gym A’s member photo', async () => {
    const victim = photoPath('exp-s3-delete-victim-b')
    await seed([victim])
    await assertFails(deleteObject(asUser(B.admin, victim)))
  })

  it('S3.10 — gym A cannot read gym B’s member photo', async () => {
    await assertFails(getMetadata(asUser(A.owner, photoPath(M_B))))
  })

  it('S3.11 — gym B owner cannot read gym A’s logo', async () => {
    await assertFails(getMetadata(asUser(B.owner, logoPath('exp-s3-gym-a-logo.png'))))
  })

  it('S3.12 — gym B owner cannot overwrite gym A’s logo', async () => {
    const victim = logoPath('exp-s3-logo-write-victim.png')
    await seed([victim])
    await assertFails(uploadBytes(asUser(B.owner, victim), PNG, { contentType: 'image/png' }))
  })

  it('S3.13 — gym B owner cannot delete gym A’s logo', async () => {
    const victim = logoPath('exp-s3-logo-delete-victim.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(B.owner, victim)))
  })

  it('S3.14 — gym B owner cannot obtain a download URL for gym A’s logo', async () => {
    // getDownloadURL is the call the app itself makes (storage.js:12) and the
    // URL it persists into Firestore. Whatever the rules decide here is what
    // ends up in settings.app.logoUrl and on every printed receipt.
    await assertFails(getDownloadURL(asUser(B.owner, logoPath('exp-s3-gym-a-logo.png'))))
  })
})

// ===========================================================================
// SEC-S4 — ROLE RESTRICTIONS
// storage.rules checks only `request.auth != null`, so a trainer with no
// members.write, and an admin with no settings.write, are both equivalent to an
// owner as far as Storage is concerned.
// ===========================================================================
describe('SEC-S4 — role restrictions are enforced', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  // A trainer holds members.view but NOT members.write, so the UI hides the
  // photo control (MemberDetail.jsx:559 `editable={canWrite}`). The rules must
  // agree with the UI, or the UI is the only thing standing between a trainer
  // and every member photo in the gym.
  it('S4.1 — trainer cannot write a member photo (no members.write)', async () => {
    const victim = photoPath('exp-s4-trainer-victim')
    await seed([victim])
    await assertFails(uploadBytes(asUser(A.trainer, victim), PNG, { contentType: 'image/png' }))
  })

  it('S4.2 — trainer cannot delete a member photo', async () => {
    const victim = photoPath('exp-s4-trainer-delete-victim')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.trainer, victim)))
  })

  // settings.write is ['owner'] (utils/constants.js:43) and the /settings route
  // is wrapped in <RoleGuard roles={['owner']}> (App.jsx:106).
  it('S4.3 — admin cannot write a gym logo (settings.write is owner-only)', async () => {
    await assertFails(uploadBytes(asUser(A.admin, logoPath('exp-s4-admin-logo.png')), PNG, { contentType: 'image/png' }))
  })

  it('S4.4 — front-desk cannot write a gym logo', async () => {
    await assertFails(
      uploadBytes(asUser(A.frontDesk, logoPath('exp-s4-desk-logo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S4.5 — admin cannot delete a gym logo', async () => {
    const victim = logoPath('exp-s4-admin-logo-delete.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.admin, victim)))
  })

  // The client never deletes member photos — nothing in src/ calls deleteFile
  // for a photo — so the rules should not hand the client that capability.
  it('S4.6 — even an owner cannot delete a member photo through the client', async () => {
    const victim = photoPath('exp-s4-owner-delete-victim')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.owner, victim)))
  })
})

// ===========================================================================
// SEC-S5 — MISSING / UNBOUND / EMPTY TENANCY CONTEXT
// A brand-new signup that has authenticated but never bound a gym is the exact
// shape an attacker controls. Today it can read and overwrite every gym's data.
// ===========================================================================
describe('SEC-S5 — absent or unusable tenancy context is denied', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' }) // no gymId
      await fs.doc(`users/${EMPTY_GYM}`).set({ role: 'admin', gymId: '' }) // blank gymId
      await fs.doc(`users/${NO_ROLE}`).set({ gymId: GYM_A }) // gym but no role
      // GHOST is deliberately never written: no users/{uid} document at all.
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    })
    await seed([photoPath(M_A), logoPath('exp-s5-logo.png')])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S5.1 — a user with no users/{uid} profile cannot read a member photo', async () => {
    await assertFails(getMetadata(asUser(GHOST, photoPath(M_A))))
  })

  it('S5.2 — a user with no users/{uid} profile cannot write a member photo', async () => {
    await assertFails(
      uploadBytes(asUser(GHOST, photoPath('exp-s5-ghost-write')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S5.3 — a user with no users/{uid} profile cannot write a gym logo', async () => {
    await assertFails(
      uploadBytes(asUser(GHOST, logoPath('exp-s5-ghost-logo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S5.4 — a profile with no gymId cannot read a member photo', async () => {
    await assertFails(getMetadata(asUser(UNBOUND, photoPath(M_A))))
  })

  it('S5.5 — a profile with no gymId cannot write a member photo', async () => {
    await assertFails(uploadBytes(asUser(UNBOUND, photoPath('exp-s5-unbound-write')), PNG, { contentType: 'image/png' }))
  })

  it('S5.6 — a profile with an empty-string gymId cannot read a member photo', async () => {
    await assertFails(getMetadata(asUser(EMPTY_GYM, photoPath(M_A))))
  })

  it('S5.7 — a profile with an empty-string gymId cannot write a member photo', async () => {
    await assertFails(
      uploadBytes(asUser(EMPTY_GYM, photoPath('exp-s5-emptygym-write')), PNG, { contentType: 'image/png' }),
    )
  })

  // Bound to a gym but carrying no role is not staff. members.read is guarded by
  // isStaff() in firestore.rules:28; Storage has no equivalent, so this user can
  // currently read everything.
  it('S5.8 — a profile with a gymId but no role cannot read a member photo', async () => {
    await assertFails(getMetadata(asUser(NO_ROLE, photoPath(M_A))))
  })

  it('S5.9 — a profile with a gymId but no role cannot write a member photo', async () => {
    await assertFails(uploadBytes(asUser(NO_ROLE, photoPath('exp-s5-norole-write')), PNG, { contentType: 'image/png' }))
  })
})

// ===========================================================================
// SEC-S6 — PARENT MEMBER DOCUMENT INTEGRITY
// A photo path is only meaningful if the member it names actually belongs to
// the caller's gym. Nothing ties the two together today, so an orphan or
// cross-gym member id is accepted just as readily as a legitimate one.
// ===========================================================================
describe('SEC-S6 — the referenced member document is validated', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
      await fs.doc(`members/${M_B}`).set({ name: 'Member B', gymId: GYM_B })
      // M_MISSING is deliberately never written.
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S6.1 — cannot write a photo for a member owned by another gym', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, photoPath(M_B)), PNG, { contentType: 'image/png' }),
    )
  })

  it('S6.2 — cannot write a photo for a member document that does not exist', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, photoPath(M_MISSING)), PNG, { contentType: 'image/png' }),
    )
  })

  it('S6.3 — cannot read a photo whose member document does not exist', async () => {
    const orphan = photoPath('exp-s6-orphan')
    await seed([orphan])
    await assertFails(getMetadata(asUser(A.owner, orphan)))
  })
})

// ===========================================================================
// SEC-S7 — NESTED, INVALID AND LEGACY-SCOPED PATHS
// ===========================================================================
describe('SEC-S7 — path shape is constrained', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    })
    await seed([`${photoPath(M_A)}/nested`, `${logoPath('exp-s7-logo.png')}/nested`])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S7.1 — a nested path under memberPhotos is denied', async () => {
    await assertFails(getMetadata(asUser(A.owner, `${photoPath(M_A)}/nested`)))
  })

  it('S7.2 — a nested path under logos is denied', async () => {
    await assertFails(getMetadata(asUser(A.owner, `${logoPath('exp-s7-logo.png')}/nested`)))
  })

  it('S7.3 — an entirely unknown prefix is denied', async () => {
    await assertFails(uploadBytes(asUser(A.owner, 'exp-anything/whatever.png'), PNG, { contentType: 'image/png' }))
  })

  it('S7.4 — a traversal segment cannot escape the memberPhotos prefix', async () => {
    await assertFails(uploadBytes(asUser(A.owner, 'memberPhotos/../logos/exp-s7-traversal.png'), PNG, { contentType: 'image/png' }))
  })

  // PHASE 3A.5 — INVERTED. These two originally asserted that the gym-scoped
  // paths did NOT resolve, as evidence that the client upload paths must not be
  // re-keyed before the rules changed. The rules have now been hardened
  // (Phase 3A), so the gym-scoped paths ARE the contract and must resolve. The
  // original intent — "the scoped shape must be the one that works" — is
  // preserved by asserting success; the revocation of the flat paths they
  // replaced is asserted by S7.7-S7.9 below.
  it('S7.5 — the gym-scoped member-photo path resolves for an authorized caller', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, scopedPhotoPath(GYM_A, M_A, 's7-photo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('S7.6 — the gym-scoped branding path resolves for the owner', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, scopedLogoPath(GYM_A, 's7-logo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  // And the reverse direction: once the rules are hardened, the CURRENT
  // unscoped prefixes must stop working. They work today, so these are red.
  it('S7.7 — the old unscoped memberPhotos prefix stops accepting writes', async () => {
    await assertFails(uploadBytes(asUser(A.owner, photoPath('exp-s7-legacy-photo')), PNG, { contentType: 'image/png' }))
  })

  it('S7.8 — the old unscoped logos prefix stops accepting writes', async () => {
    await assertFails(uploadBytes(asUser(A.owner, logoPath('exp-s7-legacy-logo.png')), PNG, { contentType: 'image/png' }))
  })

  it('S7.9 — the old unscoped logos prefix stops being publicly readable', async () => {
    const legacy = logoPath('exp-s7-legacy-read.png')
    await seed([legacy])
    await assertFails(getMetadata(asAnon(legacy)))
  })
})

// ===========================================================================
// SEC-S8 — BACKUP QUARANTINE
// Backups are written by the Admin SDK, which bypasses rules by design; the
// deny rule below is defence in depth, not the control. These tests must stay
// green — a regression here would be a real breach.
// ===========================================================================
describe('SEC-S8 — backups are denied to every client identity', () => {
  const BACKUP = 'backups/exp-date/members.json'

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
    })
    // Seeded as a plain JSON object, exactly as dailyBackup writes it
    // (functions/index.js:53).
    await seed([BACKUP], new TextEncoder().encode('{"members":[]}'), 'application/json')
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S8.1 — unauthenticated read of a backup is denied', async () => {
    await assertFails(getMetadata(asAnon(BACKUP)))
  })

  it('S8.2 — unauthenticated write of a backup is denied', async () => {
    await assertFails(
      uploadBytes(asAnon('backups/exp-date/anon.json'), new Uint8Array([1]), { contentType: 'application/json' }),
    )
  })

  it('S8.3 — owner cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.owner, BACKUP)))
  })

  it('S8.4 — admin cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.admin, BACKUP)))
  })

  it('S8.5 — front-desk cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.frontDesk, BACKUP)))
  })

  it('S8.6 — trainer cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.trainer, BACKUP)))
  })

  it('S8.7 — owner cannot overwrite a backup', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, 'backups/exp-date/owner.json'), new Uint8Array([1]), { contentType: 'application/json' }),
    )
  })

  it('S8.8 — owner cannot delete a backup', async () => {
    await assertFails(deleteObject(asUser(A.owner, BACKUP)))
  })
})

// ===========================================================================
// SEC-S9 — SIZE AND CONTENT-TYPE LIMITS
// Neither upload input in the app validates anything the server can see:
// `accept="image/*"` (MemberPhoto.jsx:62, Settings.jsx:359) is a client-side
// hint the caller can ignore, and the logo extension is taken straight from the
// user's filename (Settings.jsx:164). A rules-level cap and allowlist is the
// only server-side control.
// ===========================================================================
describe('SEC-S9 — uploads are bounded by size and content type', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('S9.1 — an oversize member photo is rejected', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, photoPath('exp-s9-oversize')), OVERSIZE, { contentType: 'image/png' }),
    )
  })

  it('S9.2 — an oversize gym logo is rejected', async () => {
    await assertFails(uploadBytes(asUser(A.owner, logoPath('exp-s9-oversize.png')), OVERSIZE, { contentType: 'image/png' }))
  })

  it('S9.3 — an HTML payload masquerading as a member photo is rejected', async () => {
    await assertFails(
      uploadBytes(
        asUser(A.owner, photoPath('exp-s9-html')),
        new TextEncoder().encode('<script>alert(1)</script>'),
        { contentType: 'text/html' },
      ),
    )
  })

  it('S9.4 — an HTML payload masquerading as a gym logo is rejected', async () => {
    await assertFails(
      uploadBytes(
        asUser(A.owner, logoPath('exp-s9-logo.html')),
        new TextEncoder().encode('<script>alert(1)</script>'),
        { contentType: 'text/html' },
      ),
    )
  })

  it('S9.5 — a PDF masquerading as a member photo is rejected', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, photoPath('exp-s9-pdf')), new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        contentType: 'application/pdf',
      }),
    )
  })

  it('S9.6 — a logo extension chosen by the caller is rejected', async () => {
    // Settings.jsx:164 builds the object name from `file.name.split('.').pop()`
    // with no allowlist, and /logos/{name} is world-readable.
    await assertFails(uploadBytes(asUser(A.owner, logoPath('exp-s9-logo.html')), PNG, { contentType: 'image/png' }))
  })

  it('S9.7 — oversize upload protection also holds across gyms', async () => {
    await assertFails(
      uploadBytes(asUser(B.owner, photoPath('exp-s9-cross-oversize')), OVERSIZE, { contentType: 'image/png' }),
    )
  })
})