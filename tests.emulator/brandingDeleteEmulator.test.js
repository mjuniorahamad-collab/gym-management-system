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
 * through the real ruleset. The delete is deliberately NOT a new capability in
 * practice: an owner can already overwrite the branding document with an empty
 * value; this simply removes the document instead of leaving a hollow one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteDoc, getDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

const GYM_A = 'brand-gym-a'
const GYM_B = 'brand-gym-b'
const GYM_C = 'brand-gym-c'

const OWNER_A = 'brand-owner-a'
const OWNER_B = 'brand-owner-b'
const OWNER_C = 'brand-owner-c'
const ADMIN_A = 'brand-admin-a'
const DESK_A = 'brand-desk-a'

const brandPath = (gymId) => `gyms/${gymId}/settings/branding`
const LOGO = 'data:image/webp;base64,' + 'A'.repeat(2048)

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
    await fs.doc(`gyms/${GYM_A}/settings/app`).set({ gymId: GYM_A, gymName: 'Brand A' })
  })
})

afterAll(async () => {
  await env.cleanup()
})

const ownerA = () => env.authenticatedContext(OWNER_A).firestore()
const ownerB = () => env.authenticatedContext(OWNER_B).firestore()
const ownerC = () => env.authenticatedContext(OWNER_C).firestore()
const adminA = () => env.authenticatedContext(ADMIN_A).firestore()
const deskA = () => env.authenticatedContext(DESK_A).firestore()

describe('firestore rules — gym branding document deletion', () => {
  it('the owner can delete their own gym branding document (the logo)', async () => {
    await assertSucceeds(deleteDoc(ownerA().doc(brandPath(GYM_A))))
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(ctx.firestore().doc(brandPath(GYM_A)))
      expect(snap.exists()).toBe(false)
    })
  })

  it('the settings document that configures the gym can never be deleted', async () => {
    await assertFails(deleteDoc(ownerA().doc(`gyms/${GYM_A}/settings/app`)))
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(ctx.firestore().doc(`gyms/${GYM_A}/settings/app`))
      expect(snap.exists()).toBe(true)
    })
  })

  it('admin and front-desk cannot delete the branding document (owner only)', async () => {
    await assertFails(deleteDoc(adminA().doc(brandPath(GYM_B))))
    await assertFails(deleteDoc(deskA().doc(brandPath(GYM_B))))
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(ctx.firestore().doc(brandPath(GYM_B)))
      expect(snap.exists()).toBe(true)
    })
  })

  it('a cross-gym owner cannot delete another gym branding document', async () => {
    await assertFails(deleteDoc(ownerB().doc(brandPath(GYM_C))))
    await assertFails(deleteDoc(ownerB().doc(`gyms/${GYM_A}/settings/app`)))
  })

  it('a branding document whose payload names another gym cannot be deleted', async () => {
    // gym C's owner, but the document claims gym B
    await assertFails(deleteDoc(ownerC().doc(brandPath(GYM_C))))
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(ctx.firestore().doc(brandPath(GYM_C)))
      expect(snap.exists()).toBe(true)
    })
  })

  it('unauthenticated callers cannot delete anything', async () => {
    await assertFails(deleteDoc(env.unauthenticatedContext().firestore().doc(brandPath(GYM_B))))
  })
})
