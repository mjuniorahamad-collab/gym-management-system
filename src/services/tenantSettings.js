/**
 * Tenant settings bootstrap policy.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------
 * `gyms/{gymId}/settings/app` was previously created on the owner's first
 * sign-in by writing `{ ...DEFAULT_SETTINGS, gymId }`. That silently invented
 * every field in DEFAULT_SETTINGS, including three that belong to a specific
 * business:
 *
 *   - `gymName: 'Himalye Wonders Gym'` — a hard-coded string that is NOT the
 *     identity of any real gym. It renders in the sidebar, on printed receipts,
 *     and on member cards, so a gym called "Crystal gym" would be presented to
 *     its own members as "Himalye Wonders Gym".
 *   - `receiptPrefix: 'HWG'` — written onto receipts AND persisted into payment
 *     records by the renewal flow (RenewalModal.jsx). Inventing it corrupts
 *     financial document numbering.
 *   - `tagline: 'Strength • Discipline • Growing'` — branded marketing copy the
 *     gym never chose, and it OVERWRITES an explicitly empty tagline.
 *
 * The tenant's own record (`gyms/{gymId}`) already carries the gym's registered
 * name and the tagline it entered at onboarding. That record is the trusted
 * source: firestore.rules:183-186 exposes it only to the caller who owns it or
 * who belongs to it, so it cannot be forged by another tenant.
 *
 * This module is deliberately PURE — no Firebase import — so the policy is unit
 * testable and can be shared verbatim by the app and by the offline migration
 * script, guaranteeing the two can never disagree.
 *
 * WHAT IS SAFE TO SEED
 *   - `gymId`   : from the signed-in users/{uid} profile (frozen by rules).
 *   - `gymName` : from `gyms/{gymId}.name`.
 *   - `tagline` : from `gyms/{gymId}.tagline`, preserving an explicit empty
 *                 string as empty rather than substituting copy.
 *   - `currency`, `dateFormat`, `timezone`: product-wide defaults that every
 *                 reader already assumes (see SAFE_DEFAULTS).
 *
 * WHAT MUST NEVER BE SEEDED
 *   - `receiptPrefix` : owner decision, persisted onto payments.
 *   - `logoPath` / `logoUrl` : there is no object to point at.
 *   - PT surcharge / WhatsApp link : separate documents, finance/business
 *     values, never touched by this module.
 */

import { DEFAULT_GYM_TIMEZONE, isValidTimezone } from '@/utils/gymTime'

/** Sub-collection + document that hold a gym's own settings. */
export const TENANT_SETTINGS_SUBCOLLECTION = 'settings'
export const TENANT_SETTINGS_DOC = 'app'

/**
 * Defaults that are safe to materialise because every reader already assumes
 * them regardless of what is stored:
 *
 *  - currency 'INR' is the default parameter of formatCurrency()
 *    (utils/formatters.js:5), so 64 call sites already behave this way.
 *  - timezone is resolved through resolveGymTimezone(), which returns exactly
 *    DEFAULT_GYM_TIMEZONE for any absent or unresolvable stored value
 *    (utils/gymTime.js). Writing it therefore changes no behaviour at all.
 *  - dateFormat is the first entry of DATE_FORMATS (utils/constants.js) and is
 *    the value the UI presents first.
 */
export const SAFE_DEFAULTS = Object.freeze({
  currency: 'INR',
  dateFormat: 'MMM D, YYYY',
  timezone: DEFAULT_GYM_TIMEZONE,
})

/**
 * Fields the bootstrap refuses to invent. These require an explicit owner
 * decision in Settings before the gym can be considered configured.
 */
export const OWNER_DECISION_FIELDS = Object.freeze(['receiptPrefix'])

/** Fields the Settings form requires before a save is accepted. */
export const REQUIRED_SETTINGS_FIELDS = Object.freeze([
  'gymName',
  'currency',
  'dateFormat',
  'receiptPrefix',
  'timezone',
])

export const BOOTSTRAP_STRATEGY = Object.freeze({
  /** No bound gym: there is no tenant to build settings for. */
  REFUSED_NO_GYM: 'refused-no-gym',
  /** The `gyms/{gymId}` owner-of-record document could not be read. */
  REFUSED_NO_TENANT_RECORD: 'refused-no-tenant-record',
  /** The tenant record exists but carries no usable identity. */
  REFUSED_UNUSABLE_TENANT_IDENTITY: 'refused-unusable-tenant-identity',
  /** A settings document is already present: never overwrite it. */
  SKIP_EXISTING: 'skip-existing',
  /** Safe, tenant-derived values only. */
  SEED_DERIVED: 'seed-derived',
})

/** Bounds mirror settingsSchema (schemas/validationSchemas.js:190-199). */
const NAME_MIN = 2
const NAME_MAX = 80

function normaliseGymId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function refusal(strategy, gymId, reason) {
  return {
    strategy,
    gymId: normaliseGymId(gymId),
    write: null,
    deferred: [...OWNER_DECISION_FIELDS],
    missingRequired: [...OWNER_DECISION_FIELDS],
    reason,
  }
}

/**
 * Decides what, if anything, may be written to `gyms/{gymId}/settings/app`.
 *
 * The function is total: it always returns a verdict and never throws, so a
 * caller cannot accidentally treat an unexpected input as permission to write.
 *
 * @param {object}  input
 * @param {string}  input.gymId     trusted gym id (users/{uid}.gymId)
 * @param {object} [input.gym]      the `gyms/{gymId}` owner-of-record document
 * @param {object} [input.existing] the current settings document, if any
 * @returns {{strategy: string, gymId: string, write: object|null,
 *            deferred: string[], missingRequired: string[], reason: string}}
 */
export function buildTenantSettingsSeed({ gymId, gym = null, existing = null } = {}) {
  const id = normaliseGymId(gymId)

  if (!id) {
    return refusal(
      BOOTSTRAP_STRATEGY.REFUSED_NO_GYM,
      id,
      'No gym is bound to this account, so no tenant settings document can be built.'
    )
  }

  // Never overwrite. This is checked BEFORE the tenant record is consulted so a
  // read failure on gyms/{gymId} can never be mistaken for licence to rewrite an
  // existing, owner-configured document.
  if (isPlainObject(existing)) {
    return {
      strategy: BOOTSTRAP_STRATEGY.SKIP_EXISTING,
      gymId: id,
      write: null,
      deferred: [],
      missingRequired: describeSettingsCompleteness(existing).missing,
      reason: 'A settings document already exists for this gym; it must not be modified.',
    }
  }

  if (!isPlainObject(gym)) {
    return refusal(
      BOOTSTRAP_STRATEGY.REFUSED_NO_TENANT_RECORD,
      id,
      `The owner-of-record document gyms/${id} could not be read, so the gym's identity is unknown.`
    )
  }

  const name = typeof gym.name === 'string' ? gym.name.trim() : ''

  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return refusal(
      BOOTSTRAP_STRATEGY.REFUSED_UNUSABLE_TENANT_IDENTITY,
      id,
      `gyms/${id}.name is missing or outside ${NAME_MIN}-${NAME_MAX} characters, so the gym's display name cannot be derived safely.`
    )
  }

  // An explicitly empty tagline is a real choice ("no tagline") and is
  // preserved as empty. Only an ABSENT tagline becomes ''.
  const tagline = typeof gym.tagline === 'string' ? gym.tagline.trim() : ''

  const write = {
    gymId: id,
    gymName: name,
    tagline,
    ...SAFE_DEFAULTS,
  }

  return {
    strategy: BOOTSTRAP_STRATEGY.SEED_DERIVED,
    gymId: id,
    write,
    // Deliberately omitted from `write`: receiptPrefix, logoPath, logoUrl.
    deferred: [...OWNER_DECISION_FIELDS],
    missingRequired: [...OWNER_DECISION_FIELDS],
    reason:
      `Derived gymName and tagline from gyms/${id}. ` +
      `receiptPrefix is left unset and must be chosen by the owner.`,
  }
}

/**
 * Which required settings are still unset on a stored document.
 *
 * Used to tell an owner precisely what remains to configure instead of letting
 * an invented default stand in for it.
 *
 * @param {object} stored
 * @returns {{complete: boolean, missing: string[]}}
 */
export function describeSettingsCompleteness(stored) {
  const data = isPlainObject(stored) ? stored : {}
  const text = (v) => (typeof v === 'string' ? v.trim() : '')
  const missing = []

  if (text(data.gymName).length < NAME_MIN) missing.push('gymName')
  if (!text(data.currency)) missing.push('currency')
  if (!text(data.dateFormat)) missing.push('dateFormat')
  if (!text(data.receiptPrefix)) missing.push('receiptPrefix')
  if (!isValidTimezone(data.timezone)) missing.push('timezone')

  return { complete: missing.length === 0, missing }
}

/**
 * Merges a stored settings document over the SAFE defaults for rendering.
 *
 * Deliberately does NOT merge DEFAULT_SETTINGS. That constant carries an
 * invented gymName and receiptPrefix, and spreading it over a partially
 * configured document would disguise the gap as a configured value.
 *
 * @param {object} stored
 * @param {object} [fallbackName] display name to use only when the stored
 *        document has none — normally `gyms/{gymId}.name`, the tenant's own
 *        registered identity.
 */
export function withSettingsFallbacks(stored, fallbackName = '') {
  const data = isPlainObject(stored) ? stored : {}
  const text = (v) => (typeof v === 'string' ? v.trim() : '')
  const name = text(data.gymName) || text(fallbackName)
  const tagline = typeof data.tagline === 'string' ? data.tagline : ''

  return { ...SAFE_DEFAULTS, ...data, gymName: name, tagline }
}

/**
 * Groups a set of gyms into the buckets the operator must act on separately.
 * Pure classification — it performs no I/O and decides nothing about writes.
 *
 * @param {Array<{id: string, name?: string, memberCount?: number, settingsDoc?: object}>} gyms
 */
export function classifyGymsForBootstrap(gyms) {
  const list = Array.isArray(gyms) ? gyms : []
  const counts = new Map()
  for (const gym of list) {
    const name = typeof gym?.name === 'string' ? gym.name.trim() : ''
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }

  return list.map((gym) => {
    const id = normaliseGymId(gym?.id)
    const name = typeof gym?.name === 'string' ? gym.name.trim() : ''
    const members = Number.isInteger(gym?.memberCount) ? gym.memberCount : null
    // Whether the caller actually checked for an existing settings document.
    // "Passed no settingsDoc" and "checked, found none" are different states,
    // and only the second justifies creating anything.
    const settingsChecked = Object.prototype.hasOwnProperty.call(gym ?? {}, 'settingsDoc')
    const seed = buildTenantSettingsSeed({
      gymId: id,
      gym: { name, tagline: gym?.tagline },
      existing: settingsChecked ? gym?.settingsDoc ?? null : null,
    })

    let classification
    if (seed.strategy === BOOTSTRAP_STRATEGY.SKIP_EXISTING) {
      classification = 'already-configured'
    } else if (seed.strategy === BOOTSTRAP_STRATEGY.SEED_DERIVED) {
      // A gym with no members has no owner evidence that it is the tenant under
      // use, even though its record is readable. Seeding it would create a
      // second plausible-looking settings document for what is most likely an
      // abandoned self-provisioning attempt.
      classification = members === 0 ? 'refused-no-activity' : 'seed-safe'
    } else {
      classification = 'refused-unusable-identity'
    }

    return {
      id,
      name,
      memberCount: members,
      settingsChecked,
      // Display-name collisions are reported so an operator can eyeball them.
      // They NEVER change the outcome: tenancy is by document id.
      sharesDisplayName: counts.get(name) > 1,
      classification,
      strategy: seed.strategy,
      write: seed.write,
      deferred: seed.deferred,
      reason: seed.reason,
    }
  })
}