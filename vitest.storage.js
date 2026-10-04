import { defineConfig } from 'vitest/config'

/**
 * Config for the Cloud Storage rules suites.
 *
 * Separate from `vitest.config.js` (jsdom, the app's own tests),
 * `vitest.emulator.js` (Firestore rules) and `vitest.functions.js` (the trusted
 * projection writer) because these suites need BOTH the Firestore and the
 * Storage emulator: Storage is the system under test, and Firestore is used
 * only as a fixture store for the `users/{uid}` and `members/{id}` documents
 * that tenant-scoped rules will read.
 *
 * Kept out of `npm test` and out of `npm run test:rules` on purpose. `npm test`
 * needs no emulator at all, and `test:rules` boots `--only firestore`, so a
 * Storage suite living in either would fail for infrastructure reasons rather
 * than because a rule is wrong. Run these with `npm run test:storage`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests.emulator/storage*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // These files share ONE Storage emulator and therefore one object namespace.
    // Running them in parallel is unsafe: each suite seeds its own fixtures in
    // `beforeAll` and asserts against the whole bucket, so one file's seed
    // could land in the middle of another file's run. Neither file calls
    // clearStorage()/clearFirestore() - they use disjoint id prefixes instead -
    // so sequential execution is both correct and still fast.
    fileParallelism: false,
  },
})