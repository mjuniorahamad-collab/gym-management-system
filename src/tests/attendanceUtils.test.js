import { describe, expect, it } from 'vitest'
import { attendanceDay, isOpenSession } from '@/utils/attendance'

describe('attendanceDay', () => {
  it('prefers the stored checkInDay', () => {
    // The stored value wins even when it disagrees with the instant, because it
    // is what was written at check-in time in the gym's zone.
    expect(attendanceDay({ checkInDay: '2026-03-10', checkIn: '2026-03-11T00:00:00Z' }, 'Asia/Kolkata')).toBe(
      '2026-03-10'
    )
  })

  it('truncates a full timestamp stored in checkInDay', () => {
    expect(attendanceDay({ checkInDay: '2026-03-10T00:00:00.000Z' }, 'Asia/Kolkata')).toBe('2026-03-10')
  })

  it('derives the day from checkIn for legacy rows with no checkInDay', () => {
    // 18:30Z is 00:00 IST on the 11th, so a UTC-slice would bucket this wrongly.
    expect(attendanceDay({ checkIn: '2026-03-10T18:30:00.000Z' }, 'Asia/Kolkata')).toBe('2026-03-11')
  })

  it('falls back to date when checkIn is absent', () => {
    expect(attendanceDay({ date: '2026-03-10T18:30:00.000Z' }, 'Asia/Kolkata')).toBe('2026-03-11')
  })

  /**
   * A zone east of UTC pushes a late-UTC check-in onto the gym's *next* calendar
   * day. A UTC slice of the same instant reports the 10th and files the check-in
   * under the wrong day.
   */
  it('shifts the day forward for a zone east of UTC', () => {
    // 14:00Z is 03:00 on the 11th in Auckland (UTC+13 in March).
    expect(attendanceDay({ checkIn: '2026-03-10T14:00:00.000Z' }, 'Pacific/Auckland')).toBe('2026-03-11')
  })

  it('shifts the day backward for a zone west of UTC', () => {
    // 02:00Z is 21:00 on the 9th in New York (UTC-5).
    expect(attendanceDay({ checkIn: '2026-03-10T02:00:00.000Z' }, 'America/New_York')).toBe('2026-03-09')
  })

  it('accepts a Date as well as a string', () => {
    expect(attendanceDay({ checkIn: new Date('2026-03-10T18:30:00.000Z') }, 'Asia/Kolkata')).toBe('2026-03-11')
  })

  it('returns empty for a missing record', () => {
    expect(attendanceDay(null, 'Asia/Kolkata')).toBe('')
    expect(attendanceDay(undefined, 'Asia/Kolkata')).toBe('')
  })

  it('falls back to the default zone for an unknown timezone', () => {
    expect(attendanceDay({ checkIn: '2026-03-10T18:30:00.000Z' }, 'Not/AZone')).toBe('2026-03-11')
  })
})

describe('isOpenSession', () => {
  it('treats a missing or empty checkOut as open', () => {
    expect(isOpenSession({ checkIn: 'x' })).toBe(true)
    expect(isOpenSession({ checkIn: 'x', checkOut: '' })).toBe(true)
  })

  /**
   * `checkOut: ''` is what the app writes for an open session, and a whitespace
   * value can appear from a manual console edit. Treating it as closed would hide
   * a member who is still in the gym from the duplicate guard.
   */
  it('treats a whitespace checkOut as open', () => {
    expect(isOpenSession({ checkIn: 'x', checkOut: '   ' })).toBe(true)
  })

  it('treats any timestamp as closed', () => {
    expect(isOpenSession({ checkIn: 'x', checkOut: '2026-03-10T07:00:00.000Z' })).toBe(false)
  })

  it('is false for a missing record', () => {
    expect(isOpenSession(null)).toBe(false)
    expect(isOpenSession(undefined)).toBe(false)
  })
})