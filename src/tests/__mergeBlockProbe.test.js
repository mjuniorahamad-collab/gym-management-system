// Throwaway probe (deleted again immediately): this file exists only to make the
// `Lint · build · unit tests` required check fail on a PR into `main`, proving the
// branch protection blocks a red commit. It is never merged.
import { describe, expect, it } from 'vitest'

describe('merge-block probe', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2)
  })
})
