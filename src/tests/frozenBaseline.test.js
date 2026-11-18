/**
 * The frozen baselines are red on purpose, so their CI job cannot use exit codes
 * to decide anything: `scripts/assert-frozen-baseline.mjs` compares the archived
 * file's own counts with the numbers in `docs/baselines.md`. These tests cover
 * that comparison, which is the only thing standing between "still red exactly
 * where we documented it" and "an assertion quietly changed".
 *
 * They use vitest JSON reports shaped like the real reporter's output, so no
 * emulator, no Firebase CLI and no network are involved.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASELINES, compareCounts, countBaselineFile } from '../../scripts/assert-frozen-baseline.mjs'

/** A vitest JSON report entry for one file, from a list of assertion statuses. */
function fileResult(name, statuses) {
  return {
    name,
    assertionResults: statuses.map((status, i) => ({ title: `assertion ${i}`, status })),
  }
}

function statuses(failed, passed, skipped = 0) {
  return [
    ...Array.from({ length: failed }, () => 'failed'),
    ...Array.from({ length: passed }, () => 'passed'),
    ...Array.from({ length: skipped }, () => 'skipped'),
  ]
}

const FIRESTORE = BASELINES.firestore
const STORAGE = BASELINES.storage

describe('frozen baseline counts', () => {
  it('counts only the baseline file, not the green suites sharing the run', () => {
    const report = {
      testResults: [
        fileResult('/repo/tests.emulator/moneyPathEmulator.test.js', statuses(0, 40)),
        fileResult(`/repo/${FIRESTORE.file}`, statuses(26, 381)),
        fileResult('/repo/tests.emulator/firestoreSecurityRemediation.test.js', statuses(0, 120, 3)),
      ],
    }

    expect(countBaselineFile(report, FIRESTORE.file)).toEqual({ failed: 26, passed: 381 })
    expect(compareCounts(countBaselineFile(report, FIRESTORE.file), FIRESTORE.expected)).toEqual([])
  })

  it('matches the path when the report uses Windows separators', () => {
    const report = { testResults: [fileResult('C:\\repo\\tests.emulator\\firestoreSecurityEmulator.test.js', statuses(26, 381))] }

    expect(countBaselineFile(report, FIRESTORE.file)).toEqual({ failed: 26, passed: 381 })
  })

  it('returns null when the baseline file was not collected', () => {
    const report = { testResults: [fileResult('/repo/tests.emulator/moneyPathEmulator.test.js', statuses(0, 40))] }

    expect(countBaselineFile(report, STORAGE.file)).toBeNull()
  })

  it('reports drift in both directions instead of accepting any red count', () => {
    expect(compareCounts({ failed: 25, passed: 382 }, FIRESTORE.expected)).toEqual([
      'failed: documented 26, measured 25 (-1)',
      'passed: documented 381, measured 382 (+1)',
    ])

    expect(compareCounts({ failed: 27, passed: 380 }, FIRESTORE.expected)).toEqual([
      'failed: documented 26, measured 27 (+1)',
      'passed: documented 381, measured 380 (-1)',
    ])
  })

  it('keeps the asserted counts in step with docs/baselines.md', () => {
    const docs = readFileSync(resolve('docs/baselines.md'), 'utf8')

    for (const suite of [FIRESTORE, STORAGE]) {
      expect(docs).toContain(`${suite.expected.failed} failed / ${suite.expected.passed} passed`)
    }
  })
})
