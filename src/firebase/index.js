import { initializeApp } from 'firebase/app'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator } from 'firebase/firestore'
import { connectStorageEmulator, getStorage } from 'firebase/storage'
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

  // Local development against the Firebase emulators. Opt-in only: nothing
  // changes unless VITE_FIREBASE_EMULATORS=true is set, so a production build
  // can never point at a localhost emulator.
  if (import.meta.env.VITE_FIREBASE_EMULATORS === 'true') {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    connectFirestoreEmulator(db, '127.0.0.1', 8080)
    connectStorageEmulator(storage, '127.0.0.1', 9199)
  }
}

export { isFirebaseConfigured }
