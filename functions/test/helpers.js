/**
 * Emulator helpers for the trusted projection writer's tests.
 *
 * ## Why Admin SDK rather than the rules-unit-testing client
 *
 * These suites test the WRITER, which runs with Admin credentials and therefore
 * bypasses Firestore Security Rules. Using a rules client here would test the
 * wrong thing: every write would be evaluated against rules the Admin SDK never
 * consults. Rules are covered separately, in `tests.emulator/`, where the
 * client is deliberately untrusted.
 *
 * Each suite takes its own id prefix via `suite()`, so these files can share the
 * single Firestore emulator without colliding.
 */
import admin from 'firebase-admin'
import { firestore } from '../projection/admin.js'

export const PROJECT_ID = 'demo-himalye-gym'
export const PREFIX = 'pw-'

/** The Admin handle under test. `projectId` matches the emulator project. */
export const db = firestore({ projectId: PROJECT_ID })

/** The gym-local day every test pins, so nothing depends on the wall clock. */
export const TODAY = '2026-06-15'
export const TIMEZONE = 'Asia/Kolkata'

/**
 * Today's real gym-local day key.
 *
 * The callable evaluates against the actual clock — it must, in production, and
 * it deliberately accepts no `today` override so a client cannot choose the day
 * its projection is computed for. Tests that drive the callable therefore have
 * to build their fixtures relative to the real date rather than pin one, or they
 * start failing the day after they are written.
 */
export function realToday(timezone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** Shift a `YYYY-MM-DD` day key by whole days. */
export function shiftDay(key, days) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export const GYM_A = `${PREFIX}gym-a`
export const GYM_B = `${PREFIX}gym-b`

/** Create a gym plus the settings doc the writer reads the timezone from. */
export async function seedGym(gymId, { timezone = TIMEZONE } = {}) {
  await db.doc(`gyms/${gymId}`).set({ name: gymId, ownerUid: `${gymId}-owner` })
  if (timezone !== null) {
    await db.doc(`gyms/${gymId}/settings/app`).set({ gymId, timezone })
  }
}

/** @param extra merged onto the member document — used to plant forged projections. */
export async function seedMember(memberId, gymId, extra = {}) {
  await db.doc(`members/${memberId}`).set({ name: memberId, gymId, ...extra })
}

/**
 * Firestore rejects `undefined` values outright, so an omitted field has to be
 * omitted from the document rather than passed as `undefined`. That distinction
 * matters here: "a period with no expiryDate" is exactly the malformed data the
 * writer must refuse to invent an answer from.
 */
function definedOnly(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
}

/**
 * Seed an authoritative membership period.
 *
 * `startDate`/`expiryDate` are `YYYY-MM-DD` day keys, matching what the app
 * writes (`gymTodayKey`), not instants. Omitting either produces a genuinely
 * malformed period, not a field set to null.
 */
export async function seedPeriod(periodId, gymId, memberId, { startDate, expiryDate, ...rest }) {
  await db.doc(`memberships/${periodId}`).set(
    definedOnly({ memberId, gymId, startDate, expiryDate, isPT: false, ...rest })
  )
}

/**
 * Seed an authoritative freeze.
 *
 * `startDate`/`expiryDate` are day keys, and the END key is `expiryDate` — not
 * `endDate`. The engine's `toRange` reads `raw.startDate`/`raw.expiryDate` and
 * returns null for anything else, so a freeze written with `endDate` is not
 * malformed data: it is silently INVISIBLE, and the projection quietly comes out
 * un-frozen. That failure mode cost a test run here, so the mistake is now a
 * loud error rather than a silently wrong assertion.
 */
export async function seedFreeze(
  freezeId,
  gymId,
  memberId,
  { periodId, kind = 'freeze', startDate, expiryDate, ...rest }
) {
  for (const wrong of ['endDate', 'end', 'to']) {
    if (wrong in rest) {
      throw new Error(
        `seedFreeze: freeze "${freezeId}" was given "${wrong}". A freeze ends on "expiryDate".`
      )
    }
  }
  await db.doc(`membershipFreezes/${freezeId}`).set(
    definedOnly({ memberId, gymId, periodId, kind, startDate, expiryDate, ...rest })
  )
}

/** A caller profile. `gymId` omitted models an account with no bound gym. */
export async function seedProfile(uid, { gymId = GYM_A, role = 'front-desk' } = {}) {
  const profile = { role }
  if (gymId !== null) profile.gymId = gymId
  await db.doc(`users/${uid}`).set(profile)
}

export async function readMemberDoc(memberId) {
  const snapshot = await db.doc(`members/${memberId}`).get()
  return snapshot.exists ? snapshot.data() : null
}

/**
 * Every document in a collection as `{ id, ...data }` rows.
 *
 * Used to assert that a job wrote NOTHING. A count would do, but comparing the
 * actual rows means a test that deletes and recreates the same number of
 * documents still fails.
 */
export async function readDocs(collectionName) {
  const snapshot = await db.collection(collectionName).get()
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/** Bind a member id once, so a fixture can never reference a *different* member. */
export function memberIdFactory(uid) {
  const id = uid('member')
  return {
    id,
    seed: (gymId, extra) => seedMember(id, gymId, extra),
    withPeriod: (gymId, options) => seedPeriod(uid('period'), gymId, id, options),
    withFreeze: (gymId, options) => seedFreeze(uid('freeze'), gymId, id, options),
    read: () => readMemberDoc(id),
  }
}

/** Delete every document belonging to one suite's prefix. */
export async function cleanup(prefix = PREFIX) {
  const collections = ['members', 'memberships', 'membershipFreezes', 'users', 'gyms', 'auditLog']
  for (const name of collections) {
    const snapshot = await db.collection(name).get()
    const batch = db.batch()
    let queued = 0
    for (const docSnap of snapshot.docs) {
      if (!docSnap.id.startsWith(prefix)) continue
      // A gym owns its settings subcollection, whose doc id is the fixed
      // 'app', so it has to be matched through its parent gym id.
      if (name === 'gyms') {
        const settings = await db.doc(`gyms/${docSnap.id}/settings/app`).get()
        if (settings.exists) {
          batch.delete(settings.ref)
          queued += 1
        }
      }
      batch.delete(docSnap.ref)
      queued += 1
      if (queued >= 400) break
    }
    if (queued) await batch.commit()
  }
}

let seq = 0

/**
 * An isolated id namespace for one test file.
 *
 * Vitest runs each test file in its own worker against the SAME emulator, so two
 * suites that both seed ids from a counter starting at zero will collide: the
 * first suite's `cleanup()` deletes the second suite's fixtures mid-test. Each
 * file therefore takes its own prefix and cleans up only its own ids, which also
 * lets the files run concurrently.
 *
 * Destructure the parts you need to keep existing call sites readable:
 *   const S = suite('pw-w-')
 *   const { uid, gymA: GYM_A, cleanup } = S
 */
export function suite(prefix) {
  if (typeof prefix !== 'string' || !prefix.startsWith(PREFIX) || prefix === PREFIX) {
    throw new Error(`suite() needs a distinct prefix starting with "${PREFIX}", got ${prefix}`)
  }
  return {
    prefix,
    uid: (label) => `${prefix}${label}-${++seq}`,
    gymA: `${prefix}gym-a`,
    gymB: `${prefix}gym-b`,
    cleanup: () => cleanup(prefix),
  }
}

/** True when a Firestore emulator is actually reachable — fails loudly if not. */
export async function assertEmulatorReachable() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set. Run these suites with `npm run test:functions`, which starts the emulator.'
    )
  }
  await db.collection('members').limit(1).get()
  return admin.apps.length > 0
}