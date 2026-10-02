import { describe, beforeEach, expect, it, vi } from 'vitest'
import { formatReceiptNo, nextReceiptNo, parseReceiptSeq } from '@/services/receipts'
import { store } from '@/services/mockStore'

vi.mock('@/firebase', () => ({
  isFirebaseConfigured: false,
  db: null,
  app: null,
  auth: null,
  storage: null,
}))

beforeEach(() => {
  store.counters = {}
})

describe('receipt number helpers', () => {
  it('formats a zero-padded 6-digit sequence under the gym prefix', () => {
    expect(formatReceiptNo('HWG', 1)).toBe('HWG-000001')
    expect(formatReceiptNo('HWG', 42)).toBe('HWG-000042')
    expect(formatReceiptNo('SILVER', 123456)).toBe('SILVER-123456')
  })

  it('falls back to a default prefix and rejects non-numbers', () => {
    expect(formatReceiptNo('', 7)).toBe('HWG-000007')
    expect(formatReceiptNo('HWG', 'abc')).toBe('')
    expect(formatReceiptNo('HWG', -1)).toBe('')
  })

  it('parses the trailing sequence from both new and legacy receipts', () => {
    expect(parseReceiptSeq('HWG-000007')).toBe(7)
    expect(parseReceiptSeq('HWG-483920')).toBe(483920)
    expect(parseReceiptSeq('HWG-renewal-demo')).toBeNull()
    expect(parseReceiptSeq(undefined)).toBeNull()
  })
})

/**
 * Receipt numbers used to be `${prefix}-${Date.now().toString().slice(-6)}`.
 * That value space is only 1e6 ms — about 16 minutes 40 seconds — so any two
 * payments whose millisecond timestamps share the same offset within that
 * window minted an IDENTICAL receipt number, while nothing enforced
 * uniqueness. A per-gym counter removes the cycle entirely.
 */
describe('nextReceiptNo', () => {
  it('issues strictly increasing, unique numbers', async () => {
    const issued = []
    for (let i = 0; i < 25; i += 1) issued.push(await nextReceiptNo('HWG'))

    expect(new Set(issued).size).toBe(25)
    const seqs = issued.map(parseReceiptSeq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs[0]).toBe(1)
  })

  it('cannot reproduce the legacy collision window', async () => {
    // The legacy scheme: two payments 1e6 ms apart produced the SAME receipt.
    const t1 = 1_800_000_000_000
    const t2 = t1 + 1_000_000
    expect(String(t1).slice(-6)).toBe(String(t2).slice(-6))

    // The counter has no such cycle: consecutive calls always differ.
    const first = await nextReceiptNo('HWG')
    const second = await nextReceiptNo('HWG')
    expect(first).not.toBe(second)
    expect(parseReceiptSeq(second)).toBe(parseReceiptSeq(first) + 1)
  })

  it('keeps numbering under the gym prefix', async () => {
    expect(await nextReceiptNo('SILVER')).toMatch(/^SILVER-\d{6}$/)
  })

  it('never re-issues a number after the counter is only read again', async () => {
    const a = await nextReceiptNo('HWG')
    const b = await nextReceiptNo('HWG')
    expect(a).not.toBe(b)
    expect(parseReceiptSeq(b)).toBe(parseReceiptSeq(a) + 1)
  })
})