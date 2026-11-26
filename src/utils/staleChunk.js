/**
 * A deploy replaces every hashed file in `/assets/`. A tab that is still open
 * holds the previous `index.html` in memory, so the first lazy route it asks
 * for (`Reports-<hash>.js`) no longer exists and the screen dies with
 * "Something went wrong · Failed to fetch dynamically imported module".
 *
 * Vite emits `vite:preloadError` for exactly this case. Reloading once picks up
 * the new shell and the new chunk hashes; the timestamp guard keeps a genuinely
 * missing bundle from turning into a reload loop.
 */
export const STALE_CHUNK_RELOAD_KEY = 'staleChunkReloadAt'
export const STALE_CHUNK_WINDOW_MS = 30_000

export function reloadOnStaleChunk({
  now = () => Date.now(),
  reload = () => window.location.reload(),
  storage = typeof window !== 'undefined' ? window.sessionStorage : null,
  windowMs = STALE_CHUNK_WINDOW_MS,
  key = STALE_CHUNK_RELOAD_KEY,
} = {}) {
  const at = now()
  let last = 0
  try {
    last = Number(storage?.getItem(key)) || 0
  } catch {
    // Storage can be blocked (private mode, sandboxed iframe). A reload is
    // still the right recovery; only the loop guard is unavailable.
    last = 0
  }

  if (last && at - last < windowMs) return false

  try {
    storage?.setItem(key, String(at))
  } catch {
    // Same as above — proceed.
  }
  reload()
  return true
}
