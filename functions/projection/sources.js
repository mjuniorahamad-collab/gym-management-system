/**
 * AUTHORITATIVE SOURCE READS.
 *
 * Everything the projection is derived from is read here, and this is the only
 * place that knows the shape of the authoritative collections.
 *
 * ## The three rules this module exists to enforce
 *
 * 1. **Tenancy is the writer's job, not the engine's.** `deriveMemberProjection`
 *    narrows periods by `memberId` ONLY (`periodsForMember` never looks at
 *    `gymId`). A single member id must therefore never be read across gyms. Every
 *    read below is filtered on BOTH `memberId` and `gymId`, so a stray document
 *    belonging to another tenant cannot widen a member's expiry.
 *
 * 2. **The document id must be stamped back onto the data.** `normalizeFreeze`
 *    sets `id: ''` for a document with no `id`, and `cancelledFreezeIds` matches
 *    a cancellation to the freeze it voids BY THAT ID. A snapshot that drops ids
 *    would make every cancellation silently inert — a freeze would keep extending
 *    an expiry that staff believe they voided. `period.id` matters for the same
 *    reason: `anchoredFreezeRanges` resolves a period's freezes through it.
 *
 * 3. **The member document is a destination and a comparison, never an input.**
 *    It is read here so its current projection can be diffed and its tenancy
 *    verified, and it is never passed to the engine. The engine does not accept a
 *    member document, so a forged `member.status` cannot influence a calculation.
 */

/**
 * The four fields the trusted writer owns. Nothing else on the member document is
 * ever written by the projection writer.
 */
export const PROJECTED_FIELDS = Object.freeze([
  'membershipStart',
  'effectiveExpiry',
  'freezeUntil',
  'status',
])

/** Firestore rejects deep pagination beyond this; chunking keeps memory bounded. */
const PAGE_SIZE = 300

/** Copy a query snapshot into plain objects with `id` restored. */
function stampDocs(snapshot) {
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
}

/**
 * Walk a query to exhaustion.
 *
 * Paged rather than `get()`-everything so the nightly sweep stays bounded on a
 * large collection: a member list that outgrows one response is walked in chunks
 * instead of being held in memory at once.
 */
export async function fetchAll(query) {
  const out = []
  let cursor = null
  for (;;) {
    const page = cursor ? query.startAfter(cursor) : query
    const snapshot = await page.limit(PAGE_SIZE).get()
    if (snapshot.empty) break
    out.push(...snapshot.docs)
    if (snapshot.size < PAGE_SIZE) break
    cursor = snapshot.docs[snapshot.docs.length - 1]
  }
  return out
}

/**
 * The gym's business timezone, as stored.
 *
 * Returned RAW and unvalidated: the engine normalises it through
 * `resolveGymTimezone`, which is the single place that decides what an absent or
 * unrecognised zone means. Resolving it here as well would create a second
 * answer to that question. An empty string is the honest "not configured" and
 * the engine turns it into the canonical default.
 */
export async function readGymTimezone(db, gymId) {
  const snapshot = await db.doc(`gyms/${gymId}/settings/app`).get()
  const stored = snapshot.exists ? snapshot.data()?.timezone : undefined
  return typeof stored === 'string' ? stored : ''
}

/** @returns {Promise<null | { ref, id, data }>} null when the member does not exist. */
export async function readMember(db, memberId) {
  const ref = db.doc(`members/${memberId}`)
  const snapshot = await ref.get()
  return snapshot.exists ? { ref, id: snapshot.id, data: snapshot.data() } : null
}

/** Authoritative periods for one member, scoped to one gym. */
export async function readPeriodsForMember(db, gymId, memberId) {
  const snapshot = await db
    .collection('memberships')
    .where('memberId', '==', memberId)
    .where('gymId', '==', gymId)
    .get()
  return stampDocs(snapshot)
}

/**
 * Authoritative freezes for one member, scoped to one gym.
 *
 * Cancelled freezes are deliberately NOT filtered out here. `membershipFreezes`
 * is append-only by design — a cancellation is a new document — so the engine's
 * `cancelledFreezeIds` has to see both the freeze and its cancellation to decide
 * which are live. Dropping either one here would make a voided freeze keep
 * extending an expiry.
 */
export async function readFreezesForMember(db, gymId, memberId) {
  const snapshot = await db
    .collection('membershipFreezes')
    .where('memberId', '==', memberId)
    .where('gymId', '==', gymId)
    .get()
  return stampDocs(snapshot)
}

/** Every period in one gym, stamped. Used by the sweep and the reminder job. */
export async function readPeriodsForGym(db, gymId) {
  const docs = await fetchAll(db.collection('memberships').where('gymId', '==', gymId))
  return docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
}

/** Every freeze in one gym, stamped. Cancellations included, as above. */
export async function readFreezesForGym(db, gymId) {
  const docs = await fetchAll(db.collection('membershipFreezes').where('gymId', '==', gymId))
  return docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
}

/** Every member in one gym, stamped. The sweep's unit of work. */
export async function readMembersForGym(db, gymId) {
  const docs = await fetchAll(db.collection('members').where('gymId', '==', gymId))
  return docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
}

/** Every gym, stamped. The sweep partitions by gym so each gets one timezone. */
export async function readAllGyms(db) {
  const docs = await fetchAll(db.collection('gyms'))
  return docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
}

/**
 * Group stamped source documents by member.
 *
 * A period or freeze with a blank `memberId` is dropped rather than filed under
 * an empty key: an unowned period belongs to nobody, and guessing an owner would
 * be exactly the kind of invention the projection is forbidden to make.
 */
export function groupByMember(docs) {
  const grouped = new Map()
  for (const doc of docs) {
    const memberId = typeof doc.memberId === 'string' ? doc.memberId.trim() : ''
    if (!memberId) continue
    const bucket = grouped.get(memberId)
    if (bucket) bucket.push(doc)
    else grouped.set(memberId, [doc])
  }
  return grouped
}