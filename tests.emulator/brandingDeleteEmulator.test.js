/**
 * GYM LOGO — THE DELETE ALLOWANCE
 *
 * The logo lives in `gyms/{gymId}/settings/branding` and the owner may DELETE it:
 * that is the undo of uploading a wrong logo, which otherwise sits on every
 * printed receipt. `app` (the gym's configuration) lives in the same collection,
 * so the allowance is scoped to three things at once:
 *
 *   - the document id, `branding` and nothing else
 *   - the caller's own gym path
 *   - the owner role, not merely staff
 *
 * A widened delete here would be a way to gut a tenant, so every edge is driven
 * through the real ruleset.
 *
 * WHY REST AND NOT `deleteDoc`
 *   The JS SDK (11.10) crashes inside `LocalDocumentsView.populateOverlays`
 *   ("Cannot read properties of undefined (reading 'toString')") whenever this
 *   test client deletes a document, which times the test out before the emulator
 *   ever reports a verdict. A DELETE against the emulator's REST endpoint is
 *   evaluated by the same rules engine with the same `request.auth`, and it
 *   returns 200 or 403 instead of hanging. Seeding still uses the SDK with rules
 *   disabled, which is the supported path.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { getDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const REST = `http://${HOST}:${PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents`

const GYM_A = 'brand-gym-a'
const GYM_B = 'brand-gym-b'
const GYM_C = 'brand-gym-c'

const OWNER_A = 'brand-owner-a'
const OWNER_B = 'brand-owner-b'
const OWNER_C = 'brand-owner-c'
const ADMIN_A = 'brand-admin-a'
const DESK_A = 'brand-desk-a'

const brandPath = (gymId) => `gyms/${gymId}/settings/branding`
const appPath = (gymId) => `gyms/${gymId}/settings/app`
const LOGO = 'data:image/webp;base64,' + 'A'.repeat(2048)

/**
 * An unsigned JWT for `uid`, the shape the emulator accepts as `request.auth`.
 * A bare uid (never signed) is rejected as "invalid jwt", so the claims carry the
 * uid in both places the emulator reads it from.
 */
function token(uid) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: 'none', typ: 'JWT' })
  const payload = b64({
    user_id: uid,
    sub: uid,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    iat: now,
    exp: now + 3600,
  })
  return `${header}.${payload}.`
}

/**
 * Deletes one document through the emulator's REST API as `uid` (or anonymously).
 * The emulator evaluates the real ruleset against that token, so the rules see
 * the same `request.auth` they see from the SDK.
 */
async function deleteAs(path, uid) {
  const res = await fetch(`${REST}/${path}`, {
    method: 'DELETE',
    headers: uid ? { Authorization: `Bearer ${token(uid)}` } : {},
  })
  return res.status
}

let env

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules },
  })
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${GYM_A}`).set({ ownerUid: OWNER_A, name: 'Brand A', receiptPrefix: 'BRA' })
    await fs.doc(`gyms/${GYM_B}`).set({ ownerUid: OWNER_B, name: 'Brand B', receiptPrefix: 'BRB' })
    await fs.doc(`gyms/${GYM_C}`).set({ ownerUid: OWNER_C, name: 'Brand C', receiptPrefix: 'BRC' })

    await fs.doc(`users/${OWNER_A}`).set({ role: 'owner', gymId: GYM_A })
    await fs.doc(`users/${OWNER_B}`).set({ role: 'owner', gymId: GYM_B })
    await fs.doc(`users/${OWNER_C}`).set({ role: 'owner', gymId: GYM_C })
    await fs.doc(`users/${ADMIN_A}`).set({ role: 'admin', gymId: GYM_A })
    await fs.doc(`users/${DESK_A}`).set({ role: 'front-desk', gymId: GYM_A })

    await fs.doc(brandPath(GYM_A)).set({ gymId: GYM_A, data: LOGO })
    await fs.doc(brandPath(GYM_B)).set({ gymId: GYM_B, data: LOGO })
    // a doc at gym C's branding path whose payload claims gym B
    await fs.doc(brandPath(GYM_C)).set({ gymId: GYM_B, data: LOGO })
    // the gym's own configuration sits beside the logo and must stay put
    await fs.doc(appPath(GYM_A)).set({ gymId: GYM_A, gymName: 'Brand A' })
  })
})

afterAll(async () => {
  await env.cleanup()
})

/** Reads a document with rules bypassed, to prove what actually happened. */
async function exists(path) {
  let found = null
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(ctx.firestore().doc(path))
    found = snap.exists()
  })
  return found
}

describe('firestore rules — gym branding document deletion', () => {
  it('the owner can delete their own gym branding document (the logo)', async () => {
    expect(await deleteAs(brandPath(GYM_A), OWNER_A)).toBe(200)
    expect(await exists(brandPath(GYM_A))).toBe(false)
  })

  it('the settings document that configures the gym can never be deleted', async () => {
    expect(await deleteAs(appPath(GYM_A), OWNER_A)).toBe(403)
    expect(await exists(appPath(GYM_A))).toBe(true)
  })

  it('admin and front-desk cannot delete the branding document (owner only)', async () => {
    expect(await deleteAs(brandPath(GYM_B), ADMIN_A)).toBe(403)
    expect(await deleteAs(brandPath(GYM_B), DESK_A)).toBe(403)
    expect(await exists(brandPath(GYM_B))).toBe(true)
  })

  it('a cross-gym owner cannot delete another gym branding document', async () => {
    expect(await deleteAs(brandPath(GYM_C), OWNER_B)).toBe(403)
    expect(await deleteAs(appPath(GYM_A), OWNER_B)).toBe(403)
  })

  it('a branding document whose payload names another gym cannot be deleted', async () => {
    // gym C's owner, but the document claims gym B
    expect(await deleteAs(brandPath(GYM_C), OWNER_C)).toBe(403)
    expect(await exists(brandPath(GYM_C))).toBe(true)
  })

  it('unauthenticated callers cannot delete anything', async () => {
    expect(await deleteAs(brandPath(GYM_B), null)).toBe(403)
    expect(await exists(brandPath(GYM_B))).toBe(true)
  })
})
