/**
 * MEMBER PHOTOS — RULES, NOT JUST THE CLIENT
 *
 * Photos moved from Cloud Storage to Firestore documents because Storage needs
 * a billing plan this project does not have. A new collection means a new
 * boundary, and the client checks are UX only: the rules are what stop one gym
 * reading another gym's members' faces, and what stop a dead upload endpoint
 * being used as free storage for arbitrary content.
 *
 * These tests drive the real ruleset through the emulator:
 *
 *   - same-gym staff read; a foreign gym does not
 *   - owner / admin / front-desk write; a trainer does not
 *   - the member document, not the photo document, proves tenancy
 *   - a document over the 300 KB cap, or with an unexpected key, is refused
 *   - an anonymous caller gets nothing
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'photo-gym-a'
const GYM_B = 'photo-gym-b'

const OWNER_A = 'photo-owner-a'
const ADMIN_A = 'photo-admin-a'
const DESK_A = 'photo-desk-a'
const TRAINER_A = 'photo-trainer-a'
const OWNER_B = 'photo-owner-b'

const MEMBER_A = 'photo-member-a'
const MEMBER_A2 = 'photo-member-a2'
const MEMBER_A3 = 'photo-member-a3'
const MEMBER_B = 'photo-member-b'

const DATA = 'data:image/webp;base64,' + 'A'.repeat(2048)

/** The exact payload shape the client writes (src/services/photoStore.js). */
const photoPayload = (gymId, data = DATA) => ({
  gymId,
  data,
  contentType: 'image/webp',
  width: 320,
  height: 240,
  updatedAt: serverTimestamp(),
  updatedBy: 'seed',
})

describe('memberPhotos rules', () => {
  let env

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })

    await env.withSecurityRulesDisabled(async (context) => {
      const fs = context.firestore()
      const users = [
        [OWNER_A, GYM_A, 'owner'],
        [ADMIN_A, GYM_A, 'admin'],
        [DESK_A, GYM_A, 'front-desk'],
        [TRAINER_A, GYM_A, 'trainer'],
        [OWNER_B, GYM_B, 'owner'],
      ]
      for (const [uid, gymId, role] of users) {
        await fs.doc(`users/${uid}`).set({ gymId, role, name: uid })
      }
      await fs.doc(`members/${MEMBER_A}`).set({ gymId: GYM_A, name: 'Member A' })
      await fs.doc(`members/${MEMBER_A2}`).set({ gymId: GYM_A, name: 'Member A2' })
      await fs.doc(`members/${MEMBER_A3}`).set({ gymId: GYM_A, name: 'Member A3' })
      await fs.doc(`members/${MEMBER_B}`).set({ gymId: GYM_B, name: 'Member B' })
      await fs.doc(`memberPhotos/${MEMBER_A}`).set(photoPayload(GYM_A))
      await fs.doc(`memberPhotos/${MEMBER_A2}`).set(photoPayload(GYM_A))
    })
  })

  afterAll(async () => env.cleanup())

  const client = (uid) => env.authenticatedContext(uid).firestore()
  const photoDoc = (fs, memberId) => doc(fs, 'memberPhotos', memberId)

  it('same-gym staff read a member photo', async () => {
    const snapshot = await assertSucceeds(getDoc(photoDoc(client(OWNER_A), MEMBER_A)))
    expect(snapshot.data().gymId).toBe(GYM_A)
  })

  it('a trainer can read but not replace a photo', async () => {
    await assertSucceeds(getDoc(photoDoc(client(TRAINER_A), MEMBER_A)))
    await assertFails(setDoc(photoDoc(client(TRAINER_A), MEMBER_A), photoPayload(GYM_A)))
  })

  it('owner, admin and front-desk can write', async () => {
    for (const uid of [OWNER_A, ADMIN_A, DESK_A]) {
      await assertSucceeds(setDoc(photoDoc(client(uid), MEMBER_A), photoPayload(GYM_A)))
    }
  })

  it('another gym cannot read the photo', async () => {
    await assertFails(getDoc(photoDoc(client(OWNER_B), MEMBER_A)))
  })

  it('another gym cannot write over the photo', async () => {
    await assertFails(setDoc(photoDoc(client(OWNER_B), MEMBER_A), photoPayload(GYM_B)))
  })

  // The tenancy boundary is the MEMBER document: a photo document that claims
  // the caller's gym still cannot attach to a member of a different gym.
  it('refuses a photo whose member belongs to another gym', async () => {
    await assertFails(setDoc(photoDoc(client(OWNER_A), MEMBER_B), photoPayload(GYM_A)))
  })

  // A caller cannot smuggle its own gym id onto a record it does not own.
  it('refuses a gymId that is not the caller profile gym', async () => {
    await assertFails(setDoc(photoDoc(client(OWNER_A), MEMBER_A), photoPayload(GYM_B)))
  })

  it('refuses a document over the 300 KB cap', async () => {
    const oversize = 'data:image/webp;base64,' + 'A'.repeat(400 * 1024)
    await assertFails(setDoc(photoDoc(client(OWNER_A), MEMBER_A), photoPayload(GYM_A, oversize)))
  })

  it('refuses a payload with keys outside the allowlist', async () => {
    await assertFails(
      setDoc(photoDoc(client(OWNER_A), MEMBER_A), {
        ...photoPayload(GYM_A),
        injected: 'value',
      })
    )
  })

  it('refuses a contentType the client never produces', async () => {
    await assertFails(
      setDoc(photoDoc(client(OWNER_A), MEMBER_A), {
        ...photoPayload(GYM_A),
        contentType: 'text/html',
      })
    )
  })

  it('front-desk cannot delete a photo; an owner can', async () => {
    await assertFails(deleteDoc(photoDoc(client(DESK_A), MEMBER_A2)))
    await assertSucceeds(deleteDoc(photoDoc(client(OWNER_A), MEMBER_A2)))
  })

  it('an anonymous caller gets nothing', async () => {
    const anon = env.unauthenticatedContext().firestore()
    await assertFails(getDoc(photoDoc(anon, MEMBER_A)))
    await assertFails(setDoc(photoDoc(anon, MEMBER_A), photoPayload(GYM_A)))
  })

  // The client writes the bytes and the member's `hasPhoto` flag in ONE commit
  // (src/services/photoStore.js), because that flag is what stops a members page
  // paying a read for every row that has no photo. Both writes must be legal for
  // the same role, or the whole upload fails.
  it('front-desk can write the photo and the member flag in one batch', async () => {
    const fs = client(DESK_A)
    const batch = writeBatch(fs)
    batch.set(photoDoc(fs, MEMBER_A), photoPayload(GYM_A))
    batch.update(doc(fs, 'members', MEMBER_A), {
      hasPhoto: true,
      photoUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    await assertSucceeds(batch.commit())

    const stored = await assertSucceeds(getDoc(doc(fs, 'members', MEMBER_A)))
    expect(stored.data().hasPhoto).toBe(true)
    expect(stored.data().gymId).toBe(GYM_A)
  })

  // The flag lives on the member document, so a member write that REPLACED the
  // document would silently erase it and every list would stop showing avatars.
  // Every member write in the app is a partial update (src/services/firestore.js
  // -> updateDoc), and this pins what that buys: the form-shaped edit that
  // Members.jsx / MemberDetail.jsx send leaves the flag alone.
  it('a member edit keeps the photo flag', async () => {
    const fs = client(DESK_A)
    const upload = writeBatch(fs)
    upload.set(photoDoc(fs, MEMBER_A), photoPayload(GYM_A))
    upload.update(doc(fs, 'members', MEMBER_A), {
      hasPhoto: true,
      photoUpdatedAt: serverTimestamp(),
    })
    await assertSucceeds(upload.commit())

    await assertSucceeds(
      updateDoc(doc(fs, 'members', MEMBER_A), {
        name: 'Member A renamed',
        phone: '9800000000',
        searchName: 'member a renamed',
        updatedAt: serverTimestamp(),
      })
    )

    const after = await assertSucceeds(getDoc(doc(fs, 'members', MEMBER_A)))
    expect(after.data().hasPhoto).toBe(true)
    expect(after.data().name).toBe('Member A renamed')
  })

  // Negative control for the test above: a full overwrite really does drop the
  // flag, so that assertion is not vacuous — the app's partial update is the
  // reason avatars survive an edit.
  it('a full overwrite would drop the photo flag', async () => {
    const fs = client(OWNER_A)
    const upload = writeBatch(fs)
    upload.set(photoDoc(fs, MEMBER_A3), photoPayload(GYM_A))
    upload.update(doc(fs, 'members', MEMBER_A3), { hasPhoto: true })
    await assertSucceeds(upload.commit())

    await assertSucceeds(
      setDoc(doc(fs, 'members', MEMBER_A3), { gymId: GYM_A, name: 'Member A3' })
    )

    const after = await assertSucceeds(getDoc(doc(fs, 'members', MEMBER_A3)))
    expect(after.data().hasPhoto).toBeUndefined()
  })

  // A role that may not write members cannot use the flag as a side channel, and
  // the batch is all-or-nothing: no photo is left behind either.
  it('a trainer cannot mark a member as having a photo', async () => {
    const fs = client(TRAINER_A)
    const batch = writeBatch(fs)
    batch.set(photoDoc(fs, MEMBER_A3), photoPayload(GYM_A))
    batch.update(doc(fs, 'members', MEMBER_A3), { hasPhoto: true })

    await assertFails(batch.commit())

    const owner = client(OWNER_A)
    const member = await assertSucceeds(getDoc(doc(owner, 'members', MEMBER_A3)))
    expect(member.data().hasPhoto).toBeUndefined()
  })
})
