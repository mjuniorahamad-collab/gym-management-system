/**
 * Unit tests for `scripts/check-firebase-env.mjs`.
 *
 * The check is the only thing standing between an empty repository secret and a
 * published bundle that says "Firebase is not configured". A false pass here is
 * silent, so the pure helper and the exit code are both covered on every
 * `npm test`, i.e. in the CI `app` job, before the deploy workflow can rely on it.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REQUIRED_FIREBASE_VARS, missingFirebaseVars } from './check-firebase-env.mjs'

// The default vitest environment here is jsdom, which presents import.meta.url as
// an http:// URL, so fileURLToPath cannot take it. `npm test` always runs from the
// repository root, which is also where the deploy workflow runs this script.
const SCRIPT = import.meta.url.startsWith('file:')
  ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-firebase-env.mjs')
  : path.resolve(process.cwd(), 'scripts', 'check-firebase-env.mjs')

// A complete, obviously fake config: the check only reads presence, never values.
const COMPLETE = {
  VITE_FIREBASE_API_KEY: 'AIza-not-a-real-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'example',
  VITE_FIREBASE_STORAGE_BUCKET: 'example.appspot.com',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
  VITE_FIREBASE_APP_ID: '1:1234567890:web:abcdef',
}

/** Run the CLI with exactly these variables and nothing inherited from the shell. */
function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })
}

describe('missingFirebaseVars', () => {
  it('reports nothing when all six variables are set', () => {
    expect(missingFirebaseVars(COMPLETE)).toEqual([])
  })

  it('names every missing variable in REQUIRED_FIREBASE_VARS order', () => {
    const env = { ...COMPLETE }
    delete env.VITE_FIREBASE_API_KEY
    delete env.VITE_FIREBASE_APP_ID

    expect(missingFirebaseVars(env)).toEqual(['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_APP_ID'])
  })

  it('treats a blank or whitespace-only secret as missing', () => {
    const env = { ...COMPLETE, VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '   ' }

    expect(missingFirebaseVars(env)).toEqual(['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID'])
  })
})

describe('check-firebase-env CLI', () => {
  it('exits 1 before the build and names each empty secret', () => {
    const env = { ...COMPLETE, VITE_FIREBASE_APP_ID: '' }
    const result = run(env)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VITE_FIREBASE_APP_ID')
    expect(result.stderr).toContain('1 of 6')
  })

  it('never echoes a value, only the variable names', () => {
    const result = run({ ...COMPLETE, VITE_FIREBASE_AUTH_DOMAIN: '' })

    expect(result.stderr).not.toContain(COMPLETE.VITE_FIREBASE_API_KEY)
    expect(result.stderr).not.toContain(COMPLETE.VITE_FIREBASE_APP_ID)
  })

  it('exits 0 when the whole config is present', () => {
    const result = run(COMPLETE)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`all ${REQUIRED_FIREBASE_VARS.length}`)
  })
})
