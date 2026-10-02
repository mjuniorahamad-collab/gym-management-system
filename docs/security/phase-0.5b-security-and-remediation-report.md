# PHASE 0.5B — SECURITY EVIDENCE & REMEDIATION DESIGN REPORT

**Date:** 2026-10-02
**Project:** `himalye-wonders-gym` (production) / `demo-himalye-gym` (emulator)
**Scope:** Evidence freeze, production rule verification, production data inventory, root-cause analysis, and Phase 1 remediation design.
**Remediation status:** None implemented. This document is design only.

---

## 1. Evidence Checkpoint

The Phase 0.5A emulator evidence has been frozen on a dedicated branch.

| Item | Value |
|---|---|
| Branch | `security-audit/phase-0.5a-evidence` |
| Commit | `c47532b` — "Add automated security regression evidence" |
| Parent | `b068b80` (unchanged `main`) |
| Files in commit | 1 (`tests.emulator/firestoreSecurityEmulator.test.js`) |
| Size | 82,517 bytes / 1,951 lines |
| SHA-256 | `6DEDEA4CE32646C59B0A79957C703A657F5D7B5CB46208D75BC5A2A3B768BD54` |
| Merged to `main` | **No** |
| Working tree | Clean |

**Byte-identical to HEAD (verified unchanged):** `firestore.rules`, `storage.rules`,
`firestore.indexes.json`, `firebase.json`, `package.json`, `vitest.emulator.js`, all of
`src/`, all of `functions/`, and `tests.emulator/firestoreRulesEmulator.test.js`.

All evidence artifacts live outside the repository at
`%TEMP%\opencode\`: `phase05a-run6.log`, `phase05a-run7.log`, `phase05a-results.json`,
`phase05a-debug.log`, `deployed-firestore.rules`, `untagged-inventory.csv`,
`gym-distribution.csv`.

## 2. Current Security Baseline

| Suite | Tests | Passed | Failed |
|---|---:|---:|---:|
| `tests.emulator/firestoreRulesEmulator.test.js` (original) | 56 | 56 | 0 |
| `tests.emulator/firestoreSecurityEmulator.test.js` (Phase 0.5A) | 407 | 356 | 51 |
| **Emulator total** | **463** | **412** | **51** |
| `src/tests/*` (Vitest unit suite, 23 files) | not re-run | — | — |

The 51 failures are deterministic across two independent full runs and confirmed via the
Vitest JSON reporter. Failure groups: `A:7 B:1 C:7 D:11 E:1 F:3 G:2 I:6 J:12 K:1`.

**The 51 failures are not 51 vulnerabilities.** They decompose into **8 independent root
causes** (§3), of which one — the query-semantics cluster (14 failures) — is very likely an
**emulator artifact**, not a production defect (§4).

Test-design invariants held: all fixture IDs are `sec-`-prefixed, `clearFirestore()` is never
called, and state is captured explicitly because `env.withSecurityRulesDisabled()` discards
its callback's return value. Matrix dimensions unchanged: 84 `members` + 48 `payments` cells.

## 3. Root-Cause Analysis

| # | Root cause | Rule location | Failure group | Count | Sev | Data migration? | Product decision? |
|---|---|---|---|---:|---|---|---|
| **RC-1** | `users` write rule never constrains `role`; `sameGymForRequest()` (L109-112) pins only `gymId` | `firestore.rules:180-185` | A | 5 | **P0** | No | No |
| **RC-2** | `users` delete has no self-exclusion and no last-owner guard | `firestore.rules:186` | A | 2 | **P0** | No | No |
| **RC-3** | `canBindGymId()` constrains only `gymId`, never `role` | `firestore.rules:97-104` | B | 1 | P1 | No | No |
| **RC-4** | Global `settings/app` singleton: `allow read: if isSignedIn()` | `firestore.rules:278-281` | C + G | 9 | **P0** | **Yes** | **Yes** |
| **RC-5** | `canWriteTenant()` admits `legacy(resource)` — untagged docs are claimable by any tenant, with no exclusivity | `firestore.rules:82-87` | D + F + K | 13 | P1 | **Yes** | **Yes** |
| **RC-6** | `bookings` write validates only the booking's own `gymId`; no referential check on `memberId`/`classId` | `firestore.rules:261-263` | F | 1 | P1 | No | No |
| **RC-8** | Emulator list-rule evaluation appears **existential/permissive** where canonical Firestore is **universal/restrictive** | emulator 1.19.8 | J + E + F | 14 | **None if artifact** | No | No |
| **RC-10** | `members` write uses `isStaff()` (trainer included) while `PERMISSIONS['members.write']` excludes trainer | `firestore.rules:192` | I | 6 | P1 | No | No |
| | | | **Total** | **51** | | | |

### Two root causes the test suite does not cover

**RC-7 (P0) — client-side tenancy backfill.** `ensureGymTenancy()`
(`src/services/migration.js:149-194`) calls `listAllUnscoped(name)` (`:160`) and stamps the
caller's `gymId` onto **every** document lacking one, across all 9 `TENANCY_COLLECTIONS` —
i.e. all untagged records database-wide, not just contested ones. Errors are swallowed
(`:161-163` → `perCollection[name] = 'error'`) and `tagged` stays 0, which
`src/pages/Settings.jsx:186-196` reports as *"Tenancy is up to date"*. Reachable by any owner.

- Against **production** Firestore the unscoped query is denied → silent false success.
- Against the **emulator** it would mass-assign the whole database.

**RC-9 (P1) — second unscoped read site, previously missed.** `ensureMemberNumberCounter()`
(`migration.js:114-139`) calls `listAllUnscoped('members')` (`:131`) and seeds the caller's
gym counter from the **global** maximum `memberNo`. Two failure modes: a cross-tenant read of
every member number, and a counter seeded from another gym's high-water mark. Under production
rules the read is denied, `.catch(() => [])` yields `max = 0`, and the counter is silently
provisioned at 0 → member-number collision. No test covers cross-gym seeding.

### The incorrect premise underneath RC-5 / RC-7

`src/services/firestore.js:37-43` documents `listAllUnscoped` as:

> "Safe because the security rules still gate every doc; while records are untagged (legacy)
> they remain readable, and once tagged they are scoped to the caller's gym."

This conflates *readable* with *claimable-as-own*. It is the origin of the `legacy()` design
and of the mass-claim risk.

## 4. J1/J5 Verification

### Rule path
`members` and 9 sibling collections read via `firestore.rules:191`:
`allow read: if isStaff() && canReadTenant(resource);` where

```
sameGym(r)     = isSignedIn() && hasGym() && r != null && r.data.gymId == gymOf(uid)
legacy(r)      = r != null && !('gymId' in r.data)
canReadTenant  = sameGym(r) || legacy(r)
```

### Emulator result (observed, pinned `FIRESTORE_EMULATOR_VERSION=1.19.8`)
A temporary probe was created, executed, and immediately deleted. It showed, as Gym A's owner:

- `collection('members').get()` (unscoped) → **ALLOWED**, returned Gym A's, Gym B's, and a legacy record
- `.where('name','==','B')` (non-tenancy filter) → **ALLOWED**, returned Gym B's member
- `.where('gymId','==',A)` → correct, Gym A only

### Canonical interpretation
Firestore evaluates a query against its **potential result set** and fails the whole request if
it could return documents the caller may not read. `resource` is unavailable for `list`, which
surfaces as a `Variable read error … for 'list'` → `permission-denied` on real Firestore. This
is a **universal** check. With `resource == null` both `sameGym` and `legacy` return `false`,
so **the query must be denied**. The rules as written are correct.

### Leading hypothesis — existential vs universal list evaluation
The emulator appears to allow a list when the rule is satisfiable for **any** potential document
rather than **all** of them. This single mechanism explains every observation:

| Observation | Existential predicts | Canonical predicts | Emulator did |
|---|---|---|---|
| Unscoped `members` | untagged candidate → allow | deny | **allow** ✅ |
| `where('gymId','==',GYM_B)` | untagged cannot match → deny | deny | **deny** ✅ |
| `where('name','==','B')` | untagged could match → allow | deny | **allow** ✅ |
| Unscoped `gyms` | no `legacy` disjunct → deny | deny | **deny** ✅ |
| Unscoped `auditLog` | untagged candidate → allow | deny | **allow** ✅ |

No observation contradicts it. `settings` is excluded from this class because its read rule has
no `resource` dependency — so **C13 (enumerate the `settings` collection) is a real finding in
both emulator and production.**

### F9 is mis-attributed
F9 is one test with three `assertFails` assertions (point read → `gymId` query → unscoped query).
`assertFails` throws on first success, so assertions 1 and 2 **passed** — the cross-tenant point
read is correctly denied. Only assertion 3 failed. **There is no point-read booking leak.** The
test name misleads, and bundling three behaviours let the query artifact mask two real guarantees.

### Production result
Verified, not assumed. See §12. Deployed production rules are **byte-identical** to the
repository's `firestore.rules`, so the analysis above applies to production unchanged.

### Classification

| Finding | Emulator | Production | Classification |
|---|---|---|---|
| **J1** (11 unscoped collection reads) | ALLOWED | denied by canonical semantics | **EMULATOR-ONLY** |
| **J5** (non-tenancy filter returns foreign doc) | ALLOWED | denied by canonical semantics | **EMULATOR-ONLY** |
| **F9** (assertion 3 only) | ALLOWED | denied | **EMULATOR-ONLY** |
| **E8** (unscoped `auditLog` enumeration) | ALLOWED | denied | **EMULATOR-ONLY** |
| **C13** (enumerate `settings`) | ALLOWED | **ALLOWED** — no `resource` dependency | **CONFIRMED** |

**Do not "fix" J1/J5 in the rules.** They are already correct.

## 5. Role / User Security

**Current.** `users/{uid}` writes are permitted by `canBindGymId(uid)` or an in-gym
admin/owner branch (`firestore.rules:180-185`). Both non-bind branches enforce only `gymId`
via `sameGymForRequest()` (L109-112). `role` is unconstrained and unvalidated. Deletes (L186)
permit any in-gym owner to delete any in-gym profile, including themselves.

**Decisive application constraint: there is no role-management UI.** Exhaustive search for role
editing, staff management, invites, and user deletion returns zero hits. The only user-profile
write from the app is the onboarding self-bind (`src/services/onboarding.js`) plus a legacy
in-place bind in `AuthContext.jsx`.

**Consequence:** RC-1, RC-2 and RC-3 are reachable only by a hand-crafted client call — no
legitimate product flow needs them. They are pure attack surface at **zero feature cost** to close.

**Production confirmation:** 3 users exist, all with `role == 'owner'`, each bound to a distinct
gym. No escalation is observable in current data.

**Target invariants (design):**
- `role` may be set only by an in-gym owner, only to an allowlisted value, never to a rank at or
  above the writer's own.
- A role write must never be satisfied by the `canBindGymId` path — binding may set only `gymId`.
- `gymId` immutable once bound (already enforced; SEC-H 15/15 green).
- Delete: forbid self-delete; forbid deleting a gym's last owner; require an audit entry.
- Reject unknown/missing `role` rather than defaulting (A11 fails today).

## 6. Settings Architecture

**Current path:** `settings/app`, a single global document. Exactly 3 Firestore operations live
in `src/context/SettingsContext.jsx` (`:36`, `:46`, `:49`, `:87`, `:89`). Nothing else in `src/`
or `functions/` touches the `settings` collection.

**Target path:** `gyms/{gymId}/settings/app` — already proven by PT pricing
(`src/services/pt.js:31-37`) and WhatsApp (`src/services/whatsappGroup.js:35-41`), both
tenant-isolated with working rules, audit entries, and 24+ emulator tests. Both carry an
explicit comment that the global singleton is *"deliberately NOT used because it is shared
across tenants."*

**Fields:** `gymName`, `tagline`, `currency`, `dateFormat`, `receiptPrefix`, `logoUrl`.
`dateFormat` is persisted but never applied — `formatDate` hardcodes `en-US`; treat as dead.

**Readers (10 files):** `Sidebar.jsx:94` · `Login.jsx:209,235` (**unauthenticated**) ·
`ReceiptModal.jsx:19,21,114` (**print**) · `MembershipCard.jsx:14` (**print**) ·
`memberSummary.js:21,32` (WhatsApp body + print) · `Dashboard.jsx:465` · `Members.jsx:80` ·
`MemberDetail.jsx:965,976` · `RenewalModal.jsx:219` · `Settings.jsx` (writer).

**Persistence constraint — `receiptPrefix` is stamped, not derived.** `Dashboard.jsx:284`,
`Payments.jsx:95`, `MemberDetail.jsx:348` and `RenewalModal.jsx:176,194` pass it into
`recordPayment`/`renewMembership`, which persist it onto `payments`/`memberships` at write time.
**Historical receipts are snapshots and must never be re-derived**; a settings migration must not
retroactively alter them. 72 payments exist in production.

**Migration blockers:**
1. `SettingsContext.jsx:23` destructures only `{ user }` — `gymId` is never read; effect deps at
   `:78` are `[user]`. A gym-scoped path races with a null `gymId`. `pt.js:33-35` and
   `whatsappGroup.js:37-39` already throw in this case; `SettingsContext` does not.
2. **Permission denial is silent.** `:52-56` catches a denied `getDoc` and still subscribes; the
   `onSnapshot` error handler `:66-68` merely `setLoading(false)`, silently reverting to
   `DEFAULT_SETTINGS`. Restricting the read would degrade branding with no user-visible error.
3. `firestore.rules:159-167` requires the pending doc to carry `gymId`; a migration must stamp it
   exactly as `pt.js:71` / `whatsappGroup.js:78` do.
4. `Login.jsx` reads settings **while unauthenticated** — no `gymId` exists yet.
5. The auto-create at `:49` seeds hardcoded defaults; these are the copy-forward source.
6. No dual-read/fallback layer exists — this is a hard cutover.

**Decision taken (this phase): drop gym branding from the login screen.** Product-level defaults
only. This removes the last reason a public/pre-login branding surface would be needed.

**Status in the rules is deliberate, not an oversight.** `firestore.rules:275-277` states the
relocation is *"deferred to the owner-auth/settings phase"* — RC-4 is a known, deferred decision.

**Production:** 1 `settings` document, global and untagged. 3 users can read it.

**No index needed.** All settings access is single-document; `firestore.indexes.json` has no
`settings` or `gyms` entry.

## 7. Legacy Data Model

**Current behaviour**

| Operation | Result | Mechanism |
|---|---|---|
| Untagged read | **ALLOWED** for every bound tenant **and for unbound users** | `legacy()` in `canReadTenant` (`firestore.rules:59-61, 72-74`) |
| Untagged create | DENIED | `canWriteTenant` requires `gymId` in payload |
| Untagged update (no `gymId`) | DENIED | same |
| **Untagged claim (add `gymId`)** | **ALLOWED** for any tenant | `legacy(resource)` in `canWriteTenant` (L86) |
| Untagged delete | DENIED — but only via a raised evaluation error | `sameGym()` L67 dereferences `resource.data.gymId` with no null guard |
| `auditLog` claim | DENIED | `allow update, delete: if false` (L271) |

Intent is documented at `firestore.rules:55-58` and L76-81: legacy records stay *"readable and
migratable so existing data is never lost during backfill."*

**Risk.** First-come-first-served capture (D7/D8): one `update({gymId})` permanently transfers a
record. Firestore rules fundamentally cannot distinguish "my legacy record" from "your legacy
record" — `legacy()` is true for *every* untagged document regardless of caller.

**Production reality (verified):** the migration has already run and there is **nothing left to
claim** — all 9 business collections are 100% tagged, and the three operating gyms hold distinct,
plausibly-correct data volumes (3 / 27 / 8 members). RC-7's mass-claim mis-assigned nothing.

**Recommended target model (design):**

| Layer | Target |
|---|---|
| Client | May **never** claim an untagged document. Remove `legacy()` from `canWriteTenant`'s update path. |
| Migration | Admin SDK / trusted server process only; bypasses rules, so it can enumerate and tag deterministically. |
| Ownership resolution | Deterministic and auditable — never "whoever ran it first". |
| Quarantine | Ambiguous records parked in `quarantine/{collection}/{id}` with reason + timestamp, never guessed. |
| Audit trail | Every tag decision durably recorded (collection, docId, from → to, rule applied, actor, timestamp). |
| Completion marker | `tenancy/migrationState` = `{ schemaVersion, completedAt, tagged, quarantined }`; the `legacy()` disjunct is then **deleted**, not kept forever. |

## 8. Bookings Integrity

**Current.** `createDoc` (`src/services/firestore.js:74`) stamps `gymId` and timestamps on every
create, so a caller-supplied forged `gymId` is always overwritten (F5–F8 confirm a direct forged
write is denied). `handleAddBooking` (`src/pages/Classes.jsx:93-111`) writes only
`{ classId, memberId, date, status }`.

**Cross-tenant reference risk (RC-6).** Nothing validates that `memberId` belongs to the booking's
gym, or that `classId` does. The UI dropdown is gym-scoped so the app is safe by construction, but
the rules are not — a hand-crafted client can create a booking in Gym A pointing at a Gym B member.

**Production impact: none.** The `bookings` collection **does not exist**. RC-6 is therefore a
code-hardening item with **no data migration, no backup, and no maintenance window**.

**Target invariant:** *a booking belonging to Gym A must not reference a member belonging to Gym B.*

**Mechanism — do NOT use `get()` in the rule.** A `get(/members/$(memberId)).data.gymId` check costs
a document read per write, breaks on a missing member, and interacts badly with `resource` semantics.
Instead:

1. **Defense-in-depth in the app layer (primary, free):** validate before writing — `getById('members', …)`
   and `getById('classes', …)`, reject on `gymId` mismatch. `createDoc` already centralises all
   creates, so one guard covers every caller.
2. **Structural denormalisation (recommended):** write `memberGymId` / `classGymId` onto the booking
   at creation, then enforce `request.resource.data.memberGymId == gymOf(request.auth.uid)` — no
   `get()`, no extra read, deterministic, auditable in the document itself.

Caveat: denormalised `memberGymId` could drift if a member were ever moved between gyms. `gymId` is
already frozen by SEC-H, so that drift is not currently reachable.

### Trainer booking parity — resolved, and the original finding was wrong

An earlier draft claimed `firestore.rules:263` (`isStaff()`) diverged from
`PERMISSIONS['classes.write']` (which excludes trainer). That was **incorrect**: `classes.write`
governs *class CRUD*, for which `firestore.rules:256` correctly matches. There is no `bookings.*`
permission key at all, and the booking UI is **not** gated:

| Location | Gated by `canWrite`? |
|---|---|
| `Classes.jsx:212-222` "Manage bookings" button | **No** — renders for every class card |
| `Classes.jsx:263` member `<Select>` | **No** |
| `Classes.jsx:271` Book button | **No** — `disabled={!selectedMember}` only |
| `handleAddBooking` (`:93-111`) | **No internal check** |
| `handleRemoveBooking` (`:113-120`) | **No internal check** |

So a trainer **can** book through the real UI, and `isStaff()` is **correct and necessary**.
Changing the rules alone would leave the button rendered and produce `PERMISSION_DENIED` on click.

**Decision taken (this phase): formalise current behaviour.** Keep `firestore.rules:262-264`
unchanged; add explicit `bookings.view` / `bookings.write` / `bookings.delete` permission keys
(trainer included) to `constants.js`; gate `Classes.jsx:212`, `:263`, `:271` on
`can('bookings.write')` and `handleRemoveBooking` (`:113`) on `can('bookings.delete')`. Zero
behaviour change; an unwritten decision becomes explicit and enforceable.

## 9. Audit Log

**Current.** Append-only and well protected: `allow update, delete: if false` (L271), reads limited
to `isFinance()` (L269), appends must carry the caller's `gymId` (L270). SEC-E confirms E2–E7 green.

**Confirmed production defect: 122 of 308 audit entries have no `gymId`.**

| | Count |
|---|---:|
| `auditLog` total | 308 |
| tagged with `gymId` | 186 (26 Crystal / 126 Gym management System / 34 Oxygen) |
| **untagged** | **122** |
| with `actor.role == 'system'` | 0 |
| with `action == 'backup'` | 0 |
| with `action == 'expiry-reminder'` | 0 |

Because `auditLog` reads through `canReadTenant`, those 122 untagged entries are readable by
**every** gym's owner/admin today — a confirmed cross-tenant exposure.

**They are legacy, not functional, and no client can ever fix them.** `auditLog` is deliberately
excluded from `TENANCY_COLLECTIONS` (`migration.js:86`) *and* has `allow update: if false` (L271).
Only an Admin SDK backfill can tag or quarantine them.

**Function-generated entries are a latent second instance.** `functions/index.js:56` (`dailyBackup`)
and `:97` (`membershipExpiryReminders`) use Admin `add()` with no `gymId`. The expiry-reminder
entry carries `entityId` plus `details.name`, i.e. a named member's expiry date. The function
iterates **all** members across all gyms (`:86`) and has `member.gymId` in hand but does not use it,
and writes one entry per expiring member **per day** with no cleanup — unbounded accumulation of
globally-readable PII.

**Functions are not deployed** (0 function-generated entries; `cloudfunctions.googleapis.com`
returns 403 for this token, so this is inference from data, not direct confirmation). So this is a
latent defect, not a live one.

**Target model:**
1. Every audit entry carries `gymId`. System-wide entries get an explicit `gymId: null` **plus**
   `scope: 'system'`, so they are never indistinguishable from tenant data.
2. Tenant queries strictly by `gymId`; add the composite index when Functions are enabled
   (`auditLog` already has 2 index entries).
3. Function entries must be restructured before deployment: pass the gym explicitly
   (`member.gymId`) rather than relying on a rules-injected field the Admin SDK never applies.
4. Expiry reminders iterate per gym and stamp each entry with that member's `gymId`.
5. Clients must never be able to write another gym's `gymId` — already guaranteed by `canWriteTenant`.

## 10. Rule Robustness

**Why errors occur.** `role()` (L12-14) is `get(users/$(uid)).data.role` with **no `exists()` guard**.
For a ghost user the document is missing → dereferencing `.data.role` raises an evaluation error,
surfacing as `PERMISSION_DENIED`. Confirmed: **15 × `Service call error. Function: [get]`** in
`%TEMP%\opencode\phase05a-debug.log`.

`gymOf()` (L45-48) is the **one correctly null-safe helper** — it checks `exists(ref)` and
`'gymId' in get(ref).data` before dereferencing, with an explanatory comment at L39-44.

**The defect.** `sameGym()` (L64-68) is not null-safe:
`resource != null && resource.data.gymId == gymOf(request.auth.uid)`. When `gymId` is absent,
`resource.data.gymId` raises **`Property gymId is undefined on object`** — **189 occurrences**, at
L193:24 (`members` delete) and L236:24 (`payments` delete).

All 189 currently resolve to a denial, so nothing is exploitable today. But untagged deletes are
denied *by accident of error semantics*, not by an explicit rule — one engine change away from
different behaviour, and it produces misleading telemetry.

**Target behaviour — no exception-dependent denial:**

| State | Target |
|---|---|
| Unauthenticated | explicit `false` |
| Missing profile (ghost) | explicit `false` via `exists()` in `role()` |
| Profile missing `gymId` | explicit `false` via `gymOf() == null` |
| Document missing `gymId` | explicit `false` via `'gymId' in resource.data` |
| Malformed `role` | `false` via a role allowlist |

Concretely: make `role()` return a sentinel (`exists(ref) ? get(ref).data.role : null`) and add a
`'gymId' in resource.data` shape test mirroring what `legacy()` already does correctly.

## 11. Storage

**`storage.rules` (23 lines, verbatim):**

```
match /memberPhotos/{memberId} { allow read: if request.auth != null; allow write: if request.auth != null; }
match /logos/{name}           { allow read: if true;  allow write: if request.auth != null; }
match /backups/{allPaths=**}  { allow read, write: if false; }
```

**Critical: these rules have never been deployed.** There is no `firebase.storage` release in
production (404 from the Rules API). With no deployed Storage rules, client SDK access to the
bucket is denied, which means **member photo upload and gym logo upload almost certainly do not
work in production today**. Deploying these rules is a *first-time* rollout, not an update, and
must be verified as its own change.

**Path model.** Neither path is gym-scoped: `memberPhotoPath = memberPhotos/${memberId}` and
`logoPath = logos/${name}` (`src/services/storage.js:20-21`), where `name` is
`logo-${Date.now()}.${ext}` (`Settings.jsx:146`).

**Concrete gaps:**
- Any authenticated user of any gym can read **and overwrite** any other gym's member photos.
- Logos are world-readable (`allow read: if true`).
- Logo names are timestamp-based → collision risk; `deleteFile` (`storage.js:15`) is **never called**
  from any production file, so every re-upload orphans an object.
- The logo extension comes from `file.name.split('.').pop()` — user-controlled, no allowlist — and is
  stored as a download URL in `settings/app.logoUrl`.
- **No size limit, no MIME restriction, no compression.** `package.json` has no image library; no
  canvas/resize helper exists in `src/`.

**Feature status.** Member photos are live and reachable (`Members.jsx:316`, `Dashboard.jsx:423`,
printed `MembershipCard`). Gym logo upload is live and owner-gated (`Settings.jsx:137-155`,
`RoleGuard roles={['owner']}`). Neither uses `capture`; there is no camera capture or gallery
multi-select.

**Target architecture (design):**
```
gyms/{gymId}/media/members/{memberId}/{fileId}   member photos
gyms/{gymId}/branding/logo.{ext}                 gym logo (fixed name — no orphans)
gyms/{gymId}/receipts/{receiptNo}.{ext}          future
```

| Concern | Target |
|---|---|
| Read | Own-gym staff |
| Upload | The relevant `*.write` role (`members.write` for photos, `settings.write` for logo) — trainer excluded |
| Delete | Owner/admin, cascading with entity deletion |
| Size | ≤ 5 MB pre-upload **and** server-side |
| MIME | `image/jpeg` / `image/png` / `image/webp`; reject SVG (XSS) |
| Compression | Client-side resize to ≤ 1600 px + WebP before upload (today: none) |
| Naming | Fixed per-entity path so re-upload overwrites instead of orphaning |

## 12. Production Data / Backup Dependencies

### 12.1 Deployed rules — RESOLVED

| Item | Value |
|---|---|
| Firestore ruleset | `e9a2306d-90c3-49f8-9c9e-935d9f8a906d` |
| Released | 2026-08-08, last updated 2026-09-01 |
| Comparison vs `firestore.rules` | **Byte-identical** — 12,663 chars, 0 differing characters, 284/284 lines identical |
| Storage rules | **No `firebase.storage` release exists** — never deployed |

Consequences: every finding in §3–§10 applies to production verbatim, and the J1/J5
classification in §4 is confirmed against the rules actually serving production.

Method: the deployed ruleset was fetched read-only via
`firebaserules.googleapis.com/v1/projects/himalye-wonders-gym/releases/cloud.firestore` then the
`rulesets/{id}` resource. (`firestore:rules:get` is not a Firebase CLI command, and the default
release ID is `cloud.firestore`, not `firestore:rules`.)

### 12.2 Production inventory — RESOLVED (count-only, no document contents)

541 documents across 14 collections. Verified via `documents:runAggregationQuery` with
`structuredAggregationQuery`, `EQUAL` validated against known-good and known-impossible values.

| Collection | Total | Tagged | Untagged |
|---|---:|---:|---:|
| `gyms` | 5 | 0 | 5 (expected — tenancy root) |
| `users` | 3 | 3 | 0 |
| `members` | 38 | 38 | **0** |
| `membershipPlans` | 20 | 20 | 0 |
| `memberships` | 51 | 51 | 0 |
| `payments` | 72 | 72 | 0 |
| `expenses` | 7 | 7 | 0 |
| `attendance` | 15 | 15 | 0 |
| `classes` | 1 | 1 | 0 |
| `trainers` | 1 | 1 | 0 |
| `weightRecords` | 15 | 15 | 0 |
| `bookings` | — | — | **collection does not exist** |
| `counters` | 4 | 3 | **1** |
| `settings` | 1 | 0 | 1 (expected — global singleton) |
| **`auditLog`** | **308** | 186 | **122** |

`members`: 37 of 38 have `status == 'active'`. All 3 users have `role == 'owner'`.

### 12.3 Data distribution — RC-7 did not mis-assign

| | Crystal gym `ZqbgLBz` | Gym management System `a2GlN7E` | Oxygen Kandhla `wqXDyKM` | 2 orphans |
|---|---:|---:|---:|---:|
| `users` | 1 | 1 | 1 | 0 |
| `members` | 3 | **27** | 8 | 0 |
| `membershipPlans` | 4 | 4 | 12 | 0 |
| `memberships` | 3 | 41 | 7 | 0 |
| `payments` | 4 | 60 | 8 | 0 |
| `expenses` | 1 | 6 | 0 | 0 |
| `attendance` | 0 | 15 | 0 | 0 |
| `classes` | 0 | 1 | 0 | 0 |
| `trainers` | 0 | 1 | 0 | 0 |
| `weightRecords` | 3 | 12 | 0 | 0 |
| `counters` | 1 | 1 | 1 | 0 |
| `auditLog` | 26 | 126 | 34 | 0 |
| **TOTAL** | **46** | **295** | **71** | **0** |

Every column reconciles exactly to §12.2 (3+27+8=38 members, 4+60+8=72 payments, 26+126+34=186
tagged audit). **Three genuinely separate gyms with distinct data.** RC-7's mass-claim mis-assigned
nothing.

### 12.4 New findings

1. **Two orphan `gyms` documents** — `RvJzaLXI6HRauKG7rR9W` ("Crystal gym") and
   `fQuLyXejHdb7S7XUco4y` ("Oxygen Gym Kandhla") have 0 users and 0 data, and their names
   **duplicate** the two live gyms. `provisionOwnerGym` (`onboarding.js:24`) never cleans up a gym
   whose owner never completes binding. The `gyms` rules prevent data access but not this clutter.
2. **122 untagged legacy audit entries** — confirmed live cross-tenant exposure, unfixable from the
   client (§9).
3. **1 untagged legacy counter** — 3 tagged (one per gym) plus 1 orphan, claimable via `legacy()`.
   A claimed counter could corrupt member numbering.
4. **There is no backup of anything.** Functions are not deployed, so `dailyBackup` has never run:
   no Firestore backup, no Storage backup. **541 documents of live business data across 3 operating
   gyms — 38 members, 72 payments — with zero backups.**

### 12.5 Dependency matrix

| Finding | Code-only or data | Inventory | Backup | Window | Deploy | Rollback |
|---|---|---|---|---|---|---|
| RC-1 role unconstrained | Code | No | No | No | **Yes** | Revert rules |
| RC-2 user delete | Code | No | No | No | **Yes** | Revert rules |
| RC-3 bind role | Code | No | No | No | **Yes** | Revert rules |
| RC-4 global settings | **Data + Code** | **Yes** | **Yes** | Low | **Yes** | Dual-read; keep `settings/app` read-only one release |
| RC-5 legacy claim | **Data + Code** | **Yes** | **Yes** | Low | **Yes** | Re-add `legacy()`; tagged docs unaffected |
| RC-6 booking referential | Code | No | No | No | **Yes** | Revert rules |
| RC-7 tenancy backfill | **Data** | **Yes** | **Yes** | **Yes** | No | Pre-migration tag snapshot |
| RC-9 counter seeding | Code | No | No | No | No | n/a |
| RC-10 members trainer | Code | No | No | No | **Yes** | Revert rules |
| Storage re-keying | **Data** | **Yes** | **Yes** | **Yes** | **Yes** | Keep old paths readable one release |
| Audit `gymId` (legacy 122) | **Data** | **Yes** | **Yes** | Low | No | Restore tagged snapshot |
| Storage rules first deploy | Code | No | No | No | **Yes** | Revert rules |

**Hard blockers before any data migration:**
1. A verified Firestore backup **and a rehearsed restore**. `dailyBackup` exists in code but has
   never run; its retention and restore path are unverified; it does not back up Storage.
2. An untagged-document inventory — **done** (§12.2).
3. A Storage inventory — **not done**; the bucket's deployed rules are unknown (none).
4. A pre-migration `gymId` tag snapshot for RC-7.

## 13. Phase 1 Remediation Plan

### TRACK A — pure rule/code safety (no data migration)

| # | Item | Pri | RC | Files | Target |
|---|---|---|---|---|---|
| A1 | Constrain `role` in `users` writes; allowlist; rank check | **P0** | RC-1 | `firestore.rules` | Role writable only by an in-gym owner, to an allowed value, never self-escalating |
| A2 | Last-owner + self-delete protection on `users` | **P0** | RC-2 | `firestore.rules` | No self-delete; never remove a gym's last owner |
| A3 | Remove `role` from `canBindGymId` | P1 | RC-3 | `firestore.rules` | Binding sets `gymId` only |
| A4 | Null-safe `role()` and `sameGym()` | P1 | §10 | `firestore.rules` | Clean `false`, no exception-dependent denial |
| A5 | Booking referential integrity via `memberGymId`/`classGymId` + app-layer guard | P1 | RC-6 | `firestore.rules`, `src/services/firestore.js`, `src/pages/Classes.jsx` | A booking cannot reference a foreign member/class |
| A6 | **Formalise** trainer booking permissions (no rules change) | P1 | §8 | `src/utils/constants.js`, `src/pages/Classes.jsx` | Authorization explicit and UI-consistent; behaviour unchanged |
| A7 | Members write role alignment | P1 | RC-10 | `firestore.rules` | `members` write matches `members.write` |
| A8 | Deploy `storage.rules` for the first time, with size/MIME limits | **P0** | §11 | `storage.rules`, new Storage tests | Interim tenant isolation while re-keying is pending |

### TRACK B — data / architecture migrations (need backup + inventory + rollback)

| # | Item | Pri | RC | Migration | Backup | Window | Rollback |
|---|---|---|---|---|---|---|---|
| B1 | **Remove `ensureGymTenancy()` from the client** | **P0** | RC-7 | Yes | **Yes** | **Yes** | Tag snapshot |
| B2 | Backfill or quarantine the 122 untagged audit entries (Admin SDK) | **P0** | §9 | Yes | **Yes** | Low | Restore snapshot |
| B3 | Remove `legacy()` from `canWriteTenant`'s update path | P1 | RC-5 | Yes | **Yes** | Low | Re-add `legacy()` |
| B4 | Backfill `memberGymId` / `classGymId` on bookings | P1 | RC-6 | Yes | **Yes** | Low | Revert rules |
| B5 | Migrate `settings/app` → `gyms/{gymId}/settings/app` | **P0** | RC-4 | Yes | **Yes** | Low | Dual-read one release |
| B6 | Restrict `settings/app` read to bound staff | **P0** | RC-4 | No | No | No | Revert rules |
| B7 | Write `gymId` + `scope:'system'` on function-generated audit entries | P1 | §9 | Yes | Yes | No | Revert Functions |
| B8 | Fix `ensureMemberNumberCounter` to use a gym-scoped member read | P1 | RC-9 | No | No | No | Revert code |
| B9 | Storage tenant re-keying to `gyms/{gymId}/...` | P2 | §11 | Yes | **Yes** | **Yes** | Old paths readable one release |
| B10 | Clean up 2 orphan `gyms` docs | P2 | §12.4 | Yes | Yes | No | Recreate |

**B3 must follow any backfill** — closing the claim path first would strand untagged documents.

### TRACK C — verification and data safety

| # | Item | Pri | Status |
|---|---|---|---|
| C1 | Verify deployed rules == repository | **P0** | ✅ **DONE** (§12.1) |
| C2 | Untagged-document inventory | **P0** | ✅ **DONE** (§12.2) |
| C3 | Per-gym distribution analysis | P0 | ✅ **DONE** (§12.3) |
| C4 | J1/J5 differential query-semantics experiment | **P0** | ✅ **DONE** (§4) |
| C5 | **Firestore backup + restore rehearsal** | **P0** | ❌ **OUTSTANDING — the last blocker** |
| C6 | Storage inventory (object count, bytes, path distribution) | P0 | ❌ Outstanding |
| C7 | Establish a read-only production verification account | P1 | ❌ Outstanding |
| C8 | Re-run the suite against an unpinned (newer) emulator | P1 | ❌ Outstanding |

### TRACK D — explicitly out of remediation scope
Member photo hardening (already live), camera capture, gallery multi-select, compression, leads,
expenses expansion, membership freeze, exports, reminders, QR attendance, member app, subscription.
Subscription is **not** implemented, message credits are **not** implemented, and "GymBook Pro" has
**no basis in the current source**.

## 14. Regression Test Plan

**Invariants that must hold at every step:**
- The original **56** emulator tests always pass. Non-negotiable.
- **No test is deleted, skipped, or weakened to go green.** Reclassification requires an annotation.
- Every one of the 51 failures ends as exactly one of: **green**, **annotated** (emulator artifact),
  or **recorded observation** (approved ambiguity).
- Matrix invariants unchanged: 84 `members` + 48 `payments` cells.

**There are two suites, not one.** `npm test` runs the Vitest unit suite in `src/tests/` (23 files);
`npm run test:rules` runs the 463-test emulator suite. Phase 1 edits `migration.js`, `firestore.js`,
`SettingsContext.jsx`, `constants.js` and `Classes.jsx` — all covered by the unit suite, which must
stay green too.

| After step | Newly green | Expected failures |
|---|---|---:|
| A1 | A1, A1b, A2, A3, A11 | 46 |
| A2 | A12, A12b | 44 |
| A3 | B3 | 43 |
| A5 | F13 | 42 |
| A7 | SEC-I × 6 | 36 |
| B6 | C2, C11, G8 × 2 | 33 |
| B5 | C6/C7, C8, C8b, C12, C13 | 28 |
| B3 | D3/D4 × 10, D7/D8, F11, K8 | 15 |
| §4 annotations | J1 × 11, J5, F9, E8 | **0** |

**Final target: 463 emulator tests, 463 passing**, with 14 annotated as emulator divergence and 34
recorded as approved-ambiguity observations — not 51 silent greens.

**Deliberate expectation changes (annotation, never deletion):**
- `tenancyMigration.test.js:86-99` asserts `tagged === 2` with untagged records claimed by the caller.
  **This encodes RC-7 as correct and must be rewritten** when B1 lands.
- `tenancyMigration.test.js:122-136` seeds the counter from a store containing only `gym-1` members,
  so it is blind to cross-gym seeding; its comment *"seeding is scoped to the bound gym id"* is true
  of the document id and `gymId` field but **false of the seeded value**. Needs a cross-gym case (B8).

**New tests required:**
1. RC-7/B1 — `ensureGymTenancy` must never claim a document outside its own gym, and must not run
   from the client at all.
2. RC-9/B8 — counter seeding must use a gym-scoped member read; no cross-gym high-water mark.
3. B2 — every audit entry carries `gymId` or an explicit `scope: 'system'`.
4. RC-6/A5 — a booking cannot reference a foreign member/class; a missing member doc is handled.
5. Storage (A8/B9) — gym-scoped read/write, size limit, MIME allowlist.
6. §10/A4 — missing profile, missing `gymId`, and malformed `role` all yield clean `false` with
   **no** evaluation error.
7. Split the composite tests: F9 → three separate tests (J5 already split).
8. §6/B6 — a denied `settings` read must surface an error, not silently revert to defaults.

## 15. Risks / Unknowns

| # | Risk / unknown | Status |
|---|---|---|
| U1 | Emulator list-rule divergence | ✅ Resolved — EMULATOR-ONLY, §4 |
| U2 | Deployed rules differ from repository | ✅ Resolved — byte-identical, §12.1 |
| U3 | Functions deployed and writing untagged PII | ✅ Resolved — **not deployed** (inferred from 0 function-generated entries; API returns 403 for direct check) |
| U4 | Production untagged-document count | ✅ Resolved — 122 auditLog + 1 counters; 0 business data, §12.2 |
| U5 | Production Storage contents | ❌ Unknown — no deployed rules, no inventory |
| U6 | `ensureGymTenancy` already run / mis-assigned data | ✅ Resolved — already run, **mis-assigned nothing**, §12.3 |
| U7 | Role escalation already occurred in production | ✅ Low risk — all 3 users are `owner`, bound to distinct gyms |
| U8 | Trainer booking parity | ✅ Resolved — app permits it; rules correct; formalise only (§8) |
| U9 | Login-screen branding depends on unauthenticated read | ✅ Resolved — drop gym branding from login (§6) |
| U10 | `dailyBackup` retention / restore | ✅ Resolved — never ran; **no backups exist** |
| U11 | Emulator pinned to 1.19.8; newer versions may differ | ❌ Untested (C8) |
| U12 | `receiptPrefix` / `gymName` persisted on historical `payments` | ✅ Constraint recorded — snapshots must not be re-derived |
| U13 | 2 orphan `gyms` documents with duplicate names | ❌ Open (B10) |
| U14 | No Storage rules deployed → photo/logo features likely non-functional in production | ❌ Open (A8) |

**No hidden assumptions.** Where evidence is missing it is marked UNKNOWN rather than inferred.

## 16. Recommended Implementation Order

Two evidence-driven changes to the originally proposed order:
1. **Production verification moved to the front.** Rule verification (C1) gates everything — every
   finding assumes the deployed rules match. The untagged inventory (C2) and distribution analysis
   (C3) gate all of Track B.
2. **Backup + restore rehearsal (C5) moved to the front.** It originally sat immediately before
   "data migration", which is too late: RC-7 is a P0 data-destruction risk and B1/B3/B5/B9 all need
   a proven restore *before* they run.

| Step | Action | Track | Gate |
|---|---|---|---|
| 1 | Establish a verified backup **and a rehearsed restore** (C5) | C | **Blocks all Track B** |
| 2 | Storage inventory (C6) | C | Sizes A8/B9 |
| 3 | Role escalation protection (A1) | A | — |
| 4 | Owner profile deletion protection (A2) | A | — |
| 5 | Onboarding role binding protection (A3) | A | — |
| 6 | Null-safe rule helpers (A4) | A | — |
| 7 | Members write role alignment (A7) | A | — |
| 8 | Booking member/gym referential integrity (A5) | A | — |
| 9 | **Deploy `storage.rules` first time** (A8) | A | Requires step 2 |
| 10 | Drop gym branding from login + **restrict `settings/app` read** (B6) | A/B | Closes RC-4 read hole with **no migration** |
| 11 | Formalise trainer booking permissions (A6) | A | No behaviour change |
| 12 | **Remove `ensureGymTenancy()` from the client** (B1) | B | Must precede any backfill |
| 13 | Fix counter seeding to a gym-scoped read (B8) | B | — |
| 14 | Admin SDK backfill: 122 audit entries + quarantine; write `tenancy/migrationState` (B2) | B | Needs 1, 12 |
| 15 | Close client legacy claiming (B3) | B | Must follow 14 |
| 16 | Migrate `settings/app` → `gyms/{gymId}/settings/app` (B5) | B | Needs 1, 10 |
| 17 | Backfill booking `memberGymId`/`classGymId` (B4) | B | Needs 1 |
| 18 | Function audit `gymId` + `scope` (B7) | B | Needed before Functions deploy |
| 19 | Storage tenant re-keying (B9) | B | Needs 1, 2, 9 |
| 20 | Clean up 2 orphan gyms (B10) | B | Needs 1 |
| 21 | Re-run suites; annotate J1/J5/F9/E8; final rules verification (C7, C8) | C | — |

**Why step 10 ships early:** RC-4 is a P0 — any signed-in user reads every tenant's branding,
receipts and currency. B6 closes the read hole with a rules-only change and **no migration**,
delivering most of the security value immediately while the full data migration waits on step 1.

**Why step 12 precedes everything data-related:** until the client-side mass-claim path is removed,
a single owner click can mis-assign the entire database.

## 17. Explicitly NOT DONE

- ❌ `firestore.rules` — **not modified**
- ❌ `storage.rules` — **not modified**
- ❌ Application source (`src/`) — **not modified**
- ❌ `functions/` — **not modified**
- ❌ `firestore.indexes.json`, `firebase.json`, `package.json`, `vitest.emulator.js` — **not modified**
- ❌ `tests.emulator/firestoreRulesEmulator.test.js` — **byte-identical to HEAD**
- ❌ **No production write of any kind.** No document created, updated or deleted; no user, settings
  or Storage object touched; no rules or Functions deployed; no migration run
- ❌ `ensureGymTenancy` / `ensureOriginPeriods` — **not run**
- ❌ No backup created (creating one is a production write and was not authorised)
- ❌ No product feature implemented
- ❌ No test deleted, skipped, or weakened

**Production reads that *were* performed** (read-only, for verification):
- Deployed ruleset fetch via the Firebase Rules REST API.
- Count aggregations via `documents:runAggregationQuery` (`count` only, no document bodies).
- Three narrow field-masked reads: `users.gymId`, `gyms.name`, plus the gym document names.
- `projects:list` and `functions:list` via the CLI.

No member names, emails, phone numbers, payment amounts, or document contents were retrieved.
The Firebase CLI access token was refreshed locally (an expired local credential, not a project change).

**One temporary probe** (`tests.emulator/zz-scratch-probe.test.js`) was created during Phase 0.5A to
gather J1/J5 evidence, executed, and immediately deleted. It is not in the repository.

## 18. FINAL DECISION

# NOT READY — VERIFICATION / DATA SAFETY WORK REMAINS

**Scope of this statement.** Verification is *not* the reason. This phase was originally blocked on
four items; three are now resolved:

| Original blocker | Status |
|---|---|
| Deployed rules unverified (U2) | ✅ Resolved — byte-identical (§12.1) |
| J1/J5 unresolved (U1) | ✅ Resolved — EMULATOR-ONLY (§4) |
| Untagged data unknown (U6) | ✅ Resolved — migration already ran, mis-assigned nothing (§12.3) |
| **No verified backup or restore** | ❌ **OPEN — the sole remaining blocker** |

**One reason remains.** 541 documents of live business data across three operating gyms — 38 members,
72 payments, 3 real gyms — have **no backup of any kind**. `dailyBackup` exists in source but the
Functions are not deployed, so it has never run; there is no Firestore backup and no Storage backup.
Any Track B step would touch this data with no way back.

**What is now ready:**
- Evidence frozen on `security-audit/phase-0.5a-evidence` (`c47532b`).
- All 51 failures attributed to 8 root causes; the 14 query-semantics failures identified as an
  emulator artifact rather than a production vulnerability.
- Every finding confirmed against byte-identical production rules.
- Production data state known and clean of mis-assignment.
- Four production findings that no emulator test could surface: 122 untagged legacy audit entries
  readable by all three gyms; 1 claimable legacy counter; 2 orphan gym documents; and `storage.rules`
  never deployed at all.
- Phase 1 design complete, with per-step files, gates, backup needs, rollback plans and regression
  expectations.

**Next actions, in order:**
1. Create a verified backup and **rehearse a restore** (C5).
2. Deploy `storage.rules` for the first time (A8) — currently the photo and logo features are almost
   certainly non-functional in production.
3. Begin code-only remediation, which needs no backup: **A1 (role escalation) first** — P0, zero
   product cost, safe to deploy in isolation.
4. Admin SDK backfill of the 122 untagged audit entries (B2), which no client can ever fix.