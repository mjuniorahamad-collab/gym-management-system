import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useToday } from '@/hooks/useToday'

describe('useToday', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns today's local date string", () => {
    vi.setSystemTime(new Date(2026, 9, 3, 10, 0, 0))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe(new Date(2026, 9, 3).toDateString())
  })

  it('does not roll over during the same day', () => {
    vi.setSystemTime(new Date(2026, 9, 3, 8, 0, 0))
    const { result } = renderHook(() => useToday())

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 60 * 1000)
    })

    expect(result.current).toBe(new Date(2026, 9, 3).toDateString())
  })

  // A page deriving "today" during render otherwise keeps yesterday's value
  // until something unrelated forces a re-render, so an attendance tab left open
  // overnight keeps reporting and stamping the previous day.
  it('rolls over at local midnight', () => {
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 0))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe(new Date(2026, 9, 3).toDateString())

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000)
    })

    expect(result.current).toBe(new Date(2026, 9, 4).toDateString())
  })

  it('rolls over again on the following night', () => {
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 30))
    const { result } = renderHook(() => useToday())

    // Cross the first midnight.
    act(() => {
      vi.advanceTimersByTime(60 * 1000)
    })
    expect(result.current).toBe(new Date(2026, 9, 4).toDateString())

    // Cross the next one, proving the timer re-arms itself.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    })
    expect(result.current).toBe(new Date(2026, 9, 5).toDateString())
  })

  it('clears its timer on unmount', () => {
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 0))
    const { unmount } = renderHook(() => useToday())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})