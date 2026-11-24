/**
 * Leads rules — the walk-in enquiry diary.
 *
 * What this file locks down:
 *   - staff (owner, admin, front desk, trainer) can record and update a lead
 *     inside their own gym;
 *   - a lead in another gym is invisible and unwritable, on read and on write;
 *   - a lead cannot be created with a foreign gymId, an empty name, or an
 *     invented status;
 *   - deleting is admin/owner only, so the person who dropped the ball cannot
 *     erase the evidence;
 *   - anonymous callers get nothing.
 *
 * Ids are `ld-` prefixed and gyms are unique because the emulator database is
 * shared with the other suites (see vitest.emulator.js).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { addDoc, collection, deleteDoc, doc, getDoc, updateDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'ld-gym-a'
const GYM_B = 'ld-gym-b'

const UID = {
  owner: 'ld-owner',
  frontDesk: 'ld-frontdesk',
  trainer: 'ld-trainer',
  otherOwner: 'ld-owner-b',
  noGym: 'ld-no-gym',
}

let env

const tenantDoc = (gymId, extra = {}) => ({ gymId, ...extra })

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: UID.owner, name: 'Leads Gym A' })
    await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: UID.otherOwner, name: 'Leads Gym B' })
    await fs.doc(`users/${UID.owner}`).set({ role: 'owner', gymId: GYM_A })
    await fs.doc(`users/${UID.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
    await fs.doc(`users/${UID.trainer}`).set({ role: 'trainer', gymId: GYM_A })
    await fs.doc(`users/${UID.otherOwner}`).set({ role: 'owner', gymId: GYM_B })
    await fs.doc(`users/${UID.noGym}`).set({ role: 'front-desk' })

    await fs.doc('leads/ld-open-a').set(
      tenantDoc(GYM_A, { name: 'Walk-in A', phone: '9800000001', status: 'new', followUpDate: '2026-03-02' })
    )
    await fs.doc('leads/ld-open-b').set(
      tenantDoc(GYM_B, { name: 'Walk-in B', phone: '9800000002', status: 'new' })
    )
    await fs.doc('leads/ld-delete-a').set(
      tenantDoc(GYM_A, { name: 'Deletable A', phone: '9800000003', status: 'lost' })
    )
  })
}

function db(uid) {
  return uid
    ? env.authenticatedContext(uid).firestore()
    : env.unauthenticatedContext().firestore()
}

describe('leads rules', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await seed()
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('lets every staff role read a lead in its own gym', async () => {
    for (const uid of [UID.owner, UID.frontDesk, UID.trainer]) {
      const snap = await assertSucceeds(getDoc(doc(db(uid), 'leads/ld-open-a')))
      expect(snap.data().name).toBe('Walk-in A')
    }
  })

  it('denies reading another gym lead, and anonymous reads', async () => {
    await assertFails(getDoc(doc(db(UID.owner), 'leads/ld-open-b')))
    await assertFails(getDoc(doc(db(UID.otherOwner), 'leads/ld-open-a')))
    await assertFails(getDoc(doc(db(null), 'leads/ld-open-a')))
  })

  it('lets the front desk record a walk-in lead in its own gym', async () => {
    await assertSucceeds(
      addDoc(
        collection(db(UID.frontDesk), 'leads'),
        tenantDoc(GYM_A, {
          name: 'New Walk-in',
          phone: '9800000004',
          status: 'new',
          source: 'Walk-in',
        })
      )
    )
  })

  it('rejects a lead with no name or an invented status', async () => {
    await assertFails(
      addDoc(collection(db(UID.frontDesk), 'leads'), tenantDoc(GYM_A, { status: 'new' }))
    )
    await assertFails(
      addDoc(collection(db(UID.frontDesk), 'leads'), tenantDoc(GYM_A, { name: '', status: 'new' }))
    )
    await assertFails(
      addDoc(
        collection(db(UID.frontDesk), 'leads'),
        tenantDoc(GYM_A, { name: 'Bad Status', status: 'hired' })
      )
    )
  })

  it('rejects a lead tagged with another gym', async () => {
    await assertFails(
      addDoc(
        collection(db(UID.owner), 'leads'),
        tenantDoc(GYM_B, { name: 'Foreign', phone: '9800000005', status: 'new' })
      )
    )
    // A caller with no bound gym cannot create one either.
    await assertFails(
      addDoc(collection(db(UID.noGym), 'leads'), { name: 'No Gym', status: 'new' })
    )
  })

  it('lets staff update a lead, including a partial status change', async () => {
    await assertSucceeds(
      updateDoc(doc(db(UID.frontDesk), 'leads/ld-open-a'), { status: 'contacted' })
    )
    await assertSucceeds(
      updateDoc(doc(db(UID.owner), 'leads/ld-open-a'), { followUpDate: '2026-03-15', notes: 'called' })
    )
    await assertFails(
      updateDoc(doc(db(UID.frontDesk), 'leads/ld-open-a'), { status: 'hired' })
    )
    await assertFails(updateDoc(doc(db(UID.owner), 'leads/ld-open-b'), { notes: 'foreign' }))
  })

  it('keeps deletes with admin/owner inside the gym', async () => {
    await assertFails(deleteDoc(doc(db(UID.frontDesk), 'leads/ld-delete-a')))
    await assertFails(deleteDoc(doc(db(UID.trainer), 'leads/ld-delete-a')))
    await assertSucceeds(deleteDoc(doc(db(UID.owner), 'leads/ld-delete-a')))
    await assertFails(deleteDoc(doc(db(UID.owner), 'leads/ld-open-b')))
  })
})
