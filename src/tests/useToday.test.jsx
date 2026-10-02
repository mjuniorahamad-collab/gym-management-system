import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useToday } from '@/hooks/useToday'

const KOLKATA = 'Asia/Kolkata' // UTC+05:30, no DST
const NEW_YORK = 'America/New_York' // UTC-05:00 in October

const { settingsState } = vi.hoisted(() => ({ settingsState: { timezone: 'Asia/Kolkata' } }))

vi.mock('@/context/SettingsContext', () => ({ useSettings: () => settingsState }))

/**
 * Expectations are written as explicit UTC instants rather than
 * `new Date(y, m, d)`, so the suite asserts the same thing regardless of the
 * timezone of the machine running it. `YYYY-MM-DD` is also the shape callers
 * compare against, where the hook used to return `Date.toDateString()`.
 */
describe('useToday', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    settingsState.timezone = KOLKATA
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns today's date in the gym's timezone", () => {
    vi.setSystemTime(new Date('2026-10-03T04:30:00.000Z')) // 10:00 IST, 3 Oct
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-10-03')
  })

  it('does not roll over during the same gym day', () => {
    vi.setSystemTime(new Date('2026-10-03T04:30:00.000Z')) // 10:00 IST
    const { result } = renderHook(() => useToday())

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 60 * 1000) // -> 20:00 IST
    })

    expect(result.current).toBe('2026-10-03')
  })

  // A page deriving "today" during render otherwise keeps yesterday's value
  // until something unrelated forces a re-render, so an attendance tab left open
  // overnight keeps reporting and stamping the previous day.
  it('rolls over at gym midnight', () => {
    vi.setSystemTime(new Date('2026-10-03T18:29:00.000Z')) // 23:59 IST, 3 Oct
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-10-03')

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // -> 00:01 IST, 4 Oct
    })

    expect(result.current).toBe('2026-10-04')
  })

  it('rolls over again on the following night', () => {
    vi.setSystemTime(new Date('2026-10-03T18:29:30.000Z')) // 23:59:30 IST
    const { result } = renderHook(() => useToday())

    act(() => {
      vi.advanceTimersByTime(60 * 1000)
    })
    expect(result.current).toBe('2026-10-04')

    // Cross the next one, proving the timer re-arms itself.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    })
    expect(result.current).toBe('2026-10-05')
  })

  /**
   * The core defect: `new Date().toDateString()` answered with the *device's*
   * day. At this instant a phone set to UTC or New York calls it the 3rd while
   * the gym it is reporting to is already on the 4th, so its check-ins are
   * filed under the wrong day.
   */
  it("tracks the gym's day rather than the device's", () => {
    vi.setSystemTime(new Date('2026-10-03T18:30:00.000Z')) // 00:00 IST, 4 Oct

    settingsState.timezone = KOLKATA
    const kolkata = renderHook(() => useToday())
    expect(kolkata.result.current).toBe('2026-10-04')

    settingsState.timezone = NEW_YORK
    const newYork = renderHook(() => useToday())
    expect(newYork.result.current).toBe('2026-10-03')
  })

  it('rolls over at the configured zone’s midnight, not the device’s', () => {
    settingsState.timezone = NEW_YORK
    // 23:59 in New York; already the 4th in Kolkata.
    vi.setSystemTime(new Date('2026-10-04T03:59:00.000Z'))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-10-03')

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // -> 00:01 EDT, 4 Oct
    })

    expect(result.current).toBe('2026-10-04')
  })

  it('falls back to the default zone for an unusable configured value', () => {
    settingsState.timezone = 'Mars/Olympus_Mons'
    vi.setSystemTime(new Date('2026-10-03T18:30:00.000Z'))
    const { result } = renderHook(() => useToday())
    // Same as Asia/Kolkata rather than crashing or falling back to the device.
    expect(result.current).toBe('2026-10-04')
  })

  it('clears its timer on unmount', () => {
    vi.setSystemTime(new Date('2026-10-03T18:29:00.000Z'))
    const { unmount } = renderHook(() => useToday())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})