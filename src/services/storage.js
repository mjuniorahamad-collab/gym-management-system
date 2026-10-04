import { getBytes, ref, uploadBytes } from 'firebase/storage'
import { isFirebaseConfigured, storage } from '@/firebase'

// ---------------------------------------------------------------------------
// Storage object layout (must match storage.rules exactly)
//
//   gyms/{gymId}/memberPhotos/{memberId}/{MEMBER_PHOTO_FILENAME}
//   gyms/{gymId}/branding/{LOGO_FILENAME}
//
// The gym dimension lives in the object path, so tenancy is enforced by the
// rules on every read and write rather than by whatever the caller happens to
// pass. The legacy flat prefixes memberPhotos/{memberId} and logos/{name} are
// revoked and must not be reintroduced.
// ---------------------------------------------------------------------------

/**
 * Filenames are CONSTANTS, not derived from the uploaded file.
 *
 * A constant name makes each logical asset exactly one object, so re-uploading
 * overwrites in place. That removes orphan growth entirely: there is never a
 * second object to clean up, which is what previously forced the client to
 * delete files it had just uploaded — a capability storage.rules denies on
 * purpose, because no product flow needs client-side deletion.
 *
 * The extension is part of the constant rather than the user's filename, so a
 * caller cannot choose the object name. storage.rules independently enforces
 * the same allowlist server-side.
 */
export const MEMBER_PHOTO_FILENAME = 'photo.jpg'
export const LOGO_FILENAME = 'logo.png'

// Mirrors storage.rules. Client validation here is UX only — it lets the user
// see "that file is too large" instead of a rules error. The security boundary
// is the ruleset, which re-checks all of this server-side.
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_MEMBER_PHOTO_BYTES = 5 * 1024 * 1024
export const MAX_LOGO_BYTES = 2 * 1024 * 1024

export function isStorageReady() {
  return isFirebaseConfigured && Boolean(storage)
}

/**
 * Rejects a blank gym identity before it can reach an object path.
 *
 * The gym id is the tenancy boundary, so a missing or empty one must fail loudly
 * rather than silently producing an unscoped path. Callers get the value from
 * the signed-in users/{uid} profile — never from the URL, form input, or any
 * other client-controlled field.
 */
function requireGymId(gymId) {
  const id = typeof gymId === 'string' ? gymId.trim() : ''
  if (!id) throw new Error('A gym identity is required to build a Storage path')
  return id
}

/** Deterministic member-photo object path for one member of one gym. */
export function memberPhotoPath(gymId, memberId) {
  const gym = requireGymId(gymId)
  const member = typeof memberId === 'string' ? memberId.trim() : ''
  if (!member) throw new Error('A member id is required to build a member photo path')
  return `gyms/${gym}/memberPhotos/${member}/${MEMBER_PHOTO_FILENAME}`
}

/**
 * Deterministic branding object path for one gym.
 *
 * Stable by design (D2): the same gym always resolves to the same object, so
 * repeated uploads replace the logo instead of accumulating timestamped files.
 */
export function logoPath(gymId) {
  return `gyms/${requireGymId(gymId)}/branding/${LOGO_FILENAME}`
}

/**
 * Returns a human-readable reason the file will be rejected, or null if it is
 * acceptable. UX affordance only; storage.rules is the enforcement point.
 */
export function validateImageFile(file, maxBytes) {
  if (!file) return 'No file selected'
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return `Unsupported image type. Use ${ALLOWED_IMAGE_TYPES.join(', ')}`
  }
  if (file.size > maxBytes) {
    return `Image is too large. Maximum size is ${Math.floor(maxBytes / (1024 * 1024))} MB`
  }
  return null
}

/**
 * Uploads bytes to an explicit object path.
 *
 * Returns the PATH, not a download URL. Returning a URL here is what created the
 * bearer-token leak: `getDownloadURL` mints a credential that bypasses
 * `storage.rules` for anyone holding it, so storing one turned a revocable
 * access decision into a permanent one. Nothing in this client needs a token
 * (see `readObjectUrl`), so no token is minted at all.
 */
async function putFile(file, path) {
  if (!isStorageReady()) throw new Error('Firebase is not configured')
  await uploadBytes(ref(storage, path), file)
  return path
}

/**
 * Uploads one member photo and returns its stable object path.
 *
 * The caller persists the path. Rendering then goes through `readObjectUrl`, so
 * every read is authorised by `storage.rules` at the moment it happens.
 */
export async function uploadMemberPhoto(gymId, memberId, file) {
  const invalid = validateImageFile(file, MAX_MEMBER_PHOTO_BYTES)
  if (invalid) throw new Error(invalid)
  const path = memberPhotoPath(gymId, memberId)
  await putFile(file, path)
  return { path }
}

/**
 * Uploads the gym logo to its single deterministic branding object and returns
 * the stable object path.
 */
export async function uploadGymLogo(gymId, file) {
  const invalid = validateImageFile(file, MAX_LOGO_BYTES)
  if (invalid) throw new Error(invalid)
  const path = logoPath(gymId)
  await putFile(file, path)
  return { path }
}

const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * Fetches an object and returns a blob URL for it (D1).
 *
 * This replaces handing out a download token. `getBytes` sends the signed-in
 * user's ID token with the request, so `storage.rules` re-evaluates tenancy on
 * every read: a downgraded or removed staff member loses access on their next
 * render instead of keeping a URL that works forever.
 *
 * The returned URL is a blob URL scoped to this page, and the CALLER MUST revoke
 * it when it is no longer needed or the bytes leak for the lifetime of the
 * document. `useSecureImage` owns that lifecycle.
 */
export async function readObjectUrl(path) {
  if (!isStorageReady()) throw new Error('Firebase is not configured')
  const target = typeof path === 'string' ? path.trim() : ''
  if (!target) throw new Error('A Storage path is required to read an object')
  const bytes = await getBytes(ref(storage, target))
  const extension = target.split('.').pop()?.toLowerCase() || ''
  // Mirrors the storage.rules allowlist; unknown extensions stay opaque rather
  // than being guessed at, and the rules remain the access boundary regardless.
  const type = MIME_BY_EXTENSION[extension] || 'application/octet-stream'
  return URL.createObjectURL(new Blob([bytes], { type }))
}
