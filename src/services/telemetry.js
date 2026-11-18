/**
 * ERROR REPORTING SEAM.
 *
 * Today the app has an ErrorBoundary. In production that means the first time a
 * user hits a crash, nobody finds out unless they call. This module is the seam
 * a real provider plugs into (Sentry and friends all reduce to "call this
 * function with an error and some context"), kept dependency-free so the app
 * does not grow a vendor SDK before one is chosen.
 *
 * Rules:
 * - `reportError` NEVER throws and never awaits: a reporting failure must not
 *   become a second user-facing failure, and a crash handler is the worst place
 *   to add latency.
 * - It logs only when there is no reporter. With a provider installed, the
 *   provider ships the error and logging it as well would duplicate every crash
 *   in the console.
 * - `setErrorReporter(null)` removes the provider (tests, or a provider that
 *   failed to initialise).
 */
let reporter = null

/** Install the provider's reporting function. Passing a non-function clears it. */
export function setErrorReporter(fn) {
  reporter = typeof fn === 'function' ? fn : null
  return reporter
}

/**
 * Report one error with context. Returns the payload that was sent (useful in
 * tests); never rethrows, never returns a promise.
 */
export function reportError(error, context = {}) {
  const payload = {
    error,
    message: error?.message ? String(error.message) : String(error),
    context: { ...context, at: new Date().toISOString() },
  }

  if (reporter) {
    try {
      reporter(payload)
    } catch {
      // A broken reporter must never mask the original error. Fall through to
      // the console so the error is not lost entirely.
      try {
        console.error('[telemetry]', payload.message, payload.context)
      } catch {
        // A missing console is not a reason to fail.
      }
    }
    return payload
  }

  try {
    console.error('[telemetry]', payload.message, payload.context)
  } catch {
    // A missing console is not a reason to fail.
  }

  return payload
}
