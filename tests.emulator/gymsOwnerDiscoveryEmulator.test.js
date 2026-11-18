/**
 * OWNER-OF-RECORD DISCOVERY — the query the APPLICATION runs at first sign-in.
 *
 * Every other gyms/ test in this repository seeds the collection with the Admin
 * SDK (`withSecurityRulesDisabled` -> `doc('gyms/GYM_A').set(...)`) and reads it
 * back BY ID. That is a `get`, and a `get` passed even while a single `read`
 * rule carrying `resource != null` was denying the collection QUERY the app
 * actually issues:
 *
 *   src/context/AuthContext.jsx -> discoverOwnGym()
 *     getDocs(query(collection(db, 'gyms'), where('ownerUid', '==', uid)))
 *
 * Consequences of that gap: a pre-provisioned owner signed in, the discovery
 * query was denied, the bootstrap catch treated the failure as "no gym yet" and
 * offered onboarding — where accepting writes a SECOND, empty gym and orphans
 * the provisioned one. The suite stayed green because no test ran a query.
 *
 * These tests run the real query as the real caller would. They fail against
 * the pre-fix `allow read` rule and pass against the split
 * `allow get` / `allow list` rules in firestore.rules.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'disc-gym-a'
const OWNER_A = 'disc-owner-a'
const GYM_B = 'disc-gym-b'
const OWNER_B = 'disc-owner-b'
// A brand-new authenticated account: no users/{uid} profile, no gym.
const NEWCOMER = 'disc-newcomer'

/** Exactly the query `discoverOwnGym()` issues. */
const discoveryQuery = (fs, uid) =>
  getDocs(query(collection(fs, 'gyms'), where('ownerUid', '==', uid)))

describe('DISC owner-of-record discovery query', () => {
  let env

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: OWNER_A, name: 'Gym A', receiptPrefix: 'GYMA' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: OWNER_B, name: 'Gym B', receiptPrefix: 'GYMB' })
    })
  })

  afterAll(async () => env.cleanup())

  const client = (uid) => env.authenticatedContext(uid).firestore()

  it('the app discovery query returns the caller\u2019s own provisioned gym', async () => {
    const snap = await assertSucceeds(discoveryQuery(client(OWNER_A), OWNER_A))
    expect(snap.docs.map((d) => d.id)).toEqual([GYM_A])
    expect(snap.docs[0].data().ownerUid).toBe(OWNER_A)
  })

  it('a newcomer with no gym gets an empty result, not a denial', async () => {
    // This is the "fresh signup" path: the query must succeed and return
    // nothing so onboarding can be offered for the right reason.
    const snap = await assertSucceeds(discoveryQuery(client(NEWCOMER), NEWCOMER))
    expect(snap.empty).toBe(true)
  })

  it('discovery is not an existence oracle: another owner\u2019s uid is denied', async () => {
    await assertFails(discoveryQuery(client(OWNER_A), OWNER_B))
  })

  it('an unconstrained gyms list is denied (rules are not filters)', async () => {
    await assertFails(getDocs(collection(client(OWNER_A), 'gyms')))
  })

  it('a signed-out caller cannot run discovery', async () => {
    const anon = env.unauthenticatedContext().firestore()
    await assertFails(discoveryQuery(anon, OWNER_A))
  })

  it('a point read of the gym the caller owns still works (get is unchanged)', async () => {
    const snap = await assertSucceeds(getDoc(doc(client(OWNER_A), 'gyms', GYM_A)))
    expect(snap.data().name).toBe('Gym A')
  })

  it('a point read of a foreign gym is still denied', async () => {
    await assertFails(getDoc(doc(client(OWNER_A), 'gyms', GYM_B)))
  })
})
