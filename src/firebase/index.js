import { initializeApp } from 'firebase/app'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import { getStorage } from 'firebase/storage'
import { firebaseConfig, isFirebaseConfigured } from './config'

export let app = null
export let db = null
export let auth = null
export let storage = null

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig)
  // Offline-first: Firestore data is cached locally and works when the
  // gym's internet connection drops. Multi-tab manager keeps tabs in sync.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  })
  auth = getAuth(app)
  storage = getStorage(app)
}

export { isFirebaseConfigured }
