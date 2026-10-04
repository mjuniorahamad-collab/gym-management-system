import { defineConfig } from 'vitest/config'

export default defineConfig({
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
  },
})
