import { describe, expect, it } from 'vitest'
import { classSchema } from '@/schemas/validationSchemas'

const base = {
  name: 'Yoga',
  description: '',
  dayOfWeek: 'Monday',
  startTime: '07:00',
  endTime: '08:00',
  trainerId: '',
  capacity: 20,
  active: true,
}

describe('classSchema time ordering', () => {
  it('accepts a class that ends after it starts', () => {
    expect(classSchema.safeParse(base).success).toBe(true)
  })

  it('accepts a class running to the end of the day', () => {
    expect(classSchema.safeParse({ ...base, startTime: '22:00', endTime: '23:59' }).success).toBe(true)
  })

  // HH:MM strings compare chronologically, so a reversed pair must not save and
  // then display to members as an 11-hour session.
  it('rejects a class whose end time is before its start time', () => {
    const result = classSchema.safeParse({ ...base, startTime: '18:00', endTime: '07:00' })
    expect(result.success).toBe(false)
    expect(result.error.issues[0].message).toBe('End time must be after start time')
    expect(result.error.issues[0].path).toEqual(['endTime'])
  })

  it('rejects a zero-length class', () => {
    const result = classSchema.safeParse({ ...base, startTime: '07:00', endTime: '07:00' })
    expect(result.success).toBe(false)
  })

  it('still enforces the existing field rules', () => {
    expect(classSchema.safeParse({ ...base, name: 'A' }).success).toBe(false)
    expect(classSchema.safeParse({ ...base, capacity: 0 }).success).toBe(false)
    expect(classSchema.safeParse({ ...base, dayOfWeek: 'Someday' }).success).toBe(false)
    expect(classSchema.safeParse({ ...base, startTime: '7am' }).success).toBe(false)
  })
})