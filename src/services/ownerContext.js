// Holds the resolved tenant (gym) identity for the current session, outside of
// React. AuthContext keeps it in sync with users/{uid}.gymId so the service
// layer can scope reads/writes and stamp gymn with every document without
// being a component.
//
// gymId is the caller's bound gym. It can only be bound once (see
// firestore.rules canBindGymId) and is frozen afterwards — clients never
// choose it freely.

let gymId = null

export function setGymId(id) {
  gymId = id || null
}

export function getGymId() {
  return gymId
}

// Stable fallback used only in demo/offline (mock) mode so the whole UI is
// testable without Firebase. Never used when Firebase is configured.
export const DEMO_GYM_ID = 'demo-gym'
