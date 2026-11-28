/**
 * SIGNUP IS INVITE-ONLY
 *
 * Creating a gym creates a TENANT in a single shared Firestore database, so an
 * allowlist document is the permission that authorises it. This suite drives the
 * real ruleset and checks both halves of self-provisioning — the `gyms/{gymId}`
 * owner record AND the `users/{uid}` bind — because gating only one of them
 * would leave the door open.
 *
 * It also pins down what an invitation must NOT be: readable or listable by
 * anybody else, writable beyond the two `used*` fields by the invitee, and
 * sufficient for any role other than the owner to hand out.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-himalye-gym'
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [HOST, PORT_RAW = '8080'] = emulatorHost.split(':')
const PORT = Number(PORT_RAW)
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

// Seeded with rules disabled, so the gym id does not have to be auto-id shaped.
const GYM_A = 'invite-gym-a'
const OWNER_A = 'invite-owner-a'
const DESK_A = 'invite-desk-a'

const OWNER_EMAIL = 'owner@gym.test'
const INVITED_EMAIL = 'new-owner@gym.test'
const STRANGER_EMAIL = 'stranger@gym.test'

let env
let gymCounter = 0
/** A 20-character id, which is the only shape `isAutoId()` rule accepts. */
const nextGymId = () => `AutoGymId${String(++gymCounter).padStart(10, '0')}`.padEnd(20, 'X')

const asOwner = () => env.authenticatedContext(OWNER_A, { email: OWNER_EMAIL }).firestore()
const asDesk = () => env.authenticatedContext(DESK_A, { email: 'desk@gym.test' }).firestore()
const asInvited = (uid = 'invited-uid') =>
  env.authenticatedContext(uid, { email: INVITED_EMAIL }).firestore()
const asStranger = (uid = 'stranger-uid') =>
  env.authenticatedContext(uid, { email: STRANGER_EMAIL }).firestore()

/**
 * Asserts a write/read was refused.
 *
 * The SDK reports every refusal as `permission-denied`, and the message text
 * differs per rule (an account with no profile also makes `isOwner()` raise an
 * evaluation error), so the stable thing to assert is the code.
 */
async function expectDenied(promise) {
  const error = await promise.then(
    () => null,
    (e) => e
  )
  expect(error, 'this operation should have been denied').toBeTruthy()
  expect(error?.code).toBe('permission-denied')
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: PORT, rules },
  })
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`gyms/${GYM_A}`).set({
      ownerUid: OWNER_A,
      ownerEmail: OWNER_EMAIL,
      name: 'Invite A',
      receiptPrefix: 'INV',
    })
    await fs.doc(`users/${OWNER_A}`).set({ role: 'owner', gymId: GYM_A, email: OWNER_EMAIL })
    await fs.doc(`users/${DESK_A}`).set({ role: 'front-desk', gymId: GYM_A })
  })
})

afterAll(async () => {
  await env.cleanup()
})

describe('the owner controls the allowlist', () => {
  it('lets the owner invite an email, using the lower-cased email as the id', async () => {
    await setDoc(doc(asOwner(), 'signupInvites', INVITED_EMAIL), {
      email: INVITED_EMAIL,
      note: 'New owner',
      invitedBy: OWNER_A,
      invitedAt: new Date().toISOString(),
    })

    const stored = await getDoc(doc(asOwner(), 'signupInvites', INVITED_EMAIL))
    expect(stored.exists()).toBe(true)
  })

  it('refuses to invite under an id that is not the email itself', async () => {
    await expectDenied(
      setDoc(doc(asOwner(), 'signupInvites', 'someone-else@gym.test'), {
        email: INVITED_EMAIL,
        invitedBy: OWNER_A,
      })
    )
  })

  it('does not let a front-desk account hand out invitations', async () => {
    await expectDenied(
      setDoc(doc(asDesk(), 'signupInvites', 'desk-invite@gym.test'), {
        email: 'desk-invite@gym.test',
        invitedBy: DESK_A,
      })
    )
  })
})

describe('an invited email can create exactly one tenant of its own', () => {
  it('creates the gyms owner record and then binds its own profile', async () => {
    const uid = 'invited-uid-1'
    const gymId = nextGymId()

    await setDoc(doc(asInvited(uid), 'gyms', gymId), {
      ownerUid: uid,
      ownerEmail: INVITED_EMAIL,
      name: 'Invited gym',
      receiptPrefix: 'INV1',
    })
    await setDoc(doc(asInvited(uid), 'users', uid), {
      role: 'owner',
      gymId,
      email: INVITED_EMAIL,
      name: 'Invited Owner',
    })

    const profile = await getDoc(doc(asInvited(uid), 'users', uid))
    expect(profile.data().gymId).toBe(gymId)
  })

  it('cannot claim a gym under a different email than the invited one', async () => {
    const uid = 'invited-uid-2'
    await expectDenied(
      setDoc(doc(asInvited(uid), 'gyms', nextGymId()), {
        ownerUid: uid,
        ownerEmail: STRANGER_EMAIL,
        name: 'Wrong email',
        receiptPrefix: 'INV2',
      })
    )
  })

  it('can read its own invitation but not list the allowlist', async () => {
    const fs = asInvited('invited-uid-3')
    const snap = await getDoc(doc(fs, 'signupInvites', INVITED_EMAIL))
    expect(snap.exists()).toBe(true)

    await expectDenied(getDocs(collection(fs, 'signupInvites')))
  })

  it('may only mark its invitation used, and only while it is unused', async () => {
    const uid = 'invited-uid-4'

    // own invitation, used fields only → allowed
    await updateDoc(doc(asInvited(uid), 'signupInvites', INVITED_EMAIL), {
      usedGymId: nextGymId(),
      usedAt: new Date().toISOString(),
    })

    // a second marking would re-point an already-used invitation
    await expectDenied(
      updateDoc(doc(asInvited(uid), 'signupInvites', INVITED_EMAIL), {
        usedGymId: nextGymId(),
        usedAt: new Date().toISOString(),
      })
    )

    // and it may never edit the invitation itself
    await expectDenied(
      updateDoc(doc(asInvited(uid), 'signupInvites', INVITED_EMAIL), { note: 'hijacked' })
    )
  })
})

describe('an uninvited account can create nothing', () => {
  it('is refused the gyms owner record', async () => {
    await expectDenied(
      setDoc(doc(asStranger(), 'gyms', nextGymId()), {
        ownerUid: 'stranger-uid',
        ownerEmail: STRANGER_EMAIL,
        name: 'Free gym',
        receiptPrefix: 'FREE',
      })
    )
  })

  it('is refused its own users profile', async () => {
    await expectDenied(
      setDoc(doc(asStranger(), 'users', 'stranger-uid'), {
        role: 'owner',
        gymId: nextGymId(),
        email: STRANGER_EMAIL,
      })
    )
  })

  it('cannot read somebody else’s invitation', async () => {
    await expectDenied(getDoc(doc(asStranger(), 'signupInvites', INVITED_EMAIL)))
  })

  it('cannot bind a profile even when a gyms doc for it exists', async () => {
    // Belt and braces: the profile bind is gated too, so an injected gym doc
    // still does not produce a usable account.
    const uid = 'stranger-uid-2'
    const gymId = nextGymId()
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`gyms/${gymId}`).set({
        ownerUid: uid,
        ownerEmail: STRANGER_EMAIL,
        name: 'Injected',
        receiptPrefix: 'INJ',
      })
    })

    await expectDenied(setDoc(doc(asStranger(uid), 'users', uid), { role: 'owner', gymId }))
  })
})

describe('existing tenants are unaffected', () => {
  it('the bound owner still reads its own gym and profile', async () => {
    const fs = asOwner()
    const gym = await getDoc(doc(fs, 'gyms', GYM_A))
    expect(gym.exists()).toBe(true)
    const profile = await getDoc(doc(fs, 'users', OWNER_A))
    expect(profile.data().gymId).toBe(GYM_A)
  })
})
