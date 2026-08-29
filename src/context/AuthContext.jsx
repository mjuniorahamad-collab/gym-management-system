import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile as fbUpdateProfile,
} from 'firebase/auth'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from 'firebase/firestore'
import { auth, db, isFirebaseConfigured } from '@/firebase'
import { can } from '@/utils/permissions'
import { setActor } from '@/services/audit'
import { setGymId, DEMO_GYM_ID } from '@/services/ownerContext'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // True when the signed-in user has no bound gym and no provisioned
  // owner-of-record yet → the Login page shows the self-provisioning
  // "Create your gym" step instead of blocking or redirecting.
  const [pendingOnboarding, setPendingOnboarding] = useState(false)
  const unsubscribeRef = useRef(null)

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) {
      setLoading(false)
      return
    }

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser)
      if (!firebaseUser) {
        setProfile(null)
        setActor(null)
        setGymId(null)
        setPendingOnboarding(false)
        setLoading(false)
      }
    })

    return () => unsubscribe()
  }, [])

  // Live profile so role changes take effect immediately across the app.
  // One listener per signed-in user, always unsubscribed on sign-out/uid change.
  //
  // IMPORTANT: the profile doc is ensured (getDoc -> setDoc if missing) BEFORE
  // subscribing. We deliberately do NOT call setDoc from inside the onSnapshot
  // callback — writing to a document while listening to it is a known trigger
  // for the Firestore "INTERNAL ASSERTION FAILED" crash (firebase-js-sdk
  // #10008) and leaves the profile missing, which denies every collection read.
  const subscribeProfile = useCallback((firebaseUser) => {
    if (unsubscribeRef.current) unsubscribeRef.current()
    const profileRef = doc(db, 'users', firebaseUser.uid)
    unsubscribeRef.current = onSnapshot(
      profileRef,
      (snap) => {
        if (!snap.exists()) {
          // Profile was removed while signed in. Do not silently recreate it
          // (that would re-introduce the write-while-listening pattern); the
          // rules will deny reads until an owner restores it.
          setError('Your staff profile could not be found.')
          setGymId(null)
          setLoading(false)
          return
        }
        const data = snap.data()
        setProfile(data || null)
        setGymId(data?.gymId || null)
        setActor(data ? { uid: firebaseUser.uid, ...data } : null)
        setError(null)
        setLoading(false)
      },
      (err) => {
        setError(err.message)
        setLoading(false)
      }
    )
  }, [])

  // Discover a gym this user is the owner-of-record for. Path B bootstrap:
  // the gyms/{gymId} owner-of-record doc is provisioned (out-of-band or via
  // self-provisioning), and the rules only expose a gyms doc to its own
  // owner, so this returns at most the caller's own gym (never other
  // tenants').
  const discoverOwnGym = useCallback(async (uid) => {
    const snap = await getDocs(query(collection(db, 'gyms'), where('ownerUid', '==', uid)))
    const gym = snap.docs[0]
    return gym ? { id: gym.id, ...gym.data() } : null
  }, [])

  // One-time bootstrap: ensure the signed-in user's profile exists and is
  // bound to the gym they own (if any). For a brand-new self-registered owner
  // with no gym yet, it sets pendingOnboarding so they can create one.
  const bootstrapProfile = useCallback(async () => {
    if (!user?.uid || !db) return
    const profileRef = doc(db, 'users', user.uid)

    try {
      const snap = await getDoc(profileRef)
      // Already bound → normal path.
      if (snap.exists() && snap.data().gymId) {
        subscribeProfile(user)
        return
      }

      // Profile missing or not yet bound. Try the one-time secure bind to
      // the caller's own provisioned gym (if any).
      const ownGym = await discoverOwnGym(user.uid)

      if (ownGym) {
        const base = {
          name: user.displayName || 'Owner',
          email: user.email,
          gymId: ownGym.id,
        }
        if (snap.exists()) {
          // Legacy profile (no gymId yet) → bind it now. The security rules
          // verify the caller is the gym's owner-of-record, so a client can
          // never claim ownership it does not have.
          const current = snap.data()
          await setDoc(profileRef, { ...current, ...base }, { merge: true })
        } else {
          // Brand-new profile for a provisioned owner.
          await setDoc(profileRef, { ...base, role: 'owner', createdAt: new Date().toISOString() })
        }
        subscribeProfile(user)
        return
      }

      // No provisioned gym. A legacy profile (without a gym) is left intact
      // so existing owners stay signed in until their gym is provisioned.
      if (snap.exists()) {
        subscribeProfile(user)
        return
      }

      // Brand-new sign-in with no gym and no profile → offer self-provisioning.
      setPendingOnboarding(true)
      setError(null)
      setLoading(false)
    } catch (e) {
      // A bootstrap failure (e.g. a rules-denied discovery read for a user
      // with no users/{uid} profile yet) must NEVER leave a signed-in user
      // with profile=null and pendingOnboarding=false, because the Login page
      // auto-navigates on that combination and would drop them into a
      // data-less dashboard with no way to start a gym. Route to the
      // onboarding flow instead so they can recover (and see the error there).
      setError(e.message)
      setPendingOnboarding(true)
      setLoading(false)
    }
  }, [user, subscribeProfile, discoverOwnGym])

  useEffect(() => {
    if (!user?.uid || !db) return
    setPendingOnboarding(false)
    bootstrapProfile()
    return () => {
      if (unsubscribeRef.current) unsubscribeRef.current()
    }
  }, [user, bootstrapProfile])

  const signIn = useCallback(async (email, password) => {
    if (!auth) throw new Error('Firebase is not configured')
    setError(null)
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch (e) {
      setError(e.message.replace('Firebase:', '').trim())
      throw e
    }
  }, [])

  // Create an owner account. After a successful sign-up, onAuthStateChanged
  // fires, bootstrapProfile runs, and (with no gym yet) pendingOnboarding is
  // set so the Login page can offer the "Create your gym" step.
  const signUp = useCallback(async (name, email, password) => {
    if (!auth) throw new Error('Firebase is not configured')
    setError(null)
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      if (name && cred.user) {
        await fbUpdateProfile(cred.user, { displayName: name }).catch(() => {})
      }
    } catch (e) {
      setError(e.message.replace('Firebase:', '').trim())
      throw e
    }
  }, [])

  const completeOnboarding = useCallback(
    async (gymId) => {
      if (!user?.uid || !db) return
      // The gyms/{gymId} owner-of-record now exists (created via
      // provisionOwnerGym). Re-run bootstrap to bind the profile to it.
      await bootstrapProfile()
      return gymId
    },
    [user, bootstrapProfile]
  )

  const signOut = useCallback(async () => {
    if (!auth) {
      setUser(null)
      setProfile(null)
      setActor(null)
      setGymId(null)
      setPendingOnboarding(false)
      return
    }
    await fbSignOut(auth)
  }, [])

  // Demo mode: no Firebase configured — log in with an in-memory owner profile
  // backed by the mock data store so the entire UI is testable offline.
  const demoSignIn = useCallback(async () => {
    setUser({ uid: 'demo-owner', email: 'demo@himalye.com' })
    const demoProfile = { name: 'Demo Owner', email: 'demo@himalye.com', role: 'owner', gymId: DEMO_GYM_ID }
    setProfile(demoProfile)
    setGymId(DEMO_GYM_ID)
    setActor({ uid: 'demo-owner', ...demoProfile })
    setError(null)
    setPendingOnboarding(false)
  }, [])

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      error,
      gymId: profile?.gymId || null,
      isConfigured: isFirebaseConfigured,
      pendingOnboarding,
      signIn,
      signUp,
      completeOnboarding,
      signOut,
      demoSignIn,
      hasRole: (role) => Boolean(profile && profile.role === role),
      can: (permission) => can(profile?.role, permission),
      role: profile?.role || null,
    }),
    [user, profile, loading, error, pendingOnboarding, signIn, signUp, completeOnboarding, signOut, demoSignIn]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
