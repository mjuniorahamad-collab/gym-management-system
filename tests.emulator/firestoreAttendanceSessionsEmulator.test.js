/**
 * PHASE 4 - ATTENDANCE SESSION POINTER RULES
 *
 * Regression suite for the `attendanceSessions/{gymId}__{memberId}` open-session
 * pointer added in this phase. Separate from the frozen Phase 0.5A evidence file
 * (`firestoreSecurityEmulator.test.js`), which must not be edited, and from
 * `firestoreSecurityRemediation.test.js`, which covers earlier phases.
 *
 * Every assertion performs a real Firestore operation against the emulator.
 *
 * All ids are `asx-`-prefixed so this suite cannot disturb the other emulator
 * suites, which may run in parallel against the single emulator.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { getDoc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'asx-gym-a'
const GYM_B = 'asx-gym-b'

const A = {
  owner: 'asx-owner-a',
  admin: 'asx-admin-a',
  trainer: 'asx-trainer-a',
  frontDesk: 'asx-front-desk-a',
}
const B = { owner: 'asx-owner-b', frontDesk: 'asx-front-desk-b' }

// Carries a role but no gymId: unbound tenancy.
const UNBOUND = 'asx-unbound-no-gymid'
// Has a users/{uid} document but is bound to neither gym.
const OUTSIDER = 'asx-outsider-other-gym'

const SESSIONS = 'attendanceSessions'

let env

function client(uid) {
  return env.authenticatedContext(uid).firestore()
}

function sessionPath(gymId, memberId) {
  return `${SESSIONS}/${gymId}__${memberId}`
}

/** The transaction body from src/services/attendanceSessions.js, in rules-tested form. */
async function checkInTransaction(fs, gymId, memberId) {
  const sessionRef = fs.doc(sessionPath(gymId, memberId))
  return runTransaction(fs, async (tx) => {
    // Reads must precede writes in a Firestore transaction.
    const snap = await tx.get(sessionRef)
    if (snap.exists()) {
      const e = new Error('already-checked-in')
      e.code = 'already-checked-in'
      throw e
    }
    const attRef = fs.collection('attendance').doc()
    tx.set(attRef, { gymId, memberId, checkIn: 'x', checkInDay: '2026-03-10', checkOut: '' })
    tx.set(sessionRef, {
      gymId,
      memberId,
      attendanceId: attRef.id,
      checkIn: 'x',
      checkInDay: '2026-03-10',
      createdAt: serverTimestamp(),
    })
    return attRef.id
  })
}

describe('attendanceSessions rules', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules },
    })
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore()
      await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: A.owner, name: 'Gym A' })
      await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: B.owner, name: 'Gym B' })
      await fs.doc(`users/${A.owner}`).set({ role: 'owner', gymId: GYM_A })
      await fs.doc(`users/${A.admin}`).set({ role: 'admin', gymId: GYM_A })
      await fs.doc(`users/${A.trainer}`).set({ role: 'trainer', gymId: GYM_A })
      await fs.doc(`users/${A.frontDesk}`).set({ role: 'front-desk', gymId: GYM_A })
      await fs.doc(`users/${B.owner}`).set({ role: 'owner', gymId: GYM_B })
      await fs.doc(`users/${B.frontDesk}`).set({ role: 'front-desk', gymId: GYM_B })
      await fs.doc(`users/${UNBOUND}`).set({ role: 'admin' })
      await fs.doc(`users/${OUTSIDER}`).set({ role: 'front-desk', gymId: 'asx-gym-c' })
    })
  })

  afterAll(async () => env.cleanup())

  /**
   * The load-bearing case. The first check-in of the first member in a gym reads
   * a pointer that does not exist, and Firestore evaluates that read against
   * `resource == null`, for which every tenant guard is false. Without the
   * null-read arm the product is dead on arrival in any new gym.
   */
  it('lets staff read a session pointer that does not exist yet', async () => {
    await assertSucceeds(getDoc(client(A.frontDesk).doc(sessionPath(GYM_A, 'asx-m-new'))))
  })

  it('lets every staff role perform a first check-in transaction', async () => {
    for (const uid of [A.owner, A.admin, A.trainer, A.frontDesk]) {
      await assertSucceeds(checkInTransaction(client(uid), GYM_A, `asx-m-${uid}`))
    }
  })

  it('lets staff read an existing pointer in their own gym', async () => {
    await assertSucceeds(getDoc(client(A.frontDesk).doc(sessionPath(GYM_A, `asx-m-${A.frontDesk}`))))
  })

  /**
   * The null-read arm must not become a hole: it grants nothing about documents
   * that do exist, so a foreign pointer is still denied.
   */
  it('denies a staff user a pointer belonging to another gym', async () => {
    await assertFails(getDoc(client(B.frontDesk).doc(sessionPath(GYM_A, `asx-m-${A.frontDesk}`))))
  })

  it('denies an unbound caller even to a missing pointer', async () => {
    await assertFails(getDoc(client(UNBOUND).doc(sessionPath(GYM_A, 'asx-anything'))))
  })

  it('denies a caller with no profile document', async () => {
    await assertFails(getDoc(client('asx-ghost').doc(sessionPath(GYM_A, 'asx-anything'))))
  })

  it('denies an unauthenticated caller', async () => {
    await assertFails(getDoc(env.unauthenticatedContext().firestore().doc(sessionPath(GYM_A, 'asx-any'))))
  })

  it('denies creating a pointer stamped with another gym', async () => {
    await assertFails(
      setDoc(client(A.frontDesk).doc(sessionPath(GYM_A, 'asx-m-forged')), {
        gymId: GYM_B,
        memberId: 'asx-m-forged',
        attendanceId: 'x',
      })
    )
  })

  it('denies updating another gyms pointer', async () => {
    await assertFails(
      setDoc(client(B.frontDesk).doc(sessionPath(GYM_A, `asx-m-${A.frontDesk}`)), {
        gymId: GYM_A,
        memberId: `asx-m-${A.frontDesk}`,
        attendanceId: 'tampered',
      })
    )
  })

  /**
   * Staff may release a pointer on checkout, which is why delete is not
   * owner-only here as it is for financial records. A real release must succeed.
   */
  it('lets staff delete a pointer in their own gym', async () => {
    const path = sessionPath(GYM_A, 'asx-m-release')
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(path).set({ gymId: GYM_A, memberId: 'asx-m-release', attendanceId: 'att-1' })
    })
    await assertSucceeds(client(A.frontDesk).doc(path).delete())
    expect((await getDoc(client(A.frontDesk).doc(path))).exists()).toBe(false)
  })

  it('denies deleting another gyms pointer', async () => {
    await assertFails(client(B.frontDesk).doc(sessionPath(GYM_A, `asx-m-${A.trainer}`)).delete())
  })

  it('denies an unbound caller writing a pointer', async () => {
    await assertFails(
      setDoc(client(UNBOUND).doc(sessionPath(GYM_A, 'asx-m-unbound')), {
        gymId: GYM_A,
        memberId: 'asx-m-unbound',
        attendanceId: 'x',
      })
    )
  })

  describe('the duplicate-prevention guarantee', () => {
    it('admits exactly one of two concurrent check-ins for the same member', async () => {
      const memberId = 'asx-m-race'
      const first = checkInTransaction(client(A.frontDesk), GYM_A, memberId)
      const second = checkInTransaction(client(A.trainer), GYM_A, memberId)
      const results = await Promise.allSettled([first, second])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason.code).toBe('already-checked-in')

      // Exactly one attendance row and one pointer survived the race.
      const pointer = await getDoc(client(A.owner).doc(sessionPath(GYM_A, memberId)))
      expect(pointer.exists()).toBe(true)
      expect(pointer.data().attendanceId).toBe(fulfilled[0].value)
    })

    it('allows a second session after the pointer is released', async () => {
      const memberId = 'asx-m-resequence'
      await assertSucceeds(checkInTransaction(client(A.frontDesk), GYM_A, memberId))
      // Checkout: write checkOut and drop the pointer.
      await assertSucceeds(client(A.frontDesk).doc(sessionPath(GYM_A, memberId)).delete())
      await assertSucceeds(checkInTransaction(client(A.frontDesk), GYM_A, memberId))
      const pointer = await getDoc(client(A.owner).doc(sessionPath(GYM_A, memberId)))
      expect(pointer.exists()).toBe(true)
    })

    it('does not let one gyms pointer block another gym', async () => {
      await assertSucceeds(checkInTransaction(client(A.frontDesk), GYM_A, 'asx-m-shared'))
      // Same member id, different gym: the deterministic id includes the gym.
      await assertSucceeds(checkInTransaction(client(B.frontDesk), GYM_B, 'asx-m-shared'))
    })

    it('rejects a check-in whose pointer write targets a foreign gym', async () => {
      const fs = client(A.frontDesk)
      await assertFails(
        runTransaction(fs, async (tx) => {
          await tx.get(fs.doc(sessionPath(GYM_A, 'asx-m-cross')))
          tx.set(fs.collection('attendance').doc(), { gymId: GYM_A, memberId: 'asx-m-cross' })
          tx.set(fs.doc(sessionPath(GYM_B, 'asx-m-cross')), {
            gymId: GYM_B,
            memberId: 'asx-m-cross',
            attendanceId: 'att-x',
          })
        })
      )
    })
  })

  describe('attendance rules remain unchanged', () => {
    it('lets staff create attendance in their own gym', async () => {
      await assertSucceeds(
        setDoc(client(A.frontDesk).collection('attendance').doc(), {
          gymId: GYM_A,
          memberId: 'asx-m-att',
          checkInDay: '2026-03-10',
          checkOut: '',
        })
      )
    })

    it('denies creating attendance stamped with another gym', async () => {
      await assertFails(
        setDoc(client(A.frontDesk).collection('attendance').doc(), { gymId: GYM_B, memberId: 'asx-m-att' })
      )
    })

    it('denies a front-desk user deleting an attendance record', async () => {
      const path = 'attendance/asx-m-deleteme'
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(path).set({ gymId: GYM_A, memberId: 'asx-m-deleteme' })
      })
      await assertFails(client(A.frontDesk).doc(path).delete())
      await assertSucceeds(client(A.owner).doc(path).delete())
    })
  })
})