import { describe, expect, it } from 'vitest'
import {
  PREFIX_CONSISTENCY,
  classifyPrefixConsistency,
} from '@/utils/receiptPrefix'

/**
 * `gyms/{gymId}.receiptPrefix` is authority; `gyms/{gymId}/settings/app.
 * receiptPrefix` is its mirror. Every reader has to agree on which of the four
 * states it is looking at, because only one is healthy, two are safe to keep
 * reading through, and two must stop and say what an operator has to do.
 *
 * These are the CF-3 states. The classifier is pure, so it carries no writes of
 * its own by construction: what these tests pin down is that a detected
 * inconsistency is REPORTED, never resolved here.
 */
describe('classifyPrefixConsistency', () => {
  const gymId = 'gym-a'
  const authorityPath = 'gyms/gym-a'
  const mirrorPath = 'gyms/gym-a/settings/app'

  it('reports no comparison to make when there is no settings document', () => {
    const state = classifyPrefixConsistency({
      gymId,
      authority: 'CRY',
      mirror: undefined,
      settingsExists: false,
    })
    expect(state.state).toBe(PREFIX_CONSISTENCY.SETTINGS_ABSENT)
    expect(state.blocking).toBe(false)
    expect(state.message).toBeNull()
  })

  it('accepts an authority with no mirror yet (state A)', () => {
    const state = classifyPrefixConsistency({
      gymId,
      authority: 'CRY',
      mirror: undefined,
      settingsExists: true,
    })
    expect(state.state).toBe(PREFIX_CONSISTENCY.MIRROR_MISSING)
    expect(state.blocking).toBe(false)
    expect(state.message).toBeNull()
  })

  it('treats identical values as healthy (state B)', () => {
    const state = classifyPrefixConsistency({
      gymId,
      authority: 'CRY',
      mirror: 'CRY',
      settingsExists: true,
    })
    expect(state.state).toBe(PREFIX_CONSISTENCY.HEALTHY)
    expect(state.blocking).toBe(false)
    expect(state.message).toBeNull()
  })

  it('detects a mirror that disagrees with the authority (state C)', () => {
    const state = classifyPrefixConsistency({
      gymId,
      authority: 'CRY',
      mirror: 'HWG',
      settingsExists: true,
    })
    expect(state.state).toBe(PREFIX_CONSISTENCY.MIRROR_MISMATCH)
    expect(state.blocking).toBe(true)
    expect(state.message).toContain(mirrorPath)
    expect(state.message).toContain(authorityPath)
    expect(state.message).toContain('"HWG"')
    expect(state.message).toContain('"CRY"')
    expect(state.message).toMatch(/does not match/)
  })

  it('never proposes a silent repair for a mismatch', () => {
    const { message } = classifyPrefixConsistency({
      gymId,
      authority: 'CRY',
      mirror: 'HWG',
      settingsExists: true,
    })
    expect(message).toMatch(/Neither value is changed automatically/)
    expect(message).toMatch(/operator must decide/)
  })

  it('refuses a mirror without an authority instead of promoting it (state D)', () => {
    for (const authority of [undefined, null, '', 'has spaces', 'toolongprefix']) {
      const state = classifyPrefixConsistency({
        gymId,
        authority,
        mirror: 'HWG',
        settingsExists: true,
      })
      expect(state.state).toBe(PREFIX_CONSISTENCY.AUTHORITY_MISSING)
      expect(state.blocking).toBe(true)
      expect(state.message).toContain(mirrorPath)
      expect(state.message).toContain(authorityPath)
      expect(state.message).toMatch(/never promoted to authority/)
      expect(state.message).toMatch(/declares the prefix/)
    }
  })

  it('says nothing about a gym that simply has no settings yet', () => {
    const state = classifyPrefixConsistency({
      gymId,
      authority: undefined,
      mirror: undefined,
      settingsExists: false,
    })
    expect(state.state).toBe(PREFIX_CONSISTENCY.SETTINGS_ABSENT)
    expect(state.blocking).toBe(false)
  })

  it('names both paths with the real gym id, not a placeholder', () => {
    const { message } = classifyPrefixConsistency({
      gymId: 'abc123',
      authority: 'AAAA',
      mirror: 'BBBB',
      settingsExists: true,
    })
    expect(message).toContain('gyms/abc123')
    expect(message).toContain('gyms/abc123/settings/app')
    expect(message).not.toContain('{gymId}')
  })
})
