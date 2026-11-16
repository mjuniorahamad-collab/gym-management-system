# Frozen rule baselines — archived, non-gating

Two test files are kept in this repository as **historical evidence of the rules
before tenancy and field hardening**. They are deliberately red and must stay
untouched:

| File | What it is | State |
| --- | --- | --- |
| `tests.emulator/firestoreSecurityEmulator.test.js` | Phase 0.5A behavioural attack-path baseline for `firestore.rules` | **26 failed / 652 passed** |
| `tests.emulator/storageBaselineEmulator.test.js` | Phase 2 characterization of the pre-Phase-3A `storage.rules` | **32 failed / 173 passed** |

Each file's header says so itself, and the Storage header states the failing
assertions describe permissions that were intentionally revoked, not defects.

## Where they run

They are **excluded from the gating suites** (`FROZEN_BASELINES=1` selects them,
see `vitest.emulator.js` and `vitest.storage.js`) and run in CI's separate
`Frozen baselines (informational, non-gating)` job with
`continue-on-error: true`:

```bash
npm run test:rules:frozen      # expect 26 failed / 652 passed
npm run test:storage:frozen    # expect 32 failed / 173 passed
```

The pipeline verdict comes from the gating jobs only, so a permanently red
baseline can never again hide a regression in a live suite.

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
files together with the `baseline` CI job and the `test:*:frozen` scripts. Do not
edit an assertion inside them: a half-edited baseline is neither evidence nor a
test.
