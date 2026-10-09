import { describe, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as migration from '@/services/migration'
import { createDoc, listAll } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { computeMemberLedger } from '@/utils/dues'

vi.mock('@/services/firestore', () => ({
  createDoc: vi.fn(async () => 'mock'),
  listAll: vi.fn(async () => []),
}))

vi.mock('@/services/audit', () => ({ logAudit: vi.fn(async () => {}) }))

// countPendingOriginPeriods now delegates to computeMemberFinanceRollups, which
// owns the counting. The rollup is mirrored here on top of the stubbed ledger
// engine so this file keeps asserting the same counting behaviour, while the
// real rollup's results are covered against real data in financeRollups.test.js.
const { duesMock } = vi.hoisted(() => {
  const computeMemberLedger = vi.fn(() => ({ periods: [] }))
  const computeMemberFinanceRollups = vi.fn(
    ({ members = [], plans = [], payments = [], memberships = [], ptSurcharge = 0 }) => {
      let pendingOriginPeriods = 0
      for (const member of members) {
        const ledger = computeMemberLedger({ member, plans, payments, memberships, ptSurcharge })
        if (ledger.periods.some((p) => p.implicit)) pendingOriginPeriods += 1
      }
      return { dues: { rows: [], totalDue: 0, count: 0 }, pendingOriginPeriods }
    }
  )
  return { duesMock: { computeMemberLedger, computeMemberFinanceRollups } }
})

vi.mock('@/utils/dues', () => duesMock)

/** Reads a source file with comments stripped, so these guards assert on
 *  executable code rather than on prose that merely names a removed symbol. */
const read = (rel) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

beforeEach(() => {
  vi.mocked(createDoc).mockClear()
  vi.mocked(listAll).mockClear()
  vi.mocked(logAudit).mockClear()
  vi.mocked(computeMemberLedger).mockReturnValue({ periods: [] })
})

describe('client tenancy claiming has been removed', () => {
  it('no longer exports ensureGymTenancy', () => {
    expect(migration.ensureGymTenancy).toBeUndefined()
  })

  it('firestore.js never declares an unscoped enumeration helper', () => {
    // A source-level guard is used here because this file mocks the firestore
    // module, so its runtime namespace cannot prove the real export surface.
    expect(read('../services/firestore.js')).not.toMatch(/listAllUnscoped/)
  })

  it('migration.js never enumerates a collection unscoped', () => {
    const source = read('../services/migration.js')
    expect(source).not.toMatch(/listAllUnscoped/)
    expect(source).not.toMatch(/TENANCY_COLLECTIONS/)
  })

  it('App.jsx does not auto-run a tenancy backfill on startup', () => {
    const source = read('../App.jsx')
    expect(source).not.toMatch(/TenancyBootstrap/)
    expect(source).not.toMatch(/ensureGymTenancy/)
  })

  it('Settings.jsx does not expose a tenant re-sync action', () => {
    const source = read('../pages/Settings.jsx')
    expect(source).not.toMatch(/ensureGymTenancy/)
    expect(source).not.toMatch(/handleTenancySync/)
  })

  it('settings are read from the tenant-scoped path, never the global singleton', () => {
    const contextSource = read('../context/SettingsContext.jsx')
    const docSource = read('../services/tenantSettingsDoc.js')
    // The scoped document lives under gyms/{gymId}/settings/app.
    expect(docSource).toMatch(
      /doc\(\s*db,\s*'gyms',\s*gymId,\s*'settings',\s*TENANT_SETTINGS_DOC\s*\)/
    )
    // There must be no read or write against the shared `settings/app`.
    expect(docSource).not.toMatch(/doc\(\s*db,\s*'settings'/)
    expect(contextSource).not.toMatch(/doc\(\s*db,\s*'settings'/)
  })
})

describe('ensureOriginPeriods (finance backfill, retained)', () => {
  beforeEach(() => {
    vi.mocked(listAll).mockImplementation(async (name) => {
      if (name === 'members') return [{ id: 'm1', membershipPlanId: 'plan-1', name: 'A' }]
      if (name === 'membershipPlans') return [{ id: 'plan-1', name: 'Monthly', price: 1000 }]
      return []
    })
  })

  it('creates nothing when no member has an implicit origin period', async () => {
    const result = await migration.ensureOriginPeriods()
    expect(result).toEqual({ created: 0 })
    expect(createDoc).not.toHaveBeenCalled()
  })

  it('materializes each implicit period through the scoped createDoc helper', async () => {
    vi.mocked(computeMemberLedger).mockReturnValue({
      periods: [
        {
          implicit: true,
          label: 'Monthly (earlier)',
          planId: 'plan-1',
          startDate: '2026-01-01',
          expiryDate: '2026-01-31',
          price: 1000,
          paid: 1000,
          due: 0,
          status: 'paid',
        },
      ],
    })

    const result = await migration.ensureOriginPeriods()

    expect(result).toEqual({ created: 1 })
    expect(createDoc).toHaveBeenCalledTimes(1)
    const [collection, payload] = vi.mocked(createDoc).mock.calls[0]
    expect(collection).toBe('memberships')
    expect(payload.memberId).toBe('m1')
    expect(payload.planId).toBe('plan-1')
    // Flagged for review, and the helper stamps the gymId itself so a
    // document can never be written outside the caller's own gym.
    expect(payload.migratedFromLegacy).toBe(true)
    expect(payload).not.toHaveProperty('gymId')
    expect(logAudit).toHaveBeenCalled()
  })
})

describe('countPendingOriginPeriods', () => {
  it('counts members whose ledger still has an implicit period', () => {
    vi.mocked(computeMemberLedger).mockImplementation(({ member }) => ({
      periods: [{ implicit: member.needsRebuild === true }],
    }))

    const count = migration.countPendingOriginPeriods({
      members: [{ id: 'a', needsRebuild: true }, { id: 'b' }, { id: 'c', needsRebuild: true }],
    })

    expect(count).toBe(2)
  })

  it('is zero for an empty member set', () => {
    expect(migration.countPendingOriginPeriods()).toBe(0)
  })
})
