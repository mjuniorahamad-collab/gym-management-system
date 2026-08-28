import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage'
import { isFirebaseConfigured, storage } from '@/firebase'

export function isStorageReady() {
  return isFirebaseConfigured && Boolean(storage)
}

export async function uploadFile(file, path) {
  if (!isStorageReady()) throw new Error('Firebase is not configured')
  const fileRef = ref(storage, path)
  const snap = await uploadBytes(fileRef, file)
  return getDownloadURL(snap.ref)
}

export async function deleteFile(path) {
  if (!isStorageReady()) return
  await deleteObject(ref(storage, path))
}

export const memberPhotoPath = (memberId) => `memberPhotos/${memberId}`
export const logoPath = (name) => `logos/${name}`
