import { defineConfig } from 'vitest/config'

/**
 * Config for the trusted projection writer's suites.
 *
 * Separate from `vitest.config.js` (jsdom, the app's own tests) and
 * `vitest.emulator.js` (rules, via @firebase/rules-unit-testing) because these
 * suites run in Node against the Firestore emulator through the Admin SDK, which
 * is exactly what the deployed writer uses.
 *
 * Kept out of `npm test` on purpose: `npm test` needs no emulator, and a suite
 * that silently required one would make the default gate depend on Docker-less
 * infrastructure. Run these with `npm run test:functions`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['functions/test/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})