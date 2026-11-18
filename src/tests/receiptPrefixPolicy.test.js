import { describe, expect, it } from 'vitest'
import {
  RECEIPT_PREFIX_MAX,
  RECEIPT_PREFIX_MIN,
  RECEIPT_PREFIX_PATTERN,
  RECEIPT_PREFIX_RULES,
  ReceiptPrefixError,
  assertValidReceiptPrefix,
  isValidReceiptPrefix,
  receiptPrefixRejection,
} from '@/utils/receiptPrefix'

describe('receipt prefix policy', () => {
  it('accepts canonical values', () => {
    for (const value of ['001', 'CRY', 'A', 'abcdefgh', 'HWG', '00123456']) {
      expect(receiptPrefixRejection(value)).toBe(null)
      expect(isValidReceiptPrefix(value)).toBe(true)
      expect(assertValidReceiptPrefix(value)).toBe(value)
    }
  })

  it('rejects every non-canonical shape', () => {
    const rejected = [
      ['not-a-string', undefined],
      ['not-a-string', null],
      ['not-a-string', 1],
      ['not-a-string', {}],
      ['empty', ''],
      ['whitespace', '   '],
      ['whitespace', '001 '],
      ['whitespace', ' 001'],
      ['whitespace', '0 01'],
      ['whitespace', 'A B'],
      ['charset', 'ABC-12'],
      ['charset', '00.1'],
      ['charset', 'CRY!'],
      ['charset', 'ÄÖÜ'],
      ['length', '123456789'],
      ['length', 'a'.repeat(RECEIPT_PREFIX_MAX + 1)],
    ]

    for (const [reason, value] of rejected) {
      expect(receiptPrefixRejection(value), JSON.stringify(value)).toBe(reason)
      expect(isValidReceiptPrefix(value), JSON.stringify(value)).toBe(false)
      expect(() => assertValidReceiptPrefix(value, 'test')).toThrow(ReceiptPrefixError)
    }
  })

  it('rejects a padded value rather than trimming it into an accepted one', () => {
    for (const padded of ['001 ', ' 001', ' 001 ', ' ABC ']) {
      expect(isValidReceiptPrefix(padded)).toBe(false)
      expect(isValidReceiptPrefix(padded.trim())).toBe(true)
      expect(receiptPrefixRejection(padded)).toBe('whitespace')
    }
    for (const spaced of ['0 01', 'A B']) {
      expect(isValidReceiptPrefix(spaced)).toBe(false)
      expect(isValidReceiptPrefix(spaced.trim())).toBe(false)
      expect(receiptPrefixRejection(spaced)).toBe('whitespace')
    }
  })

  it('returns the input untouched on success', () => {
    expect(assertValidReceiptPrefix('CRY', 'where')).toBe('CRY')
    expect(assertValidReceiptPrefix('001')).toBe('001')
  })

  it('reports the rejection reason on the error', () => {
    let caught = null
    try {
      assertValidReceiptPrefix('ABC-12', 'provisionOwnerGym')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReceiptPrefixError)
    expect(caught.code).toBe('charset')
    expect(caught.message).toContain('provisionOwnerGym')
    expect(caught.message).toContain(RECEIPT_PREFIX_RULES)
  })

  it('exposes the documented bounds', () => {
    expect(RECEIPT_PREFIX_MIN).toBe(1)
    expect(RECEIPT_PREFIX_MAX).toBe(8)
    expect(RECEIPT_PREFIX_PATTERN.test('001')).toBe(true)
    expect(RECEIPT_PREFIX_PATTERN.test('001 ')).toBe(false)
    expect(RECEIPT_PREFIX_PATTERN.test('a'.repeat(9))).toBe(false)
  })
})
