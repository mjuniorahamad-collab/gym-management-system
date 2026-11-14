import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { mockAdd, mockGet, mockList, mockPage, mockRemove, mockSubscribe, mockUpdate } from './mockStore'
import { nextMemberNo } from './memberNumbers'
import { getGymId, DEMO_GYM_ID } from './ownerContext'

export const isReady = () => isFirebaseConfigured && Boolean(db)

const ts = () => serverTimestamp()

// Scopes a Firestore query to the caller's gym. In mock (demo) mode we do NOT
// scope, so the whole offline UI keeps working against the shared sample set.
function scopedConstraints() {
  if (!isReady()) return []
  const gymId = getGymId()
  // Unbound tenant: return a constraint that can never match so nothing is
  // silently exposed before ownership is established.
  return gymId ? [where('gymId', '==', gymId)] : [where('__unbound__', '==', '__impossible__')]
}

/**
 * List a collection, optionally narrowed to one equality match and/or one row.
 *
 * `where` exists so callers that only need one member's or one period's
 * documents stop pulling the whole collection: the query is served by
 * Firestore's automatic single-field index. When `where` is supplied there is
 * deliberately NO orderBy, because `field == x` plus an orderBy needs a
 * composite index that `firestore.indexes.json` does not declare — and a
 * missing composite index fails in production with FAILED_PRECONDITION. Every
 * caller that filters either sorts the result itself or does not care about
 * order.
 *
 * `limit` is for existence probes (`limit: 1` answers "does this gym have any
 * rows here?" for the cost of one document read).
 *
 * Both options are additive: `listAll(name)` keeps its exact previous
 * behaviour and ordering.
 */
export async function listAll(name, options = {}) {
  const { where: filter = null, limit: max = null } = options

  if (!isReady()) {
    let rows = mockList(name)
    if (filter) rows = rows.filter((d) => d && d[filter.field] === filter.value)
    if (max) rows = rows.slice(0, max)
    return rows
  }

  const constraints = [...scopedConstraints()]
  if (filter) constraints.push(where(filter.field, '==', filter.value))
  else constraints.push(orderBy('createdAt', 'desc'))
  if (max) constraints.push(limit(max))

  const snap = await getDocs(query(collection(db, name), ...constraints))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

export async function getById(name, id) {
  if (!isReady()) return mockGet(name, id)
  if (!id) return null
  const snap = await getDoc(doc(db, name, id))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

export async function createDoc(name, data) {
  let payload = data
  if (name === 'members' && !data.memberNo) {
    payload = { ...data, memberNo: await nextMemberNo() }
  }
  if (!isReady()) {
    return mockAdd(name, { ...payload, gymId: getGymId() || DEMO_GYM_ID })
  }
  const gymId = getGymId()
  if (!gymId) throw new Error('No gym selected — create blocked before tenancy is established')
  const ref = await addDoc(collection(db, name), { ...payload, gymId, createdAt: ts(), updatedAt: ts() })
  return ref.id
}

export async function updateDocById(name, id, data) {
  if (!isReady()) {
    mockUpdate(name, id, data)
    return
  }
  await updateDoc(doc(db, name, id), { ...data, updatedAt: ts() })
}

/**
 * Create-or-update a single document at a specific id, scoped to the bound
 * gym. Unlike createDoc (which uses a random auto-id) this targets a
 * deterministic id so per-gym records such as the member-number counter can
 * be provisioned once. merge:true makes it safe for both the first create and
 * later updates; the security rules still reject any gymId that does not
 * match the caller's bound gym.
 */
export async function upsertDoc(name, id, data) {
  if (!isReady()) {
    mockUpdate(name, id, { ...data })
    return
  }
  const gymId = getGymId()
  if (!gymId) throw new Error('No gym selected — create blocked before tenancy is established')
  await setDoc(doc(db, name, id), { ...data, gymId, updatedAt: ts() }, { merge: true })
}

export async function removeDoc(name, id) {
  if (!isReady()) {
    mockRemove(name, id)
    return
  }
  await deleteDoc(doc(db, name, id))
}

export function subscribeCollection(name, onData, onError) {
  if (!isReady()) {
    return mockSubscribe(name, onData)
  }
  const q = query(collection(db, name), ...scopedConstraints(), orderBy('createdAt', 'desc'))
  return onSnapshot(q, (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError)
}

/**
 * Fetch one page with optional filters + text search (range query on a field,
 * e.g. `searchName` for members) + cursor pagination via startAfter.
 */
export async function fetchPage({
  name,
  pageSize = 20,
  orderField = 'createdAt',
  direction = 'desc',
  startAfterRef = null,
  filters = [],
  search = null,
}) {
  if (!isReady()) {
    return mockPage({ name, pageSize, orderField, direction, startAfterRef, filters, search })
  }

  const constraints = [...scopedConstraints()]
  for (const f of filters) {
    if (f && f.field) constraints.push(where(f.field, f.op || '==', f.value))
  }
  if (search && search.field && search.value) {
    constraints.push(where(search.field, '>=', search.value))
    constraints.push(where(search.field, '<=', search.value + '\uf8ff'))
  }
  constraints.push(orderBy(orderField, direction))
  constraints.push(limit(pageSize + 1))
  if (startAfterRef) constraints.push(startAfter(startAfterRef))

  const snap = await getDocs(query(collection(db, name), ...constraints))
  const docs = snap.docs.slice(0, pageSize)
  return {
    items: docs.map((d) => ({ id: d.id, ...d.data() })),
    hasMore: snap.docs.length > pageSize,
    last: snap.docs[pageSize - 1] || null,
  }
}
