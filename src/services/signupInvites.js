/**
 * SIGNUP INVITATIONS — who is allowed to create a new gym (a new tenant).
 *
 * Creating a gym is creating a tenant, and this app is multi-tenant inside ONE
 * Firestore database: `gyms/{gymId}` plus every document stamped with that
 * gymId. Without a gate, anyone holding the app's URL could sign up, create a
 * gym and use the app, and the existing owner could not even see it happen
 * (gyms are not listable across tenants).
 *
 * The allowlist lives at `signupInvites/{emailLower}`. The document id IS the
 * lower-cased email because firestore.rules must derive the path from
 * `request.auth.token.email` — rules cannot run a `where(email == …)` query.
 * `firestore.rules` requires this document for BOTH halves of self-provisioning:
 * creating the `gyms/{gymId}` owner record and binding `users/{uid}` to it.
 *
 * This is a permission list, not an account record. Deleting the document
 * revokes the permission while it is still unused; an invitation that has
 * already produced a gym is history (`usedAt`), not an access grant — what
 * grants access is the bound `users/{uid}` profile.
 *
 * Firebase Auth itself will still create an account for any email (the
 * email/password provider must stay enabled for existing owners to sign in).
 * What this list controls is whether that account can ever own a tenant.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { auth, db, isFirebaseConfigured } from '@/firebase'

const COLLECTION = 'signupInvites'

/** A single, predictable form of an email. Used for the id AND for comparison. */
export function normalizeInviteEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
}

/**
 * Shape check before a write. Deliberately shallow: Firestore rules do not
 * validate email syntax, and the address only has to work as a login.
 * `/` is rejected because it would change the document path.
 */
function assertUsableEmail(email) {
  const id = normalizeInviteEmail(email)
  if (!id || id.includes('/') || !id.includes('@') || id.length > 254) {
    throw new Error('Enter a valid email address to invite.')
  }
  return id
}

function requireFirestore() {
  if (!isFirebaseConfigured || !db) throw new Error('Firebase is not configured')
}

function requireOwnerUid() {
  const uid = auth?.currentUser?.uid
  if (!uid) throw new Error('You must be signed in to manage invitations.')
  return uid
}

/**
 * Invite one email to create a gym. Idempotent: inviting the same address again
 * refreshes the note, and an already-used invitation keeps its `usedAt` history
 * because the write merges instead of replacing the document.
 */
export async function inviteEmail({ email, note = '' } = {}) {
  requireFirestore()
  const invitedBy = requireOwnerUid()
  const id = assertUsableEmail(email)

  await setDoc(
    doc(db, COLLECTION, id),
    {
      email: id,
      note: String(note || '').trim(),
      invitedBy,
      invitedAt: serverTimestamp(),
    },
    { merge: true }
  )
  return id
}

/** Every invitation, newest first. Owner-only in firestore.rules. */
export async function listInvites() {
  requireFirestore()
  const snap = await getDocs(collection(db, COLLECTION))
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  return rows.sort((a, b) => {
    const at = a.invitedAt?.toMillis?.() ?? 0
    const bt = b.invitedAt?.toMillis?.() ?? 0
    return bt - at
  })
}

/** Revoke an invitation that has not been used yet. */
export async function revokeInvite(email) {
  requireFirestore()
  const id = assertUsableEmail(email)
  await deleteDoc(doc(db, COLLECTION, id))
}

/**
 * The signed-in user's own invitation, or null.
 *
 * A denial is reported as null rather than thrown: the only caller uses this to
 * decide whether to offer the "Create your gym" step, and a read failure must
 * not be presented as permission. The rules still enforce the real gate.
 */
export async function getMyInvite(email) {
  requireFirestore()
  const id = normalizeInviteEmail(email)
  if (!id || id.includes('/')) return null
  const snap = await getDoc(doc(db, COLLECTION, id))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

/**
 * Record that an invitation became a gym, so the owner can see who onboarded.
 *
 * Best-effort by design: a failure here must never turn a successfully created
 * gym into an error the user sees. `usedGymId` is the evidence; `usedAt` makes
 * the invitation immutable from then on (rules only allow the invitee to add
 * these two fields while the invitation is still unused).
 */
export async function markInviteUsed({ email, gymId } = {}) {
  try {
    requireFirestore()
    const id = normalizeInviteEmail(email)
    if (!id || !gymId) return false
    await updateDoc(doc(db, COLLECTION, id), { usedAt: serverTimestamp(), usedGymId: gymId })
    return true
  } catch (e) {
    console.warn('[signupInvites] could not mark the invitation as used', e)
    return false
  }
}
