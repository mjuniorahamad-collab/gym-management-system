import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STALE_CHUNK_RELOAD_KEY, reloadOnStaleChunk } from '@/utils/staleChunk'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  }
}

describe('reloadOnStaleChunk', () => {
  let reload
  let storage

  beforeEach(() => {
    reload = vi.fn()
    storage = memoryStorage()
  })

  it('reloads once when a lazy chunk is gone', () => {
    expect(reloadOnStaleChunk({ now: () => 1_000, reload, storage })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe('1000')
  })

  it('does not loop when the chunk is genuinely missing', () => {
    reloadOnStaleChunk({ now: () => 1_000, reload, storage })
    expect(reloadOnStaleChunk({ now: () => 5_000, reload, storage })).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('allows another reload after the window passes', () => {
    reloadOnStaleChunk({ now: () => 1_000, reload, storage })
    expect(reloadOnStaleChunk({ now: () => 31_001, reload, storage })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('still reloads when storage is unavailable', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(reloadOnStaleChunk({ now: () => 1_000, reload, storage: blocked })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
