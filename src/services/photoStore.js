import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { MAX_STORED_BYTES, makeThumbnail } from '@/utils/image'

// ---------------------------------------------------------------------------
// Where images live
//
//   memberPhotos/{memberId}                  { gymId, data, contentType, ... }
//   members/{memberId}.hasPhoto              flag written in the SAME commit
//   gyms/{gymId}/settings/branding           { gymId, data, contentType, ... }
//
// WHY FIRESTORE AND NOT CLOUD STORAGE
//   Cloud Storage for Firebase requires a billing plan this project does not
//   have, and the default bucket is therefore unusable: uploads fail and the
//   upload control is dead. Firestore already carries the tenancy model — every
//   read and write is authorised by firestore.rules against users/{uid}.gymId —
//   so moving the bytes here keeps "every render is re-authorised" intact
//   instead of replacing it with a public URL that never expires.
//
//   The cost of that choice is honest and bounded: only a 320px thumbnail is
//   kept (~16-34 KB as base64), never the original. Firestore documents are
//   capped at 1 MiB and the stored string is capped at 300 KB by the rules.
//
// WHY A SEPARATE DOCUMENT FOR PHOTOS
//   A photo inside the member document would be downloaded by every member list,
//   dashboard query and export. Keyed by member id instead, a photo costs one
//   read when an avatar actually renders, and listing members stays small.
//
// WHY DETERMINISTIC IDS
//   One document per member, one per gym. Re-uploading overwrites in place, so
//   there is never a second copy to find and delete — which is the same reason
//   storage.js used constant filenames.
//
// WHY THE `hasPhoto` FLAG ON THE MEMBER DOCUMENT
//   Firestore bills one read per document returned, so batching 20 avatars into
//   one query would cost exactly the same 20 reads. What is avoidable is asking
//   for photos that do not exist: a members page renders 20 rows, and most gyms
//   have a photo for only a few of them. The member document is already read to
//   render the row, so a boolean on it tells the list which avatars are worth a
//   read at all. The flag is set in the same batched commit as the photo, so it
//   can never claim a photo that was not written (and the write fails as a whole
//   if the member update is refused).
//
// READS ARE ALWAYS FROM THE SERVER, DELIBERATELY
//   Serving an already-read avatar from the local cache would save more reads,
//   but it also means a photo replaced on ANOTHER device keeps showing the old
//   face here until a reload — a silent "my photo did not change" bug for a
//   saving that is small next to what the flag above already removes. The flag is
//   the whole optimisation: no flag, no read.
// ---------------------------------------------------------------------------

export const MEMBER_PHOTOS_COLLECTION = 'memberPhotos'
export const MEMBERS_COLLECTION = 'members'
export const GYMS_COLLECTION = 'gyms'
export const SETTINGS_SUBCOLLECTION = 'settings'
export const BRANDING_DOC_ID = 'branding'

const THUMBNAIL_OPTIONS = { maxPx: 320, quality: 0.75 }

/** True when a real Firestore client exists (false in demo/mock mode). */
export const isPhotoStoreReady = () => Boolean(isFirebaseConfigured && db)

function requireId(value, label) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error(`A ${label} is required to store an image`)
  return id
}

/** Reads the stored data URL, tolerating a missing document or a bad shape. */
function readDataUrl(snapshot) {
  if (!snapshot || typeof snapshot.exists !== 'function' || !snapshot.exists()) return null
  const value = typeof snapshot.data === 'function' ? snapshot.data()?.data : null
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null
}

/** One server read. No cache layer: the banner above says why. */
async function readStoredDataUrl(ref) {
  return readDataUrl(await getDoc(ref))
}

/**
 * Encodes the file and refuses anything that would not fit the rules cap.
 *
 * Checked here as well as in firestore.rules so the operator gets a message
 * instead of a PERMISSION_DENIED, exactly as services/storage.js did for its
 * 5 MB photo limit.
 */
async function buildPayload(file, gymId) {
  const thumbnail = await makeThumbnail(file, THUMBNAIL_OPTIONS)
  if (thumbnail.bytes > MAX_STORED_BYTES) {
    throw new Error('That image is still too large after resizing. Try a smaller one.')
  }
  return {
    payload: {
      gymId,
      data: thumbnail.dataUrl,
      contentType: thumbnail.contentType,
      width: thumbnail.width,
      height: thumbnail.height,
    },
    thumbnail,
  }
}

/**
 * Saves one member's photo thumbnail and returns the bytes that were stored.
 *
 * The gym id MUST come from the signed-in users/{uid} profile (AuthContext).
 * The rules reject a mismatch, but a caller passing a member document's own
 * gymId would be trusting client data — the member row is the thing being
 * edited, so it is exactly the wrong source for tenancy.
 */
export async function saveMemberPhoto(gymId, memberId, file, { uploadedBy = '' } = {}) {
  const gym = requireId(gymId, 'gym identity')
  const member = requireId(memberId, 'member id')
  if (!isPhotoStoreReady()) throw new Error('Firestore is not configured')

  const { payload, thumbnail } = await buildPayload(file, gym)

  // ONE commit: the bytes and the "this member has a photo" flag. A photo that
  // landed without its flag would never be fetched by any list, and a flag
  // without a photo would make every page pay for a read that returns nothing.
  const batch = writeBatch(db)
  batch.set(doc(db, MEMBER_PHOTOS_COLLECTION, member), {
    ...payload,
    updatedAt: serverTimestamp(),
    updatedBy: uploadedBy,
  })
  batch.update(doc(db, MEMBERS_COLLECTION, member), {
    hasPhoto: true,
    photoUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await batch.commit()

  return {
    memberId: member,
    dataUrl: thumbnail.dataUrl,
    contentType: thumbnail.contentType,
    width: thumbnail.width,
    height: thumbnail.height,
    bytes: thumbnail.bytes,
  }
}

/** Loads a member's photo bytes, or null when none is stored. */
export async function loadMemberPhoto(memberId) {
  const id = typeof memberId === 'string' ? memberId.trim() : ''
  if (!id || !isPhotoStoreReady()) return null
  return readStoredDataUrl(doc(db, MEMBER_PHOTOS_COLLECTION, id))
}

/**
 * Saves the gym logo thumbnail to its single deterministic document.
 *
 * Branding is owner-only in firestore.rules (gyms/{gymId}/settings/{doc}
 * already gates writes on isOwner() + a matching gymId), so no rule change was
 * needed for this half — only the client had to stop talking to Storage.
 */
export async function saveGymLogo(gymId, file, { uploadedBy = '' } = {}) {
  const gym = requireId(gymId, 'gym identity')
  if (!isPhotoStoreReady()) throw new Error('Firestore is not configured')

  const { payload, thumbnail } = await buildPayload(file, gym)

  await setDoc(doc(db, GYMS_COLLECTION, gym, SETTINGS_SUBCOLLECTION, BRANDING_DOC_ID), {
    ...payload,
    updatedAt: serverTimestamp(),
    updatedBy: uploadedBy,
  })

  return {
    gymId: gym,
    dataUrl: thumbnail.dataUrl,
    contentType: thumbnail.contentType,
    width: thumbnail.width,
    height: thumbnail.height,
    bytes: thumbnail.bytes,
  }
}

/**
 * Removes a member's photo: the bytes document and the `hasPhoto` flag in ONE
 * commit.
 *
 * Upload-only was a dead end in practice: a wrong face on a member could never be
 * taken off the profile again. The flag goes with the bytes for the same reason
 * it is written with them — a `true` left behind would make every list pay for a
 * read that can only return nothing, and a photo left behind would be bytes no
 * screen can reach.
 */
export async function removeMemberPhoto(memberId) {
  const member = requireId(memberId, 'member id')
  if (!isPhotoStoreReady()) throw new Error('Firestore is not configured')

  const batch = writeBatch(db)
  batch.delete(doc(db, MEMBER_PHOTOS_COLLECTION, member))
  batch.update(doc(db, MEMBERS_COLLECTION, member), {
    hasPhoto: false,
    photoUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await batch.commit()

  return { memberId: member }
}

/**
 * Deletes the gym's branding document so the default mark renders again.
 *
 * firestore.rules allows a client delete here for `branding` only — the same
 * settings collection also holds `app`, whose removal would unconfigure the gym.
 */
export async function removeGymLogo(gymId) {
  const gym = requireId(gymId, 'gym identity')
  if (!isPhotoStoreReady()) throw new Error('Firestore is not configured')

  await deleteDoc(doc(db, GYMS_COLLECTION, gym, SETTINGS_SUBCOLLECTION, BRANDING_DOC_ID))
  return { gymId: gym }
}

/** Loads the gym's logo bytes, or null when none is stored. */
export async function loadGymLogo(gymId) {
  const id = typeof gymId === 'string' ? gymId.trim() : ''
  if (!id || !isPhotoStoreReady()) return null
  return readStoredDataUrl(doc(db, GYMS_COLLECTION, id, SETTINGS_SUBCOLLECTION, BRANDING_DOC_ID))
}
