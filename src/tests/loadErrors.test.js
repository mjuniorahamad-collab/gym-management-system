import { describe, expect, it } from 'vitest'
import { LOAD_ERROR, safeLoadMessage } from '@/utils/loadErrors'

const RAW_PERMISSION = {
  code: 'permission-denied',
  message: 'Missing or insufficient permissions. (firestore.rules:412)',
}

describe('safeLoadMessage', () => {
  it('maps permission errors to the stable permission message without echoing raw detail', () => {
    const result = safeLoadMessage(RAW_PERMISSION)
    expect(result).toBe(LOAD_ERROR.PERMISSION)
    expect(result).not.toContain('permission-denied')
    expect(result).not.toContain('Missing or insufficient')
    expect(result).not.toContain('firestore.rules')
  })

  it('maps network failures to the stable network message', () => {
    expect(
      safeLoadMessage({ code: 'unavailable', message: 'Failed to get documents because the network is down.' })
    ).toBe(LOAD_ERROR.NETWORK)
    expect(
      safeLoadMessage({ code: 'auth/network-request-failed', message: 'Firebase: Failed to fetch.' })
    ).toBe(LOAD_ERROR.NETWORK)
    expect(safeLoadMessage(new Error('Failed to fetch'))).toBe(LOAD_ERROR.NETWORK)
    expect(safeLoadMessage(new Error('Request timed out'))).toBe(LOAD_ERROR.NETWORK)
  })

  it('maps unknown failures to the stable generic message without echoing raw detail', () => {
    const result = safeLoadMessage({ code: 'internal', message: 'An internal error occurred at xyz-abc-123.' })
    expect(result).toBe(LOAD_ERROR.GENERIC)
    expect(result).not.toContain('internal')
    expect(result).not.toContain('xyz-abc-123')
  })

  it('classifies raw string messages (authError passthrough)', () => {
    expect(safeLoadMessage('permission denied while reading users/u1')).toBe(LOAD_ERROR.PERMISSION)
    expect(safeLoadMessage('network request failed')).toBe(LOAD_ERROR.NETWORK)
    expect(safeLoadMessage('something odd happened')).toBe(LOAD_ERROR.GENERIC)
  })

  it('is idempotent for already-safe messages', () => {
    for (const message of Object.values(LOAD_ERROR)) {
      expect(safeLoadMessage(message)).toBe(message)
    }
  })

  it('returns the generic message for null, undefined and empty objects', () => {
    expect(safeLoadMessage(null)).toBe(LOAD_ERROR.GENERIC)
    expect(safeLoadMessage(undefined)).toBe(LOAD_ERROR.GENERIC)
    expect(safeLoadMessage({})).toBe(LOAD_ERROR.GENERIC)
  })

  it('never returns anything outside the three stable messages', () => {
    const inputs = [
      RAW_PERMISSION,
      { code: 'unavailable', message: 'Firebase: UNAVAILABLE' },
      { code: 'internal', message: 'stack trace at foo.bar' },
      new Error('Failed to fetch'),
      'raw technical detail ABC123',
      LOAD_ERROR.NETWORK,
      null,
    ]
    for (const input of inputs) {
      expect(Object.values(LOAD_ERROR)).toContain(safeLoadMessage(input))
    }
  })
})
