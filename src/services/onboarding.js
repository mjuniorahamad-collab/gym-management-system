import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db, auth, isFirebaseConfigured } from '@/firebase'
import { assertValidReceiptPrefix } from '@/utils/receiptPrefix'

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
 * Only callable when Firebase is configured and a user is signed in.
 */
export async function provisionOwnerGym({ name, tagline = '', receiptPrefix } = {}) {
  if (!isFirebaseConfigured || !db || !auth) {
    throw new Error('Firebase is not configured')
  }
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('You must be signed in to create a gym')
  assertValidReceiptPrefix(receiptPrefix, 'provisionOwnerGym')

  const ref = await addDoc(collection(db, 'gyms'), {
    ownerUid: uid,
    name,
    tagline,
    receiptPrefix,
    createdAt: serverTimestamp(),
  })
  return ref.id
}
