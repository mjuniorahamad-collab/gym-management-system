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
 * All ids are `pw-`-prefixed so these suites can share the single Firestore
 * emulator with `tests.emulator/**` without colliding, and so cleanup can find
 * everything they created.
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

/** Seed an authoritative freeze. `kind` is 'freeze' or 'cancellation'. */
export async function seedFreeze(freezeId, gymId, memberId, { periodId, kind = 'freeze', ...rest }) {
  await db.doc(`membershipFreezes/${freezeId}`).set(
    definedOnly({ memberId, gymId, periodId, kind, ...rest })
  )
}

export async function readMemberDoc(memberId) {
  const snapshot = await db.doc(`members/${memberId}`).get()
  return snapshot.exists ? snapshot.data() : null
}

/** Delete every `pw-` document from the collections these suites touch. */
export async function cleanup() {
  const collections = ['members', 'memberships', 'membershipFreezes', 'users', 'gyms']
  for (const name of collections) {
    const snapshot = await db.collection(name).get()
    const batch = db.batch()
    let queued = 0
    for (const docSnap of snapshot.docs) {
      if (!docSnap.id.startsWith(PREFIX)) continue
      // A gym owns its settings subcollection, which is not matched by the parent id.
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