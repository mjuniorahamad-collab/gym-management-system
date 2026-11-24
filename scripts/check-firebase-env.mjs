#!/usr/bin/env node
/**
 * Pre-build check for the Firebase web configuration — READ ONLY.
 *
 * WHY IT EXISTS
 *   Vite inlines every `VITE_FIREBASE_*` variable it finds in the environment
 *   into the bundle, and `src/firebase/config.js` reads six of them. A build
 *   that runs without one of those secrets does not fail: it ships
 *   `apiKey: void 0` and every user gets the "Firebase is not configured" login
 *   page. `scripts/smoke-hosting.mjs` refuses such a bundle, but in deploy.yml
 *   that check runs after Hosting has already published it. This check runs
 *   before `npm run build`, so a missing or blank repository secret stops the
 *   job while nothing has been built, uploaded or deployed.
 *
 * WHAT IT CHECKS
 *   That each of the six variables is present and not blank. Nothing else: the
 *   values are public by design (they end up in the bundle), and whether the
 *   bundle really carries a usable api key is the smoke check's job.
 *
 * WHAT IT NEVER DOES
 *   Print, log or otherwise store a value. Only variable names reach the log.
 *
 * USAGE
 *   node scripts/check-firebase-env.mjs
 *
 * EXIT  0 all six are set · 1 at least one is empty or missing
 */

import process from 'node:process'
import { pathToFileURL } from 'node:url'

// The same six `import.meta.env.VITE_FIREBASE_*` reads as src/firebase/config.js.
// Keep the order in sync with `.env.example`, so the failure lists them the way
// the file a developer copies from does.
export const REQUIRED_FIREBASE_VARS = Object.freeze([
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
])

/** The names in REQUIRED_FIREBASE_VARS whose value is missing or blank. */
export function missingFirebaseVars(env = process.env) {
  return REQUIRED_FIREBASE_VARS.filter((name) => `${env[name] ?? ''}`.trim() === '')
}

function main() {
  const missing = missingFirebaseVars(process.env)

  if (missing.length === 0) {
    console.log(
      `✓ all ${REQUIRED_FIREBASE_VARS.length} VITE_FIREBASE_* variables are set for this build.`
    )
    return
  }

  for (const name of missing) {
    console.error(
      `::error::${name} is empty or missing, so the build would ship "Firebase is not configured". ` +
        'Add the repository secret before deploying.'
    )
  }
  console.error(
    `\n✗ ${missing.length} of ${REQUIRED_FIREBASE_VARS.length} Firebase web config variables are not set:\n` +
      `  - ${missing.join('\n  - ')}\n\n` +
      'The job stops before the build, so no bundle without the config can be deployed.'
  )
  process.exit(1)
}

// Imported by tests, which never want the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
