import { describe, beforeEach, expect, it, vi } from 'vitest'
import {
  MAX_PLAUSIBLE_SEQUENCE,
  formatReceiptNo,
  highestSequenceIn,
  isPlausibleSequence,
  nextReceiptNo,
  nextReceiptSequence,
  parseReceiptSeq,
} from '@/services/receipts'
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

  it('never invents a prefix, and rejects non-numbers', () => {
    // No default brand: an unresolvable prefix mints nothing, so a receipt can
    // never be issued under a prefix nobody is accountable for.
    expect(formatReceiptNo('', 7)).toBe('')
    expect(formatReceiptNo(undefined, 7)).toBe('')
    expect(formatReceiptNo(null, 7)).toBe('')
    expect(formatReceiptNo('has spaces', 7)).toBe('')
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
 * The counter floor comes from the highest number already on file, so a number
 * the counter did NOT mint must never seed it. A live gym carried one timestamp
 * receipt (`GMS-1791540317434`, 2026-10-09) and no counter document, so the next
 * receipt would have been `GMS-1791540317435` — epoch numbers for ever. These
 * cases pin the bound that keeps timestamp receipts out of the sequence without
 * touching the numbers already printed.
 */
describe('counter floor ignores timestamp receipts', () => {
  it('treats epoch-scale values as not-a-sequence', () => {
    expect(isPlausibleSequence(1_791_540_317_434)).toBe(false)
    expect(isPlausibleSequence(MAX_PLAUSIBLE_SEQUENCE)).toBe(true)
    expect(isPlausibleSequence(MAX_PLAUSIBLE_SEQUENCE + 1)).toBe(false)
    expect(isPlausibleSequence(undefined)).toBe(false)
    expect(isPlausibleSequence(-1)).toBe(false)
  })

  it('seeds from the highest real sequence, never from a timestamp receipt', () => {
    const payments = [
      { receiptNo: '001-874835' },
      { receiptNo: 'GMS-1791540317434' },
      { receiptNo: 'GMS-000042' },
      { receiptNo: 'GMS-renewal-demo' },
      { receiptNo: null },
    ]
    expect(highestSequenceIn(payments)).toBe(874835)
    expect(nextReceiptSequence(undefined, highestSequenceIn(payments))).toBe(874836)
  })

  it('ignores an implausible stored counter as well as an implausible floor', () => {
    expect(nextReceiptSequence(1_791_540_317_434, 0)).toBe(1)
    expect(nextReceiptSequence(undefined, 1_791_540_317_434)).toBe(1)
    expect(nextReceiptSequence(7, 1_791_540_317_434)).toBe(8)
  })

  it('keeps the plain cases unchanged', () => {
    expect(highestSequenceIn([])).toBe(0)
    expect(nextReceiptSequence(undefined, 0)).toBe(1)
    expect(nextReceiptSequence(41, 0)).toBe(42)
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