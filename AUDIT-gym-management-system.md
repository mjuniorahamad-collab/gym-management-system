# Audit — gym-management-system

**Repo:** `mjuniorahamad-collab/gym-management-system` (public, JavaScript)
**Branch audited:** `production-readiness/phase-4` @ `685a27e` (default branch)
**Date:** 14 Nov 2026
**Stack:** React 18 + Vite 5 · Firebase Auth / Firestore / Storage · Cloud Functions v2 (Node 20) · Tailwind · Vitest

---

## 0. Scope & method

Read the full security surface (`firestore.rules` 645 lines, `storage.rules` 181 lines), auth/session
flow, payments & receipt path, tenancy bootstrap, the Cloud Functions projection writer, and the
existing audit docs in `docs/security/`. Then ran the real toolchain:

| Check | Command | Result |
| --- | --- | --- |
| Install (locked) | `npm ci` | ✅ 545 packages, exit 0 |
| Production build | `npm run build` | ✅ 14.5 s, exit 0 |
| Lint | `npm run lint` | ✅ 0 errors, 6 `react-refresh` warnings |
| Unit/component tests | `npx vitest run` | ✅ **1183 tests / 76 files passed** (101 s) |
| Dependency audit (app) | `npm audit --omit=dev` | ⚠️ **7 vulns (5 high, 2 moderate)** |
| Dependency audit (functions) | `npm audit --package-lock-only` | ⚠️ **12 vulns (2 high, 9 moderate, 1 low)** |
| Generated `functions/vendor/projection.mjs` in sync | `npm run build` + `git diff` | ✅ no drift |
| Firestore/Storage rules tests | `npm run test:rules` etc. | ❌ **not run** — needs Java + Firebase CLI (not in this VM) |

Not done: production data inspection, deploy verification, manual UI click-through.

---

## 1. Verdict

**Strong foundation, not "just trust the rules" territory.** This is a genuinely hardened codebase:
tenant isolation is derived server-side from `users/{uid}.gymId`, role is write-once, projection
fields are server-owned, receipt prefixes are frozen on the gym document and mirrored in rules,
Storage is private per-gym, and the audit log is append-only. 1183 tests and a clean build.

The gap is not "obvious vulnerabilities". It is **(a) one likely-broken onboarding read that the
rules tests never exercise**, **(b) an aging dependency set**, and **(c) operational hygiene**
(no CI, no security headers, unbounded client-side collection reads).

| Area | Grade |
| --- | --- |
| Firestore/Storage authorization design | A− |
| Auth & tenancy model | A− |
| Rules ↔ app correctness (query legality) | **C** |
| Test coverage (unit) | A |
| Test coverage (rules, in CI) | D |
| Dependency hygiene | C |
| Deployment/operational hardening | C+ |

---

## 2. High priority

### H-1 — Owner-of-record discovery query is denied by its own rules *(likely broken onboarding)*

**Where:** `src/context/AuthContext.jsx:100` vs `firestore.rules:236-243`

```js
// src/context/AuthContext.jsx:100
const snap = await getDocs(query(collection(db, 'gyms'), where('ownerUid', '==', uid)))
```

```js
// firestore.rules:236
match /gyms/{gymId} {
  allow read: if isSignedIn()
    && resource != null                       // ← not satisfiable for a list/query
    && 'ownerUid' in resource.data
    && (resource.data.ownerUid == request.auth.uid || (hasGym() && gymOf(request.auth.uid) == gymId));
```

Firestore evaluates a **collection query** against the query's potential result set, and `resource`
is not the document being evaluated there (no `resource != null` to satisfy). A read rule that
requires `resource != null` therefore denies the *whole query*, no matter how well the `where()`
clause matches. Your own report already records the mechanism:
`docs/security/phase-0.5b-security-and-remediation-report.md` §4 — *"`resource` is unavailable for
`list`, which surfaces as a `Variable read error … for 'list'` → `permission-denied`"*.

**Impact.** A pre-provisioned owner (the flow the README documents: create `gyms/gym-abc` with
`ownerUid`, then sign in) fails at discovery. The `catch` in `bootstrapProfile()` sets
`pendingOnboarding = true`, so the user is shown **"Create your gym"** and, if they accept, gets a
brand-new empty gym written with `addDoc` — while their real, provisioned gym and all its members
stay orphaned behind the old `gymId`. Every collection read then fails tenant scoping (or shows an
empty app).

**Coverage gap.** No test exercises this query. Every emulator test seeds gyms with the Admin SDK
(`fs.doc('gyms/GYM_A').set(...)`) and never queries the `gyms` collection as a client, so the
suite can be 100% green while this path is denied.

**Fix (rules):** split `get` and `list`, and never reference `resource != null` in the list clause:

```js
match /gyms/{gymId} {
  allow get: if isSignedIn()
    && resource != null
    && 'ownerUid' in resource.data
    && (resource.data.ownerUid == request.auth.uid
        || (hasGym() && gymOf(request.auth.uid) == gymId));

  // Query is constrained by where('ownerUid','==',uid); no resource presence test here.
  allow list: if isSignedIn() && resource.data.ownerUid == request.auth.uid;
}
```

**Fix (app, defense in depth):** don't depend on a collection query at all — if the gym id is known
(console/CLI provisioning), read `gyms/{gymId}` directly; and make the bootstrap failure
**fail closed**: never route an error into "create a new gym". Show the error instead, otherwise a
transient network failure can mint a second gym for the same person.

**Verify:** add one emulator test that runs the *real client query* as a fresh user
(`getDocs(query(collection('gyms'), where('ownerUid','==',uid)))`) and asserts it returns the
provisioned gym — and one asserting it returns nothing for another user's gym.

> Confidence: high (documented Firestore list semantics + your own report). Not executed here
> because the emulator needs Java. Confirm with the single query test above before shipping the fix.

### H-2 — Vulnerable dependencies

App (`npm audit --omit=dev` → 7 vulns, 5 high):

- **zod < 4.6.6 — high** (GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained
  collections). Fix is `zod@4` — a breaking major (v3 → v4 API changes touch
  `src/schemas/validationSchemas.js` and every `zodResolver` form). Needs a planned upgrade + test
  run, not `--force`.
- **react-router / react-router-dom 6.x — moderate** (open redirect via backslash in `<Link>` /
  `useNavigate`, plus SSR `deserializeErrors` injection). A non-breaking patch/minor is available
  via `npm audit fix`; the app is client-only so exposure is limited to the redirect issue.

Functions (`12 vulns, 2 high`) come in transitively via `firebase-admin@12` →
`@google-cloud/storage` / `google-gax` / `teeny-request`. `npm audit fix` inside `functions/`
should move these; then re-run `npm run build` there to regenerate `vendor/projection.mjs` and
confirm no drift.

**Why this matters here more than usual:** the app handles money (payments, receipts, dues) and
personal data (phone, address, DOB, photos) for gym members. An unpatched `zod` is a cheap DoS on
every form; an unpatched router is a phishing redirect vector in a staff app.

---

## 3. Medium priority

### M-1 — Unbounded client-side collection reads

`listAll()` (`src/services/firestore.js:37`) has **no `limit()`**. It is called on the hottest and
largest collections:

| Call site | What it loads |
| --- | --- |
| `src/services/attendanceSessions.js:196` | **every attendance row in the gym**, on check-in/out reconciliation |
| `src/services/receipts.js:57` | every payment, to seed the receipt counter (once per session) |
| `src/services/memberships.js:123` | every payment, for dues/allocation roll-ups |
| `src/services/memberNumbers.js:58` | every member, to seed the member-number counter |
| `src/services/payments.js:28` | every payment + membership + plan in one call |

A gym with 500 members and a year of attendance is ~100k+ documents. That is seconds of load, real
Firestore read cost, and a plausible OOM on the low-end Android tablet a front desk actually uses.
`attendance` is the worst offender — it grows linearly with check-ins.

Fix direction: keep per-gym counters in `counters/*` (you already do for receipts/member numbers),
use `getCountFromServer`/aggregation for totals, and filter attendance by date range with a
composite index instead of listing the collection.

### M-2 — Missing production security headers

`firebase.json:6-15` sets only cache-control and `X-Content-Type-Options`. For a financial/PII app,
add at minimum:

```json
{ "key": "Content-Security-Policy", "value": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.cloudfunctions.net; frame-ancestors 'none'; base-uri 'self'" },
{ "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" },
{ "key": "X-Frame-Options", "value": "DENY" },
{ "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
```

(Test the CSP against Firebase Auth popups and Storage download URLs before deploying.)

### M-3 — No CI

No `.github/workflows`. 84 test files, 1183 tests, plus three emulator suites that are the *only*
automated proof of the authorization model — none of it runs on push. Given a public repo with
outside contributors possible, this is the cheapest high-value improvement: one workflow running
`npm ci && npm run lint && npm run build && npm test`, and a second job with
`firebase emulators:exec --only firestore,storage` for the rules suites.

### M-4 — Emulator scripts are Windows-only

`package.json` scripts use `set FIRESTORE_EMULATOR_VERSION=1.19.8&& …`, which is `cmd.exe` syntax.
On macOS, Linux and CI this silently fails (`set` with no args prints shell variables; the version
pin is lost or the chain breaks). Use `cross-env`:

```json
"test:rules": "cross-env FIRESTORE_EMULATOR_VERSION=1.19.8 firebase emulators:exec --project demo-himalye-gym --only firestore \"vitest run --config vitest.emulator.js\""
```

### M-5 — Nightly backup: memory, retention and tenant scoping

`functions/index.js:38-72` (`dailyBackup`, 256 MiB): loads **every collection fully into memory**
per run, writes one JSON per collection for **all tenants into one prefix**, and never prunes.
- Memory/time: `snap.docs.map(...)` on `payments`/`attendance` will exceed 256 MiB on a mid-size
  deployment; raise to 1–2 GiB or stream per tenant in batches.
- Retention: nothing deletes old `backups/<date>/` objects. Add a Storage lifecycle rule (e.g.
  keep 30 daily + 12 monthly), otherwise the bucket and backup time grow forever.
- The audit entry it writes (`auditLog` add) has **no `gymId`**, so it is invisible to every gym's
  gym-scoped audit view. That's acceptable for a system event, but give it an explicit
  `scope: 'system'` field so nothing looks like a missing tenant later.

### M-6 — README documents staff management that doesn't exist

README: *"Add more staff under Settings → Load sample data / manage roles (update `users/{uid}`
role docs)"*. There is no staff-invite/manage UI in `src/`, and the rules **cannot** support one as
written: an admin creating another user's profile hits
`isRole('admin') && inCallerGym(uid) && …`, but `inCallerGym(uid)` requires `gymOf(uid)` to already
exist — impossible for a brand-new staff uid. Combined with `roleWriteOnce()`, the only working path
is Console/Admin SDK provisioning: create the Auth user, then create `users/{uid}` with
`{ name, email, role, gymId }`.

That's a **deliberate, defensible** posture (owner can't be impersonated, role can't drift) — but
it must be documented as an admin/CLI step, and the README + Settings page should say so. Round out
the existing provisioning script (`scripts/init-tenant-settings.mjs`) with an `addStaff.mjs`.

---

## 4. Low / polish

- **L-1** `.env.example` ships `VITE_ENABLE_SEEDING=true`. `loadSampleData()` is a real UI action
  (owner + empty collections) and would happily populate a production gym with fake members,
  payments and receipts. Default it to `false` and gate on `import.meta.env.DEV`.
- **L-2** `/portal` route renders a static "Coming soon in v2" placeholder (`src/pages/MemberPortal.jsx`)
  and is not linked in the sidebar. Either remove the route or put it behind a feature flag.
- **L-3** `receipts.js` fallback numbering mixes 6-digit sequence values with epoch-ms values, so
  receipt numbers are not uniformly padded and don't sort by issue order after a fallback. It is
  collision-safe (which is the important part) — consider documenting the exception on the receipt
  itself or alerting when the fallback path fires.
- **L-4** No client error reporting sink. `ErrorBoundary` and Phase 5A load-error surfaces exist,
  which is good, but failures only reach the user's screen. A lightweight reporter (Sentry or a
  Firestore `clientErrors` collection) would turn "the app is blank" support tickets into data.
- **L-5** `.firebaserc` pins `himalye-wonders-gym` in a public repo. The project id isn't a secret,
  but config that is environment-specific belongs outside the public history if you ever add a
  second deployment.

---

## 5. What's already done well (keep it)

- **Tenancy is server-derived, not client-asserted**: every rule resolves the caller's gym from
  `users/{uid}.gymId`, which is write-once and pinned to `gyms/{gymId}.ownerUid`. Null-safe helpers
  mean denial is explicit, never an evaluation exception.
- **Role escalation is closed**: `roleWriteOnce()` freezes role after creation; `canBindGymId()`
  cannot introduce a role other than the caller's own or `owner`.
- **Financial integrity**: receipt numbers are immutable on update, must match the frozen
  `gyms/{gymId}.receiptPrefix` at create, and are minted inside the same transaction as the payment.
- **Bookings** resolve `memberId`/`classId` existence + gym from the server side rather than
  trusting denormalized payload fields — a pattern most codebases get wrong.
- **Projection fields** (`membershipStart`, `effectiveExpiry`, `freezeUntil`, `status`, `isFrozen`)
  are server-owned, and the rules compare values rather than keys, so a client can't stage a write.
- **Storage** migrated to gym-scoped paths with role + parent-document checks, content-type and
  extension allowlists, size caps, and explicit deny of the legacy public prefixes.
- **Test culture**: 1183 tests, including regression suites for tenancy, receipt integrity, finance
  visibility and freeze tails — far above typical for a project this size.

---

## 6. Suggested order of work

1. **H-1** — add the two emulator tests for the owner-discovery query; if they fail, ship the
   `get`/`list` split + fail-closed bootstrap. *(half a day, highest user-visible risk)*
2. **M-4 + M-3** — `cross-env` the emulator scripts, then a CI workflow that actually runs them.
   *(half a day, makes every later change safe)*
3. **H-2** — `npm audit fix` in `functions/`; plan the `zod@4` upgrade as its own PR with a full
   test run. *(1–2 days)*
4. **M-6 + L-1** — document real staff provisioning; flip the seeding default. *(2 hours)*
5. **M-1** — replace `listAll('attendance'|'payments')` with counters/date ranges. *(1–2 days,
   do this before the first busy gym)*
6. **M-2, M-5, L-2…L-5** — hardening pass. *(1 day)*

---

## 7. Limitations of this audit

- **Rules suites were not executed** (no Java / Firebase CLI in the audit VM). The rules were read
  line by line and cross-checked against the existing emulator suites and reports, but the
  `gyms` list behaviour in H-1 is reasoned from documented Firestore semantics, not observed here.
- **No access to the live Firebase project**: no production data, index or deploy-state inspection.
- **No manual UI/UX pass**: build, lint and 1183 automated tests passed; screens were not clicked.
- Only the default branch `production-readiness/phase-4` was audited (the repo has no `main`).

---

## 8. Follow-up: rules suites executed (same day)

A JDK 21 runtime and Firebase CLI 15.36 were installed into the audit VM, so the emulator
suites from §0 could finally be run.

| Suite | Result |
| --- | --- |
| `vitest.emulator.js` (Firestore rules, 6 files) | **642 passed / 26 failed / 668 total** |
| Same suite against the pre-change `firestore.rules` (baseline) | **642 passed / 26 failed** — identical |
| New `gymsOwnerDiscoveryEmulator.test.js` | 7/7 pass |

All 26 failures live in `tests.emulator/firestoreSecurityEmulator.test.js`, the file its own header
describes as a frozen vulnerable baseline. They are pre-existing and unchanged by this work.
They are the documented emulator-only cases (J1 unscoped collection reads, J5 non-tenancy filter).
The `SEC-M payments.create` failures are stale fixtures that create a payment with no `receiptNo`,
which the receipt-integrity policy now rejects; the dedicated receipt-integrity suite passes.

### Correction to H-1

Running the real query changed the conclusion: **`getDocs(query(collection('gyms'),
where('ownerUid','==',uid)))` succeeds on the emulator against BOTH the old and the new rule.**
The emulator evaluates a list rule against a hypothetical matching document, so `resource != null`
is satisfiable there. H-1 is therefore **not reproducible** and should be treated as *unverified*, not
as a live breakage.

The `get`/`list` split was kept anyway, as defensive hardening: the list path no longer depends on a
presence test whose behaviour differs between emulator and documented canonical semantics, and list
is now explicitly limited to the caller's own `ownerUid`. The 7 new tests pin that contract.
The companion change — bootstrap failures no longer fall through to "Create your gym" — is
independent of the rules question and remains the right behaviour either way.

### Still not verified

- Production list semantics (the audit never touched the live project). If the canonical reading
  in `docs/security/phase-0.5b-…` §4 were correct, *every* collection query would be denied in
  production, not just `gyms`; the live app's usability argues against it, but only a production
  probe settles it.
- `storage.rules` were never released to the project (per §11 of that report), so member-photo and
  logo uploads are unverified in production.

---

## 9. Remediation executed (same day)

### Rules and app

| Change | File |
| --- | --- |
| `gyms` read split into `get` + `list`; the comment that claimed the old rule denied the discovery query was **rewritten** after the emulator disproved it | `firestore.rules` |
| Bootstrap failure is now **fail-closed** — no more silent "Create your gym" on a transient error | `src/context/AuthContext.jsx` |
| That error is surfaced with a sign-out/retry path | `src/pages/Login.jsx` |
| 7 tests that run the app's real discovery query (`where('ownerUid','==',uid)`) | `tests.emulator/gymsOwnerDiscoveryEmulator.test.js` |
| `hookTimeout: 30000` — rules-unit-testing v6 made the 10s default abort suites (59 tests skipped) | `vitest.emulator.js` |
| CI: lint + build + unit + all three emulator suites; Java 21 (firebase-tools 15 requires it) | `.github/workflows/ci.yml` |
| Emulator scripts made POSIX (`cross-env` instead of Windows `set VAR=` ) | `package.json` |
| CSP + HSTS + X-Frame-Options + Referrer-Policy + Permissions-Policy | `firebase.json` |
| Seeding defaults to `false`; real staff-provisioning steps documented | `.env.example`, `README.md` |

### CSP verified in a browser (not just declared)

Built the production bundle with the live project's **public** web config (those values ship inside
the deployed JS anyway), served `dist/` with the exact header set from `firebase.json`, and drove it
in a real browser:

- app rendered at `/login`, fonts + inline theme bootstrap script loaded → **no CSP violation**
- empty submit → "Email is required" / "Password must be at least 6 characters"; bad email →
  "Enter a valid email" (product copy, not zod's raw text)
- sign-in attempt with dummy credentials reached `identitytoolkit.googleapis.com`; UI showed
  "Incorrect email or password" → **Auth not blocked**
- `fetch` to `firestore.googleapis.com` returned **403 PERMISSION_DENIED from the rules**, i.e. the
  request went through CSP and was answered by Firestore → **Firestore not blocked**
- console: no CSP errors (only the expected 400/403 responses)

### Dependencies upgraded

`firebase 13.3.0` · `zod 4.6.7` · `@hookform/resolvers 5.9.2` · `react-router-dom 7.18.5` ·
`@firebase/rules-unit-testing 6.0.0` · `cross-env 7.0.3` · `firebase-admin 14.5.1` (modular API port
in `functions/projection/admin.js`) · `overrides: @grpc/grpc-js ^1.13.6`.

Two migration defects were found and fixed rather than papered over:

1. **zod 4 silently ignores `required_error` / `invalid_type_error` / `errorMap`.** Every one of those
   fields fell back to zod's raw English. Migrated to the v4 `error` param and added three regression
   tests that pin the user-facing strings (`src/tests/validationSchemas.test.js`).
2. **firebase-admin 14 removed the namespaced API** (`admin.apps`, `admin.firestore()`). Ported
   `admin.js` and the test helper to `firebase-admin/app` + `/firestore` + `/storage`.

`npm audit --omit=dev`: **0 vulnerabilities** in the app and **0** in `functions/`.

### Final verification

| Check | Result |
| --- | --- |
| `npm run lint` | 0 errors (6 pre-existing fast-refresh warnings) |
| `npm run build` | ✅ |
| Unit + component | **1186 / 1186** |
| Firestore rules | 642 pass / 26 fail — identical to the pre-change baseline (frozen file) |
| Storage rules | 173 pass / 32 fail — frozen baseline file only |
| Cloud Functions (Admin SDK) | **180 / 180** |
| `npm audit` (app + functions) | **0 / 0** |
| CSP / Auth / Firestore in browser | verified against the production build |

---

## 10. Fresh-eyes review of §9 (same day)

Re-reading the remediation with no attachment to it changed three decisions.

| Change | Verdict | Why |
| --- | --- | --- |
| `firebase` 11 → 13 | **Reverted to 11.10.0** | It was chased only for the grpc advisory. `@grpc/grpc-js` is **not in the shipped bundle** (the built `vendor-firebase` chunk contains only the string `grpcFlowControlWindow`), so the advisory is not reachable from the deployed web app. A major upgrade of the app's core SDK bought nothing. |
| `firebase-admin` 12 → 14 (modular API port) | **Reverted to 12.7.0**; `admin.js` restored | Only cleared **moderate** `uuid` advisories inside `google-gax` (transitive). The port touched the production Functions writer for no reachable benefit. |
| `overrides: @grpc/grpc-js ^1.13.6` | **Removed** | `@firebase/firestore` declares `@grpc/grpc-js: "~1.9.0"` — a tilde range. Forcing 1.14 went outside the library's declared compatibility window to fix a dependency that never reaches the browser. Not worth the standing install risk. |
| `zod` 3 → 4 (+ resolvers 5) | **Kept** | Five high advisories; also fixed a real silently-ignored-parameter bug (§9). |
| `react-router-dom` 6 → 7 | **Kept** | Fixes the 6.x advisories; the SPA is covered by 1186 tests and a browser smoke run. |

Resulting audit state, stated honestly: **app 4 high** (`@grpc/grpc-js`, Node-only, not bundled) and
**functions 8 moderate** (`uuid` inside `google-gax`, reachable only with attacker-controlled buffers).
Neither is fixed by guesswork. Both are recorded rather than suppressed by a risky override.

### `listAll()` collection scans removed

| Site | Before | After |
| --- | --- | --- |
| `payments.refreshMembershipSnapshots` | whole `payments` + whole `memberships` on every payment create/delete | `where memberId == <member>` for both; `computeMemberLedger` already filters by member id, so results are identical |
| `memberships.deleteMembershipPeriod` | whole `payments` collection | `where membershipId == <period>`; the now-redundant in-memory copy plumbing was deleted |
| `receipts.highestExistingSequence` | whole `payments` on first receipt | one-document probe (`limit: 1`); the legacy scan runs only for a gym that already has payments |
| `attendanceSessions.checkOutMember` | flagged in §3 — **correction: that read is inside the mock/offline branch only**, never Firestore | unchanged |
| `memberNumbers.backfillMemberNumbers`, `migration.js`, `seedService` | whole collections, but only in one-time migrations / dev seeding | unchanged (documented) |

`listAll(name, { where, limit })` deliberately omits `orderBy` when filtering: `field == x` plus
an `orderBy` needs a composite index that `firestore.indexes.json` does not declare, and a missing
composite index fails in production with `FAILED_PRECONDITION`. Callers that need order sort in
memory (the ledger already sorts periods by start date).

Test impact: `paymentReadReduction.test.js` was rewritten to pin the **new** read shape (one scoped
read per question, no unfiltered payments read), and the `membershipPeriods` mock now honours the
`where`/`limit` options.

Final state: **1183 unit tests pass**, lint 0 errors, build clean, Firestore rules 642/668 and
Storage 173/205 (frozen baseline files only), Functions 180/180.

---

## 11. Index coverage for the filtered reads, and the money path end to end

### 11.1 Every query the refactor added, against `firestore.indexes.json`

| Query (after tenancy scoping) | Shape | Index needed | Covered by |
| --- | --- | --- | --- |
| `payments` where `memberId == m` | `gymId ==` + `memberId ==` | none — equality only | automatic single-field indexes (`fieldOverrides` is empty, so every field is indexed ascending *and* descending) |
| `memberships` where `memberId == m` | `gymId ==` + `memberId ==` | none — equality only | automatic single-field indexes |
| `payments` where `membershipId == p` | `gymId ==` + `membershipId ==` | none — equality only | automatic single-field indexes |
| `payments` probe, `limit: 1` | `gymId ==` + `orderBy createdAt desc` + `limit 1` | composite | already declared: `payments (gymId ASC, createdAt DESC)` |
| `payments`, legacy receipt scan | `gymId ==` + `orderBy createdAt desc` | composite | same declared index |
| `membershipPlans` (unchanged) | `gymId ==` + `orderBy createdAt desc` | composite | already declared: `membershipPlans (gymId ASC, createdAt DESC)` |

Why no composite index was added: a query that filters on equality only (no `orderBy`, no range on a
different field) is served by index merging over the automatic single-field indexes. A composite
index would only be required if a filtered read gained an `orderBy` — which is exactly why
`listAll` **deliberately omits** `orderBy` when `where` is supplied. Adding unused composite indexes
would only slow down every `payments` write.

Verification done, and its limit, stated plainly:

- **Static:** each shape above was checked against the declared indexes; the only shapes needing a
  composite index are the pre-existing `orderBy createdAt` reads, and all three are declared.
- **Functional:** the new suites run the queries against the Firestore emulator and return the right
  rows.
- **Not verified:** the emulator does **not** enforce index requirements (it will happily serve a
  query production would reject with `FAILED_PRECONDITION`), and the live project's index metadata
  was not queried — there are no admin credentials here. So "index-covered" is established by shape,
  not by a production probe. The first production run of a screen using these reads is the real
  confirmation; an equality-only query failing there would mean a `fieldOverride` was added to
  disable a single-field index, and `fieldOverrides` is empty.

### 11.2 `tests.emulator/moneyPathEmulator.test.js` — the real services, rules enforced

Five tests drive `recordPayment`, `deletePayment` and `deleteMembershipPeriod` through the real
service layer with `firestore.rules` active, then read the database back:

| Test | What it proves |
| --- | --- |
| partial payment | payment document written with the minted receipt (`HWG-000001`), `membershipId`, `type`, `memberName`; `counters/receiptNo_<gym>` = 1; period snapshot `500 / 1500 / partial`; one audit entry |
| second payment | next receipt is `HWG-000002` (no reuse); period settles to `2000 / 0 / paid` |
| foreign prefix | `recordPayment` refuses a prefix that is not the gym's authority — **nothing** written: no payment, no counter movement, snapshot untouched |
| `deleteMembershipPeriod` | only that period's payment is read (filtered query), it is unlinked to `''`, the period document is gone, and the freed cash is FIFO-reallocated onto the remaining period (`2000 / 0 / paid`), audit + reprojection requested |
| `deletePayment` | payment removed, period reverts to `0 / 2000 / due`, both audit entries present |

### 11.3 A real bug this test found (fixed)

The `deletePayment` audit entry was being **silently dropped**. `payments.js` builds its audit
details as `member: payment.memberName || undefined`, and Firestore rejects any document containing
`undefined` ("Unsupported field value: undefined"). Because `logAudit` is deliberately non-throwing
(auditing must never break a payment), the entry disappeared with only a console error — so a
deleted payment could leave no audit trail at all. `src/services/audit.js` now strips undefined
object properties (and turns undefined array slots into null) before writing, leaving `Date`,
Timestamp and FieldValue values untouched.

### 11.4 Two time-of-day-flaky tests (fixed)

The full unit run failed after 19:00 UTC in `membership.test.js` and `renewal.test.js`: the fixture
dates are built from the device clock while `getDaysRemaining` answers in the gym's timezone, so
late in the UTC day the two calendars differ by one and every "today/tomorrow" expectation flips.
Both files now freeze the clock at a fixed mid-morning instant (`vi.useFakeTimers({ toFake: ['Date'] })`),
which makes them independent of the hour they run — the app's timezone-aware behaviour is unchanged
and still what the tests assert.

### 11.5 Emulator suites now run serially

`vitest.emulator.js` gained `fileParallelism: false`.

---

## 12. Atomic money path: payment + receipt counter + snapshots in one transaction

### 12.1 What changed

`src/services/firestore.js` gained `commitAtomically(apply)`: a transaction whose writer API is
`get / upsert / create / update / remove`, each stamped with `gymId` and `updatedAt` the way
`createDoc` / `updateDocById` already do. In demo (no Firebase) mode it applies straight to the mock
store; in real mode it is one `runTransaction`.

`recordPayment` and `deletePayment` (`src/services/payments.js`) now commit as ONE unit:

| Inside the transaction | Outside the transaction |
| --- | --- |
| receipt counter read + increment | authoritative prefix read (`gyms/{id}`, cached) |
| `payments` create (receipt number minted from that same read) | ledger queries (member, plans, payments, memberships) |
| every changed `memberships` snapshot patch | legacy counter-floor seed (cached probe) |
|  | audit entry (after commit, never able to roll back a payment) |

Before this, the payment was written first and the snapshots recomputed afterwards: a failure in
between left recorded cash with a stale "due" / "paid in full" state that only the nightly sweep
could repair — and that sweep is a Cloud Function that is not deployed yet.

### 12.2 The proof (`tests.emulator/moneyPathAtomicityEmulator.test.js`)

The failure is injected through the RULES, not a mock: a second emulator project runs the real
`firestore.rules` with the `memberships` `update` permission removed (the anchor match throws if the
block is ever reshaped).

| Test | Assertion |
| --- | --- |
| guard | a direct `payments` create and a direct `counters` write still SUCCEED under that ruleset — so the denial really is the snapshot write, and the other two tests are not vacuous |
| record | `recordPayment` rejects; **payment count is 0**, `counters/receiptNo_<gym>` is **absent** (no burned receipt), period still `amountPaid: 0` |
| delete | `deletePayment` rejects; the payment document **still exists** and the period still shows it paid |

The payment and counter writes are individually legal in that ruleset, so any non-transactional
implementation would have left them behind. They are absent because a transaction cannot commit a
part of itself.

### 12.3 What atomicity here does NOT claim

The reads that decide the snapshot values (the member's payment history) happen before the
transaction, because the web SDK's transaction API accepts single document references only — it
cannot run a query. So the guarantee is: **the writes are all-or-nothing.** A concurrent payment for
the same member, landing between our read and our commit, can still make the snapshots we write
momentarily stale; the next recompute (any payment, the period-edit paths, the sweep) corrects it,
and every screen computes dues from the ledger rather than from these snapshots.

That last gap is now closed by a per-member ledger revision — see §15. (This section is kept as
written to record what the atomicity change did and did not claim on its own.)

## 13. The rest of the money path, on the same primitive

`deleteMembershipPeriod` and `renewMembership` now go through `commitAtomically` too, so every path
that changes what a member owes is one transaction:

| Path | Inside the transaction |
| --- | --- |
| `deleteMembershipPeriod` | unlink each of the period's payments, delete the period, rewrite the remaining periods' snapshots (computed from the unlinked ledger, so FIFO reallocation is part of the same commit) |
| `renewMembership` | receipt counter read + increment, the new period, its payment (cross-referenced ids reserved up front), the member's plan patch, and the OTHER periods' snapshots |

`renewMembership` keeps its fallback (a receipt number is a convenience, the ledger entry is the
record), but both attempts now stage the SAME write list through one `staged(tx, receiptNo)` helper
instead of two hand-written `tx.set` blocks. The now-unused `mintReceiptNoInTransaction` and
`receiptCounterRef` were removed; the counter arithmetic lives in `nextReceiptSequence`, used by the
transactions and by `nextReceiptNo` alike. The shared ledger reads moved to
`src/services/memberLedger.js` (`readLedgerInputs`, `snapshotPatches`, `asWritten`), so the three
services cannot drift apart.

Proof, in the same rules-injected emulator project (`moneyPathAtomicityEmulator.test.js`, 5 tests):

| Test | Assertion |
| --- | --- |
| guard | a direct payment create and counter write still succeed under the restrictive ruleset |
| record / delete `payment` | no payment, no burned receipt number / the payment survives |
| `deleteMembershipPeriod` | the period, its payment attribution and the other period's snapshot are all unchanged |
| `renewMembership` | no new period, no new payment, no minted number, no reprojection requested |

---

## 14. Why the frozen baseline files still fail (26 Firestore + 32 Storage)

They are a snapshot of the rules as they were BEFORE the tenancy and field hardening, and they were
written to fail where the rules were weak. Read individually, the 26 Firestore failures are:

| Count | Group | What the emulator actually says |
| --- | --- | --- |
| 14 | `E8`, `F9`, `J1` (11 collections), `J5` | "Expected request to fail, but it succeeded" — these assert that an UNSCOPED or other-tenant-filtered **query** is rejected. Measured on this emulator (see §16.2): an unscoped `list` is ALLOWED and returns **both gyms' documents**, because the emulator evaluates the list rule once against a synthetic document shaped by the query's filters (no filter ⇒ no `gymId` ⇒ the intentional `legacy()` disjunct admits the list) and does not filter the result set per document. A `gymId == own` query is allowed and returns only the caller's rows; a `gymId == other` query is DENIED. The app always scopes (`listAll` adds the `gymId` equality), so the enforceable contract is scoped-query containment, which §16 asserts and `J2` already showed. |
| 3 | `SEC-M` payments.create | "Expected ALLOW, denied" — the fixture has no `receiptNo`, and payment creation now requires one under the gym's authoritative prefix (§ P1). |
| 5 | `SEC-F` F1–F4, F12 bookings.create | "Expected ALLOW, denied" — the fixture references `sec-member-a` / `sec-class-a`, which are never seeded; bookings create now requires the referenced member and class to exist in the caller's gym. The app only books existing members/classes. |
| 3 | `SEC-I` member.status | "Expected ALLOW, denied" — `status` is a server-owned projection field; no client role may write it, by design. |
| 1 | `SEC-C` C6/C7 | The pre-migration `settings/app` singleton carries ONE `gymId`; the test expects per-tenant isolation inside a shared document, which the design replaces with per-gym settings documents. |

None of the 26 is an open hole. The honest summary is: 14 assertions test the wrong property (query
denial instead of result containment) and 12 fixture/design assumptions that later hardening
invalidated.

The Storage baseline (`storageBaselineEmulator.test.js`, measured: 32 failed / 173 passed) is the
clean case: **all 32 are "expected ALLOW, now denied"** — it is a CHARACTERIZATION of the old
permissive ruleset (public logo reads, any authenticated user overwriting any member photo,
cross-gym access, writes for nonexistent members), and the file itself says it is expected to go red
once `storage.rules` is hardened. Every one of those 32 pins a permission that was deliberately
revoked, so red here is the hardening working, not a regression.

### Frozen baselines are not part of the gate

Both baselines are now excluded from the gating suites and run in their own
non-gating CI job (`baseline`, `continue-on-error: true`) via
`npm run test:rules:frozen` / `npm run test:storage:frozen`; the exclusion is
`FROZEN_BASELINES=1` in `vitest.emulator.js` / `vitest.storage.js`.
Measured after the split: gate Firestore **271 passed / 0 failed**, gate Storage
**155 passed / 0 failed** (2 files), frozen Firestore **26 failed / 652 passed**,
frozen Storage **32 failed / 173 passed** — i.e. the pipeline verdict is green
while the historical record is still reproduced on demand, unchanged.

The Storage emulator also logged `storage.rules line [38] Null value error` for anonymous
requests: `callerGym()`/`callerRole()` read `request.auth.uid` before any sign-in check, so an
unauthenticated caller was denied by an evaluation error rather than by `false` — safe, but
contradicting the "every accessor is NULL-SAFE" comment above them. Both accessors now short-circuit
on `isSignedIn()` first. Verified after the change: `npm run test:storage` = **155 passed / 0 failed**
and the log contains **zero** `Null value` errors (it had five).

Options for the owner: leave them as a frozen record (they are documented as such), or convert them
into a passing "current contract" suite — containment assertions for the 14, seeded references and a
`receiptNo` for the 11, and per-gym settings for the last one. That is a deliberate decision, not a
bug to patch quietly. All these suites share one emulator database and
two of them seed the pre-migration `settings/app` singleton; adding a seventh file made the
`settings/app` tests fail intermittently (a different one on each run, and both pass alone). The
suites already isolate themselves with unique ids — serial file execution removes the shared-document
race rather than hiding it behind retries. Cost: the Firestore emulator suite takes ~40s instead of ~20s.

---

## 15. Ledger isolation: the figures a money transaction writes can no longer be stale

§12.3 named the remaining gap precisely: the writes are atomic, the *numbers* are computed from a
query taken before the transaction opens, so a concurrent money write could be overwritten by a
later commit that never saw it. Two terminals taking two payments for the same member at the same
time could leave a period showing one payment while the ledger held two — atomic, and wrong.

### 15.1 The guard

`src/services/memberLedger.js` is now the only place that knows how a money movement is staged:

| Piece | What it does |
| --- | --- |
| `readLedgerSnapshot(memberId)` | the ledger inputs PLUS `revision`, read from the member document's `ledgerRevision` (already part of the read — no extra query, no new collection, no new permission) |
| `assertLedgerFresh(tx, memberId, revision)` | the transaction's FIRST read: throws `LedgerConflictError` if anyone changed the member since the read |
| `bumpLedgerRevision(tx, memberId, revision)` | staged in the SAME commit as the snapshots, so a later reader sees that the ledger moved |
| `withLedgerRevision(memberId, attempt)` | retries the whole attempt (re-read + recompute) up to three times on a conflict; every other error propagates unchanged |

All four money paths use it: `recordPayment`, `deletePayment`, `deleteMembershipPeriod`,
`renewMembership`. `deleteMembershipPeriod` re-reads the period's payments inside the attempt too,
because a retry must not reuse the attribution it read before the conflict. `renewMembership`'s
"counter unavailable, retry without it" carve-out treats a `LedgerConflictError` as NOT a counter
failure — committing the fallback there would have written exactly the stale figures the guard
rejects.

The revision lives on the member document rather than in `counters` on purpose: the roles that may
record money (owner/admin) are exactly the roles allowed to update a member, and a counter outage
must not turn into "cannot take a payment" — the receipt fallback stays intact.

### 15.2 The proof (`tests.emulator/ledgerIsolationEmulator.test.js`, real `firestore.rules`)

| Test | Assertion |
| --- | --- |
| stale read is refused | a terminal reads revision 0, another records a payment (revision → 1), the first then tries to commit the figures it computed (period entirely unpaid) — the commit is rejected with `ledger moved from revision 0 to 1`, and the payment's snapshot is still the stored one |
| simultaneous payments converge | two `recordPayment` calls in one `Promise.all` both land, mint `HWG-000001`/`HWG-000002` from the same counter, and the stored snapshot equals `computeMemberLedger()` over the payments actually on record (₹1000 of ₹2000, `partial`), with `ledgerRevision: 2` |

Measured: gate Firestore suite **273 passed / 0 failed** (8 files), unit **1181 passed / 0 failed**
(76 files), lint 0 errors, build ✅.

### 15.3 Review pass (same day): what the fresh-eyes read changed

- **Retry loop simplified.** `withLedgerRevision` no longer keeps a `conflict`
  variable and no longer has a `throw null` path when `retries` is 0/absent; it
  throws the error it caught on the last attempt, and a missing member id is
  handled inside it, which removed the duplicated
  `memberId ? withLedgerRevision(...) : attempt(null)` branch from both payment
  services.
- **Member-document-missing edge: provably unreachable, so not guarded.**
  `firestore.rules` denies reading a member document that does not exist —
  `sameGym()` requires a non-null resource and `legacy()` requires a non-null
  document — so `readLedgerSnapshot` fails before any transaction opens when a
  member was deleted. The bump is therefore unconditional; adding a
  "member missing?" branch would have been dead code. (Behaviour is unchanged
  from before the guard: the ledger read already fetched the member.)
- **One write instead of two.** `renewMembership` wrote the member twice (plan
  patch, then revision); `bumpLedgerRevision(tx, memberId, revision, patch)`
  merges both into a single member update.
- **Smaller fixes.** A single `revisionOf()` normaliser is shared by the read and
  the transaction check; `recordPayment` audits the `membershipId` it actually
  attempted rather than re-deriving it from the returned period.
- **New unit contract** (`src/tests/memberLedgerRevision.test.js`, 8 tests): the
  revision comes from the member read itself, an unusable value reads as 0, a
  conflict costs exactly one re-read, three conflicts give up, non-conflict
  errors are never retried, and the bump merges into the caller's patch.
  Measured after the review: unit **1189 passed / 0 failed** (77 files),
  Firestore emulator **273 passed / 0 failed**, lint 0 errors.

### 15.4 Period edits and the snapshot repair are in the protocol too

`refreshMembershipSnapshots`, `editMembershipPeriod` and `applyPTInclusivePriceToPeriod` no longer
write snapshots outside a transaction:

| Flow | Now inside the guarded transaction |
| --- | --- |
| `editMembershipPeriod` | the plan/price/date patch, the edited period's OWN recomputed dues, every sibling period's snapshots, revision bump |
| `applyPTInclusivePriceToPeriod` | same, with the PT-inclusive price patch; the plan lookup comes from the ledger read that already happened |
| `refreshMembershipSnapshots` | the repair patches + bump, and only when there is something to write (a no-op refresh does not bump the revision and therefore cannot make busy terminals retry) |

Both edit flows use one helper (`writePeriodAndSnapshots`) and write each document exactly once: the
edited period's patch and its recomputed figures are merged into a single `update`.

Both also validate **ownership** against the member's own periods before writing anything
(`Membership period not found` / `Period does not belong to this member`).
`applyPTInclusivePriceToPeriod` already did; `editMembershipPeriod` did not, so a stale form could
re-price another member's period in the same gym and then recompute the caller's dues from that edit.
Covered by a unit test (`membershipPeriods.test.js`) and an emulator test that edits another member's
period and asserts it is refused with the period, and the revision, untouched. Measured after
the change: unit **1190 passed / 0 failed** (77 files), Firestore emulator **277 passed / 0 failed**,
lint 0 errors.

New emulator coverage in `ledgerIsolationEmulator.test.js` (now 6 tests): a price edit commits with
the dues it implies and bumps the revision; a payment taken during a price edit is NOT overwritten
(₹1000 paid, ₹1500 due on a ₹2500 period, equal to the ledger); and a drifted snapshot is repaired on
the guard while a no-op refresh writes nothing and leaves the revision alone.

### 15.5 What is still outside the protocol

- The guard serialises per member, not per gym: two payments for different members still commit
  independently, which is correct — their snapshots do not overlap.
- A client that deliberately bumps `ledgerRevision` can make other terminals retry, but cannot forge
  figures: every value written is recomputed from the ledger after the re-read.
- Server-side (Admin SDK) writers — the projection function and the nightly sweep — bypass rules and
therefore this guard by design; they recompute from the ledger, so they can only make a snapshot
*more* correct, never overwrite cash.


---

## 16. The frozen baselines, restated as a gating "current contract" suite

The frozen files are historical records and stay untouched (they still run in the non-gating `baseline`
CI job). What was missing is a **green** test for the same security intent, so the intent is not only
documented by red assertions. Two new artifacts close that: one suite for Firestore, and a verified
mapping for Storage where the green coverage already existed.

### 16.1 `tests.emulator/firestoreCurrentContractEmulator.test.js` — 13 gating tests

The frozen baseline's 26 scenarios, expressed against today's rules — **after a duplicate review**
that cut 14 of the first draft's 27 tests, because those intents already have green, gating assertions
in `firestoreSecurityRemediation.test.js` and `firestoreReceiptIntegrityEmulator.test.js` and a second
copy would only make two tests fail together. The file's header carries the full 26-row mapping. Ids
are `cc-` prefixed and the suite has its own gyms, because the emulator database is shared.

| Frozen failures | Current-contract assertion |
| --- | --- |
| `J1`×11, `J5`, `E8` (13 tests, **here**) | for all 11 collections: a `where('gymId','==',own)` query is ALLOWED, contains the caller's row, contains no other tenant's row, and every returned row carries the caller's `gymId`; the same query pointed at the other tenant is DENIED. `auditLog`: finance-only (trainer denied on list and direct read) and no other tenant's row. |
| `F12` (1 test, **here**) | front-desk cancels a booking inside their own gym. |
| 3 `payments.create` (SEC-M) | `firestoreReceiptIntegrityEmulator.test.js` — owner/admin allow, foreign invented/missing prefix rejected, non-finance rejected, receipt immutable. |
| `F1–F4` + forged/foreign/missing booking references | `firestoreSecurityRemediation.test.js` booking block. |
| 3 `member.status` (SEC-I) | `firestoreSecurityRemediation.test.js` "CURRENT POLICY" block + "members.write roles keep every other field writable". |
| 1 `settings/app` singleton (SEC-C C6/C7) | `firestoreSecurityRemediation.test.js` per-gym settings block. |

### 16.2 What the conversion found (emulator fidelity, measured)

The frozen `J1` expectation ("an unscoped collection read is denied") is not what the emulator does,
and it is not what production rules express either. A probe against the real `firestore.rules`:

| Operation | Result |
| --- | --- |
| owner A, unscoped `members` query | ALLOWED — returns **gym A AND gym B** documents |
| owner A, `where('gymId','==',gymB)` | DENIED |
| owner A, `where('gymId','==',gymA)` | ALLOWED — only gym A documents |
| anonymous, unscoped | DENIED |
| owner A, direct read of gym B's document | DENIED |

The emulator evaluates a `list` rule once, against a synthetic document shaped by the query's equality
filters. With no filter that document carries no `gymId`, so the intentional `legacy()` disjunct (which
keeps pre-tenancy documents readable) admits the list — and the emulator then returns the whole
matching set without per-document filtering. Production evaluates the rule per document, where a
foreign document fails both `sameGym` and `legacy`. This is an emulator fidelity limit, not a rules
decision, and it is exactly why §14's earlier "production behaviour is correct" claim has been
corrected above instead of being asserted as a test. The enforceable, app-shaped contract is asserted
in §16.1: every app read is filtered by `gymId` (`listAll` adds it), scoped reads are contained, and
cross-tenant queries are denied.

### 16.3 Storage — covered already, so no duplicate file

All 32 frozen Storage failures are "expected ALLOW, now denied". Their green counterparts already exist
in `storageSecurityEmulator.test.js`, so adding a copy would only duplicate assertions:

| Frozen group | Now-green assertion |
| --- | --- |
| `CHAR-1.1–1.5` any authenticated user reads/writes/deletes any member photo, trainer included | `S1.*` (anonymous), `S3.*` (cross-gym), `S4.1`, `S4.6` (trainer write, no client delete) |
| `CHAR-2.1–2.5` public logo read, any authenticated write/delete | `S1.5–1.8`, `S3.11–3.14`, `S4.3–4.5` |
| `CHAR-3.1–3.10` cross-gym access | `S3.*`, `S6.1–6.3` |
| `CHAR-4.1–4.5` no profile / no `gymId` / blank `gymId` | `S5.1–5.9` |
| `CHAR-5.1–5.5` 6 MB uploads, HTML, PDF | `S9.1–9.5` |
| `CHAR-6.5–6.6` gym-scoped path "does not resolve" | `S7.5`, `S7.6` |

### 16.4 Measured after the conversion

| Check | Result |
| --- | --- |
| Unit + component | **1190 passed / 0 failed** (77 files) |
| Firestore emulator gate | **290 passed / 0 failed** (9 files; current-contract 13/13) |
| Storage emulator gate | **155 passed / 0 failed** (2 files) |
| Projection writer (functions) | **180 passed / 0 failed** (5 files) |
| Lint | 0 errors (6 pre-existing warnings) |
| Build | ✅ |

Frozen files: unchanged, still **26 failed / 652 passed** (Firestore) and **32 failed / 173 passed**
(Storage) on demand, still non-gating in CI.


### 16.5 Decision: the baselines stay on disk, out of the gate

Keeping them as a non-gating archive is implemented, not just agreed:

- `docs/baselines.md` states what each file is, the exact expected red numbers, the on-demand commands,
  where the green counterpart of each group lives, and the rule "delete the pair or leave them alone;
  never half-edit a baseline".
- CI keeps them in `Frozen baselines (informational, non-gating)` (`continue-on-error: true`), so the
  pipeline verdict is decided by the gating jobs only.
- The frozen files themselves are byte-for-byte untouched.

Full gate after the duplicate review: unit **1190 passed**, Firestore **290 passed**, Storage
**155 passed**, functions **180 passed**, lint 0 errors (6 pre-existing warnings), build ✅.

---

## 17. Production-readiness batch 2 — recovery, offline money, crash visibility

Three items from the ranked backlog are implemented and verified; the rest are listed below with the
reason they are not done yet, rather than being quietly dropped.

### 17.1 Restore drill for backups (item: recovery)

`functions/projection/backup.js` holds `exportAllCollections`, `restoreAllCollections` (with `dryRun`)
and `compareBackup`. The nightly `dailyBackup` job now calls the SAME `exportAllCollections`, so a drill
that passes is evidence about the real payload, not about a parallel implementation.

`functions/test/backupRestore.test.js` (8 tests, emulator) proves: export preserves ids, nested fields and
timestamps; a deleted document comes back at its original id with identical values; a dry run reports the
same counts and writes nothing; a row without an id is refused instead of being invented; comparison
reports missing and changed documents and is insensitive to field order.

`restoreAllCollections` uses `set` and therefore REPLACES documents — point it at an empty or dedicated
project, never at live data.

### 17.2 Offline money writes are refused, not queued (item: money-path safety)

`src/services/connectivity.js` adds `isOffline()` / `assertOnline(action)` / `OfflineError`. Every money
path calls `assertOnline` before it mints a receipt number or stages a transaction:
`recordPayment`, `deletePayment`, `deleteMembershipPeriod`, `editMembershipPeriod`,
`applyPTInclusivePriceToPeriod`, `renewMembership`.

Why: the Firestore SDK queues offline writes. A queued payment either lands hours later against a ledger
that moved on, or never lands after the tab closes — neither is recoverable by the desk. The guard is
scoped to a configured backend only; demo/offline mode is a local store and must keep working without a
network.

### 17.3 One seam for crashes (item: observability)

`src/services/telemetry.js` (`setErrorReporter` / `reportError`) never throws and never awaits. The
ErrorBoundary now calls it instead of `console.error`, so installing a provider turns a user-reported
crash into a ticket. Without a provider, behaviour is unchanged (it logs).

### 17.4 Verified after this batch

| Check | Result |
| --- | --- |
| Unit + component | **1200 passed / 0 failed** (79 files; +10) |
| Firestore emulator gate | **290 passed / 0 failed** (9 files) |
| Projection writer (functions) | **188 passed / 0 failed** (6 files; +8) |
| Lint | 0 errors (6 pre-existing warnings) |
| Build | ✅ (`vendor-firebase` 614 kB chunk warning is pre-existing) |

Storage gate was not re-run in this batch: no storage rule, storage test or media path changed.

### 17.5 Still open, and why

| Item | Blocker | Estimate |
| --- | --- | --- |
| Dues drift reconciliation job | Needs a decision on which stored period fields are cache (safe to rewrite) vs snapshot; the detector must not "fix" a legitimate manual adjustment | 1 day incl. tests |
| Error tracking provider (Sentry-type) | Requires an account + DSN; the seam is ready | 1 hour once the DSN exists |
| Reminder delivery (email/SMS) | Provider account + API key; today `reminders.js` accepts an injected `deliver` and logs a placeholder | 2–4 hours |
| Playwright end-to-end suite | Needs a browser download + emulator wiring in CI | 1–2 days |
| App Check | Needs reCAPTCHA/App Attest keys per platform | 2 hours + keys |
| Legacy storage migration / `settings/app` retirement / PII deletion | Need a read of production data to write a safe backfill; cannot be designed blind | 1–2 days each |
| Dependency `high` advisories (`@grpc/grpc-js` via `@firebase/firestore`) | Only fixed by a firebase major bump; must be done with a full gate run, not blind | half a day |
| Multi-gym switching | Product decision (data model + permissions), not an implementation gap | — |

---

## 18. Batch 2 review — simplification, edge cases, and the offline refusal in the UI

### 18.1 What the review changed

- **Telemetry logged twice.** With a provider installed it shipped the error AND wrote `console.error`,
  so every crash appeared twice. Now: provider → provider only; no provider → console; provider *throws* →
  console as the fallback (so a broken reporter never loses the error entirely). The test-only
  `__resetErrorReporter` export is gone — `setErrorReporter(null)` is the one way to clear it.
- **Two sources of truth for "online".** `OnlineIndicator` tracked `navigator.onLine` itself and therefore
  disagreed with the money guard in demo mode (no backend, nothing to be offline from). It now reads a
  single `useOnline()` hook built on `isOffline()`.
- **`instanceof OfflineError` is unsafe in the UI.** A page chunk can hold its own copy of the module, so
  `isOfflineError(error)` matches on class, `name` or the stable `code`.
- **`refreshMembershipSnapshots` was unguarded** even though it rewrites paid/due/status — it now refuses
  offline like the flows that call it.
- `compareBackup` dropped an unreachable `Date` special case (Firestore returns Timestamps; `toJSON`
  already normalises them).

### 18.2 Guard edge cases, stated rather than assumed

| Case | Behaviour | Why |
| --- | --- | --- |
| Demo/offline mode, no backend | never "offline" | local store is meant to work with no network |
| `navigator.onLine` missing (old webviews) | treated as ONLINE | "unknown" must not disable every money action |
| `navigator` absent (SSR/tests) | treated as ONLINE | same reason |
| `onLine === true` behind a captive portal | guard passes; the transaction is the safety net | a link existing is not proof of reachability — this closes the queued-write hole, not every network failure |
| Write fails mid-flight | unchanged behaviour: transaction rejects | the guard only prevents *queueing* |
| Non-offline errors | `isOfflineError` returns false | an ordinary validation error must not be reported as connectivity |

### 18.3 What the operator sees

- Header badge: **Offline — payments, renewals and edits are disabled**.
- A page-level notice (Layout, so it appears on every screen) explaining the actions are disabled and that
  **nothing is queued**.
- Disabled controls: Payments `Record payment` + row delete, MemberDetail `Renew` / `Record payment` /
  edit-period / delete-period, and the submit buttons inside `PaymentForm` and `RenewalModal` (each modal
  also repeats the notice).
- If a write is attempted anyway, the service error message is already operator-readable: “Recording a
  payment needs an internet connection. Nothing was saved — reconnect and try again.”

### 18.4 Verified after the review

| Check | Result |
| --- | --- |
| Unit + component | **1209 passed / 0 failed** (80 files; +9) |
| Projection writer (functions) | **188 passed / 0 failed** (6 files) |
| Firestore emulator gate | passed, 0 failed (9 files; 290 tests) |
| Lint | 0 errors (6 pre-existing warnings) |
| Build | ✅ |

Not done: no browser/visual pass on the new notice and disabled states (no browser in this environment);
the UI assertions are component-level only.

---

## 19. One offline message, no dead helper, and the states seen in a browser

### 19.1 What changed (commit `50addd1`)

- The offline refusal was rendered three times: the layout banner plus a copy inside `PaymentForm` and
  `RenewalModal`. Only the layout banner remains, so an operator reads exactly one sentence. The modal
  submit buttons stay disabled with an "Unavailable while offline" tooltip.
- `isOfflineError` had no caller outside its own test. Deleted, together with its two tests — dead API kept
  "for the UI" would have been the beginning of a second error taxonomy.

### 19.2 Verified

| Check | Result |
| --- | --- |
| Unit + component | **1207 passed / 0 failed** (80 files; -2 tests that only covered the deleted helper) |
| Lint / build | from the same edits: 0 errors, ✅ (no source change since) |

Browser pass (dev server on the reserved port, see 19.3 for the measurement method):

| Surface | Observed |
| --- | --- |
| Header badge | `Offline` (amber) |
| Layout banner | exactly **1** per page; text: “You're offline. Recording payments, renewals and membership edits are disabled until the connection returns — nothing is queued.” |
| Payments page | `Record payment` disabled; per-row delete icons disabled |
| Member detail | `Renew` and `Record payment` disabled; the renewal trigger button disabled |
| Back online | banner count **0**, badge `Online`, `Record payment` enabled again |

`Edit period` / `Delete period` were not visible in the checked member's view (they render on period rows),
so those two are covered by code review and the shared hook, not by this visual pass.

### 19.3 How the browser state was produced (so nobody repeats it)

`.env` points at a live Firebase project with no test credentials, and demo mode deliberately never reports
offline. The visual pass therefore used two **browser-only request stubs**: `firebase/config.js` served as
"not configured" (so demo sign-in works) and `connectivity.js` `isOffline()` reading a window flag set by the
test. Real components, real CSS, real state transitions; **no stubbed code in the repository**.

Also learned: this Vite version rejects the preview hostname inline (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`
is not enough), so the dev server needs `server.allowedHosts` for the current chat hostname; the temporary
config used for the check was deleted afterwards and the tree is clean.

---

## 20. Full gate re-run and the period controls confirmed in the browser

### 20.1 Full gate (all suites, this session)

| Check | Result |
| --- | --- |
| Unit + component | **1207 passed / 0 failed** (80 files) |
| Firestore emulator gate | **290 passed / 0 failed** (9 files) |
| Storage emulator gate | **155 passed / 0 failed** (2 files) |
| Projection writer (functions) | **188 passed / 0 failed** (6 files) |
| Lint | 0 errors, 6 pre-existing warnings |
| Build | ✅ (`vendor-firebase` 614 kB chunk warning is pre-existing) |

### 20.2 Correction to 19.2

19.2 said `Edit period` / `Delete period` were not visible for the checked member. They were being looked for
on the wrong tab: both controls live in the **Payments** tab, inside the “Membership history” list, and only
on recorded (non-implicit) periods. Re-checked there, with the device offline:

| Control | State | Accessible name |
| --- | --- | --- |
| `Edit period` (pencil) | **disabled** | title = “Unavailable while offline” |
| `Delete period` (trash) | **disabled** | title = “Unavailable while offline” |
| Header badge | `Offline` | — |
| Layout banner | exactly 1 on the page | — |

Both buttons are now visually confirmed, not just covered by review. The 19.3 method note still applies
(browser-only request stubs, no stubbed code in the repository).

---

## 21. Dues-drift reconciliation — report only, price changes are legitimate

### 21.1 The decision the detector encodes

**A manual price adjustment is NOT drift.** `editMembershipPeriod` and
`applyPTInclusivePriceToPeriod` change a period's `price` and write the resulting `amountPaid` /
`amountDue` / `paymentStatus` in the SAME guarded transaction. The period is then internally consistent —
just priced differently because a human decided so.

Drift is narrower: those three **derived** fields disagree with what `computeMemberLedger` derives from the
same period documents and payments. That state comes from writes that bypassed the services (scripts,
console edits, pre-snapshot legacy documents, a repair that half-failed) and it is exactly what makes a list
and a receipt show different balances.

Consequences of the decision:

- `price` is never compared, and no manual adjustment is reported.
- Nothing is repaired automatically. Rewriting a period could silently discard a human decision; the job
  makes drift visible while it is still cheap.
- A missing `amountPaid` reads as 0, so a legacy period with no payments reports only the fields that
  genuinely disagree (`amountDue`, `paymentStatus`) — not `amountPaid`.

### 21.2 What was built

| Piece | File |
| --- | --- |
| Canonical detector (`duesDriftForMember`, `findDuesDrift`, `DRIFT_FIELDS`) | `src/utils/duesDrift.js` |
| Bundled into the functions bundle (single source of truth) | `functions/projection/engine.entry.js` → `vendor/projection.mjs` |
| Job + report writer, `collectGymDuesDrift` / `runDuesDriftJob` | `functions/projection/duesDrift.js` |
| Schedule `every day 03:30` (Asia/Kathmandu) | `functions/index.js` → `duesDriftReconciliation` |
| Unit tests (14) | `src/tests/duesDrift.test.js` |
| Emulator tests (9) | `functions/test/duesDrift.test.js` |

Report document: `systemReports/duesDrift-<gymId>` — overwritten each run, `clean` flag, exact counters,
and a capped sample (25) of `{ memberId, periodId, fields, stored, expected }`. `systemReports` has no
client write rule; only the Admin SDK writes it.

Operational properties the tests pin: a clean gym writes `clean: true` (evidence the job ran), a drifted
period is named with stored vs expected, the period document is byte-identical afterwards, no `auditLog`
entry and no member write happens, a deliberate re-price is not reported, one gym's run never reads another
gym, `writeReport: false` is a true dry run, and a second run produces the same counts with exactly one
report document.

### 21.3 Gate after this change

| Check | Result |
| --- | --- |
| Unit + component | **1221 passed / 0 failed** (81 files; +14) |
| Firestore emulator gate | **290 passed / 0 failed** (9 files) |
| Projection writer (functions) | **197 passed / 0 failed** (7 files; +9) |
| Lint | 0 errors, 6 pre-existing warnings |
| Build | ✅ |

Storage suite (155) was not re-run: no storage rule, storage test or media path changed.

---

## 22. Drift job correctness fix + the owner-facing integrity card

### 22.1 The bug: the job compared a different thing than the ledger

The job read `payments` and `memberships` with `where('gymId','==',gymId)`. The ledger
(`readLedgerInputs`) reads them **by memberId only**, and plans with **no filter at all**. Consequences:

- a payment with no `gymId` (legacy, or written by a script) was invisible to the job but counted by the
  ledger → the job reported drift where there was none;
- a plan outside the gym filter could be missing from the calculation.

A false report is worse than no report: it teaches operators to ignore the next one.

Fix — the job now mirrors the ledger exactly:

| Input | Before (job) | Now (job) = ledger |
| --- | --- | --- |
| members | `gymId ==` (partition) | `gymId ==` (unchanged — a member belongs to one gym) |
| plans | `gymId ==` | **all plans, read once per run** |
| payments | `gymId ==` | **`memberId ==` per member** |
| memberships | `gymId ==` | **`memberId ==` per member** |

Cost: two reads per member instead of two per gym, run 5-at-a-time. Duplication removed: the job no longer
has its own grouping — it calls the bundled `findDuesDrift`, so the app, the job and the report share one
implementation.

New tests for exactly the broken cases:
- payment with **no `gymId`** for the member's period → report stays clean;
- payment filed under **another gymId** but the right memberId → still credited, no drift;
- period document with **no `gymId`** → still scanned (and reported when genuinely stale).

### 22.2 Option chosen: (a) surface the detector to the owner

Reasons: (b) reminder delivery is blocked on a provider account and API key I do not have; (c) the firebase
major bump is a dependency migration that deserves its own deliberate pass, not a tail-end squeeze. (a) is
self-contained, needs no key, and makes the work from §21 usable instead of sitting in admin-only storage.

- `functions/projection/duesDriftReport.js` — callable `getDuesDriftReport`. Chain: authenticated →
  profile with a bound gym (from `users/{uid}`, never the request) → role `owner`/`admin` (mirrors
  `finance.view`). Returns the caller's own gym report, or `report: null` when the job has not run.
- `src/services/integrity.js` — client wrapper; never throws; demo mode returns `offline-mode`.
- `src/components/settings/IntegrityCard.jsx` — Settings card, hidden in demo mode. Four distinct states:
  clean (counts + when), drift (count + sampled stored-vs-expected rows), **no report yet** (explicitly not
  "all clear"), and read failure. Its only action is "check again" — there is deliberately no fix button.

### 22.3 Gate after this change

| Check | Result |
| --- | --- |
| Unit + component | **1226 passed / 0 failed** (82 files; +5 card states) |
| Firestore emulator gate | 290 passed / 0 failed (unchanged by this commit — no rules change) |
| Projection writer (functions) | **208 passed / 0 failed** (8 files; +11: 3 input tests, 8 callable auth) |
| Lint | 0 errors, 6 pre-existing warnings |
| Build | ✅ (bundle rebuilt: `vendor/projection.mjs` 28.0 kB, now exports `findDuesDrift`) |

Not verified: the card has no browser pass — it needs deployed Functions plus a signed-in owner, neither of
which exists here. Its five states are covered by component tests; the visual layout is unverified.

---

## 23. Bounded drift scans, one role source, and the simplification pass

### 23.1 Single role source

`functions/projection/duesDriftReport.js` had its own `REPORT_ROLES = ['owner','admin']` — a second answer to
"who is finance" next to `PERMISSIONS['finance.view']`. Now:

- `src/utils/constants.js` exports `FINANCE_VIEW_ROLES = PERMISSIONS['finance.view']` (derived, never re-typed);
- it is bundled via `engine.entry.js` and the callable gates on it.

The same pass removed a duplicated profile read: role and gym now come from ONE `users/{uid}` fetch instead of
`resolveCallerGym` fetching it a second time.

### 23.2 A nightly run is now bounded

Two queries per member is correct (it is what the ledger does) but linear. A large gym could be killed inside
the scheduled window, leaving a report that looks current and is not.

| Piece | Behaviour |
| --- | --- |
| Page size | `DRIFT_MAX_MEMBERS_PER_RUN = 400` members per gym per run |
| Cursor | stored as `nextCursor` in the report; next run resumes after it |
| Cycle totals | counts + sample accumulate across runs of one cycle (sample deduped by member/period, capped 25) |
| `complete: false` | a PARTIAL check — `clean` is deliberately NOT written |
| `complete: true` | whole gym covered; only then is `clean` written |
| Card | new partial state: "Partial check — large gym … not an all-clear" |

Paging asks for `limit + 1` documents so a full page cannot be mistaken for the last one; ordering is explicit
(`gymId ==` + document id) because Firestore rejects a cursor that does not match the query's order. That
ordering adds one composite index `members(gymId ASC, __name__ ASC)` to `firestore.indexes.json` (now 30).

### 23.3 Fresh-eyes simplifications

- `mergeSample`: dropped a `break` that only worked because the input happened to be sorted; it now dedupes and
  slices.
- `IntegrityCard` drift rows: three concatenated strings per row became `field: stored → ledger` lines — fewer
  moving parts, and the test now pins the exact rendered fact.
- `IntegrityCard` effect: removed a mounted flag and a `.catch` for a function that never throws.
- Callable: one profile read (above).

### 23.4 Gate after this change

| Check | Result |
| --- | --- |
| Unit + component | **1227 passed / 0 failed** (82 files; +1 partial-state test) |
| Projection writer (functions) | **209 passed / 0 failed** (8 files; +1 large-gym cycle test) |
| Lint | 0 errors, 6 pre-existing warnings |
| Build | ✅ (`vendor/projection.mjs` rebuilt 29.8 kB) |

Firestore rules were not touched, so the 290-test rules gate was not re-run for this commit.

Not verified: the new composite index against a real project (the emulator does not require indexes), and the
card's partial state in a browser.

---

## 24. Latest-evidence-only drift reports, and the index diff corrected

### 24.1 Stale evidence in a multi-run cycle (fixed)

A bounded cycle accumulates coverage, so it also used to accumulate EVIDENCE: counts and the sample from
night one stayed in the report even if someone repaired the period before night three closed the cycle. The
report then described drift that no longer existed.

Rule now: **a report may only contain rows from a read that just happened.**

- a PARTIAL report shows this run's page only (counts + sample) and stores `pendingMemberIds` — the members
  whose drift still needs confirming — instead of a carried-forward sample;
- the run that closes a cycle RE-READS every implicated member (`reverify`, capped at
  `DRIFT_REVERIFY_LIMIT = 200`) and writes what is true now; if the pending set exceeded the cap the report
  says so (`reverifyTruncated`);
- `clean` is still only written when a cycle completes, and now it is computed from those re-read rows.

New emulator test: night one finds drift on member A → A is repaired → night two closes the cycle →
`complete: true`, `driftedPeriods: 0`, `clean: true`, `sample: []`.

### 24.2 `firestore.indexes.json` diff corrected

The previous commit's append went through a JSON re-serialiser and reformatted the whole file
(256 insertions / 61 deletions for one index). Restored from the parent commit and re-appended by hand; the
diff against `a734690^` is now exactly **one** composite entry:

```
{ "collectionGroup": "members",
  "fields": [ { "fieldPath": "gymId" }, { "fieldPath": "__name__" } ] }
```

30 indexes total, unchanged otherwise.

### 24.3 Gate

| Check | Result |
| --- | --- |
| Unit + component | **1227 passed / 0 failed** (82 files) |
| Projection writer (functions) | **210 passed / 0 failed** (8 files; +1 repaired-between-runs test) |
| Lint | 0 errors, 6 pre-existing warnings |
| Build | ✅ |

Rules untouched → the 290-test rules gate was not re-run for this commit. Index still unverified against a
real project (the emulator does not demand indexes).

---

## 25. Coverage and evidence are separate, and labelled

### 25.1 The inconsistency

A partial report carried `membersScanned`/`periodsScanned` for the whole cycle but drift counts and the sample
for the current page only. Rendered together that read as a contradiction ("400 members scanned, 1 period
drifted" — from which page, out of what?). Two numbers answering different questions were sitting in one flat
namespace.

### 25.2 New report shape

```
{
  gymId, complete, generatedAt,
  coverage: { membersScanned, periodsScanned },        // cumulative for this cycle
  evidence: { scope: 'page' | 'cycle',                 // what the last read covered
              members, periods, sample },
  clean?,                                              // complete cycles only
  nextCursor?, pendingMemberIds?,                      // partial cycles only
  reverifyTruncated?                                   // pending set exceeded the cap
}
```

- `evidence.scope === 'page'` → this run's page;
- `evidence.scope === 'cycle'` → the closing re-read of every implicated member.

Resuming a cycle reads coverage from `coverage` (with a top-level fallback for any report written before this
split). A caught regression: the first attempt still read `previous.membersScanned`, which silently restarted
coverage at 0 on every resumed run — the large-gym test failed and that was the cause, not the test.

### 25.3 Card

- clean: "{n} membership periods across {m} members match the ledger" — coverage numbers, said as coverage.
- drift: "{n} periods disagree with the ledger … across {m} members in this run's page" when partial.
- partial banner: "{m} members scanned so far … any drift below is from this run's page only … not an
  all-clear".

Tests were rewritten against the new shape (card fixtures + 4 report assertions), and the card gained one test
that pins coverage and evidence being labelled apart on the same partial report.

### 25.4 Gate (re-run after the change)

| Check | Result |
| --- | --- |
| Unit + component | **1228 passed / 0 failed** (82 files; +1 coverage/evidence labelling test) |
| Projection writer (functions) | **210 passed / 0 failed** (8 files) |
| Lint | 0 errors, 6 pre-existing warnings |
| Build | ✅ |

Rules untouched → 290-test rules gate not re-run. Card still not viewed in a browser, and the index still not
verified against a real project.

---

## 26. Legacy fallback removed; deploy plan

`runDuesDriftJob` no longer accepts a pre-`coverage` report shape: a report without `coverage` resumes at 0
rather than being silently reinterpreted. There is no legacy data — nothing has run against a real project yet —
so the fallback was carrying a case that cannot exist.

Gate after the change: functions **210 passed / 0 failed**, lint 0 errors. Unit/build untouched (no `src/` change).

Deployment is planned, not executed: nothing was pushed, deployed, or configured. See the plan in the chat —
notably that Cloud Functions and Cloud Scheduler require the Blaze (paid) plan, while rules, indexes and
hosting do not.

Reminder delivery stays out of scope by decision: the reminder job only flags expiring memberships today, and no
provider, key or send path is being added.

---

## 27. Free static index audit (pre-deploy)

Method: every Firestore read path in `src/` and `functions/` (excluding tests and the vendored bundle) was traced
to the constraints it actually sends, and each resulting constraint set was matched against
`firestore.indexes.json`. Nothing was run against a project, no index was deleted, no file was changed.

**Result: 15 of 30 indexes are reachable today; 15 are not; 0 missing.**

Used (reachable):

| # | Index | Reached by |
| --- | --- | --- |
| 1 | members(gymId, createdAt DESC) | `subscribeCollection('members')`, `memberNumbers` |
| 2 | members(gymId, searchName ASC) | Members page (no status filter) |
| 3 | members(gymId, status, searchName) | Members page + status filter |
| 4 | members(gymId, isFrozen, searchName) | Members page + Frozen filter |
| 5–13 | memberships/plans/freezes/payments/expenses/attendance/classes/bookings/trainers (gymId, createdAt DESC) | `subscribeCollection` on those collections |
| 17 | weightRecords(gymId, createdAt DESC) | MemberDetail progress tab |
| 30 | members(gymId, __name__) | drift job paging |

Not reachable today (kept, not deleted):

| # | Index | Why it is unreachable |
| --- | --- | --- |
| 14 | auditLog(gymId, createdAt) | `auditLog` is write-only; no page queries it |
| 15 | counters(gymId, createdAt) | counters are point reads (`tx.get('counters', id)`) |
| 16 | weightRecords(memberId, date) | MemberDetail filters `weightRecords` in JS |
| 18 | members(status, searchName) | every members query is gym-scoped; wrong prefix |
| 19 | members(status, createdAt) | no page orders members by createdAt |
| 20 | payments(memberId, date) | member payments are read with single equality, no orderBy |
| 21 | payments(method, date) | Payments page filters method in JS |
| 22 | attendance(memberId, date) | attendance is read gym-scoped |
| 23 | bookings(classId, date) | Classes page filters bookings in JS |
| 24 | expenses(category, date) | Expenses page filters category in JS |
| 25 | classes(dayOfWeek, startTime) | Classes page groups by day in JS |
| 26 | auditLog(entity, timestamp) | audit trail is never queried |
| 27–29 | payments/expenses/attendance(gymId, date) | only used by `src/services/rangeQueries.js`, which is deliberately not enabled |

Missing: none. Equality-only queries (memberId, membershipId, ownerUid, users/{uid}, systemReports/*) are served by
automatic single-field indexes, and two equality filters on different fields are served by index merging.

Not covered by this audit: no query was executed against a real project, so index *build* state is unverified, and a
query constructed later would need re-checking. Unused indexes cost storage only; nothing was removed.

---

## 28. Index cleanup proposal + full gate (deploy not run)

The 15 unreachable indexes from §27 now have a written cleanup proposal:
`gym-audit/docs/index-cleanup-proposal.md`. It splits them into **Tier A (10: #15, #18–26, safe to delete now)** and
**Tier B (5: #14, #16, #27–29, keep until a named decision)**, carries a `file:line` evidence trail for every Tier A
entry, and documents what deletion does and does not do, pre-delete verification (code re-trace, file-is-authoritative
console diff), execution order and rollback. It also records that the console exposes index *status* but not per-index
usage for Standard edition, so the canary after deletion is the real verification. The proposal itself deleted nothing
(`firestore.indexes.json` still held all 30 entries at that point); Tier A was then removed in its own commit — see §29.

Full gate, run locally after the proposal was written (nothing deployed, nothing pushed):

| Gate | Command | Result |
| --- | --- | --- |
| Unit | `npx vitest run` | **1228 passed**, 82 files |
| Rules (emulator) | `npm run test:rules` | **290 passed**, 9 files |
| Storage (emulator) | `npm run test:storage` | **155 passed**, 2 files |
| Functions (emulator) | `npm run test:functions` | **210 passed**, 8 files |
| Lint | `npx eslint .` | **0 errors, 6 warnings** (all `react-refresh/only-export-components`) |
| Build | `npm run build` | ✅ 2628 modules, 9.38s (chunk-size warning only) |
| Vendor bundle | `npm --prefix functions run build` | ✅ `vendor/projection.mjs`, 29.8 kB |

All suites exited 0. The Functions-emulator suite needs the vendor bundle built first; it was built before the run, so
the bundle-freshness test passed rather than being skipped.

---

## 29. Tier A index removal + GitHub Actions deploy workflow (nothing deployed)

### 29.1 Ten indexes removed, twenty remain

`firestore.indexes.json` now declares **20** entries. Removed (original §27 numbering): **#15** and **#18–26** —
`counters(gymId,createdAt)`, `members(status,searchName)`, `members(status,createdAt)`, `payments(memberId,date)`,
`payments(method,date)`, `attendance(memberId,date)`, `bookings(classId,date)`, `expenses(category,date)`,
`classes(dayOfWeek,startTime)`, `auditLog(entity,timestamp)`. Tier B stayed declared: #14, #16, #27–29.

Nothing was removed from any Firebase project, and no project was contacted.

One test had to change, and it was a real over-approximation rather than a passing check: `compositeIndexCoverage`
listed `counters` in its "every collection read through `useCollection` orders by `createdAt`" table, although nothing
reads counters that way — they are point reads/writes by id whose documents carry no `createdAt`. That assertion is
what kept #15 alive, so `counters` was removed from that list with a comment saying why. Side effect of dropping one
`it.each` case: the unit total is **1227**, one lower than 1228, with nothing skipped.

Gate after the change: unit **1227 passed / 0 failed** (82 files), lint **0 errors / 6 warnings**. Rules, storage and
Functions suites were not re-run: no rule, storage or function code changed. Build was not re-run either (no `src/`
change outside a test).

### 29.2 Deploy workflow

`.github/workflows/deploy.yml` runs **only on `workflow_dispatch` for now**, and what a run deploys is chosen per
run with a `deploy_scope` choice input. The hosting bundle and the security surface carry different risks, so they
are separate, reviewable steps rather than one `firebase deploy`:

```
CI gate → credential check → auth → index diff (only when indexes are in scope) → npm ci → npm run build
        → firebase deploy --only hosting
        → live smoke check of that build (scripts/smoke-hosting.mjs)
        → [hosting+rules]         firebase deploy --only firestore:rules
        → [hosting+rules+indexes] index diff + firebase deploy --only firestore:indexes
```

| `deploy_scope` | What runs |
| --- | --- |
| `hosting` (default) | hosting, then the smoke check |
| `hosting+rules` | the above, then `firestore:rules` |
| `hosting+rules+indexes` | the above, then the index diff gate, then `firestore:indexes` |

- **Phase 1 (current): manual only.** The first index deploy after the cleanup deletes indexes that are live in the
  project, so it is dispatched and reviewed once before any automation is trusted with it. The `push: branches: [main]`
  trigger is present but commented out in the workflow; uncommenting it is the Phase 2 switch that turns auto-deploy on.
  Every gate below stays in force after that switch.
- **Gate 1 — green CI for the same commit.** The job queries the CI workflow's runs for `github.sha` and fails unless at
  least one completed run concluded `success` (a later cancelled duplicate cannot block an otherwise tested commit).
  Because the workflow is dispatch-only, this is checked explicitly instead of being implied by a push trigger. The
  early gates run before `npm ci`/build, so a blocked deploy fails in seconds instead of after a full build.
- **Gate 2 — deploy credential.** The job fails with a named error when `FIREBASE_SERVICE_ACCOUNT` is
  missing, before `npm ci`/build, instead of surfacing a CLI auth failure after the build.
- **Gate 3 — index diff, only when indexes are in scope.** `scripts/index-diff.mjs` (read-only; one `indexes.list` call)
  prints, to the log and the job summary, how many indexes the deploy would create and delete, with the full delete
  list. It exits non-zero when deletions are planned unless `confirm_index_deletions` was ticked on the dispatch, which
  stops the job before Firebase is touched. Single-field indexes are excluded from both sets (Firestore maintains
  them); `fieldOverrides` is reported but not diffed. Covered by `src/tests/indexDiff.test.js` (13 tests, part of the
  gating unit suite): create/delete sets, single-field exclusion, and the confirm gate's exit codes.
- **Post-hosting check — live smoke check (before the next stage).** `scripts/smoke-hosting.mjs` compares the live origin with the
  bundle that was just built, using cache-busted URLs: (a) the served `index.html` must reference the same hashed entry
  files as `dist/index.html`, (b) every entry asset must answer 200 with a JavaScript/CSS content type and the same
  sha256 as the local file, and (c) a deep link (`/login`) must serve the app shell through the SPA rewrite. It retries
  6 times, 5 s apart, for the Hosting rollout. This exists because the deploy command itself can report success while
  the CDN still serves the previous release — the check stops the run *before* the rules or indexes step, so a stale,
  truncated or not-published bundle cannot ride along with a security-surface deploy. `npm run smoke:hosting` runs the
  same check by hand; the origin comes from the optional `FIREBASE_HOSTING_URL` variable, default
  `https://<FIREBASE_PROJECT_ID>.web.app`.
- Cloud Functions are deliberately excluded: they need Blaze. Enabling them later means adding
  `npm ci --prefix functions`, `npm --prefix functions run build` and `functions` to the `--only` list.
- The workflow header repeats the warning that deploying indexes deletes any project index absent from the file.

**The one required repository secret is `FIREBASE_SERVICE_ACCOUNT`** — the JSON key of a service account with
`Firebase Hosting Admin`, `Firebase Rules Admin` and Cloud Datastore index permissions (`roles/firebase.admin` covers
all three but is broad). Optional repository variable `FIREBASE_PROJECT_ID` overrides the default project; without it
the workflow falls back to `himalye-wonders-gym`. No key, token or password is stored in the repository.

At the time this section was written nothing had been pushed or deployed. The staging above landed later, in PR #4
(§30.5–§30.7); the chain, gate list and scope table here describe the workflow as it now stands. The workflow itself
has still **never run** — the index diff was exercised against saved fixtures, and the smoke check against a locally
served `dist/` (pass, truncated-asset failure) and against the real live origin, where it correctly refuses because
that origin is the older `685a27e` release. Ten Tier A removals are expected to surface as deletions on the first real
index run.

## 30. Frozen baseline counts asserted; both deploy-phase PRs merged into `main` (nothing deployed)

Two pull requests carried Phase 5A from local commits to `main`, both merged with merge commits (no squash, no rebase)
through the GitHub integration, so no credential ever touched a shell.

### 30.1 PR #1 — deploy on dispatch, gated on green CI, indexes diffed first

- Head `freebuff/deploy-gates` @ `dba54eb` (27 commits, 112 files, +11,056 / −927); merged **2026-11-18 15:37Z** as
  merge commit **`0c3e4e5`**; branch deleted afterwards.
- `main` CI on `0c3e4e5` (`44337766260`): `Lint · build · unit tests` ✅, `Security rules · storage · functions` ✅,
  `Frozen baselines (informational, non-gating)` ❌ — the latter red **by design**, tolerated via `continue-on-error`.
- That red X was the last known wart: 10 failure annotations (Actions caps annotations at 10; the baseline has 26
  known-red assertions) across `SEC-J J1` (unscoped reads: membershipPlans, trainers, classes, attendance, counters,
  bookings, payments, members), `SEC-F F9` (bookings cross-tenant) and `SEC-E E8` (auditLog enumeration).

### 30.2 PR #2 — the archived baselines are now counted, not just tolerated

- Branch `fix/frozen-baseline-counts`, 6 commits, 6 files, +311 / −23; merged **2026-11-18 16:27Z** as merge commit
  **`c91c1c0`**; branch deleted, leaving `main` and `production-readiness/phase-4` only.
- New `scripts/assert-frozen-baseline.mjs` runs each frozen suite through its `:raw` script, reads vitest's JSON report
  and compares **the archived file's own** counts with the documented ones. Match → exit 0 (job green), drift → exit 1,
  no report → exit 2. The baseline files themselves are untouched; `continue-on-error` is gone and the job is named
  `Frozen baselines (expected counts asserted)`.
- **Counts were measured, not assumed.** The old docs said `26 failed / 652 passed` (Firestore) and
  `32 failed / 173` (Storage). Measurement (Java 21 + firebase-tools 15.36, Firestore/Storage emulators) showed those
  were **whole-run** totals, and Firestore's run total had already drifted to 671 because the live suites in the same
  run gained 19 tests. Pin that number and the job goes red for a reason nobody may act on, so the gate pins the
  archived file instead:

  | Suite | Archived file (asserted) | Whole run (printed as context) |
  | --- | --- | --- |
  | Firestore | 26 failed / 381 passed | 26 failed / 671 passed |
  | Storage | 32 failed / 18 passed | 32 failed / 173 passed |

- `docs/baselines.md` was corrected to the file-level numbers and now explains why the gate pins the file, not the run.
  `src/tests/frozenBaseline.test.js` (5 tests, part of the gating unit suite) covers per-file counting, Windows paths,
  a missing baseline file, drift in both directions, and the docs/script sync. `.frozen/` is gitignored.
- Verification: both `npm run test:rules:frozen` and `npm run test:storage:frozen` exit 0 locally with the counts above;
  `npm run lint` reports 0 errors (6 pre-existing warnings); `main` CI on `c91c1c0` (`44347406223`) is **all green**,
  including the new `Frozen baselines (expected counts asserted)` job.

### 30.3 Still not deployed

`deploy.yml` remains dispatch-only (the `push` trigger is still commented out) and no workflow run exists yet. The one
blocking input is unchanged: repository secret `FIREBASE_SERVICE_ACCOUNT`; Cloud Functions additionally need Blaze.
Live index verification (`indexes.list`) therefore still has not happened, and the first dispatch must be reviewed with
`confirm_index_deletions` left false to see the planned deletions before allowing them.

### 30.4 `main` is the default branch and is protected by the three CI jobs

- Repository default branch changed from `production-readiness/phase-4` to **`main`** (2026-11-18). New PRs now open
  against `main` by default, and `push: branches: [main]` in `ci.yml`/`deploy.yml` matches the default branch.
- Branch protection on `main`, **admin enforcement on**, force pushes blocked, deletions blocked, 0 required approvals
  (solo maintainer cannot self-approve):
  - `Lint · build · unit tests`
  - `Security rules · storage · functions (emulator)`
  - `Frozen baselines (expected counts asserted)`
  All three are bound to the GitHub Actions app (`app_id 15368`) and `strict` is off, so a branch does not have to be
  rebased onto the latest `main` before merging — it only has to pass its own run.
- Nothing was deployed; this is repository configuration only. The prior `production-readiness/phase-4` branch is left
  untouched and unprotected.

### 30.5 Protection proved with a throwaway PR, and the deploy staged

**Probe PR #3 (`ci/probe-merge-block`, commit `be91204`) — merged? No, and that is the point.**

- Added one file, `src/tests/__mergeBlockProbe.test.js`, with a deliberately failing assertion.
- CI: `Lint · build · unit tests` → **failure** (run `44365894097`); `Security rules · storage · functions`
  → skipped (`needs: app`); `Frozen baselines` ran independently.
- `GITHUB_MERGE_A_PULL_REQUEST` on `be91204` was **rejected**: *"Cannot merge PR #3 … 2 of 3 required status checks
  have not succeeded: 1 failing."* `mergeable_state` was `blocked`. So the protection is enforced, not cosmetic —
  and it is enforced against the owner too (`enforce_admins`).
- Then closed unmerged (`merged: false`) and `ci/probe-merge-block` deleted. `main` stayed at `c91c1c0`.
  (GitHub's `merge_commit_sha` on the closed PR is its discarded test-merge commit, not a commit on `main`.)
- `delete_branch_on_merge: true` is now on for the repository, so future merged PRs clean their head branch up
  automatically.

**What the live release actually is** (measured, because "deployed" was being assumed):

- `https://himalye-wonders-gym.web.app` serves `/assets/index-b-wpXrvP.js`, `last-modified: Fri, 09 Oct 2026
  08:27:38 GMT`. A local build of `685a27e` (Oct 9, `production-readiness/phase-4`) reproduces the live
  **stylesheet hash exactly** (`index-BrspUv4k.css`) and the same `vendor-firebase-DdaLSSDd.js`, while `main`'s
  build produces a different CSS hash — so the live bundle is at/around `685a27e`, six weeks behind `main`.
  The GitHub deploy workflow has still **never run** (every one of the repository's workflow runs is `ci.yml`).
- The live client already scopes its reads: `src/services/firestore.js` at `685a27e` builds every list query as
  `where('gymId','==',getGymId())`, and single documents go through `getDoc(doc(db, name, id))`.
- `firestore.rules` changed since `685a27e` by **one block**, `match /gyms/{gymId}`: `allow read` split into
  `allow get` (unchanged predicate) and `allow list: if isSignedIn() && resource.data.ownerUid == request.auth.uid`.
  The only client list on `gyms` is `discoverOwnGym()`'s `where('ownerUid','==',uid)`, which satisfies that rule.
  So on this diff alone, no screen loses access.
- Removed indexes were checked against the code that still runs: every collection the client lists
  (`attendance, members, membershipPlans, memberships, payments, weightRecords`) keeps a `gymId ASC + createdAt DESC`
  index in the 20 that remain; `counters` is read as a single document, never listed; the deleted
  `status`/`memberId`/`classId`/`dayOfWeek`/`entity` combinations have no query left in `src/`.
- **Unverifiable without credentials:** which rules and indexes are actually live today. The comparison above is
  repository-side; the first dispatch's index diff is what settles the project side.

**Deploy staged accordingly (PR #4, `ci/deploy-scope`):** `deploy.yml` gains a `deploy_scope` choice input —
`hosting` (default), `hosting+rules`, `hosting+rules+indexes` — and the index-diff gate now runs only when indexes
are in scope. Hosting ships first so the new bundle can be verified against the live project before the security
surface moves, and index deletion stays the last, explicitly confirmed step.

### 30.6 PR #4 merged; the auto-delete setting proved itself

Merged `ci/deploy-scope` (commit `ac76bfa`, all three required checks green on both duplicate runs) as merge commit
**`5a5b8eb`**. `delete_branch_on_merge` then did its job with no extra call: `GET /branches` now lists only `main`
(`5a5b8eb`) and `production-readiness/phase-4` (`685a27e`). Branch protection is reported by GitHub as
`enforcement_level: "everyone"` with the same three checks. No deployment was triggered by the merge — `deploy.yml`
is still `workflow_dispatch` only, and no `FIREBASE_SERVICE_ACCOUNT` secret exists yet.

### 30.7 PR #5 — deploy docs aligned with the staged flow, and a live hosting smoke check

The docs still described the pre-staging one-shot `firebase deploy`, and nothing checked the live origin after
`firebase deploy --only hosting`. PR #5 (`ci/deploy-docs-smoke`, head `5b6640f`, 4 files, +374 / −37) fixed both.
Merged **2026-11-18 18:38Z** as merge commit **`95946e7`**; `delete_branch_on_merge` removed the head branch.
All three required checks were green on both duplicate CI runs (`Lint · build · unit tests` `44370992836` and
`44371092613`, `Security rules · storage · functions`, `Frozen baselines`), and the merge started no deployment —
`deploy.yml` is still `workflow_dispatch` only.

| File | Change |
| --- | --- |
| `scripts/smoke-hosting.mjs` (new, 281 lines) | read-only post-deploy check of the live origin against `dist/` |
| `.github/workflows/deploy.yml` | runs it immediately after `Deploy hosting`, before the rules and indexes steps; optional `FIREBASE_HOSTING_URL` variable |
| `package.json` | `smoke:hosting` script |
| `README.md` | Deploying / production checklist rewritten for `deploy_scope`; the local CLI path is now break-glass, in the same order |

**What the smoke check asserts**, on cache-busted URLs (`?smoke=<nonce>`), retrying 6 times 5 s apart for the
Hosting rollout:

1. `<base>/` answers 200 `text/html`.
2. The served `index.html` references the same hashed `/assets/...` entry files as `dist/index.html` — this is
   what catches "the deploy reported success but the CDN still serves the previous release".
3. Every entry asset answers 200 with a JavaScript/CSS content type and the same sha256 as the local file.
4. A deep link (`/login`) serves the app shell through the SPA rewrite.

On failure it exits 1 with the file name, both byte counts and both sha256 prefixes, and the job stops **before**
the rules or indexes step. A stale shell short-circuits after (2), so a stale release is reported as one reason
instead of also blaming the rewrite (an earlier draft produced exactly that false noise against the real site).

**Verified locally, without deploying:**

| Case | Result |
| --- | --- |
| ESLint on the new script | 0 errors |
| Prettier on the four changed files | clean |
| `dist/` served on loopback with the SPA rewrite, check pointed at it | exit 0 |
| same build, entry JS truncated by 500 bytes | exit 1 — `does not match the build: served 50573 bytes (sha256 da5912d4…), build has 51073 bytes (sha256 00bb7f3e…)` |
| the real live origin (still the `685a27e` release) | exit 1 — live shell references `index-b-wpXrvP.js` / `vendor-react-B1_gtdtE.js` / `index-BrspUv4k.css`, not this build's entry files |

**Not verified:** the check has never run inside the deploy job, because the workflow has never run and there is
no `FIREBASE_SERVICE_ACCOUNT` secret. The first `deploy_scope=hosting` dispatch is its first real execution. If
the project answers on a different hostname than `<project-id>.web.app`, set `FIREBASE_HOSTING_URL` before that run.

### 30.8 PR #6 — the smoke check's parsers are unit-tested

`scripts/smoke-hosting.mjs` ran only inside the deploy job, which has never run, so a broken asset parser or
argument handler would have surfaced for the first time during a real release. PR #6
(`ci/smoke-hosting-tests`, squashed as **`6773698`**, 3 files, +155 / −3) adds
`scripts/smoke-hosting.test.mjs` (16 tests) and includes `scripts/**/*.test.mjs` in `vitest.config.js`, so the
gating `Lint · build · unit tests` job runs them on every push and PR — no new job, no new step.

- `assetsIn` is covered for document order, non-asset/external/inline references, de-duplication and
  query-string/fragment stripping; `parseArgs` for defaults, call isolation, trailing-slash and route
  normalisation, `=` inside a value, numeric settings, `--help`, unknown options and invalid
  `--attempts` / `--delay-ms`.
- One test found a real bug rather than describing the code: `ASSET_RE` required the closing quote immediately
  after the file name, so a shell referencing `/assets/app.js?v=1` was invisible to the check. The regex now
  tolerates a `?query` or `#fragment`, and the test was not weakened to fit the bug.
- `parseArgs` is exported for the tests. The existing CLI guard
  (`import.meta.url === pathToFileURL(process.argv[1]).href`) already kept `main()` from running under Vitest.
- Verified: `npm test` **85 files / 1261 tests passed**; `npm run lint` 0 errors (6 pre-existing warnings);
  Prettier clean on the three touched files; `--help` exits 0 and an unknown option exits 2. CI green on both
  duplicate suites (push `44516145467`, PR `44516177160`), and `main` CI on `6773698` (`44516955737`) green.
- Still not verified: the network half of the check (a live origin) is not unit-tested; it runs for the first
  time in the first `deploy_scope=hosting` dispatch.

### 30.9 PR #7 — the smoke check's verdicts are now unit-tested too

PR #6 covered `assetsIn` and `parseArgs`; the part the deploy job actually stops on — `checkOnce`'s
`problems` array — had still never executed outside a release. PR #7
(`ci/smoke-hosting-network-tests`, head `938127d1`, commits `4f13658` + `938127d1`, 2 files, +180 / −4)
squashed as **`de4df35`** closes that gap without credentials or a deploy.

- Six new tests serve a throwaway `dist/` from an ephemeral `node:http` origin on `127.0.0.1`: a healthy
  origin passes with the shell, both assets and the deep link reported ok; a **stale release** produces exactly
  one problem (`the live index.html is NOT this build`) and no misleading rewrite problem; a **truncated asset**
  reports both byte counts; a **wrong content type** is reported while the bytes still match; a **missing SPA
  rewrite** is reported from a real `404` deep link; and a **missing local build** fails before any request.
- One production line changed: `checkOnce` is exported. The existing CLI guard keeps `main()` from running
  under Vitest, so the script's behaviour is unchanged.
- Verified locally: `npx vitest run scripts/smoke-hosting.test.mjs` **22 passed** (16 + 6); full `npm test`
  **85 files / 1267 passed**; `npm run lint` 0 errors (6 pre-existing warnings); Prettier clean on both files.
- CI green on both duplicate suites (`44524230614` push, `44524274267` PR): all three required checks succeeded
  on each. Pushed blobs were confirmed byte-identical to the local files before the PR was opened.
- Not verified, and unchanged: the check has still never run inside the deploy job; `deploy.yml` remains
  dispatch-only with no `FIREBASE_SERVICE_ACCOUNT`. Nothing was deployed by this PR.

### 30.10 PR #8 — CI runs once per PR, and still once per merge commit

`ci.yml` had an unfiltered `push:` next to `pull_request:`, so every branch that was pushed and then opened
as a PR ran the entire workflow twice on the same commit — two check suites, double minutes, for one review.
PR #8 (`ci/ci-push-main-only`, `b110dc4`, 1 file, +9 / −0) squashed as **`2686476`** binds `push:` to `main`:

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

- `main` must stay in the push trigger: `deploy.yml`'s Gate 1 asks GitHub for a successful `ci.yml` run **for the
  exact SHA being deployed**, and a squash merge creates a commit the PR run never tested.
- **Measured, not assumed:** the PR head `b110dc4` produced `total_count: 1` workflow run (`44526470562`, event
  `pull_request`), where every earlier PR produced two. All three required checks succeeded on it.
- Also verified: the YAML parses to `{push: {branches: [main]}, pull_request: null}`, Prettier is clean, and the
  committed blob is byte-identical to the locally checked file (`51eb4188`).
- Nothing was deployed; no job, gate or test was changed or weakened — only when the workflow runs.

### 30.11 First CI deploy — `deploy.yml` run #1, hosting only

The repository had **never** deployed: `deploy.yml` had `total_count: 0` runs, and every live release in Firebase
Console → Hosting → Releases was uploaded manually by `m.juniorahamad@gmail.com` between 2026-08-10 and
**2026-10-09 13:57**, so the live bundle predated the repository's audit work. On 2026-11-22 the first dispatch
was triggered for `main` @ `2686476` with `deploy_scope=hosting`, `confirm_index_deletions=false`.

- Run **`45050368415`** (`run_number: 1`), job `137293935307`, 17:36:14 → **17:37:07Z**, conclusion **success**.
- Gates: *Require green CI for this commit* ✓ (`CI is green for 2686476da34173f2217e1032572704f03ea04914.`),
  *Check deploy credential* ✓, *Authenticate to Google Cloud* ✓ (service account key accepted).
- Steps: `npm ci` ✓ (547 packages, 7s), `npm run build` ✓ (2628 modules, `dist/index.html` 1.54 kB),
  *Deploy hosting* ✓, **Smoke check the live hosting URL** ✓. *Deploy Firestore rules* and
  *Deploy Firestore indexes* were **skipped**, as the `hosting` scope intends.
- Independent verification from this workspace, not from the workflow's own output: the live
  `index.html` moved from `last-modified: Fri, 09 Oct 2026 08:27:38 GMT` to
  `Sun, 22 Nov 2026 17:37:03 GMT`; asset references changed to the freshly built set
  (`index-C9JKIx5E.css`, `index-Cxmif_kA.js`, `vendor-react-xD2SGZ_1.js`, `vendor-ui-B3-qBXB7.js`);
  `sha256sum dist/index.html` at `2686476` equals the served bytes exactly
  (`634879f856609d2d866843fad7b86d4831994c57fead0b5177203b0769819837`); the CSS asset is served as
  `text/css` with the CSP header and `immutable` caching; `/members` returns `200 text/html` through the
  SPA rewrite.
- `scripts/smoke-hosting.mjs` was also re-run locally against the live origin at the same commit:
  `✓ live origin matches this build, and a deep link serves the app shell.` (exit 0) — the same verdict the
  job's step reached.
- Not verified here: the workflow log download truncated before the deploy/smoke sections, so those lines were
  read through live state + local reproduction instead; and Firebase Console's release-history "deployed by"
  for the new release (service account, not the owner's gmail) was not inspected.
- Unchanged and still open: Storage rules have never been deployed (photo/logo uploads are denied in
  production), Cloud Functions remain out of scope on the Spark plan, and rules + indexes are still pending the
  `hosting+rules` and `hosting+rules+indexes` dispatches.

### 30.12 Second dispatch — `hosting+rules` blocked by an IAM pre-flight, rules NOT deployed

Run **`45051119105`** (`run_number: 2`, job `137296237025`) for `main` @ `2686476` with
`deploy_scope=hosting+rules`. Gates 1–2, auth, `npm ci`, build, *Deploy hosting* and
**Smoke check the live hosting URL** all succeeded; *Deploy Firestore rules* failed after 3s and
*Deploy Firestore indexes* was skipped, so the run is red while production rules are **unchanged**:

```
i  deploying firestore
i  firestore: ensuring required API firestore.googleapis.com is enabled...
Error: Request to https://serviceusage.googleapis.com/v1/projects/himalye-wonders-gym/services/firestore.googleapis.com
had HTTP Error: 403, Permission denied to get service [firestore.googleapis.com]
```

- This is a **credential permission problem, not a rules problem**: firebase-tools first asks the
  Service Usage API whether `firestore.googleapis.com` is enabled, and the service account in
  `FIREBASE_SERVICE_ACCOUNT` cannot read that service (`serviceusage.services.get`). Hosting deploys
  succeeded because that path needs different permissions.
- Fix is in Google Cloud IAM, not in the repo: grant the service account a read-only Service Usage role
  (`roles/serviceusage.serviceUsageViewer` or `roles/serviceusage.serviceUsageConsumer`), then re-dispatch.
- Nothing in the repo was changed to make this pass — no gate, step or `--force` flag was added.
- Run #1's hosting deploy was repeated by this run (same commit, same bundle); live `index.html`
  stayed byte-identical, so the failed run had no effect on the site.
- Deployed rules remain the August-era ruleset (`e9a2306d-…`), while the repository holds 672 lines
  against that 284-line release: the first successful `hosting+rules` run will apply ~390 lines of
  accumulated rules change in one step, which is why the post-deploy app check (login, member edit,
  payment recording, expenses read) matters.

## §30.13 — Storage step + the index-diff gate finally runs (Nov 22, 2026, 17:54–18:39 UTC)

### What was asked
1. Add a Storage rules deploy step to `deploy.yml` via PR (there was no `--only storage`, so
   production Storage still ran the default deny-all ruleset and photo/logo uploads were denied).
2. Dispatch `deploy_scope=hosting+rules+indexes` with `confirm_index_deletions=false` and report
   from the run log how many indexes would be deleted.

### PRs merged (all squash, all CI green before merge)
| PR | commit | change |
|----|--------|--------|
| #9  | `f206397` | `Deploy Storage rules` step + boolean input `deploy_storage_rules` (default `false`) |
| #10 | `d7c1352` | `token_format: access_token` on the auth step (first attempt at Gate 3's token) |
| #11 | `4d180ba` | replaced that with `gcloud auth print-access-token` |
| #12 | `7fe6c5c` | dropped `pageSize=200` from `indexes.list` |
| #13 | `3fc7496` | compare indexes without the implicit trailing `__name__` field |

Storage stays **opt-in and off**: housekeeping said storage has no space right now, so the step
exists, ships from the reviewed pipeline, and runs only when `deploy_storage_rules=true`.
No storage rules, bucket or data were touched.

### Runs of `deploy.yml` this session
| # | run id | scope | result |
|---|--------|-------|--------|
| 1 | 45050368415 | hosting | success (live `index.html` = build, smoke ✓) |
| 2 | 45051119105 | hosting+rules | rules 403 `serviceusage.services.get` |
| 3 | 45052060507 | hosting+rules+indexes | Gate 3 exit 2: `ACCESS_TOKEN` empty |
| 4 | 45053074758 | hosting+rules+indexes | auth 403: `iamcredentials.googleapis.com` disabled |
| 5 | 45053889645 | hosting+rules+indexes | `indexes.list` 400 `Invalid page size` |
| 6 | 45054710158 | hosting+rules+indexes | diff printed, but `__name__` inflated it |
| 7 | 45056246156 | hosting+rules+indexes | **diff correct, refused as designed (exit 1)** |

Runs 3–7 all stopped at Gate 3, i.e. **before hosting, rules or indexes were touched**. Nothing was
deployed in any of them.

### Root causes found (all were latent bugs in the pipeline, not project config)
1. `google-github-actions/auth@v2` only exports `access_token` when `token_format` is requested —
   Gate 3 was receiving an empty token and exiting 2.
2. `token_format: access_token` itself calls IAM Credentials, which is disabled in the project.
   gcloud signs locally from the same credentials file, so no API/role change is needed.
3. The Firestore database is **Enterprise edition**: `indexes.list` rejects any non-zero `pageSize`.
4. `indexes.list` appends `__name__` to every composite index and reports single-field indexes as
   `[field, __name__]`; comparing raw fields made 15 existing indexes look new and inflated
   deletions from 10 to 25.

### Run #7 — the answer to "how many indexes get deleted" (verbatim from the job log)
```
  desired (index file)        : 20
  live composite in project   : 25
  unchanged                   : 15
  to create                   : 5
  to delete (DESTRUCTIVE)     : 10
```
Deletions (legacy, unused shapes): members [status, createdAt], payments [method, date],
bookings [classId, date], auditLog [entity, timestamp], expenses [category, date],
counters [gymId, createdAt], classes [dayOfWeek, startTime], attendance [memberId, date],
payments [memberId, date], members [status, searchName].
Creations (needed): members [gymId, isFrozen, searchName], payments [gymId, date],
expenses [gymId, date], attendance [gymId, date], members [gymId].

### Index consumer check
`src/services/firestore.js:78,220` → `where('gymId','==') + orderBy('createdAt','desc')` (already live).
`src/services/rangeQueries.js:52-58` → `where('gymId','==') + where(date,'>=') + where(date,'<=') +
orderBy('date','asc')` for payments/expenses/attendance — **those three `gymId+date` indexes are in
the to-create list**, i.e. the Reports date-range reads cannot be served until indexes are deployed.
No non-test code queries `memberId`, `method`, `category`, `entity`, `classId`, `dayOfWeek` or
`status` with an `orderBy`, so the 10 deletions have no known consumer.

### Still blocked
- `Deploy Firestore rules` needs `serviceusage.services.get` on
  `firebase-adminsdk-fbsvc@himalye-wonders-gym.iam.gserviceaccount.com` (run #2's 403). Console fix:
  IAM → grant **Service Usage Viewer** (`roles/serviceusage.serviceUsageViewer`).
- Indexes deploy is one dispatch away (`confirm_index_deletions=true`) but it sits after the rules
  step, so the rules 403 must be fixed first.
- Cloud Functions still need Blaze; storage data/uploads deliberately postponed.

## §30.14 — Rules-less index deploy: two more pipeline bugs, one IAM wall left (Nov 22, 2026, 19:00–19:25 UTC)

User granted `roles/serviceusage.serviceViewer` and asked for a `hosting+indexes` scope so the
reviewed index changes (10 delete / 5 create) could ship without the blocked rules step.

### PRs merged
| PR | commit | change |
|----|--------|--------|
| #14 | `2e4c968` | `deploy_scope` gains `hosting+indexes` (same path, rules condition false) |
| #15 | `45170dd` | new `firebase.indexes.json` + `--config` on the index step (skips rules compile) |
| #16 | `47ed0c9` | `--force` on the index step (firebase-tools only deletes with it) |

### Runs
| # | run id | result |
|---|--------|--------|
| 8 | 45058611058 | gates ✓, diff ✓ (15/5/10), hosting ✓, smoke ✓ → index step: `firebaserules ...:test` 403 |
| 9 | 45059877853 | gates ✓, diff ✓, hosting ✓, smoke ✓ → index step: `firestore .../collectionGroups/members/indexes` 403 |

Logs: `verify/logs8/`, `verify/logs9/`. No Firestore rules, index or storage change happened in either
run; hosting was re-deployed from the same commit and the live-URL smoke check passed both times.

### Root causes found
1. `firebase deploy --only firestore:indexes` still compiles `firestore.rules` when `firebase.json` is
   the active config (`firebaserules.googleapis.com:test`), and it 403s for this service account even
   though only indexes were requested. A config naming only the indexes file removes that step.
2. With the extra project indexes present, firebase-tools refuses to delete them without `--force`
   ("there are 10 indexes ... not present in your firestore indexes file"). Gate 3 already blocks
   unconfirmed deletions, so the step passes the flag.

### Remaining blocker (IAM, user action)
`datastore.indexes.create/delete` is missing on
`firebase-adminsdk-fbsvc@himalye-wonders-gym.iam.gserviceaccount.com`.
Console fix: IAM → grant **Cloud Datastore Index Admin** (`roles/datastore.indexAdmin`).
Reads (`indexes.list`) already work, which is why Gate 3 could print the diff in every run.

### Dispatch contract (for future runs)
`Actions → Deploy (hosting · Firestore rules · indexes · storage rules) → Run workflow`,
branch `main`, `deploy_scope = hosting+indexes`, `confirm_index_deletions = true`, storage off.
CLI equivalent:
`gh workflow run deploy.yml -f deploy_scope=hosting+indexes -f confirm_index_deletions=true`

---

## §30.15 Index deploy completed — 10 deleted, 5 live, idempotent re-run (run #10, #11, #12)

`roles/datastore.indexAdmin` granted by the user; the 403 from §30.14 is gone.

### Run #10 (`45092434330`, main `47ed0c9`) — FAILED, but created 4 of the 5 indexes
- Gates, index diff (20 desired / 25 live / 15 unchanged / 5 create / 10 delete), hosting deploy and
  hosting smoke check all passed.
- Index step reached Firestore and was **rejected with a validation error, not a permission error**:
  `HTTP Error: 400, this index is not necessary, configure using single field index controls`
  (`.../collectionGroups/members/indexes`).
- Cause: `firestore.indexes.json` declared `members [gymId, __name__]` — a single-field index written
  as a composite. Firestore Enterprise refuses that; single-field indexes are managed by Firestore.
- Because the create loop runs in order, the other four indexes were created before the failing one:
  `payments [gymId,date]`, `expenses [gymId,date]`, `attendance [gymId,date]`,
  `members [gymId,isFrozen,searchName]` → live went 25 → 29.

### Fix (PR #17, squash `232922b`)
`firestore.indexes.json` now declares 19 composites; the single-field `members [gymId,__name__]` entry is
removed. `scripts/index-diff.mjs` already strips a trailing `__name__` when comparing, so no create or
delete is triggered for it. Local checks: `vitest run src/tests/compositeIndexCoverage.test.js
src/tests/indexDiff.test.js` (34 passed), `prettier --check firestore.indexes.json` clean. CI: `Lint ·
build · unit tests`, `Frozen baselines`, `Security rules · storage · functions` all green; main CI run
#53 green before dispatch.

### Run #11 (`45094067467`, main `232922b`) — SUCCESS
- Gate diff: desired 19, live 29, unchanged 19, **to create 0**, **to delete 10**.
- Index step: `i firestore: Deleting 10 indexes...` → `✔ firestore: deployed indexes ... successfully`.
- Hosting deployed and smoke check passed.

### Run #12 (`45094527264`, main `232922b`) — SUCCESS (verification / idempotency)
- Gate diff: desired 19, live 19, unchanged 19, **to create 0**, **to delete 0**, `Index diff check passed`.
- Index step re-deployed the same (empty) delta; hosting smoke check passed again.

### Final state
Live composite indexes: **19**, exactly matching `firestore.indexes.json`. The 10 legacy indexes are gone
and the four new `gymId`-scoped composites (including the three `gymId + date` ones that
`src/services/rangeQueries.js` depends on) exist. Logs kept at `verify/logs10/`, `verify/logs11/`,
`verify/logs12/`.

### Still not verified
- The app's Reports screen was not exercised (needs a signed-in gym account and data); the indexes it
  needs are now present, which is the deploy-side precondition only.
- Firestore **rules** deploy (`hosting+rules`) has still never run; the `firebaserules` permission
  question from §30.14 is open.
- Storage rules step remains opt-in and off.

## 30.16 — Firestore rules deploy (`hosting+rules`): blocked by 403 on `firebaserules:test`

Dispatched on main `232922b` with `deploy_scope=hosting+rules`, `confirm_index_deletions=false`,
`deploy_storage_rules=false` (run **#13 `45095657426`**, completed **failure** in 57 s).

Steps: green-CI gate ✓, credential gate ✓, auth ✓, index diff skipped (indexes not in scope), build ✓,
`Deploy hosting` ✓ (`✔ hosting[himalye-wonders-gym]: release complete`), hosting smoke ✓,
then `Deploy Firestore rules` **failed**:

```
i  cloud.firestore: checking firestore.rules for compilation errors...
Error: Request to https://firebaserules.googleapis.com/v1/projects/himalye-wonders-gym:test
       had HTTP Error: 403, The caller does not have permission
```

Storage rules and indexes steps were skipped (out of scope / after the failure).

### Cause and exact fix
The `:test` call is the rules compile check, i.e. permission **`firebaserules.rulesets.test`**. The deploy
service account has hosting + `datastore.indexAdmin` but no `firebaserules.*` grant. Minimal predefined
role that contains it (plus `rulesets.create/get/list` and `releases.create/update` needed for the actual
release) is **`roles/firebaserules.admin`** — `firebase.json` `firestore.rules` needs nothing else; the
earlier `serviceusage.services.get` preflight concern did not surface here.

```
gcloud projects add-iam-policy-binding himalye-wonders-gym \
  --member="serviceAccount:<DEPLOY_SA_EMAIL>" \
  --role="roles/firebaserules.admin"
```

Then re-dispatch `hosting+rules`. Rules releases take a few minutes to propagate.

### Hosting side effect and cache risk
None of these deploys changed the bundle: the entry chunk is `assets/index-Cxmif_kA.js` in run #10
(01:05 UTC), #11, #12, #13 and in the 2026-11-22 18:26 CI run. `firebase.json` serves `/assets/**` as
`immutable, max-age=31536000` and `index.html` with Firebase's default `max-age=3600`.

Residual risk pattern (not triggered here): a shell cached for up to an hour after a release that *does*
change hashes asks for chunk files the new release no longer publishes; the SPA rewrite answers those
paths with `index.html` (HTTP 200, `text/html`), so the dynamic import fails rather than 404s, and the app
lands on its load-error state until the shell refreshes. Logs: `verify/logs13/`.

## 30.17 — `index.html` cache header: two PRs, verified live

Goal: stop a stale SPA shell from surviving a deploy. Firebase Hosting's default for
`index.html` is `Cache-Control: max-age=3600`, and `/assets/**` is `immutable, max-age=31536000`.

### PR #18 (`8879ac9`) — first attempt, insufficient
Added a `/index.html` header rule. Deploy run #14 (`45098440604`, hosting) succeeded and live
`/index.html` returned `no-cache, max-age=0, must-revalidate`, **but** `/` and deep links still returned
`max-age=3600`.

Cause: header rules match the **original request path, before the rewrite**, and when several rules
match, the **last one wins** (Firebase docs; confirmed by a firebase-tools maintainer in
firebase-tools#8917). So `/index.html` never matched `/` or `/members`.

### PR #19 (`c3a8763`) — correct ordering
- `/**` now carries the security headers plus `Cache-Control: no-cache, max-age=0, must-revalidate`.
- `/assets/**` with `public, max-age=31536000, immutable` moved **last**, so last-match precedence keeps
  hashed assets long-cached.
- The `/index.html`-only rule was removed as redundant.

Checks: PR #19 three checks green, main CI run #57 green, `prettier --check firebase.json` clean.

### Live verification — deploy run #15 (`45099649222`, SUCCESS)
```
/                    cache-control: no-cache, max-age=0, must-revalidate   text/html
/index.html          cache-control: no-cache, max-age=0, must-revalidate   text/html
/members             cache-control: no-cache, max-age=0, must-revalidate   text/html
/some/deep/link      cache-control: no-cache, max-age=0, must-revalidate   text/html
/assets/index-Cxmif_kA.js  cache-control: public, max-age=31536000, immutable  text/javascript
```
`x-content-type-options: nosniff` still present on the shell responses, so the `/**` security headers
still apply. Bundle unchanged (`index-Cxmif_kA.js`), so this deploy only changed header policy.

Effect: a deploy is now visible on the next navigation instead of up to an hour later; the stale-shell
window that could ask for deleted chunks is gone.

## 30.18 — Cache policy is now a deploy gate (PR #20)

`scripts/smoke-hosting.mjs` used to verify bundle identity and the SPA rewrite only, so the header
ordering of §30.17 could regress silently. It now also asserts the applied cache policy:

- `GET /` (cache-busted) must answer `Cache-Control` containing `no-cache`;
- the deep route (`/login`) must answer `no-cache` too — `/index.html`-only matching was exactly the
  bug in §30.17;
- every `/assets/**` entry file must answer `immutable`.

Tests (`scripts/smoke-hosting.test.mjs`): the loopback origin now sends `Cache-Control` (shell default
vs asset default, per-path), the pass case asserts both new ok messages, and three failure tests cover
a cached shell, a cached deep link, and a non-immutable asset. Local: **25 passed**; `prettier --check`
clean.

Local run against the live origin (with the live build in `--dist`, because a local `dist/` from a
different Node version hashes differently): `Hosting smoke check passed`, exit 0 — i.e. `/`, `/login`
and every asset satisfied all five checks against production.

Merged squash **`a02fbd5`** (PR checks 3/3 green). No deploy was run for this PR: the script runs inside
the deploy job, so it starts gating from the next `hosting` dispatch.

## 30.19 — Cache policy documented, and the gate proven in CI (PR #21, run #16)

Docs had drifted from what §30.18 added, so PR #21 (squash `2265304`) fixed three things:

- `README.md`: the smoke-check paragraph now states the cache policy and why it is checked (header
  rules match the original request path; the last match wins).
- `scripts/smoke-hosting.test.mjs`: the verdict comment now names the five covered failures, cache
  cases included, instead of the stale "four failures" wording.
- `scripts/smoke-hosting.mjs`: on success it prints every fact it verified, so a deploy log shows what
  passed instead of only that nothing failed.

Checks: `vitest run scripts/smoke-hosting.test.mjs` **25 passed**; `prettier --check` clean on all three
files; PR checks 3/3 green; main CI run #61 green.

### Deploy run #16 (`45102755724`, main `2265304`) — SUCCESS, new gate visible in the log
```
Hosting smoke check — https://himalye-wonders-gym.web.app vs ./dist
  ✓ the shell is served with Cache-Control: no-cache
  ✓ served index.html references this build's entry files (/assets/index-Cxmif_kA.js, …)
  ✓ /assets/index-Cxmif_kA.js served identically (50912 bytes, sha256 575c579a8952)
  ✓ … four more assets …
  ✓ every entry asset is served with Cache-Control: immutable (5)
  ✓ deep link /login serves the app shell through the rewrite
  ✓ deep link /login is served with Cache-Control: no-cache
✓ live origin matches this build, a deep link serves the app shell, and the cache policy is applied.
Hosting smoke check passed.
```
So the cache assertions are now exercised in CI against production, not only locally. Logs:
`verify/logs16/`.

## 30.20 — Rollback runbook for hosting and rules (PR #22, squash `270368d`)

Deploys were gated from merge to live origin, but the way *back* was a console click nobody had
rehearsed, and `firebase hosting:rollback` prompts interactively — unusable from a job, unreviewable in a
diff. PR #22 adds:

- `scripts/rollback-release.mjs` — `--target=hosting|rules`, **dry run by default**: without `--apply`
  it only calls list/get, prints the live release, the older candidates and the exact requests.
  With `--apply` it performs that printed plan:
  - hosting: `POST sites/<site>/releases?versionName=<older version>` — appends a release, deletes nothing;
  - rules: `GET` the old ruleset (list responses omit file contents) → `POST` a ruleset with that source →
    `PATCH projects/<p>/releases/cloud.firestore?updateMask=rulesetName`.
  - Neither path calls `firebaserules:test`, so a rules rollback does not depend on the pending
    `roles/firebaserules.admin` grant. That is a claim about which API is called, not a tested run.
- `README.md` — 3-step incident procedure (freeze via the `deploy-${{ github.ref }}` concurrency group,
  dry run, `--apply` + verify), permissions per path, and an explicit "not exercised against production yet".
- `scripts/rollback-release.test.mjs` — 16 offline tests with an injected `fetch`; they assert a dry run
  issues **only GETs** and an apply writes exactly the printed plan (previous version only, never an empty
  ruleset source).

Checks: focused vitest 16/16, eslint clean on both files, prettier clean on all four, PR checks 3/3 green.
Not verified: no rollback has been applied to the production project (it would change live state). First
real use: dry run → `--apply` → `npm run smoke:hosting` (hosting) or one real read/write (rules).

## 30.21 — PR preview channels (PR #23, squash `91f80bb`)

The last gap in the hosting story was that a bundle was only ever checked on a real URL **after** merge:
`deploy.yml` builds from `main`, so a reordered `headers` array or a broken rewrite shipped first and the
smoke check caught it a minute later. `.github/workflows/preview.yml` closes it:

- on every PR to `main`: `npm ci` → `npm run build` → `firebase hosting:channel:deploy pr-<number>
  --expires 7d --json` → `scripts/smoke-hosting.mjs --base-url=<channel>` → one sticky PR comment with the URL;
- hosting only (no rules/indexes/storage in a channel), fork PRs skipped (no secrets), per-PR concurrency
  cancels a stale run, and it is deliberately **not** a required check.

### First real run — PR #23, run `45168951091` (success)
```
Preview channel: https://himalye-wonders-gym--pr-23-v3lb3gxy.web.app
Hosting smoke check — https://himalye-wonders-gym--pr-23-v3lb3gxy.web.app vs ./dist
  ✓ the shell is served with Cache-Control: no-cache
  ✓ served index.html references this build's entry files (/assets/index-Cxmif_kA.js, …)
  ✓ every entry asset is served with Cache-Control: immutable (5)
  ✓ deep link /login serves the app shell through the rewrite
  ✓ deep link /login is served with Cache-Control: no-cache
Hosting smoke check passed.
```
So the cache policy and the SPA rewrite hold on a preview channel too — the check is meaningful pre-merge,
not just against production. The channel-create permission therefore exists on the deploy service account
(Firebase Hosting Admin); no extra IAM grant was needed. Logs: `verify/logs-preview/`.

Note: the channel `pr-23` stays up until its 7-day expiry; nothing deletes it explicitly.

## 30.22 — The build now refuses to run without the Firebase web config (PR #24, merge `1a51001`)

The production bundle was built while CI had no `VITE_FIREBASE_*` values at all. `vite build` inlines them at
compile time, so an unset variable becomes `undefined`, `isFirebaseConfigured` in `src/firebase/config.js` goes
false, and every visitor to `/login` got the "Firebase is not configured" banner. Adding repository secrets
alone does not change a live bundle — it has to be rebuilt. PR #24 closes both halves:

- **The config reaches the build as job identity.** `deploy.yml` and `preview.yml` now carry the six secrets as
  a **job-level `env:`** block, so the gate, install, build and smoke steps all read the same six values; the old
  per-step `env:` on the build step (the only place they existed) is gone.
- **A guard stops the job before anything is built.** `scripts/check-firebase-env.mjs` exports
  `REQUIRED_FIREBASE_VARS` (API_KEY, APP_ID, AUTH_DOMAIN, MESSAGING_SENDER_ID, PROJECT_ID, STORAGE_BUCKET) and
  `missingFirebaseVars(env)`; as a CLI it prints one `::error::` per missing or blank variable and exits 1, and on
  success prints `✓ all 6 VITE_FIREBASE_* variables are set for this build.` It checks presence only and never
  prints a value. In `deploy.yml` it is **Gate 4, before `Install`**, so no unconfigured bundle can be built or
  uploaded; `preview.yml` runs the same step.
- `scripts/check-firebase-env.test.mjs` — 6 tests: missing-variable order, blank/whitespace, exit 1 with "1 of 6",
  no value leak, exit 0. Path resolution works under jsdom as well as node (jsdom makes `import.meta.url` an
  `http:` URL, which `fileURLToPath` rejects — that was a real CI failure, fixed inside the PR).

Checks: 6/6 tests, eslint and prettier clean locally; all four PR checks green, including **Deploy preview
channel**, which proves the config now reaches a real bundle. `deploy.yml` remains `workflow_dispatch` only, so
**this PR deployed nothing**.

### Post-deploy verification (run #17, verified)
The steps below were planned before the deploy; the result block after them records what actually happened.
1. Dispatch `deploy.yml` from `main` @ `1a51001` with `deploy_scope=hosting`, `confirm_index_deletions=false`,
   `deploy_storage_rules=false`.
2. `npm run smoke:hosting` — the local half asserts the built `dist` contains a real `AIza…` key
   (`FIREBASE_KEY_RE`); the live half asserts the served `index.html` references this build's entry files.
3. Fetch the live entry JS and confirm it contains `AIza` rather than `apiKey:void 0` — the old failure looked
   exactly like the latter.
4. Open `/login` on the live origin and confirm the "Firebase is not configured" banner is gone and signing in
   reaches Firebase Auth.

#### Result — run #17 `45368931003`, `main` @ `1a51001` (2026-11-24 09:50:02Z, SUCCESS in 44 s)

Job `Firebase deploy (hosting)` (job id `138357839288`) steps, in order: green-CI gate ✓, deploy credential ✓,
GCP auth ✓, **Check Firebase web config ✓** (`✓ all 6 VITE_FIREBASE_* variables are set for this build.`),
Install ✓, Build hosting bundle ✓, Deploy hosting ✓, Smoke check ✓. The index diff, Firestore rules, Storage
rules and Firestore indexes steps were **skipped** — the dispatch used `deploy_scope=hosting`,
`confirm_index_deletions=false`, `deploy_storage_rules=false`, so nothing outside hosting was touched.

Deploy log: 51 files in `dist`, `file upload complete` 09:50:42Z, `version finalized`, `release complete`,
`Deploy complete!`. Live verification a minute later:

- `/index.html` answers 200 with `Last-Modified: Tue, 24 Nov 2026 09:50:42 GMT` — this release, not a cached copy.
- Served entry `/assets/index-CNG0CU41.js` (51,074 bytes) contains `apiKey:"AIzaSy…"`: `AIza` appears once,
  `apiKey:void 0` zero times. The smoke step independently reports "the build carries the Firebase web config"
  and that every served entry asset has the same sha256 as `dist`.
- Signed-out incognito `/login`: "Welcome back", email and password fields, Sign in / Create account — and
  **no "Firebase is not configured" banner**. A signed-in tab rendered the dashboard with live Firestore data
  (28 members, ₹4,600 outstanding), so client reads against the configured project work.
- `/login` is still served through the rewrite with `Cache-Control: no-cache`.

Not shown: a before/after bundle diff. The release completed at 09:50:42Z and the first snapshot could only be
taken at 09:50:49Z, so the pre-deploy bundle was never captured; only the post-deploy state is observed.
