/**
 * BUILD-TIME ENTRY POINT ONLY — never import this from runtime code.
 *
 * Cloud Functions deploys ONLY the `functions/` directory, so a deployed
 * function cannot resolve `../../src/utils/...` at runtime. This file exists so
 * esbuild has something to resolve; it names the public API the trusted writer
 * is allowed to use and nothing else.
 *
 * The four canonical modules are bundled from `src/utils/` into
 * `functions/vendor/projection.mjs`, which IS the single source of truth:
 *
 *   src/utils/gymTime.js            -> resolveGymTimezone, gymDayKey, gymTodayKey
 *   src/utils/membershipPeriods.js  -> periodsForMember, resolvePeriodState, daysToExpiry
 *   src/utils/membershipFreezes.js  -> anchoredFreezeRanges, effectiveExpiryKey, freezeUntilKey
 *   src/utils/memberProjection.js   -> deriveMemberProjection  (the calculation authority)
 *   src/utils/duesDrift.js          -> duesDriftForMember      (dues reconciliation report)
 *
 * There is deliberately no second implementation of any of this. If a symbol
 * below is not exported here, the writer has no business using it.
 */
export { deriveMemberProjection, PROJECTION_STATUS, EXPIRING_WITHIN_DAYS } from '../../src/utils/memberProjection.js'
export { resolveGymTimezone, DEFAULT_GYM_TIMEZONE, gymDayKey, gymTodayKey } from '../../src/utils/gymTime.js'
/**
 * The dues-drift detector, bundled from the same money module the app uses.
 * A reconciliation job computing its own ledger would be able to disagree with
 * the app it is reconciling, which defeats the point.
 */
export { duesDriftForMember, findDuesDrift, DRIFT_FIELDS } from '../../src/utils/duesDrift.js'
/**
 * Role lists, bundled from the app's single permission table. The drift-report
 * callable must gate on exactly the roles that hold `finance.view`; re-typing
 * that list in `functions/` is how two answers to "who is finance" appear.
 */
export { FINANCE_VIEW_ROLES } from '../../src/utils/constants.js'