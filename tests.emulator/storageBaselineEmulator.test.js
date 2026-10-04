/**
 * STORAGE PHASE 2 — BEHAVIORAL CHARACTERIZATION OF THE CURRENT storage.rules
 *
 * This file is the mirror image of tests.emulator/storageSecurityEmulator.test.js.
 * Where that file asserts what multi-tenant isolation REQUIRES (and is therefore
 * red against today's rules), this file asserts what the rules ACTUALLY permit.
 * Every test here is expected to PASS right now.
 *
 * Its purpose is to make the current ruleset's behaviour explicit and
 * reproducible BEFORE they are changed, so that hardening them in the next phase
 * is a deliberate, reviewable diff rather than a guess.
 *
 * ======================== WHEN THIS FILE TURNS RED ========================
 * This file is EXPECTED TO GO RED once storage.rules is hardened. That is the
 * signal that a rule changed, not a regression: each of those assertions pins a
 * permission that must be revoked (cross-gym access, trainer writes, public logo
 * reads, unbounded uploads). When that happens, DELETE the assertion that
 * described the old behaviour and let the corresponding assertion in
 * storageSecurityEmulator.test.js go green. Never leave both describing the same
 * request.
 *
 * ======================== PHASE 3A TRANSITION LOG ==========================
 * storage.rules was hardened in Phase 3A. As predicted above, this file went
 * red. It is DELIBERATELY KEPT RED as the historical record of the
 * pre-hardening ruleset. No assertion here has been weakened, deleted or
 * re-pointed, because the value of this file is that it records exactly what
 * the old rules permitted.
 *
 * Verified red after Phase 3A: 32 of 50. The 32 are precisely the permissions
 * that were intentionally revoked, and each maps to a green assertion in
 * storageSecurityEmulator.test.js or storageScopedEmulator.test.js:
 *
 *   CHAR-1.1-1.5   (5) any authenticated user read/download/write/delete any
 *                       member photo, trainer included
 *                 -> SC-S1.* (same-gym allowed), SC-S4.1-4.3 (trainer + delete
 *                    denied), SC-S6.1-6.4 (legacy paths revoked)
 *   CHAR-2.1-2.5   (5) world-readable logos, any authenticated write/delete
 *                 -> SC-S4.4-4.10, SC-S5.10, SC-S6.5-6.7
 *   CHAR-3.1-3.10 (10) cross-gym read/write/delete across both namespaces
 *                 -> SC-S2.1-2.13
 *   CHAR-4.1-4.5   (5) ghost / unbound / blank-gymId identities served
 *                 -> SC-S5.1-5.9
 *   CHAR-5.1-5.5   (5) unbounded uploads: 6 MB, HTML, PDF, caller-set extension
 *                 -> SC-S8.1-8.11
 *   CHAR-6.5-6.6   (2) "the gym-scoped path does not resolve"
 *                 -> SC-S1.7 (it now resolves, and is the only shape allowed)
 *
 * Still green (18), and required to stay green: CHAR-1.6-1.8 and CHAR-2.6-2.7
 * (unauthenticated denial), CHAR-6.1-6.4 (nested / unknown / traversal shapes),
 * CHAR-7.1-7.9 (backups denied to every identity, and no root listing).
 * ========================================================================
 *
 * Architecture mirrors tests.emulator/firestoreSecurityEmulator.test.js:
 *   - rules read from storage.rules (and firestore.rules) at runtime
 *   - one initializeTestEnvironment per suite, seeded in beforeAll inside
 *     withSecurityRulesDisabled, torn down with env.cleanup() in afterAll
 *   - never calls clearStorage() / clearFirestore(); every id is `char-`-prefixed
 *     so this file cannot disturb the other storage suite (they run sequentially
 *     against one emulator)
 *   - every mutating test seeds its OWN victim, so an allowed mutation cannot
 *     make a later test fail as object-not-found instead of as a rule decision
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

const GYM_A = 'char-gym-a'
const GYM_B = 'char-gym-b'

const A = {
  owner: 'char-owner-a',
  admin: 'char-admin-a',
  frontDesk: 'char-front-desk-a',
  trainer: 'char-trainer-a',
}
const B = {
  owner: 'char-owner-b',
  admin: 'char-admin-b',
}

const GHOST = 'char-ghost-no-profile'
const UNBOUND = 'char-unbound-no-gymid'
const EMPTY_GYM = 'char-emptygym-blank-gymid'

const M_A = 'char-member-a' // belongs to GYM_A
const M_B = 'char-member-b' // belongs to GYM_B
const M_MISSING = 'char-member-does-not-exist'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const OVERSIZE = new Uint8Array(6 * 1024 * 1024)

const photoPath = (memberId) => `memberPhotos/${memberId}`
const logoPath = (name) => `logos/${name}`
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

const asUser = (uid, path) => env.authenticatedContext(uid).storage().ref(path)
const asAnon = (path) => env.unauthenticatedContext().storage().ref(path)

async function seed(paths, data = PNG, contentType = 'image/png') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const p of paths) {
      await uploadBytes(ctx.storage().ref(p), data, { contentType })
    }
  })
}

// ===========================================================================
// CHAR-1 — memberPhotos/{memberId}: authenticated read, write and delete
// `allow read: if request.auth != null; allow write: if request.auth != null;`
// There is no gymId in the path and no role or ownership check.
// ===========================================================================
describe('CHAR-1 — current memberPhotos behaviour', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-1.1 — any authenticated user reads any member photo', async () => {
    const victim = photoPath('char-1-read')
    await seed([victim])
    await assertSucceeds(getMetadata(asUser(A.owner, victim)))
  })

  it('CHAR-1.2 — any authenticated user downloads any member photo', async () => {
    const victim = photoPath('char-1-download')
    await seed([victim])
    await assertSucceeds(getBytes(asUser(A.owner, victim)))
  })

  it('CHAR-1.3 — any authenticated user overwrites any member photo', async () => {
    const victim = photoPath('char-1-write')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(A.owner, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-1.4 — any authenticated user deletes any member photo', async () => {
    // The app never deletes a photo from the client, but `allow write` covers
    // delete, so the capability is live today.
    const victim = photoPath('char-1-delete')
    await seed([victim])
    await assertSucceeds(deleteObject(asUser(A.owner, victim)))
  })

  it('CHAR-1.5 — a trainer with no members.write overwrites a member photo', async () => {
    const victim = photoPath('char-1-trainer')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(A.trainer, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-1.6 — unauthenticated read of a member photo is denied', async () => {
    const victim = photoPath('char-1-anon-read')
    await seed([victim])
    await assertFails(getMetadata(asAnon(victim)))
  })

  it('CHAR-1.7 — unauthenticated write of a member photo is denied', async () => {
    await assertFails(uploadBytes(asAnon(photoPath('char-1-anon-write')), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-1.8 — unauthenticated delete of a member photo is denied', async () => {
    const victim = photoPath('char-1-anon-delete')
    await seed([victim])
    await assertFails(deleteObject(asAnon(victim)))
  })
})

// ===========================================================================
// CHAR-2 — logos/{name}: world-readable, authenticated write
// `allow read: if true; allow write: if request.auth != null;`
// ===========================================================================
describe('CHAR-2 — current logos behaviour', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-2.1 — an unauthenticated visitor reads a gym logo', async () => {
    const victim = logoPath('char-2-anon-read.png')
    await seed([victim])
    await assertSucceeds(getMetadata(asAnon(victim)))
  })

  it('CHAR-2.2 — an unauthenticated visitor downloads a gym logo', async () => {
    const victim = logoPath('char-2-anon-download.png')
    await seed([victim])
    await assertSucceeds(getBytes(asAnon(victim)))
  })

  it('CHAR-2.3 — an unauthenticated visitor obtains a download URL for a gym logo', async () => {
    // This is the URL shape stored in settings.app.logoUrl and rendered on every
    // printed receipt (ReceiptModal.jsx:16).
    const victim = logoPath('char-2-anon-url.png')
    await seed([victim])
    await assertSucceeds(getDownloadURL(asAnon(victim)))
  })

  it('CHAR-2.4 — an authenticated user overwrites a gym logo', async () => {
    const victim = logoPath('char-2-write.png')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(A.owner, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-2.5 — an authenticated user deletes a gym logo', async () => {
    const victim = logoPath('char-2-delete.png')
    await seed([victim])
    await assertSucceeds(deleteObject(asUser(A.owner, victim)))
  })

  it('CHAR-2.6 — an unauthenticated visitor cannot write a gym logo', async () => {
    await assertFails(uploadBytes(asAnon(logoPath('char-2-anon-write.png')), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-2.7 — an unauthenticated visitor cannot delete a gym logo', async () => {
    const victim = logoPath('char-2-anon-delete.png')
    await seed([victim])
    await assertFails(deleteObject(asAnon(victim)))
  })
})

// ===========================================================================
// CHAR-3 — CROSS-GYM ACCESS IS CURRENTLY PERMITTED
// The headline finding: storage.rules carries no gym dimension, so one gym's
// staff can read, overwrite and delete another gym's media.
// ===========================================================================
describe('CHAR-3 — cross-gym access is currently permitted', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${B.admin}`).set({ role: 'admin', gymId: GYM_B })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
      await fs.doc(`members/${M_B}`).set({ name: 'Member B', gymId: GYM_B })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-3.1 — gym B owner reads gym A’s member photo', async () => {
    const victim = photoPath('char-3-gym-a-photo')
    await seed([victim])
    await assertSucceeds(getMetadata(asUser(B.owner, victim)))
  })

  it('CHAR-3.2 — gym B owner overwrites gym A’s member photo', async () => {
    const victim = photoPath('char-3-gym-a-write')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(B.owner, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-3.3 — gym B owner deletes gym A’s member photo', async () => {
    const victim = photoPath('char-3-gym-a-delete')
    await seed([victim])
    await assertSucceeds(deleteObject(asUser(B.owner, victim)))
  })

  it('CHAR-3.4 — gym A owner reads gym B’s member photo', async () => {
    const victim = photoPath('char-3-gym-b-photo')
    await seed([victim])
    await assertSucceeds(getMetadata(asUser(A.owner, victim)))
  })

  it('CHAR-3.5 — gym B owner reads gym A’s logo', async () => {
    const victim = logoPath('char-3-gym-a-logo.png')
    await seed([victim])
    await assertSucceeds(getMetadata(asUser(B.owner, victim)))
  })

  it('CHAR-3.6 — gym B owner overwrites gym A’s logo', async () => {
    const victim = logoPath('char-3-gym-a-logo-write.png')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(B.owner, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-3.7 — gym B admin overwrites gym A’s logo', async () => {
    // settings.write is ['owner'] in the app; Storage does not care.
    const victim = logoPath('char-3-gym-a-logo-admin.png')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(B.admin, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-3.8 — gym B owner deletes gym A’s logo', async () => {
    const victim = logoPath('char-3-gym-a-logo-delete.png')
    await seed([victim])
    await assertSucceeds(deleteObject(asUser(B.owner, victim)))
  })

  it('CHAR-3.9 — a gym B owner writes a photo into gym A’s member namespace', async () => {
    await assertSucceeds(uploadBytes(asUser(B.owner, photoPath(M_A)), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-3.10 — a photo can be written for a member document that does not exist', async () => {
    await assertSucceeds(uploadBytes(asUser(A.owner, photoPath(M_MISSING)), PNG, { contentType: 'image/png' }))
  })
})

// ===========================================================================
// CHAR-4 — IDENTITIES WITH NO TENANCY CONTEXT ARE CURRENTLY SERVED
// ===========================================================================
describe('CHAR-4 — absent or unusable tenancy context is currently served', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' }) // no gymId
      await fs.doc(`users/${EMPTY_GYM}`).set({ role: 'admin', gymId: '' }) // blank gymId
      // GHOST is deliberately never written.
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    })
    await seed([photoPath(M_A)])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-4.1 — a user with no users/{uid} profile reads a member photo', async () => {
    await assertSucceeds(getMetadata(asUser(GHOST, photoPath(M_A))))
  })

  it('CHAR-4.2 — a user with no users/{uid} profile overwrites a member photo', async () => {
    const victim = photoPath('char-4-ghost-write')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(GHOST, victim), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-4.3 — a profile with no gymId reads a member photo', async () => {
    await assertSucceeds(getMetadata(asUser(UNBOUND, photoPath(M_A))))
  })

  it('CHAR-4.4 — a profile with an empty-string gymId reads a member photo', async () => {
    await assertSucceeds(getMetadata(asUser(EMPTY_GYM, photoPath(M_A))))
  })

  it('CHAR-4.5 — a profile with an empty-string gymId overwrites a member photo', async () => {
    const victim = photoPath('char-4-empty-write')
    await seed([victim])
    await assertSucceeds(uploadBytes(asUser(EMPTY_GYM, victim), PNG, { contentType: 'image/png' }))
  })
})

// ===========================================================================
// CHAR-5 — UPLOADS ARE CURRENTLY UNBOUNDED
// No size cap, no content-type allowlist, and a logo extension taken from the
// user's own filename.
// ===========================================================================
describe('CHAR-5 — uploads are currently unbounded', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-5.1 — a 6 MB member photo is accepted', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, photoPath('char-5-oversize')), OVERSIZE, { contentType: 'image/png' }),
    )
  })

  it('CHAR-5.2 — a 6 MB gym logo is accepted', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, logoPath('char-5-oversize.png')), OVERSIZE, { contentType: 'image/png' }),
    )
  })

  it('CHAR-5.3 — an HTML payload is accepted as a member photo', async () => {
    await assertSucceeds(
      uploadBytes(
        asUser(A.owner, photoPath('char-5-html')),
        new TextEncoder().encode('<script>alert(1)</script>'),
        { contentType: 'text/html' },
      ),
    )
  })

  it('CHAR-5.4 — an HTML payload is accepted as a publicly readable gym logo', async () => {
    const victim = logoPath('char-5-logo.html')
    await assertSucceeds(
      uploadBytes(asUser(A.owner, victim), new TextEncoder().encode('<script>alert(1)</script>'), {
        contentType: 'text/html',
      }),
    )
    // ...and it is then readable with no authentication at all.
    await assertSucceeds(getMetadata(asAnon(victim)))
  })

  it('CHAR-5.5 — a PDF is accepted as a member photo', async () => {
    await assertSucceeds(
      uploadBytes(asUser(A.owner, photoPath('char-5-pdf')), new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        contentType: 'application/pdf',
      }),
    )
  })
})

// ===========================================================================
// CHAR-6 — PATHS THAT ARE ALREADY DENIED
// Firebase Storage denies anything that matches no `allow`, and both published
// prefixes bind exactly ONE path segment. These denials are correct today and
// must survive hardening unchanged.
// ===========================================================================
describe('CHAR-6 — currently denied path shapes', () => {
  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`members/${M_A}`).set({ name: 'Member A', gymId: GYM_A })
    })
    await seed([`${photoPath(M_A)}/nested`, `${logoPath('char-6-nested.png')}/nested`])
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-6.1 — a nested path under memberPhotos is denied', async () => {
    await assertFails(getMetadata(asUser(A.owner, `${photoPath(M_A)}/nested`)))
  })

  it('CHAR-6.2 — a nested path under logos is denied', async () => {
    await assertFails(getMetadata(asUser(A.owner, `${logoPath('char-6-nested.png')}/nested`)))
  })

  it('CHAR-6.3 — an unknown prefix is denied', async () => {
    await assertFails(uploadBytes(asUser(A.owner, 'char-anything/whatever.png'), PNG, { contentType: 'image/png' }))
  })

  it('CHAR-6.4 — a traversal segment cannot escape the memberPhotos prefix', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, 'memberPhotos/../logos/char-6-traversal.png'), PNG, { contentType: 'image/png' }),
    )
  })

  // Why the client upload paths must not be re-keyed before the rules change.
  it('CHAR-6.5 — the target gym-scoped photo path does not resolve', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, scopedPhotoPath(GYM_A, M_A, 'photo.png')), PNG, { contentType: 'image/png' }),
    )
  })

  it('CHAR-6.6 — the target gym-scoped logo path does not resolve', async () => {
    await assertFails(uploadBytes(asUser(A.owner, scopedLogoPath(GYM_A, 'logo.png')), PNG, { contentType: 'image/png' }))
  })
})

// ===========================================================================
// CHAR-7 — backups/** IS DENIED TO EVERY CLIENT IDENTITY
// Correct today and must stay correct. The real control is the identity's IAM
// policy (the Admin SDK bypasses rules by design); this deny is defence in depth.
// ===========================================================================
describe('CHAR-7 — backups are denied to every client identity', () => {
  const BACKUP = 'backups/char-date/members.json'

  beforeAll(async () => {
    env = await makeEnv()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
    })
    await seed([BACKUP], new TextEncoder().encode('{"members":[]}'), 'application/json')
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('CHAR-7.1 — unauthenticated read of a backup is denied', async () => {
    await assertFails(getMetadata(asAnon(BACKUP)))
  })

  it('CHAR-7.2 — unauthenticated write of a backup is denied', async () => {
    await assertFails(
      uploadBytes(asAnon('backups/char-date/anon.json'), new Uint8Array([1]), { contentType: 'application/json' }),
    )
  })

  it('CHAR-7.3 — owner cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.owner, BACKUP)))
  })

  it('CHAR-7.4 — admin cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.admin, BACKUP)))
  })

  it('CHAR-7.5 — front-desk cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.frontDesk, BACKUP)))
  })

  it('CHAR-7.6 — trainer cannot read a backup', async () => {
    await assertFails(getMetadata(asUser(A.trainer, BACKUP)))
  })

  it('CHAR-7.7 — owner cannot overwrite a backup', async () => {
    await assertFails(
      uploadBytes(asUser(A.owner, 'backups/char-date/owner.json'), new Uint8Array([1]), {
        contentType: 'application/json',
      }),
    )
  })

  it('CHAR-7.8 — owner cannot delete a backup', async () => {
    await assertFails(deleteObject(asUser(A.owner, BACKUP)))
  })

  it('CHAR-7.9 — no application role can list the bucket root', async () => {
    // Even an owner: there is no client-facing path to enumerate the repository.
    await assertFails(listAll(asUser(A.owner, '/')))
  })
})