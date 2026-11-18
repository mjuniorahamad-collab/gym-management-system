#!/usr/bin/env node
/**
 * Frozen baseline gate — assert the documented red, never edit the evidence.
 *
 * WHY IT EXISTS
 *   `tests.emulator/firestoreSecurityEmulator.test.js` and
 *   `tests.emulator/storageBaselineEmulator.test.js` are archived attack-path
 *   baselines. They are red on purpose: the archived rules allowed reads the
 *   current rules deny, and `docs/baselines.md` records exactly how red they are
 *   supposed to be. The counts pinned here are the ARCHIVED FILE's own results
 *   (26 failed / 381 passed for Firestore, 32 failed / 18 passed for Storage),
 *   not the whole run's totals: the frozen run also executes the green suites, so
 *   its totals grow whenever a live suite gains a test, which is not baseline
 *   drift and must not turn this job red.
 *
 *   A job that merely tolerates their failures cannot tell "still red where we
 *   documented it" from "an assertion was edited, a test stopped being collected,
 *   or the archived rules moved". This script compares the per-file counts of the
 *   frozen run with the documented ones: the same counts pass the job, any drift
 *   fails it.
 *
 * WHAT IT NEVER DOES
 *   - It does not edit, skip or rewrite an assertion in either baseline file.
 *   - It ignores vitest's exit code: a frozen run is expected to exit non-zero,
 *     so the JSON reporter's per-file counts are the source of truth.
 *   - It ignores the counts of the green suites that share the same run; only the
 *     baseline file's own results are compared. The run totals are printed as
 *     context, never asserted.
 *
 * USAGE
 *   node scripts/assert-frozen-baseline.mjs firestore
 *   node scripts/assert-frozen-baseline.mjs storage
 *
 *   Wired as `npm run test:rules:frozen` and `npm run test:storage:frozen`.
 *   Each run writes its JSON report to `.frozen/<suite>.json` (gitignored).
 *
 * EXIT  0 counts match · 1 drift · 2 the suite produced no results
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const BASELINES = {
  firestore: {
    label: 'Firestore',
    file: 'tests.emulator/firestoreSecurityEmulator.test.js',
    script: 'test:rules:frozen:raw',
    outputFile: '.frozen/firestore.json',
    expected: { failed: 26, passed: 381 },
  },
  storage: {
    label: 'Storage',
    file: 'tests.emulator/storageBaselineEmulator.test.js',
    script: 'test:storage:frozen:raw',
    outputFile: '.frozen/storage.json',
    expected: { failed: 32, passed: 18 },
  },
}

function usage() {
  console.log(
    [
      'Frozen baseline gate — compare an archived baseline run with docs/baselines.md',
      '',
      '  node scripts/assert-frozen-baseline.mjs <firestore|storage>',
      '',
      'Exit: 0 counts match · 1 drift · 2 no results produced',
    ].join('\n')
  )
}

/** The baseline file's own failures/passes out of a vitest JSON report. */
export function countBaselineFile(report, file) {
  const wanted = file.replace(/\\/g, '/')
  const entry = (report.testResults || []).find((result) =>
    String(result.name || '')
      .replace(/\\/g, '/')
      .endsWith(wanted)
  )
  if (!entry) return null

  const counts = { failed: 0, passed: 0 }
  for (const assertion of entry.assertionResults || []) {
    if (assertion.status === 'failed') counts.failed += 1
    else if (assertion.status === 'passed') counts.passed += 1
  }
  return counts
}

/** Human-readable drift between a measured count and the documented one. */
export function compareCounts(actual, expected) {
  return ['failed', 'passed']
    .filter((key) => actual[key] !== expected[key])
    .map((key) => {
      const delta = actual[key] - expected[key]
      return `${key}: documented ${expected[key]}, measured ${actual[key]} (${delta > 0 ? '+' : ''}${delta})`
    })
}

function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Frozen baseline counts\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`)
}

function runSuite(spec) {
  mkdirSync(dirname(spec.outputFile), { recursive: true })
  rmSync(spec.outputFile, { force: true })

  const result = spawnSync('npm', ['run', spec.script], {
    stdio: 'inherit',
    env: process.env,
    // npm is a .cmd shim on Windows, where spawn needs a shell to resolve it.
    shell: process.platform === 'win32',
  })

  try {
    return { report: JSON.parse(readFileSync(spec.outputFile, 'utf8')), status: result.status }
  } catch {
    return { report: null, status: result.status }
  }
}

function main() {
  const suite = process.argv[2]
  const spec = BASELINES[suite]
  if (!spec) {
    usage()
    process.exit(2)
  }

  const { report, status } = runSuite(spec)
  if (!report) {
    console.error(
      `\nFrozen ${spec.label} baseline produced no JSON report at ${spec.outputFile}` +
        ` (suite exit status: ${status}). The assertions did not run, so their counts cannot be checked.\n`
    )
    process.exit(2)
  }

  const actual = countBaselineFile(report, spec.file)
  if (!actual) {
    console.error(`\nThe report contains no results for ${spec.file}: the baseline file was not collected.\n`)
    process.exit(2)
  }

  const drift = compareCounts(actual, spec.expected)
  const lines = [
    `Frozen ${spec.label} baseline — ${spec.file}`,
    `  documented : ${spec.expected.failed} failed / ${spec.expected.passed} passed`,
    `  measured   : ${actual.failed} failed / ${actual.passed} passed`,
    `  run totals : ${report.numFailedTests ?? '?'} failed / ${report.numPassedTests ?? '?'} passed` +
      ' (context only: includes the green suites, not asserted)',
  ]

  if (drift.length === 0) {
    lines.push('  result     : counts match the documented baseline')
    console.log(`\n${lines.join('\n')}\n`)
    writeSummary(lines)
    return
  }

  lines.push('  result     : DRIFT')
  for (const item of drift) lines.push(`    - ${item}`)
  console.error(`\n${lines.join('\n')}\n`)
  console.error(
    'The frozen baseline no longer fails where docs/baselines.md says it does.\n' +
      'Do not edit an assertion inside the baseline file to silence this: a half-edited\n' +
      'baseline is neither evidence nor a test. Either restore the file, or — if the\n' +
      'archived rules or the documented counts genuinely changed — update\n' +
      'docs/baselines.md and BASELINES in scripts/assert-frozen-baseline.mjs together\n' +
      'in one reviewable commit.\n'
  )
  writeSummary(lines)
  process.exit(1)
}

// Imported by src/tests/frozenBaseline.test.js, which never wants the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
