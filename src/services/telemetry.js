/**
 * ERROR REPORTING SEAM.
 *
 * Today the app has an ErrorBoundary that `console.error`s. In production that
 * means the first time a user hits a crash, nobody finds out unless they call.
 * This module is the seam a real provider plugs into (Sentry and friends all
 * reduce to "call this function with an error and some context"), kept
 * dependency-free so the app does not grow a vendor SDK before one is chosen.
 *
 * Rules:
 * - `reportError` NEVER throws and never awaits: a reporting failure must not
 *   become a second user-facing failure, and a crash handler is the worst place
 *   to add latency.
 * - Without a reporter it logs, so the behaviour is unchanged in development.
 * - `setErrorReporter(null)` removes the provider (used by tests and by a
 *   provider that fails to initialise).
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
      // A broken reporter must never mask the original error.
    }
  }

  try {
    console.error('[telemetry]', payload.message, payload.context)
  } catch {
    // A missing console is not a reason to fail.
  }

  return payload
}

/** Test-only: reset the provider between cases. */
export function __resetErrorReporter() {
  reporter = null
}
