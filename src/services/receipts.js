import { doc, getDoc, runTransaction } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { store } from './mockStore'
import { getGymId } from './ownerContext'

const ready = () => isFirebaseConfigured && Boolean(db)

const RECEIPT_DIGITS = 6

// A single monotonic sequence per gym, independent of the receipt prefix, so a
// gym that later changes its prefix can never re-issue a number it already used.
const counterKey = () => {
  const id = getGymId() || 'none'
  const normalized = String(id).replace(/[^a-zA-Z0-9_-]/g, '_')
  return `receiptNo_${normalized}`
}

const counterRef = () => doc(db, 'counters', counterKey())

export function formatReceiptNo(prefix, n) {
  const num = Number.parseInt(n, 10)
  if (Number.isNaN(num) || num < 0) return ''
  return `${prefix || 'HWG'}-${String(num).padStart(RECEIPT_DIGITS, '0')}`
}

export function parseReceiptSeq(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/-(\d+)$/)
  return match ? Number.parseInt(match[1], 10) : null
}

/**
 * Highest receipt sequence already in use by this gym.
 *
 * Legacy receipt numbers were the last six digits of `Date.now()`, so they are
 * bounded by 999999 and a legacy number could in principle equal a freshly
 * minted one (roughly a 1% chance of landing on any specific value across
 * thousands of payments). Seeding the counter above every existing sequence
 * makes a duplicate structurally impossible and also keeps receipts sorting in
 * issue order.
 *
 * Deliberately computed OUTSIDE the transaction callback: Firestore re-runs
 * that callback on contention, and a full payments read must not be repeated on
 * every retry. Cached per session so a gym pays for it at most once.
 */
let seedCache = null
async function highestExistingSequence() {
  if (seedCache !== null) return seedCache
  const { listAll } = await import('./firestore')
  const payments = await listAll('payments')
  let max = 0
  for (const p of payments) {
    const seq = parseReceiptSeq(p?.receiptNo)
    if (seq !== null && seq > max) max = seq
  }
  seedCache = max
  return max
}

/** Test-only: forget the cached seed so the next call re-reads. */
export function __resetReceiptSeedCache() {
  seedCache = null
}

/**
 * Last-resort receipt when the counter cannot be reached. Made strictly
 * monotonic in-process so two receipts minted in the same millisecond still
 * differ, and so wide (full epoch ms) that the legacy 1e6-value cycle cannot
 * recur. Used instead of throwing because a payment must never be refused just
 * because its receipt number could not be minted — and because a real
 * PERMISSION_DENIED from the payment write itself is a far clearer error for
 * staff than a receipt-numbering failure.
 */
let lastFallback = 0
function fallbackReceiptNo(prefix) {
  const now = Date.now()
  lastFallback = now > lastFallback ? now : lastFallback + 1
  return `${prefix || 'HWG'}-${lastFallback}`
}

/**
 * Returns the next receipt number for the current gym (e.g. HWG-000001).
 *
 * Real Firestore mode uses the same atomic per-gym counter transaction as member
 * numbering, so two receipts minted in the same millisecond — or by two gym
 * terminals at once — can never collide. The counter never decrements, so a
 * number is never re-issued after a payment is deleted.
 */
export async function nextReceiptNo(prefix = 'HWG') {
  const gymId = getGymId()

  // Genuine demo/offline mode (mirrors nextMemberNo).
  if (!ready()) {
    store.counters ??= {}
    store.counters[counterKey()] ??= 0
    store.counters[counterKey()] += 1
    return formatReceiptNo(prefix, store.counters[counterKey()])
  }

  // Firebase is configured but tenancy is not established. The payment write is
  // about to fail its own tenant check, so do not mask that behind a receipt
  // error; fall back rather than throw.
  if (!gymId) return fallbackReceiptNo(prefix)

  try {
    const current = await getDoc(counterRef()).catch(() => null)
    const seed = current?.exists?.() ? null : await highestExistingSequence()

    const n = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef())
      const stored = snap.data()?.value
      const next = (typeof stored === 'number' ? stored : seed) + 1
      tx.set(counterRef(), { value: next, gymId }, { merge: true })
      return next
    })
    return formatReceiptNo(prefix, n)
  } catch (err) {
    console.warn('[receipts] counter unavailable; using timestamp receipt', err)
    return fallbackReceiptNo(prefix)
  }
}