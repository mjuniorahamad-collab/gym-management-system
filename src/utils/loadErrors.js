/**
 * User-facing load-failure messages.
 *
 * Firestore/Firebase error objects carry technical detail (error codes,
 * stack traces, internal messages) that must never be rendered into the UI.
 * Every load-failure path funnels through safeLoadMessage() so the UI only
 * ever shows one of three stable strings, while the raw error object stays
 * available to console logging at the call site.
 */

export const LOAD_ERROR = {
  PERMISSION: "You don't have permission to view this data.",
  NETWORK: "Couldn't reach the server. Check your connection and try again.",
  GENERIC: "Couldn't load this data. Please check your connection and try again.",
}

const SAFE_MESSAGES = new Set(Object.values(LOAD_ERROR))

const PERMISSION_CODES = new Set(['permission-denied', 'unauthenticated', 'unauthorized'])
const NETWORK_CODES = new Set([
  'unavailable',
  'deadline-exceeded',
  'network-request-failed',
  'resource-exhausted',
])

const PERMISSION_PATTERN = /permission|insufficient|forbidden|unauthorized/i
const NETWORK_PATTERN = /network|failed to fetch|fetch failed|offline|timed?\s?out|socket|ECONN|offline/i

function classify(text) {
  if (PERMISSION_PATTERN.test(text)) return LOAD_ERROR.PERMISSION
  if (NETWORK_PATTERN.test(text)) return LOAD_ERROR.NETWORK
  return LOAD_ERROR.GENERIC
}

/**
 * Map any error-shaped value to one of the three stable user-facing messages.
 * Accepts a Firebase error ({ code, message }), a plain Error, or a string.
 *
 * Idempotent: passing a value that is already one of the safe messages
 * returns it unchanged, so hook-level and render-level sanitisation can both
 * apply without re-classifying the friendly text.
 *
 * The raw input is never echoed into the return value.
 */
export function safeLoadMessage(err) {
  if (err == null) return LOAD_ERROR.GENERIC

  if (typeof err === 'string') {
    // Already-safe strings pass through; anything else is classified.
    if (SAFE_MESSAGES.has(err)) return err
    return classify(err)
  }

  const code = typeof err.code === 'string' ? err.code : ''
  if (code && PERMISSION_CODES.has(code)) return LOAD_ERROR.PERMISSION
  if (code && NETWORK_CODES.has(code)) return LOAD_ERROR.NETWORK

  const message = typeof err.message === 'string' ? err.message : ''
  if (code || message) return classify(`${code} ${message}`.trim())

  return LOAD_ERROR.GENERIC
}
