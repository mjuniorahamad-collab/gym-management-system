import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.js'],
    css: false,
    // `scripts/**` holds the operator/deploy tooling. Its unit tests live next to
    // the scripts so a broken parser or argument handler fails the CI `app` job,
    // not the deploy job that runs them for real.
    include: ['src/tests/**/*.test.{js,jsx}', 'scripts/**/*.test.mjs'],
  },
})
