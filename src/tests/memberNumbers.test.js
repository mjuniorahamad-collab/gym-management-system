import { describe, beforeEach, expect, it, vi } from 'vitest'
import { formatMemberNo, MEMBER_NO_PREFIX, parseMemberNo } from '@/utils/memberNo'
import { backfillMemberNumbers, nextMemberNo } from '@/services/memberNumbers'
import { createDoc } from '@/services/firestore'
import { mockList, store } from '@/services/mockStore'

vi.mock('@/firebase', () => ({
  isFirebaseConfigured: false,
  db: null,
  app: null,
  auth: null,
  storage: null,
}))

beforeEach(() => {
  mockList('members')
  store.members.forEach((m) => {
    delete m.memberNo
  })
  store.counters = {}
})

describe('memberNo helpers', () => {
  it('uses a generic, non gym-specific prefix', () => {
    expect(MEMBER_NO_PREFIX).toBe('MEM')
  })

  it('formats zero-padded 4-digit numbers', () => {
    expect(formatMemberNo(1)).toBe('MEM-0001')
    expect(formatMemberNo(42)).toBe('MEM-0042')
    expect(formatMemberNo(9999)).toBe('MEM-9999')
    expect(formatMemberNo(10000)).toBe('MEM-10000')
  })

  it('parses member numbers back to integers', () => {
    expect(parseMemberNo('MEM-0007')).toBe(7)
    expect(parseMemberNo('mem-0007')).toBe(7)
    expect(parseMemberNo('A-1001')).toBeNull()
    expect(parseMemberNo('MEM-x')).toBeNull()
    expect(parseMemberNo(undefined)).toBeNull()
    expect(parseMemberNo(null)).toBeNull()
  })

  it('round-trips format(parse(value))', () => {
    expect(formatMemberNo(parseMemberNo('MEM-0012'))).toBe('MEM-0012')
  })
})

describe('nextMemberNo', () => {
  it('returns sequential unique numbers starting at MEM-0001', async () => {
    const a = await nextMemberNo()
    const b = await nextMemberNo()
    const c = await nextMemberNo()
    expect(a).toBe('MEM-0001')
    expect(b).toBe('MEM-0002')
    expect(c).toBe('MEM-0003')
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('createDoc auto-assignment', () => {
  it('auto-assigns a stable memberNo when creating a member', async () => {
    const id = await createDoc('members', { name: 'Test Member' })
    const doc = store.members.find((m) => m.id === id)
    expect(doc).toBeTruthy()
    expect(doc.memberNo).toBe('MEM-0001')
  })

  it('does not assign memberNo to other collections', async () => {
    await createDoc('expenses', { title: 'Rent' })
    expect(store.expenses[0].memberNo).toBeUndefined()
  })
})

describe('backfillMemberNumbers', () => {
  it('assigns unique sequential numbers to existing members without changing document ids', async () => {
    const idsBefore = store.members.map((m) => m.id)
    const count = await backfillMemberNumbers()

    expect(count).toBe(store.members.length)
    expect(store.members.map((m) => m.id)).toEqual(idsBefore)

    const numbers = store.members.map((m) => m.memberNo)
    expect(new Set(numbers).size).toBe(numbers.length)
    store.members.forEach((m) => expect(parseMemberNo(m.memberNo)).not.toBeNull())
  })

  it('is idempotent — already-numbered members are left untouched', async () => {
    store.members.forEach((m, i) => {
      m.memberNo = formatMemberNo(100 + i)
    })
    const count = await backfillMemberNumbers()
    expect(count).toBe(0)
    expect(store.members.map((m) => m.memberNo)).toEqual(store.members.map((m, i) => formatMemberNo(100 + i)))
  })
})
