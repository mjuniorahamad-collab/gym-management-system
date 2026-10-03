import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    where: vi.fn((...a) => ({ kind: 'where', a })),
    orderBy: vi.fn((...a) => ({ kind: 'orderBy', a })),
    limit: vi.fn((...a) => ({ kind: 'limit', a })),
    getDocs: vi.fn(),
    getGymId: vi.fn(() => 'gym-1'),
    isFirebaseConfigured: true,
    db: {},
  },
}))

vi.mock('firebase/firestore', () => ({
  collection: (db, name) => ({ kind: 'collection', db, name }),
  query: (...parts) => ({ kind: 'query', parts }),
  getDocs: mocks.getDocs,
  where: mocks.where,
  orderBy: mocks.orderBy,
  limit: mocks.limit,
}))

vi.mock('@/firebase', () => ({
  db: mocks.db,
  isFirebaseConfigured: mocks.isFirebaseConfigured,
}))
vi.mock('@/services/ownerContext', () => ({ getGymId: mocks.getGymId }))

const loadModule = async () => {
  vi.resetModules()
  return import('@/services/rangeQueries')
}

describe('bounded range query constraints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getGymId.mockReturnValue('gym-1')
    mocks.isFirebaseConfigured = true
    mocks.getDocs.mockResolvedValue({ docs: [] })
  })

  it('scopes to the gym and bounds the date field inclusively', async () => {
    const { rangeConstraints } = await loadModule()
    rangeConstraints({ from: '2026-01-01', to: '2026-01-31' }, 'Asia/Kolkata', 'date')

    expect(mocks.where).toHaveBeenNthCalledWith(1, 'gymId', '==', 'gym-1')
    // Bounds are UTC instants covering the whole gym-local day.
    expect(mocks.where).toHaveBeenNthCalledWith(2, 'date', '>=', '2025-12-31T18:30:00.000Z')
    expect(mocks.where).toHaveBeenNthCalledWith(3, 'date', '<=', '2026-01-31T18:29:59.999Z')
    expect(mocks.orderBy).toHaveBeenCalledWith('date', 'asc')
  })

  it('uses the gym timezone, so the end day is not truncated', async () => {
    const { rangeConstraints } = await loadModule()
    rangeConstraints({ from: '2026-01-01', to: '2026-01-31' }, 'America/New_York', 'date')
    // 23:59:59.999 in New York on the 31st.
    expect(mocks.where).toHaveBeenNthCalledWith(3, 'date', '<=', '2026-02-01T04:59:59.999Z')
  })

  /**
   * A query with no tenant constraint would match every gym's rows. Returning an
   * unsatisfiable constraint means "nothing" rather than "everything", which is
   * the same defensive stance services/firestore.js takes.
   */
  it('refuses to build a queryable range before tenancy is established', async () => {
    mocks.getGymId.mockReturnValue(null)
    const { rangeConstraints } = await loadModule()
    const c = rangeConstraints({ from: '2026-01-01', to: '2026-01-31' }, 'Asia/Kolkata', 'date')
    expect(c).toHaveLength(1)
    expect(mocks.where).toHaveBeenCalledWith('__unbound__', '==', '__impossible__')
  })

  it('returns nothing without a usable range rather than reading everything', async () => {
    const { fetchRange } = await loadModule()
    await expect(fetchRange('payments', null, 'Asia/Kolkata')).resolves.toEqual([])
    await expect(fetchRange('payments', { from: '', to: '' }, 'Asia/Kolkata')).resolves.toEqual([])
    expect(mocks.getDocs).not.toHaveBeenCalled()
  })

  it('rejects a collection with no mapped date field instead of guessing', async () => {
    const { fetchRange } = await loadModule()
    await expect(fetchRange('members', { from: '2026-01-01', to: '2026-01-31' }, 'Asia/Kolkata'))
      .rejects.toThrow(/No date field is mapped/)
  })

  it('applies a safety row limit', async () => {
    const { fetchRange } = await loadModule()
    await fetchRange('payments', { from: '2026-01-01', to: '2026-01-31' }, 'Asia/Kolkata', {
      maxRows: 100,
    })
    expect(mocks.limit).toHaveBeenCalledWith(100)
  })
})