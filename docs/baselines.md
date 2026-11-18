# Frozen rule baselines — archived evidence, counts asserted

Two test files are kept in this repository as **historical evidence of the rules
before tenancy and field hardening**. They are deliberately red and must stay
untouched:

| File | What it is | State (the archived file's own tests) |
| --- | --- | --- |
| `tests.emulator/firestoreSecurityEmulator.test.js` | Phase 0.5A behavioural attack-path baseline for `firestore.rules` | **26 failed / 381 passed** |
| `tests.emulator/storageBaselineEmulator.test.js` | Phase 2 characterization of the pre-Phase-3A `storage.rules` | **32 failed / 18 passed** |

The counts above are the archived file's own results, and they are the numbers
CI asserts. The whole frozen run also executes the live suites, so its totals are
higher (currently 26 failed / 671 passed for Firestore, 32 failed / 173 for
Storage) and they grow whenever a live suite gains a test — that is not baseline
drift, which is why the gate pins the file, not the run.

Each file's header says so itself, and the Storage header states the failing
assertions describe permissions that were intentionally revoked, not defects.

## Where they run

They are **excluded from the gating suites** (`FROZEN_BASELINES=1` selects them,
see `vitest.emulator.js` and `vitest.storage.js`) and run in CI's separate
`Frozen baselines (expected counts asserted)` job:

```bash
npm run test:rules:frozen      # archived file: expect 26 failed / 381 passed
npm run test:storage:frozen    # archived file: expect 32 failed / 18 passed
```

Both commands run the suite through `scripts/assert-frozen-baseline.mjs`. Because
the files are red by design, the run's exit code cannot carry the verdict: the
script reads the vitest JSON report and compares the baseline file's **own**
counts with the numbers in the table above. Matching counts pass the job — so the
red X is replaced by a green check — and any drift (edited assertion, a test that
stopped being collected, moved rules) fails it. The raw, unasserted runs stay
available as `npm run test:rules:frozen:raw` and `npm run test:storage:frozen:raw`;
both write `.frozen/<suite>.json` for inspection.

Do not "fix" a drift by editing a baseline assertion, and do not silence it by
re-tolerating the job: that is the regression this gate exists to catch.

## Why not convert them?

A conversion would rewrite the evidence: the value of these files is that they
record exactly what the old rules permitted, in the form they were measured.
Instead, today's intent is asserted green in the gating suites, and the mapping
is documented in `AUDIT-gym-management-system.md` §16:

- `tests.emulator/firestoreCurrentContractEmulator.test.js` — 13 tests for the
  query-isolation, audit-log and booking-cancel intents the baseline pinned; the
  remaining frozen scenarios are already asserted green by
  `firestoreSecurityRemediation.test.js` and
  `firestoreReceiptIntegrityEmulator.test.js` (see the table at the top of that
  file).
- `tests.emulator/storageSecurityEmulator.test.js` (`S1`–`S9`) — the green
  counterpart of every Storage `CHAR-*` assertion.

## Deleting

If the project ever decides the history is no longer needed, delete these two
files together with the `baseline` CI job, `scripts/assert-frozen-baseline.mjs`
and the `test:*:frozen*` scripts. Do not edit an assertion inside them: a
half-edited baseline is neither evidence nor a test.
