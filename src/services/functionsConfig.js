/**
 * CLOUD FUNCTIONS — where they are and whether they exist in this environment.
 *
 * Two separate mistakes used to live in the two callers:
 *
 * 1. REGION. Every callable in functions/index.js declares
 *    `region: 'asia-south1'`, but `getFunctions()` defaults to us-central1. The
 *    client therefore POSTed to an endpoint that does not exist, Google answered
 *    with an HTML 404, and the browser reported it as a CORS failure. Nothing was
 *    wrong with CORS; the URL was wrong.
 *
 * 2. DEPLOYMENT. Cloud Functions v2 needs a billing plan this project does not
 *    have, so the callables are not deployed at all. A report card that asks for
 *    them on every Settings load can only ever fail, and it fills the console with
 *    a red network error for a feature that was never switched on. With
 *    `VITE_ENABLE_CALLABLES` unset the client does not call at all, and the card
 *    says so plainly. Set it to "true" in the build environment once the
 *    functions are deployed.
 *
 * Both callable clients read this flag: the integrity report (Settings) and the
 * post-renewal reprojection request, which otherwise logged a console warning
 * after every renewal about a sweep that cannot run either.
 */

/** Matches the `region` declared by every callable in functions/index.js. */
export const FUNCTIONS_REGION = 'asia-south1'

/** True only when the callables are deployed for the project being built. */
export const CALLABLES_ENABLED =
  String(import.meta.env?.VITE_ENABLE_CALLABLES ?? '').toLowerCase() === 'true'
