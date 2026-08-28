import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests.emulator/**/*.test.js'],
    testTimeout: 30000,
  },
})
