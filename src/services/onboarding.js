import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db, auth, isFirebaseConfigured } from '@/firebase'
import { assertValidReceiptPrefix } from '@/utils/receiptPrefix'
import { getMyInvite, normalizeInviteEmail, markInviteUsed } from '@/services/signupInvites'

/**
 * Self-provision a brand-new gym for the current owner, in-app.
 *
 * Security (enforced by firestore.rules, not the client): the gyms/{gymId}
 * doc is created via Firestore's random auto-id (a user can never choose the
 * id, so no slug can be squatted), must be owned by the caller
 * (ownerUid == request.auth.uid), and is create-only — an already-provisioned
 * or foreign gym can never be created/overwritten. After this succeeds the
 * caller binds their own users/{uid} profile to the returned gymId via the
 * existing one-time owner-gated bind (canBindGymId).
 *
 * `receiptPrefix` is declared here and nowhere else: firestore.rules freezes
 * `update, delete` on gyms/{gymId} to false, so the prefix chosen at
 * onboarding becomes the tenant's permanent receipt identity.
 *
 * CREATING A GYM CREATES A TENANT, so it is invite-only: the caller's email must
 * be on the `signupInvites` allowlist. This check is a courtesy that produces a
 * clear message; `firestore.rules` enforces the same condition on both the gyms
 * create and the profile bind, so bypassing this function gains nothing.
 *
 * `ownerEmail` is written because the rules compare it with the caller's token
 * email — the allowlist is keyed by email, so the gym records which address was
 * invited.
 *
 * Only callable when Firebase is configured and a user is signed in.
 */
export async function provisionOwnerGym({ name, tagline = '', receiptPrefix } = {}) {
  if (!isFirebaseConfigured || !db || !auth) {
    throw new Error('Firebase is not configured')
  }
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('You must be signed in to create a gym')
  assertValidReceiptPrefix(receiptPrefix, 'provisionOwnerGym')

  const email = normalizeInviteEmail(auth.currentUser?.email)
  const invite = await getMyInvite(email)
  if (!invite) {
    throw new Error(
      'This account is not invited to create a gym. Ask the owner of this app for an invitation first.'
    )
  }

  const ref = await addDoc(collection(db, 'gyms'), {
    ownerUid: uid,
    ownerEmail: email,
    name,
    tagline,
    receiptPrefix,
    createdAt: serverTimestamp(),
  })

  // Evidence for the owner's invitation list; never fatal (see markInviteUsed).
  await markInviteUsed({ email, gymId: ref.id })
  return ref.id
}
