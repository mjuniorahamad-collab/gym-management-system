import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // The emulator suites used to test `firestore.rules` as text through raw SDK
  // calls. `moneyPathEmulator.test.js` drives the REAL service layer
  // (`recordPayment`, `deleteMembershipPeriod`) against the emulator, and the
  // services import through the app's `@/` alias, so it has to resolve here too.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests.emulator/**/*.test.js'],
    // The Storage suites need the Storage emulator, which `npm run test:rules`
    // deliberately does not boot (--only firestore). Running them here would
    // abort on `assertEmulatorRunning` and turn a green Firestore gate red for a
    // reason that has nothing to do with Firestore. They have their own config
    // and script: `npm run test:storage` -> vitest.storage.js.
    exclude: ['tests.emulator/storage*.test.js'],
    testTimeout: 30000,
    // @firebase/rules-unit-testing v6 opens the emulator connection with an
    // extra round-trip inside beforeAll; the 10s default hook timeout started
    // aborting whole suites ("Hook timed out in 10000ms") and skipping 59
    // tests. 30s matches testTimeout and the functions suite.
    hookTimeout: 30000,
    // All these suites talk to ONE shared emulator database, and two of them
    // seed the pre-migration `settings/app` singleton. Running files in parallel
    // workers therefore races on that shared document: measured, adding a seventh
    // file made "frontDeskA reads settings/app" and "the owning gym can still read
    // and update the legacy global singleton" fail intermittently (both pass
    // alone, and a different one failed on each run). The suites already use
    // unique ids to coexist; serial file execution removes the remaining shared
    // document race instead of hiding it behind retries.
    fileParallelism: false,
  },
})
