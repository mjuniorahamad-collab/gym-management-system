import { describe, beforeEach, expect, it, vi } from 'vitest'
import { addDays, startOfDay, toDateInputValue } from '@/utils/dateHelpers'
import {
  addWeightRecord,
  updateWeightRecord,
  deleteWeightRecord,
  setFitnessGoal,
  parseWeightHistory,
  validateWeightRecord,
} from '@/services/weightRecords'
import { weightRecordSchema, fitnessGoalSchema } from '@/schemas/validationSchemas'
import { __store } from '@/services/firestore'

vi.mock('@/services/firestore', () => {
  const store = { members: [], weightRecords: [], auditLog: [] }
  return {
    __store: store,
    isReady: () => true,
    listAll: async (name) => store[name],
    getById: async (name, id) => store[name].find((d) => d.id === id) || null,
    createDoc: async (name, data) => {
      const id = `mock-${name}-${store[name].length + 1}`
      const doc = { id, ...data }
      store[name].push(doc)
      return id
    },
    updateDocById: async (name, id, data) => {
      const doc = store[name].find((d) => d.id === id)
      if (doc) Object.assign(doc, data)
    },
    removeDoc: async (name, id) => {
      store[name] = store[name].filter((d) => d.id !== id)
    },
  }
})

// Suppress audit logging noise (it writes to mock auditLog via createDoc).
vi.mock('@/services/audit', () => ({ logAudit: vi.fn(async () => {}) }))

const today = () => startOfDay(new Date())
const daysAgo = (n) => toDateInputValue(addDays(today(), -n))

function member(id = 'm1', overrides = {}) {
  return { id, name: 'Test Member', fitnessGoal: '', targetWeight: '', ...overrides }
}

function seedMember() {
  __store.members.push(member('m1'))
}

function weight(id, weight, date, overrides = {}) {
  return { id, memberId: 'm1', weight, date, ...overrides }
}

describe('weightRecords service', () => {
  beforeEach(() => {
    __store.members = []
    __store.weightRecords = []
    __store.auditLog = []
  })

  describe('addWeightRecord', () => {
    it('adds a first weight entry without overwriting anything', async () => {
      seedMember()
      await addWeightRecord('m1', { weight: 80, date: daysAgo(30) })
      expect(__store.weightRecords).toHaveLength(1)
      expect(__store.weightRecords[0]).toMatchObject({ memberId: 'm1', weight: 80, date: daysAgo(30) })
    })

    it('keeps every entry as a separate historical record (no overwrite)', async () => {
      seedMember()
      await addWeightRecord('m1', { weight: 80, date: daysAgo(30) })
      await addWeightRecord('m1', { weight: 78, date: daysAgo(15) })
      await addWeightRecord('m1', { weight: 76, date: daysAgo(0) })
      expect(__store.weightRecords).toHaveLength(3)
      expect(__store.weightRecords.map((r) => r.weight)).toEqual([80, 78, 76])
    })

    it('accepts decimal weights', async () => {
      seedMember()
      await addWeightRecord('m1', { weight: 72.5, date: daysAgo(5) })
      expect(__store.weightRecords[0].weight).toBe(72.5)
    })

    it('rejects invalid (non-positive) weight', async () => {
      seedMember()
      await expect(addWeightRecord('m1', { weight: -5, date: daysAgo(1) })).rejects.toThrow(/positive/)
      await expect(addWeightRecord('m1', { weight: 0, date: daysAgo(1) })).rejects.toThrow(/positive/)
      expect(__store.weightRecords).toHaveLength(0)
    })

    it('rejects an unreasonably large weight', async () => {
      seedMember()
      await expect(addWeightRecord('m1', { weight: 900, date: daysAgo(1) })).rejects.toThrow(/high/)
      expect(__store.weightRecords).toHaveLength(0)
    })

    it('rejects an invalid date', async () => {
      seedMember()
      await expect(addWeightRecord('m1', { weight: 70, date: 'not-a-date' })).rejects.toThrow(/date/i)
      await expect(addWeightRecord('m1', { weight: 70, date: '' })).rejects.toThrow(/date/i)
      expect(__store.weightRecords).toHaveLength(0)
    })

    it('requires a member ID', async () => {
      seedMember()
      await expect(addWeightRecord('', { weight: 70, date: daysAgo(1) })).rejects.toThrow(/member ID/)
    })

    it('does not touch member profile data', async () => {
      seedMember()
      const before = { ...__store.members[0] }
      await addWeightRecord('m1', { weight: 72, date: daysAgo(3) })
      expect(__store.members[0]).toEqual(before)
    })
  })

  describe('updateWeightRecord', () => {
    it('edits an existing measurement', async () => {
      seedMember()
      const id = await addWeightRecord('m1', { weight: 80, date: daysAgo(30) })
      await updateWeightRecord(id, { weight: 79, date: daysAgo(30) })
      expect(__store.weightRecords[0]).toMatchObject({ weight: 79, date: daysAgo(30) })
      expect(__store.weightRecords).toHaveLength(1)
    })

    it('rejects invalid values when editing', async () => {
      seedMember()
      const id = await addWeightRecord('m1', { weight: 80, date: daysAgo(30) })
      await expect(updateWeightRecord(id, { weight: 0, date: daysAgo(30) })).rejects.toThrow(/positive/)
      await expect(updateWeightRecord(id, { weight: 70, date: '' })).rejects.toThrow(/date/i)
      expect(__store.weightRecords[0].weight).toBe(80)
    })

    it('does not affect other weight entries', async () => {
      seedMember()
      await addWeightRecord('m1', { weight: 80, date: daysAgo(30) })
      const id2 = await addWeightRecord('m1', { weight: 78, date: daysAgo(15) })
      await updateWeightRecord(id2, { weight: 77, date: daysAgo(15) })
      expect(__store.weightRecords[0].weight).toBe(80)
      expect(__store.weightRecords[1].weight).toBe(77)
    })
  })

  describe('deleteWeightRecord', () => {
    it('deletes only the target measurement', async () => {
      seedMember()
      await addWeightRecord('m1', { weight: 80, date: daysAgo(30) })
      const id2 = await addWeightRecord('m1', { weight: 78, date: daysAgo(15) })
      await deleteWeightRecord(id2)
      expect(__store.weightRecords).toHaveLength(1)
      expect(__store.weightRecords[0].weight).toBe(80)
    })

    it('leaves member data intact after deletion', async () => {
      seedMember()
      const id = await addWeightRecord('m1', { weight: 72, date: daysAgo(1) })
      const before = { ...__store.members[0] }
      await deleteWeightRecord(id)
      expect(__store.members[0]).toEqual(before)
    })

    it('requires a record ID', async () => {
      await expect(deleteWeightRecord('')).rejects.toThrow(/record ID/)
    })
  })

  describe('setFitnessGoal', () => {
    it('throws when no goal/no history member is missing', async () => {
      await expect(setFitnessGoal('missing', { fitnessGoal: 'Weight Loss' })).rejects.toThrow(/not found/)
    })

    it('sets an optional fitness goal', async () => {
      seedMember()
      await setFitnessGoal('m1', { fitnessGoal: 'Weight Loss' })
      expect(__store.members[0].fitnessGoal).toBe('Weight Loss')
    })

    it('changes an existing fitness goal', async () => {
      seedMember()
      __store.members[0].fitnessGoal = 'Weight Loss'
      await setFitnessGoal('m1', { fitnessGoal: 'Muscle Gain' })
      expect(__store.members[0].fitnessGoal).toBe('Muscle Gain')
    })

    it('clears an optional goal', async () => {
      seedMember()
      __store.members[0].fitnessGoal = 'Strength'
      await setFitnessGoal('m1', { fitnessGoal: '' })
      expect(__store.members[0].fitnessGoal).toBe('')
    })

    it('sets an optional target weight', async () => {
      seedMember()
      await setFitnessGoal('m1', { fitnessGoal: 'Weight Loss', targetWeight: '70' })
      expect(__store.members[0].targetWeight).toBe(70)
    })

    it('clears the target weight when not set', async () => {
      seedMember()
      __store.members[0].targetWeight = 70
      await setFitnessGoal('m1', { fitnessGoal: 'Strength' })
      expect(__store.members[0].targetWeight).toBe('')
    })

    it('rejects an invalid target weight', async () => {
      seedMember()
      await expect(setFitnessGoal('m1', { targetWeight: '0' })).rejects.toThrow(/positive/)
      await expect(setFitnessGoal('m1', { targetWeight: '99999' })).rejects.toThrow(/high/)
    })
  })

  describe('parseWeightHistory', () => {
    it('returns empty progress for no records', () => {
      const res = parseWeightHistory([])
      expect(res.chronological).toEqual([])
      expect(res.current).toBeNull()
      expect(res.starting).toBeNull()
      expect(res.change).toBeNull()
    })

    it('determines current weight from the latest measurement', () => {
      const records = [
        weight('a', 80, daysAgo(30)),
        weight('b', 78, daysAgo(15)),
        weight('c', 76, daysAgo(0)),
      ]
      const res = parseWeightHistory(records)
      expect(res.current.weight).toBe(76)
      expect(res.starting.weight).toBe(80)
      expect(res.change).toBe(-4)
    })

    it('orders history chronologically', () => {
      const records = [
        weight('c', 76, daysAgo(0)),
        weight('a', 80, daysAgo(30)),
        weight('b', 78, daysAgo(15)),
      ]
      const res = parseWeightHistory(records)
      expect(res.chronological.map((r) => r.weight)).toEqual([80, 78, 76])
    })

    it('computes a positive change (muscle gain)', () => {
      const res = parseWeightHistory([weight('a', 62, daysAgo(30)), weight('b', 68, daysAgo(0))])
      expect(res.change).toBe(6)
    })

    it('ignores records with missing/invalid date for ordering', () => {
      const res = parseWeightHistory([weight('a', 80, daysAgo(30)), weight('b', 78, 'nope')])
      expect(res.chronological.length).toBe(1)
    })
  })

  describe('validateWeightRecord', () => {
    it('accepts a positive decimal weight', () => {
      expect(validateWeightRecord({ weight: '72.5', date: daysAgo(1) })).toMatchObject({ weight: 72.5 })
    })

    it('rejects non-positive and oversized weights', () => {
      expect(() => validateWeightRecord({ weight: '0', date: daysAgo(1) })).toThrow(/positive/)
      expect(() => validateWeightRecord({ weight: '-1', date: daysAgo(1) })).toThrow(/positive/)
      expect(() => validateWeightRecord({ weight: '9999', date: daysAgo(1) })).toThrow(/high/)
      expect(() => validateWeightRecord({ weight: '', date: daysAgo(1) })).toThrow(/required/)
    })

    it('rejects invalid dates', () => {
      expect(() => validateWeightRecord({ weight: 70, date: '2021-02-30' })).toThrow(/date/i)
    })
  })
})

describe('weightRecordSchema', () => {
  it('accepts a valid decimal weight and date', () => {
    const res = weightRecordSchema.safeParse({ weight: '72.5', date: '2026-08-15' })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data.weight).toBe(72.5)
  })

  it('rejects non-positive weight', () => {
    expect(weightRecordSchema.safeParse({ weight: '0', date: '2026-08-15' }).success).toBe(false)
    expect(weightRecordSchema.safeParse({ weight: '-5', date: '2026-08-15' }).success).toBe(false)
  })

  it('rejects an oversized weight', () => {
    expect(weightRecordSchema.safeParse({ weight: '9999', date: '2026-08-15' }).success).toBe(false)
  })

  it('rejects a missing/invalid date', () => {
    expect(weightRecordSchema.safeParse({ weight: '70', date: '' }).success).toBe(false)
    expect(weightRecordSchema.safeParse({ weight: '70', date: 'not-a-date' }).success).toBe(false)
  })
})

describe('fitnessGoalSchema', () => {
  it('allows an empty (unset) goal', () => {
    expect(fitnessGoalSchema.safeParse({ fitnessGoal: '', targetWeight: '' }).success).toBe(true)
  })

  it('allows a valid goal with optional target weight', () => {
    expect(fitnessGoalSchema.safeParse({ fitnessGoal: 'Weight Loss', targetWeight: '70' }).success).toBe(true)
    expect(fitnessGoalSchema.safeParse({ fitnessGoal: 'Strength', targetWeight: '' }).success).toBe(true)
  })

  it('rejects an invalid target weight', () => {
    expect(fitnessGoalSchema.safeParse({ fitnessGoal: 'Weight Loss', targetWeight: '-5' }).success).toBe(false)
    expect(fitnessGoalSchema.safeParse({ fitnessGoal: 'Weight Loss', targetWeight: '99999' }).success).toBe(false)
  })
})
