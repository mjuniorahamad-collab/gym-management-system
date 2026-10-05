/**
 * Tenant settings bootstrap policy tests.
 *
 * These lock in the Phase 4C hardening: the bootstrap that creates
 * `gyms/{gymId}/settings/app` must never invent a gym identity, receipt
 * numbering, or branding. Every case below corresponds to a real failure mode
 * found in production data or in the previous implementation.
 *
 * This suite is deliberately pure — `src/services/tenantSettings.js` imports no
 * Firebase code — so the same policy object the app writes with is the one the
 * offline migration script plans with.
 */

import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_STRATEGY,
  OWNER_DECISION_FIELDS,
  REQUIRED_SETTINGS_FIELDS,
  SAFE_DEFAULTS,
  buildTenantSettingsSeed,
  classifyGymsForBootstrap,
  describeSettingsCompleteness,
  withSettingsFallbacks,
} from '@/services/tenantSettings'
import {
  buildRollback,
  gateRows,
  normaliseSnapshot,
} from '../../functions/projection/tenantSettingsBootstrap.js'

const CRYSTAL = { name: 'Crystal gym', tagline: 'Discipline Strength ' }
const OXYGEN = { name: 'Oxygen Gym Kandhla', tagline: '' }
const NAMELESS = { tagline: 'Discipline Strength' }

describe('buildTenantSettingsSeed', () => {
  // 1. The ordinary case: a readable owner-of-record document.
  it('seeds gymName and tagline from the tenant record for a valid gym', () => {
    const result = buildTenantSettingsSeed({ gymId: 'gym-crystal', gym: CRYSTAL })

    expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.SEED_DERIVED)
    expect(result.write).toMatchObject({
      gymId: 'gym-crystal',
      gymName: 'Crystal gym',
      // Trailing whitespace from onboarding is normalised; the words are not.
      tagline: 'Discipline Strength',
      currency: 'INR',
      dateFormat: 'MMM D, YYYY',
      timezone: 'Asia/Kolkata',
    })
    expect(result.deferred).toEqual(OWNER_DECISION_FIELDS)
  })

  // 6 + the explicit-empty-tagline requirement: an owner who left the tagline
  // blank must not have copy substituted for them.
  it('preserves an explicitly empty tagline instead of inventing one', () => {
    const result = buildTenantSettingsSeed({ gymId: 'gym-oxygen', gym: OXYGEN })

    expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.SEED_DERIVED)
    expect(result.write.tagline).toBe('')
    expect(result.write.tagline).not.toMatch(/Strength|Discipline|Growth/i)
  })

  it('treats a missing tagline as empty rather than as branding', () => {
    const result = buildTenantSettingsSeed({ gymId: 'gym-x', gym: { name: 'Gym X' } })

    expect(result.write.tagline).toBe('')
  })

  // 2. The tenant record could not be read. This is the case that previously
  // fell through to DEFAULT_SETTINGS and produced 'Himalye Wonders Gym'.
  it('refuses to seed when the tenant record is missing or unreadable', () => {
    for (const gym of [null, undefined, 'not-an-object', 42]) {
      const result = buildTenantSettingsSeed({ gymId: 'gym-1', gym })
      expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.REFUSED_NO_TENANT_RECORD)
      expect(result.write).toBeNull()
    }
  })

  it('refuses to seed when the tenant record carries no usable name', () => {
    for (const gym of [NAMELESS, { name: '' }, { name: '   ' }, { name: 'x' }, { name: 'G'.repeat(81) }]) {
      const result = buildTenantSettingsSeed({ gymId: 'gym-1', gym })
      expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.REFUSED_UNUSABLE_TENANT_IDENTITY)
      expect(result.write).toBeNull()
    }
  })

  // 3. No bound gym: an unbound account has no tenant to configure.
  it('refuses to seed when no gym is bound to the account', () => {
    for (const gymId of [undefined, null, '', '   ', 12345, {}]) {
      const result = buildTenantSettingsSeed({ gymId, gym: CRYSTAL })
      expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.REFUSED_NO_GYM)
      expect(result.write).toBeNull()
    }
  })

  // 4. Two gyms can legitimately share a display name. Tenancy is by document
  // id, so a collision must change nothing about what gets written.
  it('seeds each gym independently when display names collide', () => {
    const a = buildTenantSettingsSeed({ gymId: 'gym-1', gym: { name: 'Oxygen Gym' } })
    const b = buildTenantSettingsSeed({ gymId: 'gym-2', gym: { name: 'Oxygen Gym' } })

    expect(a.write.gymId).toBe('gym-1')
    expect(b.write.gymId).toBe('gym-2')
    expect(a.write.gymName).toBe('Oxygen Gym')
    expect(b.write.gymName).toBe('Oxygen Gym')
  })

  // 5. The single most important property: never clobber real owner data.
  it('never modifies an existing settings document', () => {
    const existing = {
      gymName: 'Oxygen Gym Kandhla',
      receiptPrefix: '001',
      currency: 'INR',
      dateFormat: 'MMM D, YYYY',
      timezone: 'Asia/Kolkata',
      tagline: '',
    }
    const result = buildTenantSettingsSeed({
      gymId: 'gym-oxygen',
      gym: { name: 'RENAMED GYM', tagline: 'NEW COPY' },
      existing,
    })

    expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.SKIP_EXISTING)
    expect(result.write).toBeNull()
    expect(existing.receiptPrefix).toBe('001')
  })

  it('skips an existing document even when the tenant record is unreadable', () => {
    // Existence is checked before identity so a transient read failure can
    // never be mistaken for permission to rewrite a configured document.
    const result = buildTenantSettingsSeed({
      gymId: 'gym-1',
      gym: null,
      existing: { gymName: 'Crystal gym' },
    })

    expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.SKIP_EXISTING)
    expect(result.write).toBeNull()
  })

  // 8. Values that belong to a business decision, not to a bootstrap.
  it('never seeds a receipt prefix, logo path, or link', () => {
    const result = buildTenantSettingsSeed({ gymId: 'gym-1', gym: CRYSTAL })

    expect(result.write).not.toHaveProperty('receiptPrefix')
    expect(result.write).not.toHaveProperty('logoPath')
    expect(result.write).not.toHaveProperty('logoUrl')
    expect(result.write).not.toHaveProperty('ptSurcharge')
    expect(result.write).not.toHaveProperty('whatsappLink')

    // Nothing anywhere in the payload may carry the previous invented values.
    // The tagline here is legitimately "Discipline Strength" because that is
    // what this gym's own record says; the check is that the INVENTED copy is
    // absent, not that the tenant's own words are.
    const serialised = JSON.stringify(result.write)
    expect(serialised).not.toContain('HWG')
    expect(serialised).not.toContain('Himalye')
    expect(serialised).not.toContain('Growing')
    expect(result.write.tagline).not.toBe('Strength • Discipline • Growing')
  })

  // 9. Owner-only write contract. firestore.rules requires an owner write to
  // carry the caller's own bound gymId, so the seed must always be self-consistent.
  it('always stamps the seed with the gym it was built for', () => {
    const result = buildTenantSettingsSeed({ gymId: '  gym-1  ', gym: CRYSTAL })

    expect(result.gymId).toBe('gym-1')
    expect(result.write.gymId).toBe('gym-1')
  })

  it('writes no owner-scoped fields the rules would have to infer', () => {
    // If the seed carried its own notion of "who is allowed", a change to it
    // could widen or narrow the rules' intent. It carries none.
    const result = buildTenantSettingsSeed({ gymId: 'gym-1', gym: CRYSTAL })

    expect(Object.keys(result.write).sort()).toEqual(
      ['currency', 'dateFormat', 'gymId', 'gymName', 'tagline', 'timezone'].sort()
    )
  })

  // 7. Deterministic defaults: same input, same output, no clock or randomness.
  it('is deterministic across repeated builds', () => {
    const runs = Array.from({ length: 5 }, () =>
      buildTenantSettingsSeed({ gymId: 'gym-1', gym: CRYSTAL }).write
    )

    for (const run of runs) expect(run).toEqual(runs[0])
    expect(runs[0]).toMatchObject(SAFE_DEFAULTS)
  })

  it('returns a refusal instead of throwing for a completely empty call', () => {
    const result = buildTenantSettingsSeed()

    expect(result.strategy).toBe(BOOTSTRAP_STRATEGY.REFUSED_NO_GYM)
    expect(result.write).toBeNull()
    expect(result.missingRequired).toEqual(OWNER_DECISION_FIELDS)
  })
})

describe('describeSettingsCompleteness', () => {
  it('reports a fully configured gym as complete', () => {
    const result = describeSettingsCompleteness({
      gymName: 'Crystal gym',
      currency: 'INR',
      dateFormat: 'MMM D, YYYY',
      receiptPrefix: 'CRY',
      timezone: 'Asia/Kolkata',
    })

    expect(result).toEqual({ complete: true, missing: [] })
  })

  it('reports the receipt prefix as outstanding on a seeded document', () => {
    const seeded = buildTenantSettingsSeed({ gymId: 'gym-1', gym: CRYSTAL }).write
    const result = describeSettingsCompleteness(seeded)

    expect(result.complete).toBe(false)
    expect(result.missing).toEqual(['receiptPrefix'])
  })

  it('reports an entirely unset document as missing everything required', () => {
    for (const stored of [null, undefined, {}, 'nope', { gymName: '  ' }]) {
      const result = describeSettingsCompleteness(stored)
      expect(result.complete).toBe(false)
      expect(result.missing).toEqual(expect.arrayContaining(REQUIRED_SETTINGS_FIELDS))
    }
  })

  it('treats an unresolvable timezone as outstanding', () => {
    const result = describeSettingsCompleteness({
      gymName: 'Crystal gym',
      currency: 'INR',
      dateFormat: 'MMM D, YYYY',
      receiptPrefix: 'CRY',
      timezone: 'Mars/Olympus_Mons',
    })

    expect(result.missing).toContain('timezone')
  })
})

describe('withSettingsFallbacks', () => {
  it('does not disguise an unset gym name as a configured one', () => {
    const merged = withSettingsFallbacks({ receiptPrefix: 'CRY' })

    expect(merged.gymName).toBe('')
    expect(merged.currency).toBe('INR')
  })

  it('falls back only to the tenant record name, never to another gym branding', () => {
    expect(withSettingsFallbacks({}, 'Crystal gym').gymName).toBe('Crystal gym')
    expect(withSettingsFallbacks({ gymName: '' }, 'Crystal gym').gymName).toBe('Crystal gym')
    expect(withSettingsFallbacks({ gymName: 'Crystal gym' }, 'Other name').gymName).toBe('Crystal gym')
  })

  it('lets a stored value win over the fallback', () => {
    const merged = withSettingsFallbacks({ gymName: 'Crystal gym', currency: 'AED' }, 'Other name')

    expect(merged.gymName).toBe('Crystal gym')
    expect(merged.currency).toBe('AED')
  })

  it('never reintroduces the previous invented branding', () => {
    const merged = withSettingsFallbacks(null, 'Crystal gym')

    expect(merged.gymName).toBe('Crystal gym')
    expect(merged.receiptPrefix).toBeUndefined()
    expect(merged.tagline).toBe('')
  })
})

describe('classifyGymsForBootstrap', () => {
  it('flags a gym with no members as refusing bootstrap', () => {
    // An abandoned self-provisioning attempt has a readable record but no
    // evidence it is the tenant in use. Seeding it would create a second
    // plausible-looking settings document for a gym nobody uses.
    const [row] = classifyGymsForBootstrap([
      { id: 'gym-1', name: 'Crystal gym', tagline: '', memberCount: 0 },
    ])

    expect(row.classification).toBe('refused-no-activity')
    expect(row.write).toBeTruthy() // the seed is computed, but not proposed for write
  })

  it('marks an in-use gym with no settings as seed-safe', () => {
    const [row] = classifyGymsForBootstrap([
      { id: 'gym-1', name: 'Crystal gym', tagline: '', memberCount: 3 },
    ])

    expect(row.classification).toBe('seed-safe')
    expect(row.write.gymId).toBe('gym-1')
  })

  it('marks a configured gym as already-configured and proposes no write', () => {
    const [row] = classifyGymsForBootstrap([
      {
        id: 'gym-1',
        name: 'Crystal gym',
        memberCount: 27,
        settingsDoc: { gymName: 'Crystal gym', receiptPrefix: 'CRY' },
      },
    ])

    expect(row.classification).toBe('already-configured')
    expect(row.write).toBeNull()
  })

  it('flags display-name collisions without changing the outcome', () => {
    const rows = classifyGymsForBootstrap([
      { id: 'gym-1', name: 'Oxygen Gym Kandhla', memberCount: 8 },
      { id: 'gym-2', name: 'Oxygen Gym Kandhla', memberCount: 0 },
    ])

    expect(rows.every((r) => r.sharesDisplayName)).toBe(true)
    expect(rows[0].write.gymId).toBe('gym-1')
    expect(rows[0].classification).toBe('seed-safe')
    expect(rows[1].classification).toBe('refused-no-activity')
  })

  it('handles a missing gym list without throwing', () => {
    expect(classifyGymsForBootstrap(null)).toEqual([])
  })

  it('distinguishes "checked, none found" from "never checked"', () => {
    // Only an explicit check may authorise a create. An omitted settingsDoc
    // means the caller never looked, and must not be read as "absent".
    const [checked] = classifyGymsForBootstrap([
      { id: 'gym-1', name: 'Crystal gym', memberCount: 3, settingsDoc: null },
    ])
    const [unchecked] = classifyGymsForBootstrap([
      { id: 'gym-1', name: 'Crystal gym', memberCount: 3 },
    ])

    expect(checked.settingsChecked).toBe(true)
    expect(checked.classification).toBe('seed-safe')
    expect(unchecked.settingsChecked).toBe(false)
  })
})

/**
 * Round trip through the operator tool's own planner.
 *
 * `gateRows` and `normaliseSnapshot` live in functions/projection/
 * tenantSettingsBootstrap.js because the apply path needs the Admin SDK that
 * functions/ owns. They are pure, so the offline plan the CLI prints is covered
 * here alongside the policy it composes with. The apply path itself is unit
 * tested in functions/test/, which runs in plain Node with an injected handle.
 */
describe('init-tenant-settings planner round trip', () => {
  it('proposes a create for a live gym whose settings are known absent', () => {
    const rows = gateRows(
      classifyGymsForBootstrap(
        normaliseSnapshot({
          gyms: [{ id: 'gym-1', data: { name: 'Crystal gym' }, memberCount: 3, settingsDoc: null }],
        })
      )
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].writable).toBe(true)
    expect(rows[0].blockedBy).toEqual([])
    expect(rows[0].write.gymId).toBe('gym-1')
    // Still an owner decision after gating.
    expect(rows[0].write).not.toHaveProperty('receiptPrefix')
  })

  it('refuses to plan anything from an empty snapshot', () => {
    expect(() => normaliseSnapshot({ gyms: [] })).toThrow(/no gyms/i)
  })

  it('blocks a gym whose member count the snapshot never established', () => {
    const [row] = gateRows(
      classifyGymsForBootstrap(
        normaliseSnapshot({ gyms: [{ id: 'gym-1', data: { name: 'Crystal gym' }, settingsDoc: null }] })
      )
    )

    expect(row.writable).toBe(false)
    expect(row.blockedBy.join(' ')).toMatch(/member count unknown/i)
  })

  it('blocks a gym with no members as a presumed abandoned attempt', () => {
    const [row] = gateRows(
      classifyGymsForBootstrap(
        normaliseSnapshot({
          gyms: [{ id: 'gym-1', data: { name: 'Crystal gym' }, memberCount: 0, settingsDoc: null }],
        })
      )
    )

    expect(row.writable).toBe(false)
    expect(row.blockedBy.join(' ')).toMatch(/no members/i)
  })

  it('blocks an existing gym, so nothing is ever overwritten', () => {
    const [row] = gateRows(
      classifyGymsForBootstrap(
        normaliseSnapshot({
          gyms: [
            {
              id: 'gym-1',
              data: { name: 'Crystal gym' },
              memberCount: 9,
              settingsDoc: { gymName: 'Crystal gym', receiptPrefix: 'CRY' },
            },
          ],
        })
      )
    )

    expect(row.classification).toBe('already-configured')
    expect(row.writable).toBe(false)
    expect(row.write).toBeNull()
  })

  it('builds a delete-only rollback listing for exactly the writable rows', () => {
    const rows = gateRows(
      classifyGymsForBootstrap(
        normaliseSnapshot({
          gyms: [
            { id: 'gym-1', data: { name: 'Crystal gym' }, memberCount: 3, settingsDoc: null },
            { id: 'gym-2', data: { name: 'Ghost gym' }, memberCount: 0, settingsDoc: null },
          ],
        })
      )
    )

    const rollback = buildRollback(rows)
    expect(rollback.strategy).toBe('delete-only')
    expect(rollback.paths.map((p) => p.path)).toEqual(['gyms/gym-1/settings/app'])
  })
})