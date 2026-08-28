import { describe, beforeEach, expect, it, vi } from 'vitest'
import { ensureGymTenancy } from '@/services/migration'
import { getGymId } from '@/services/ownerContext'
import { listAllUnscoped, updateDocById, isReady, getById, upsertDoc } from '@/services/firestore'
import { logAudit } from '@/services/audit'

const BUSINESS_COLLECTIONS = [
  'members',
  'membershipPlans',
  'memberships',
  'payments',
  'expenses',
  'attendance',
  'classes',
  'bookings',
  'trainers',
]

vi.mock('@/services/firestore', () => {
  const store = {}
  for (const name of [
    'members',
    'membershipPlans',
    'memberships',
    'payments',
    'expenses',
    'attendance',
    'classes',
    'bookings',
    'trainers',
    'counters',
  ]) {
    store[name] = []
  }
  return {
    createDoc: vi.fn(async () => 'mock'),
    listAll: vi.fn(async (name) => store[name]),
    isReady: vi.fn(() => true),
    listAllUnscoped: vi.fn(async (name) => [...store[name]]),
    getById: vi.fn(async (name, id) => store[name].find((d) => d.id === id) || null),
    updateDocById: vi.fn(async (name, id, data) => {
      const doc = store[name].find((d) => d.id === id)
      if (doc) Object.assign(doc, data)
    }),
    upsertDoc: vi.fn(async (name, id, data) => {
      const existing = store[name].find((d) => d.id === id)
      if (existing) Object.assign(existing, data)
      else store[name].push({ id, ...data })
    }),
    __tenancyStore: store,
  }
})

vi.mock('@/services/audit', () => ({ logAudit: vi.fn(async () => {}) }))
vi.mock('@/services/ownerContext', () => ({ getGymId: vi.fn(() => 'gym-1') }))

const store = (await import('@/services/firestore')).__tenancyStore

beforeEach(() => {
  for (const name of BUSINESS_COLLECTIONS) store[name] = []
  store.counters = []
  vi.mocked(isReady).mockReturnValue(true)
  vi.mocked(getGymId).mockReturnValue('gym-1')
  vi.mocked(logAudit).mockClear()
  vi.mocked(listAllUnscoped).mockClear()
  vi.mocked(updateDocById).mockClear()
  vi.mocked(getById).mockClear()
  vi.mocked(upsertDoc).mockClear()
})

describe('ensureGymTenancy', () => {
  it('does nothing and reports no-gym when the caller has no bound gym', async () => {
    vi.mocked(getGymId).mockReturnValue(null)
    const result = await ensureGymTenancy()
    expect(result.status).toBe('no-gym')
    expect(updateDocById).not.toHaveBeenCalled()
  })

  it('reports demo in offline/mock mode', async () => {
    vi.mocked(isReady).mockReturnValue(false)
    const result = await ensureGymTenancy()
    expect(result.status).toBe('demo')
    expect(updateDocById).not.toHaveBeenCalled()
  })

  it('tags records missing a gymId and counts them', async () => {
    store.members = [{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B', gymId: 'gym-9' }]
    store.payments = [{ id: 'p1', amount: 100 }]

    const result = await ensureGymTenancy()

    expect(result.status).toBe('ok')
    expect(result.tagged).toBe(2)
    // m1 (no gymId) gets tagged; m2 (already gym-9) is left untouched
    expect(store.members.find((m) => m.id === 'm1').gymId).toBe('gym-1')
    expect(store.members.find((m) => m.id === 'm2').gymId).toBe('gym-9')
    expect(store.payments[0].gymId).toBe('gym-1')
    expect(logAudit).toHaveBeenCalled()
  })

  it('is idempotent — a second run tags zero records', async () => {
    store.members = [{ id: 'm1', name: 'A' }]
    await ensureGymTenancy()
    vi.mocked(updateDocById).mockClear()
    vi.mocked(logAudit).mockClear()

    const result = await ensureGymTenancy()
    expect(result.status).toBe('ok')
    expect(result.tagged).toBe(0)
    expect(updateDocById).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('never overwrites an existing valid gymId', async () => {
    store.expenses = [{ id: 'e1', title: 'Rent', gymId: 'other-gym' }]
    const result = await ensureGymTenancy()
    expect(result.tagged).toBe(0)
    expect(store.expenses[0].gymId).toBe('other-gym')
    expect(updateDocById).not.toHaveBeenCalled()
  })

  it('provisions the per-gym member-number counter seeded from existing members', async () => {
    store.members = [
      { id: 'm1', name: 'A', memberNo: 'MEM-0003' },
      { id: 'm2', name: 'B', memberNo: 'MEM-0009' },
    ]

    const result = await ensureGymTenancy()

    expect(result.countersCreated).toBe(1)
    const counter = store.counters.find((c) => c.id === 'memberNo_gym-1')
    expect(counter).toBeTruthy()
    expect(counter.value).toBe(9)
    // seeding is scoped to the bound gym id
    expect(counter.gymId).toBe('gym-1')
  })

  it('seeds the counter at 0 when the gym has no members yet', async () => {
    const result = await ensureGymTenancy()

    expect(result.countersCreated).toBe(1)
    const counter = store.counters.find((c) => c.id === 'memberNo_gym-1')
    expect(counter.value).toBe(0)
  })

  it('does not overwrite an already-provisioned member-number counter', async () => {
    store.counters = [{ id: 'memberNo_gym-1', value: 14, gymId: 'gym-1' }]
    store.members = [{ id: 'm1', name: 'A', memberNo: 'MEM-0003' }]

    const result = await ensureGymTenancy()

    expect(result.countersCreated).toBe(0)
    // the existing counter and its value are left untouched
    expect(store.counters[0].value).toBe(14)
    expect(upsertDoc).not.toHaveBeenCalled()
  })
})
