export const RECEIPT_PREFIX_MIN = 1
export const RECEIPT_PREFIX_MAX = 8

export const RECEIPT_PREFIX_PATTERN = /^[A-Za-z0-9]{1,8}$/

export const RECEIPT_PREFIX_RULES =
  'Receipt prefix must be 1-8 letters or digits, with no spaces.'

export class ReceiptPrefixError extends Error {
  constructor(reason, where = '') {
    super(`${where ? `${where}: ` : ''}${RECEIPT_PREFIX_RULES} (got: ${reason})`)
    this.name = 'ReceiptPrefixError'
    this.code = reason
  }
}

export function receiptPrefixRejection(value) {
  if (typeof value !== 'string') return 'not-a-string'
  if (value.length === 0) return 'empty'
  if (/\s/.test(value)) return 'whitespace'
  if (value.length < RECEIPT_PREFIX_MIN || value.length > RECEIPT_PREFIX_MAX) return 'length'
  if (!RECEIPT_PREFIX_PATTERN.test(value)) return 'charset'
  return null
}

export function isValidReceiptPrefix(value) {
  return receiptPrefixRejection(value) === null
}

export function assertValidReceiptPrefix(value, where = '') {
  const reason = receiptPrefixRejection(value)
  if (reason) throw new ReceiptPrefixError(reason, where)
  return value
}

/**
 * The four states a gym's authority/mirror pair can be in.
 *
 * `gyms/{gymId}.receiptPrefix` is the only authoritative value;
 * `gyms/{gymId}/settings/app.receiptPrefix` is a derived mirror. Every reader
 * has to know which of these four situations it is looking at, because only one
 * of them is healthy and only two of them are safe to keep reading through.
 */
export const PREFIX_CONSISTENCY = Object.freeze({
  SETTINGS_ABSENT: 'settings-absent',
  HEALTHY: 'healthy',
  MIRROR_MISSING: 'mirror-missing',
  MIRROR_MISMATCH: 'mirror-mismatch',
  AUTHORITY_MISSING: 'authority-missing',
})

/**
 * Classify the authority/mirror pair without writing anything.
 *
 * - `settings-absent`  no settings document to compare against (not a defect).
 * - `mirror-missing`   authority is valid, mirror absent — acceptable where the
 *                      settings document has not been provisioned yet; the
 *                      missing field is reported through the normal
 *                      needs-configuration path, not as an inconsistency.
 * - `healthy`          both present and identical.
 * - `mirror-mismatch`  both present and different. BLOCKING: an actionable
 *                      failure, never a silent repair — neither value is
 *                      rewritten from the other.
 * - `authority-missing` a settings document exists while the owner-of-record
 *                      carries no usable prefix. BLOCKING: the mirror must
 *                      never be promoted into authority, so the only correct
 *                      outcome is to refuse and say what an operator must do.
 *
 * Pure by design: no Firebase import, no reads, no writes. The app, the guard
 * and the tests all take their answer from here so they cannot disagree.
 *
 * @returns {{state: string, blocking: boolean, message: string|null}}
 */
export function classifyPrefixConsistency({
  gymId = '',
  authority,
  mirror,
  settingsExists = false,
} = {}) {
  const authorityPath = gymId ? `gyms/${gymId}` : 'gyms/{gymId}'
  const mirrorPath = gymId
    ? `gyms/${gymId}/settings/app`
    : 'gyms/{gymId}/settings/app'

  if (!settingsExists) {
    return { state: PREFIX_CONSISTENCY.SETTINGS_ABSENT, blocking: false, message: null }
  }

  if (!isValidReceiptPrefix(authority)) {
    return {
      state: PREFIX_CONSISTENCY.AUTHORITY_MISSING,
      blocking: true,
      message:
        `${mirrorPath} exists, but ${authorityPath}.receiptPrefix is absent or malformed. ` +
        'The settings copy is only a mirror and is never promoted to authority, so receipts ' +
        `stay refused until an operator declares the prefix on ${authorityPath}.`,
    }
  }

  if (typeof mirror !== 'string' || mirror === '') {
    return { state: PREFIX_CONSISTENCY.MIRROR_MISSING, blocking: false, message: null }
  }

  if (mirror !== authority) {
    return {
      state: PREFIX_CONSISTENCY.MIRROR_MISMATCH,
      blocking: true,
      message:
        `${mirrorPath} stores receipt prefix "${mirror}", which does not match the ` +
        `authoritative "${authority}" on ${authorityPath}. Neither value is changed ` +
        'automatically; an operator must decide which one is correct.',
    }
  }

  return { state: PREFIX_CONSISTENCY.HEALTHY, blocking: false, message: null }
}
