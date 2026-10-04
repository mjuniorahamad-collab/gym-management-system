/**
 * STORAGE PHASE 3A.5 — PERMANENT SCOPED-PATH SECURITY COVERAGE
 *
 * This suite is the behavioural proof that the hardened storage.rules actually
 * enforce the tenant-scoped architecture:
 *
 *   gyms/{gymId}/memberPhotos/{memberId}/{fileName}
 *   gyms/{gymId}/branding/{fileName}
 *   backups/{allPaths=**}
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * tests.emulator/storageSecurityEmulator.test.js was written in Phase 2 against
 * the PRE-hardening ruleset. Almost all of its negative cases drive the legacy
 * flat paths (`memberPhotos/{memberId}`, `logos/{name}`). Once those paths were
 * revoked in Phase 3A, that suite went green *because the legacy paths were
 * denied* — which proves revocation, but says nothing about whether the NEW
 * paths are correct. Cross-gym isolation, parent-document integrity, role gates
 * and upload limits were therefore untested on the paths that now serve
 * production traffic.
 *
 * This file closes that gap. Every requirement below is asserted against a real
 * Storage operation evaluated by the emulator; nothing inspects storage.rules as
 * text.
 *
 *   - same-gym member-photo reads / writes
 *   - cross-gym reads / writes / deletes
 *   - parent member gym integrity, and nonexistent members
 *   - trainer restrictions
 *   - admin / front-desk branding restrictions
 *   - owner branding access
 *   - unbound user, missing profile, empty gymId, role-less profile
 *   - invalid and nested path shapes
 *   - legacy flat-path denial
 *   - size limits and content-type limits
 *   - backups denial for every identity
 *
 * Architecture mirrors tests.emulator/firestoreSecurityEmulator.test.js:
 *   - rules read from storage.rules / firestore.rules at runtime
 *   - one initializeTestEnvironment, seeded in beforeAll inside
 *     withSecurityRulesDisabled, torn down with env.cleanup()
 *   - never calls clearStorage() / clearFirestore(); every id is `sc-`-prefixed
 *     so this suite cannot disturb the other Storage suites, which vitest runs
 *     sequentially against the single emulator
 *   - every mutating test seeds its OWN victim, so an allowed mutation cannot
 *     make a later assertion fail as object-not-found instead of as a decision
 *
 * Firestore is booted purely as a FIXTURE STORE for the `users/{uid}` and
 * `members/{id}` documents that the tenant-scoped rules consult.
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
  listAll,
  uploadBytes,
} from 'firebase/storage'

const PROJECT_ID = 'demo-himalye-gym'

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [FS_HOST, FS_PORT_RAW = '8080'] = firestoreHost.split(':')
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199'
const [ST_HOST, ST_PORT_RAW = '9199'] = storageHost.split(':')

const firestoreRules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')
const storageRules = readFileSync(join(process.cwd(), 'storage.rules'), 'utf8')

const GYM_A = 'sc-gym-a'
const GYM_B = 'sc-gym-b'

const A = {
  owner: 'sc-owner-a',
  admin: 'sc-admin-a',
  frontDesk: 'sc-front-desk-a',
  trainer: 'sc-trainer-a',
}
const B = {
  owner: 'sc-owner-b',
  admin: 'sc-admin-b',
  frontDesk: 'sc-front-desk-b',
  trainer: 'sc-trainer-b',
}

// Four flavours of "no usable tenancy context", all of which must be denied.
const GHOST = 'sc-ghost-no-profile' // no users/{uid} document at all
const UNBOUND = 'sc-unbound-no-gymid' // role but no gymId
const EMPTY_GYM = 'sc-emptygym-blank-gymid' // gymId: ''
const NO_ROLE = 'sc-norole-gymid-only' // gym bound, no role

const M_A = 'sc-member-a' // belongs to GYM_A
const M_B = 'sc-member-b' // belongs to GYM_B
const M_MISSING = 'sc-member-does-not-exist' // never created

// Real PNG magic bytes, so the emulator stores a genuine image/* object.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MB = 1024 * 1024
const OVERSIZE = new Uint8Array(6 * MB) // above both caps
const OVER_BRANDING_CAP = new Uint8Array(3 * MB) // above the 2 MB branding cap, below the 5 MB photo cap

/** The tenant-scoped member-photo path. */
const photo = (gymId, memberId, file) => `gyms/${gymId}/memberPhotos/${memberId}/${file}`
/** The tenant-scoped branding path. */
const brand = (gymId, file) => `gyms/${gymId}/branding/${file}`
/** The revoked flat paths. */
const legacyPhoto = (memberId) => `memberPhotos/${memberId}`
const legacyLogo = (name) => `logos/${name}`

let env

function makeEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: FS_HOST, port: Number(FS_PORT_RAW), rules: firestoreRules },
    storage: { host: ST_HOST, port: Number(ST_PORT_RAW), rules: storageRules },
  })
}

const asUser = (uid, path) => env.authenticatedContext(uid).storage().ref(path)
const asAnon = (path) => env.unauthenticatedContext().storage().ref(path)

async function seed(paths, data = PNG, contentType = 'image/png') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const p of paths) {
      await uploadBytes(ctx.storage().ref(p), data, { contentType })
    }
  })
}

/** Seeds the full two-gym fixture set used by every suite below. */
async function seedTenancy() {
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
    await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
    await fs.doc(`users/${EMPTY_GYM}`).set({ role: 'admin', gymId: '' })
    await fs.doc(`users/${NO_ROLE}`).set({ gymId: GYM_A })
    // GHOST is deliberately never written: no users/{uid} document at all.
    await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    await fs.doc(`members/${M_B}`).set({ name: 'Member B', gymId: GYM_B })
    // M_MISSING is deliberately never written.
  })
}

// ===========================================================================
// SC-S1 — SAME-GYM MEMBER-PHOTO ACCESS (the contract that must keep working)
// ===========================================================================
describe('SC-S1 — same-gym member-photo access is allowed', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([photo(GYM_A, M_A, 'seed.png')])
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S1.1 — owner reads a same-gym member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.owner, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S1.2 — admin reads a same-gym member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.admin, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S1.3 — front-desk reads a same-gym member photo', async () => {
    await assertSucceeds(getMetadata(asUser(A.frontDesk, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S1.4 — trainer reads a same-gym member photo', async () => {
    // members.view is all four staff roles, so a trainer may READ.
    await assertSucceeds(getMetadata(asUser(A.trainer, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S1.5 — same-gym staff download photo bytes', async () => {
    await assertSucceeds(getBytes(asUser(A.trainer, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S1.6 — same-gym staff obtain a rules-evaluated download URL', async () => {
    await assertSucceeds(getDownloadURL(asUser(A.owner, photo(GYM_A, M_A, 'seed.png'))))
  })

  it('SC-S1.7 — owner writes a same-gym member photo', async () => {
    await assertSucceeds(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'w-owner.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S1.8 — admin writes a same-gym member photo', async () => {
    await assertSucceeds(uploadBytes(asUser(A.admin, photo(GYM_A, M_A, 'w-admin.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S1.9 — front-desk writes a same-gym member photo', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.frontDesk, photo(GYM_A, M_A, 'w-desk.png')), PNG, { contentType: 'image/png' }),
    )
  })
  it('SC-S1.10 — an owner replaces an existing photo in place', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'seed.png')), PNG, { contentType: 'image/png' }),
    )
  })
  it('SC-S1.11 — jpeg, jpg and webp are all accepted', async () => {
    for (const [file, type] of [['a.jpg', 'image/jpeg'], ['b.jpeg', 'image/jpeg'], ['c.webp', 'image/webp']]) {
      await assertSucceeds(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, file)), PNG, { contentType: type }))
    }
  })
})

// ===========================================================================
// SC-S2 — CROSS-GYM ISOLATION ON THE SCOPED PATHS
// The central multi-tenant requirement, asserted on the paths now in use.
// ===========================================================================
describe('SC-S2 — cross-gym access is denied', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([photo(GYM_A, M_A, 'a.png'), photo(GYM_B, M_B, 'b.png'), brand(GYM_A, 'a.png'), brand(GYM_B, 'b.png')])
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S2.1 — every gym B role cannot read a gym A member photo', async () => {
    for (const u of [B.owner, B.admin, B.frontDesk, B.trainer]) {
      await assertFails(getMetadata(asUser(u, photo(GYM_A, M_A, 'a.png'))))
    }
  })
  it('SC-S2.2 — every gym B role cannot download gym A photo bytes', async () => {
    for (const u of [B.owner, B.admin, B.frontDesk, B.trainer]) {
      await assertFails(getBytes(asUser(u, photo(GYM_A, M_A, 'a.png'))))
    }
  })
  it('SC-S2.3 — a gym B owner cannot overwrite a gym A member photo', async () => {
    await assertFails(uploadBytes(asUser(B.owner, photo(GYM_A, M_A, 'v1.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S2.4 — a gym B admin cannot overwrite a gym A member photo', async () => {
    await assertFails(uploadBytes(asUser(B.admin, photo(GYM_A, M_A, 'v2.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S2.5 — a gym B owner cannot delete a gym A member photo', async () => {
    const victim = photo(GYM_A, M_A, 'del-a.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(B.owner, victim)))
  })
  it('SC-S2.6 — a gym B admin cannot delete a gym A member photo', async () => {
    const victim = photo(GYM_A, M_A, 'del-b.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(B.admin, victim)))
  })
  it('SC-S2.7 — a gym A owner cannot read a gym B member photo', async () => {
    await assertFails(getMetadata(asUser(A.owner, photo(GYM_B, M_B, 'b.png'))))
  })
  it('SC-S2.8 — a gym A owner cannot write into the gym B photo namespace', async () => {
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_B, M_B, 'v8.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S2.9 — a gym B owner cannot read a gym A branding asset', async () => {
    await assertFails(getMetadata(asUser(B.owner, brand(GYM_A, 'a.png'))))
  })
  it('SC-S2.10 — a gym B owner cannot obtain a download URL for gym A branding', async () => {
    await assertFails(getDownloadURL(asUser(B.owner, brand(GYM_A, 'a.png'))))
  })
  it('SC-S2.11 — a gym B owner cannot write into the gym A branding namespace', async () => {
    await assertFails(uploadBytes(asUser(B.owner, brand(GYM_A, 'v11.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S2.12 — a gym B owner cannot delete gym A branding', async () => {
    const victim = brand(GYM_A, 'del.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(B.owner, victim)))
  })
  it('SC-S2.13 — a gym A owner cannot write into the gym B branding namespace', async () => {
    await assertFails(uploadBytes(asUser(A.owner, brand(GYM_B, 'v13.png')), PNG, { contentType: 'image/png' }))
  })
})

// ===========================================================================
// SC-S3 — PARENT MEMBER DOCUMENT INTEGRITY
// ===========================================================================
describe('SC-S3 — the referenced member document is validated', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S3.1 — a photo cannot be written for a member owned by another gym', async () => {
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_B, 'x1.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S3.2 — a photo cannot be written for a member that does not exist', async () => {
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_MISSING, 'x2.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S3.3 — a photo cannot be read for a member that does not exist', async () => {
    const orphan = photo(GYM_A, M_MISSING, 'orphan.png')
    await seed([orphan])
    await assertFails(getMetadata(asUser(A.owner, orphan)))
  })
  it('SC-S3.4 — a photo cannot be read when the member belongs to another gym', async () => {
    // M_B belongs to GYM_B, so gym A staff have no claim to it even under /gyms/GYM_A.
    await assertFails(getMetadata(asUser(A.owner, photo(GYM_A, M_B, 'x4.png'))))
  })
})

// ===========================================================================
// SC-S4 — ROLE RESTRICTIONS ON THE SCOPED PATHS
// members.write is ['owner','admin','front-desk'] (utils/constants.js:26).
// settings.write is ['owner'] (utils/constants.js:43).
// ===========================================================================
describe('SC-S4 — role restrictions are enforced on scoped paths', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([photo(GYM_A, M_A, 'seed.png'), brand(GYM_A, 'seed.png')])
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S4.1 — a trainer cannot write a member photo', async () => {
    await assertFails(uploadBytes(asUser(A.trainer, photo(GYM_A, M_A, 't1.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S4.2 — a trainer cannot delete a member photo', async () => {
    const victim = photo(GYM_A, M_A, 't2.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.trainer, victim)))
  })
  it('SC-S4.3 — even an owner cannot delete a member photo through the client', async () => {
    // No client code path deletes a photo, so the rules must not grant it.
    const victim = photo(GYM_A, M_A, 't3.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.owner, victim)))
  })
  it('SC-S4.4 — an admin cannot write branding (settings.write is owner-only)', async () => {
    await assertFails(uploadBytes(asUser(A.admin, brand(GYM_A, 'r4.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S4.5 — front-desk cannot write branding', async () => {
    await assertFails(uploadBytes(asUser(A.frontDesk, brand(GYM_A, 'r5.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S4.6 — a trainer cannot write branding', async () => {
    await assertFails(uploadBytes(asUser(A.trainer, brand(GYM_A, 'r6.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S4.7 — an admin cannot delete branding', async () => {
    const victim = brand(GYM_A, 'r7.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.admin, victim)))
  })
  it('SC-S4.8 — even an owner cannot delete branding through the client', async () => {
    // Replacement is an update in place; no client delete capability is granted.
    const victim = brand(GYM_A, 'r8.png')
    await seed([victim])
    await assertFails(deleteObject(asUser(A.owner, victim)))
  })
  it('SC-S4.9 — an owner can write and replace branding', async () => {
    await assertSucceeds(uploadBytes(asUser(A.owner, brand(GYM_A, 'r9.png')), PNG, { contentType: 'image/png' }))
    await assertSucceeds(uploadBytes(asUser(A.owner, brand(GYM_A, 'seed.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S4.10 — same-gym staff of every role can read branding', async () => {
    for (const u of [A.owner, A.admin, A.frontDesk, A.trainer]) {
      await assertSucceeds(getMetadata(asUser(u, brand(GYM_A, 'seed.png'))))
    }
  })
})

// ===========================================================================
// SC-S5 — UNUSABLE TENANCY CONTEXT
// ===========================================================================
describe('SC-S5 — absent or unusable tenancy context is denied', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([photo(GYM_A, M_A, 'seed.png'), brand(GYM_A, 'seed.png')])
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S5.1 — a missing users/{uid} profile cannot read a photo', async () => {
    await assertFails(getMetadata(asUser(GHOST, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S5.2 — a missing users/{uid} profile cannot write a photo', async () => {
    await assertFails(uploadBytes(asUser(GHOST, photo(GYM_A, M_A, 'g2.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S5.3 — a missing users/{uid} profile cannot write branding', async () => {
    await assertFails(uploadBytes(asUser(GHOST, brand(GYM_A, 'g3.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S5.4 — a profile with no gymId cannot read a photo', async () => {
    await assertFails(getMetadata(asUser(UNBOUND, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S5.5 — a profile with no gymId cannot write a photo', async () => {
    await assertFails(uploadBytes(asUser(UNBOUND, photo(GYM_A, M_A, 'u5.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S5.6 — a profile with an empty-string gymId cannot read a photo', async () => {
    await assertFails(getMetadata(asUser(EMPTY_GYM, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S5.7 — a profile with an empty-string gymId cannot write a photo', async () => {
    await assertFails(uploadBytes(asUser(EMPTY_GYM, photo(GYM_A, M_A, 'e7.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S5.8 — a profile with a gymId but no role cannot read a photo', async () => {
    await assertFails(getMetadata(asUser(NO_ROLE, photo(GYM_A, M_A, 'seed.png'))))
  })
  it('SC-S5.9 — a profile with a gymId but no role cannot write a photo', async () => {
    await assertFails(uploadBytes(asUser(NO_ROLE, photo(GYM_A, M_A, 'n9.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S5.10 — an unauthenticated caller is denied on both scoped paths', async () => {
    await assertFails(getMetadata(asAnon(photo(GYM_A, M_A, 'seed.png'))))
    await assertFails(getBytes(asAnon(photo(GYM_A, M_A, 'seed.png'))))
    await assertFails(uploadBytes(asAnon(photo(GYM_A, M_A, 'anon.png')), PNG, { contentType: 'image/png' }))
    await assertFails(deleteObject(asAnon(photo(GYM_A, M_A, 'seed.png'))))
    await assertFails(getMetadata(asAnon(brand(GYM_A, 'seed.png'))))
    await assertFails(uploadBytes(asAnon(brand(GYM_A, 'anon.png')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S5.11 — an owner of another gym cannot read branding through a forged path', async () => {
    // B.owner is a legitimate owner, but not of GYM_A.
    await assertFails(getMetadata(asUser(B.owner, brand(GYM_A, 'seed.png'))))
  })
})

// ===========================================================================
// SC-S6 — LEGACY FLAT PATHS STAY REVOKED
// The pre-hardening layout (memberPhotos/{memberId}, logos/{name}) was
// unscoped, role-free and world-readable. It must remain unreachable.
// ===========================================================================
describe('SC-S6 — legacy flat paths remain denied', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([legacyPhoto(M_A), legacyLogo('sc6-logo.png'), legacyLogo('sc6-read.png')])
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S6.1 — an owner cannot read a legacy member photo', async () => {
    await assertFails(getMetadata(asUser(A.owner, legacyPhoto(M_A))))
  })
  it('SC-S6.2 — an owner cannot download legacy member-photo bytes', async () => {
    await assertFails(getBytes(asUser(A.owner, legacyPhoto(M_A))))
  })
  it('SC-S6.3 — an owner cannot write a legacy member photo', async () => {
    await assertFails(uploadBytes(asUser(A.owner, legacyPhoto(M_A)), PNG, { contentType: 'image/png' }))
  })
  it('SC-S6.4 — an owner cannot delete a legacy member photo', async () => {
    await assertFails(deleteObject(asUser(A.owner, legacyPhoto(M_A))))
  })
  it('SC-S6.5 — an owner cannot read a legacy logo', async () => {
    await assertFails(getMetadata(asUser(A.owner, legacyLogo('sc6-logo.png'))))
  })
  it('SC-S6.6 — a legacy logo is no longer publicly readable', async () => {
    // The old rule was `allow read: if true`.
    await assertFails(getMetadata(asAnon(legacyLogo('sc6-read.png'))))
    await assertFails(getBytes(asAnon(legacyLogo('sc6-read.png'))))
  })
  it('SC-S6.7 — an owner cannot write or delete a legacy logo', async () => {
    await assertFails(uploadBytes(asUser(A.owner, legacyLogo('sc6-new.png')), PNG, { contentType: 'image/png' }))
    await assertFails(deleteObject(asUser(A.owner, legacyLogo('sc6-logo.png'))))
  })
  it('SC-S6.8 — legacy paths are denied even for a member the caller legitimately owns', async () => {
    // M_A does belong to GYM_A; the path shape alone is what is revoked.
    await assertFails(uploadBytes(asUser(A.owner, legacyPhoto(M_A)), PNG, { contentType: 'image/png' }))
  })
})

// ===========================================================================
// SC-S7 — INVALID AND NESTED PATH SHAPES
// ===========================================================================
describe('SC-S7 — invalid path shapes are denied', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([photo(GYM_A, M_A, 'a.png')])
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S7.1 — deeper nesting under a photo path is denied', async () => {
    await assertFails(getMetadata(asUser(A.owner, `${photo(GYM_A, M_A, 'a.png')}/nested`)))
  })
  it('SC-S7.2 — deeper nesting under a branding path is denied', async () => {
    await assertFails(getMetadata(asUser(A.owner, `${brand(GYM_A, 'a.png')}/nested`)))
  })
  it('SC-S7.3 — a missing member segment is denied', async () => {
    await assertFails(uploadBytes(asUser(A.owner, `gyms/${GYM_A}/memberPhotos/${M_A}`), PNG, { contentType: 'image/png' }))
  })
  it('SC-S7.4 — a missing branding filename is denied', async () => {
    await assertFails(uploadBytes(asUser(A.owner, `gyms/${GYM_A}/branding`), PNG, { contentType: 'image/png' }))
  })
  it('SC-S7.5 — an unknown top-level prefix is denied', async () => {
    await assertFails(uploadBytes(asUser(A.owner, 'sc-unknown/whatever.png'), PNG, { contentType: 'image/png' }))
  })
  it('SC-S7.6 — a path outside the gyms namespace is denied', async () => {
    await assertFails(uploadBytes(asUser(A.owner, `photos/${GYM_A}/${M_A}.png`), PNG, { contentType: 'image/png' }))
  })
  it('SC-S7.7 — a traversal segment cannot escape into the gyms namespace', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, 'gyms/../backups/sc7.json'), new Uint8Array([1]), { contentType: 'application/json' }),
    )
  })
  it('SC-S7.8 — no role can list the bucket root', async () => {
    await assertFails(listAll(asUser(A.owner, '/')))
  })
})

// ===========================================================================
// SC-S8 — SIZE AND CONTENT-TYPE LIMITS
// photos < 5 MB, branding < 2 MB, images only, extension allowlisted.
// ===========================================================================
describe('SC-S8 — uploads are bounded by size and content type', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S8.1 — an oversize member photo is rejected', async () => {
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'big.png')), OVERSIZE, { contentType: 'image/png' }))
  })
  it('SC-S8.2 — an oversize branding asset is rejected', async () => {
    await assertFails(uploadBytes(asUser(A.owner, brand(GYM_A, 'big.png')), OVERSIZE, { contentType: 'image/png' }))
  })
  it('SC-S8.3 — branding above the 2 MB cap is rejected even though a photo would pass', async () => {
    // Proves branding is capped at 2 MB, not merely at the 5 MB photo cap.
    await assertFails(uploadBytes(asUser(A.owner, brand(GYM_A, 'mid.png')), OVER_BRANDING_CAP, { contentType: 'image/png' }))
  })
  it('SC-S8.4 — an HTML payload is rejected as a member photo', async () => {
    await assertFails(
      uploadBytes(
        asUser(A.owner, photo(GYM_A, M_A, 'x.html')),
        new TextEncoder().encode('<script>alert(1)</script>'),
        { contentType: 'text/html' },
      ),
    )
  })
  it('SC-S8.5 — an HTML payload is rejected as branding', async () => {
    await assertFails(
      uploadBytes(
        asUser(A.owner, brand(GYM_A, 'x.html')),
        new TextEncoder().encode('<script>alert(1)</script>'),
        { contentType: 'text/html' },
      ),
    )
  })
  it('SC-S8.6 — a PDF is rejected as a member photo', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'x.pdf')), new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        contentType: 'application/pdf',
      }),
    )
  })
  it('SC-S8.7 — a PDF is rejected as branding', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, brand(GYM_A, 'x.pdf')), new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        contentType: 'application/pdf',
      }),
    )
  })
  it('SC-S8.8 — a caller-chosen extension is rejected even with an image content type', async () => {
    // Settings.jsx:164 builds the object name from the user's own filename with
    // no allowlist; the rules must not let a .html object be created.
    await assertFails(uploadBytes(asUser(A.owner, brand(GYM_A, 'spoof.html')), PNG, { contentType: 'image/png' }))
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'spoof.svg')), PNG, { contentType: 'image/png' }))
  })
  it('SC-S8.9 — svg and gif are rejected by the type allowlist', async () => {
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'v.svg')), PNG, { contentType: 'image/svg+xml' }))
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'g.gif')), PNG, { contentType: 'image/gif' }))
  })
  it('SC-S8.10 — size limits hold across gyms', async () => {
    await assertFails(uploadBytes(asUser(B.owner, photo(GYM_B, M_B, 'big.png')), OVERSIZE, { contentType: 'image/png' }))
  })
  it('SC-S8.11 — limits are enforced before any role shortcut', async () => {
    // A trainer is denied by role, so use the owner: oversize must fail on size,
    // and a bad type must fail even for the most privileged caller.
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 'big2.png')), OVERSIZE, { contentType: 'image/png' }))
    await assertFails(uploadBytes(asUser(A.owner, photo(GYM_A, M_A, 't.txt')), PNG, { contentType: 'text/plain' }))
  })
})

// ===========================================================================
// SC-S9 — BACKUPS ARE DENIED TO EVERY CLIENT IDENTITY
// Defence in depth: backups are written by the Admin SDK, which bypasses rules.
// A regression here would be a real breach.
// ===========================================================================
describe('SC-S9 — backups are denied to every client identity', () => {
  const BACKUP = 'backups/sc-date/members.json'

  beforeAll(async () => {
    env = await makeEnv()
    await seedTenancy()
    await seed([BACKUP], new TextEncoder().encode('{"members":[]}'), 'application/json')
  })
  afterAll(async () => { await env.cleanup() })

  it('SC-S9.1 — unauthenticated read and write of a backup are denied', async () => {
    await assertFails(getMetadata(asAnon(BACKUP)))
    await assertFails(uploadBytes(asAnon('backups/sc-date/anon.json'), new Uint8Array([1]), { contentType: 'application/json' }))
  })
  it('SC-S9.2 — owner cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.owner, BACKUP)))
  })
  it('SC-S9.3 — admin cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.admin, BACKUP)))
  })
  it('SC-S9.4 — front-desk cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.frontDesk, BACKUP)))
  })
  it('SC-S9.5 — trainer cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.trainer, BACKUP)))
  })
  it('SC-S9.6 — no role can write or delete a backup', async () => {
    await assertFails(uploadBytes(asUser(A.owner, 'backups/sc-date/o.json'), new Uint8Array([1]), { contentType: 'application/json' }))
    await assertFails(deleteObject(asUser(A.owner, BACKUP)))
    await assertFails(deleteObject(asUser(A.admin, BACKUP)))
  })
})