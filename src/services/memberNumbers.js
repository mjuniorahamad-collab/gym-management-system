import { doc, runTransaction } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { store } from './mockStore'
import { formatMemberNo, parseMemberNo } from '@/utils/memberNo'
import { getGymId } from './ownerContext'

const ready = () => isFirebaseConfigured && Boolean(db)

// Member-number counters are scoped per gym so independent tenants never
// collide, and every counter document carries the gymId its sequence belongs
// to (enforced by the security rules).
const counterKey = () => {
  const id = getGymId() || 'none'
  const normalized = String(id).replace(/[^a-zA-Z0-9_-]/g, '_')
  return `memberNo_${normalized}`
}

const counterRef = () => doc(db, 'counters', counterKey())

/**
 * Returns the next member number (e.g. MEM-0001). Real Firestore mode uses an
 * atomic transaction on a per-gym `counters/memberNo_<gymId>` document so
 * concurrent creates never collide. Demo (mock) mode derives it from the
 * highest existing number. The counter never decrements, so numbers are never
 * reused after a delete.
 */
export async function nextMemberNo() {
  if (!ready()) {
    store.counters ??= {}
    store.counters[counterKey()] ??= 0
    const docMax = store.members.reduce((hi, m) => {
      const n = parseMemberNo(m.memberNo)
      return n !== null && n > hi ? n : hi
    }, 0)
    const next = Math.max(docMax + 1, (store.counters[counterKey()] ?? 0) + 1)
    store.counters[counterKey()] = next
    return formatMemberNo(next)
  }

  const gymId = getGymId()
  if (!gymId) throw new Error('No gym selected — member numbering unavailable before tenancy is established')
  const n = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef())
    const next = (snap.data()?.value ?? 0) + 1
    tx.set(counterRef(), { value: next, gymId }, { merge: true })
    return next
  })
  return formatMemberNo(n)
}

/**
 * One-time, idempotent migration: assigns a stable member number to every
 * existing member that does not have one yet, oldest first, without touching
 * their Firebase document ID. Safe to run repeatedly — it only fills gaps.
 */
export async function backfillMemberNumbers() {
  const { listAll, updateDocById } = await import('./firestore')
  const members = await listAll('members')
  const ordered = [...members].sort((a, b) => {
    const ta = String(a.createdAt || a.joinDate || '')
    const tb = String(b.createdAt || b.joinDate || '')
    return ta.localeCompare(tb)
  })
  let assigned = 0
  for (const m of ordered) {
    if (m.memberNo) continue
    const no = await nextMemberNo()
    await updateDocById('members', m.id, { memberNo: no })
    assigned += 1
  }
  return assigned
}
