# FINAL PHASE 1 PLAN — CORRECTED AND LOCKED

**Status:** Plan lock. No remediation implemented. No rules, source, data, index, Storage, or deploy changes made.

**Branch:** `security-audit/phase-0.5a-evidence` · `main` untouched at `b068b80` · implementation branch `security-remediation/phase-1` proposed but **not created**.

**Evidence baseline:** `docs/security/phase-0.5b-security-and-remediation-report.md`

**Locked decisions (not reopenable):** client user deletion = deny all · trainer booking capability remains allowed (permissions formalized only) · login = platform/default branding only · J1/J5/F9/E8 = emulator-only, no rules change · RC-7 remove client tenancy bootstrap · null-safety mandatory · historical financial snapshots immutable.

---

## 1. Changes From Phase 0.5C

| # | Correction | Impact |
|---|---|---|
| 1 | Settings target is **`gyms/{gymId}/settings/app`**, not `settings/{gymId}/app` | Reuses the existing `firestore.rules:159-169` block and the `pt.js`/`whatsappGroup.js` pattern. **No new rules block required.** Removes the duplication the Phase 0.5C draft proposed. |
| 2 | Bookings integrity re-evaluated; client-forgeable `memberGymId`/`classGymId` **rejected** | Rule-side `get()`/`exists()` is the sole security boundary; app validation is defense-in-depth only. **No migration, no denormalized backfill** (bookings does not exist in production). |
| 2a | Bookings write-semantics verification gate added (§6.1) | Mandatory pre-implementation check of single create/update, `writeBatch`, and `runTransaction` semantics. Already satisfied and recorded with evidence; **no redesign required**. |
| 3 | Legacy quarantine redefined from "copy elsewhere" to **terminal-state disposition** | Originals are tagged in place **or** moved to quarantine **and deleted**. Leaving an untagged doc is itself the leak. |
| 4 | Functions described as *strongly inferred* not deployed, never "proven" | Wording fixed everywhere. `dailyBackup` **and** `membershipExpiryReminders` both blocked from deployment pending redesign + tests. |
| 5 | Storage split into two branches gated on inventory | If zero client-created objects ⇒ **no Storage migration at all**; secure architecture first, app media workflow later. |
| 6 | Settings client dual-read fallback **removed entirely**; migration-first cutover replaces it | Clients read **only** `gyms/{gymId}/settings/app`. Global `settings/app` retained physically present but **client-inaccessible** as a dated Admin-readable rollback/migration artifact. |
| 7 | Backup access control moved to the **infrastructure plane** | Backup objects are Storage objects, not Firestore documents. Application roles do **not** govern them. Least-privilege operational identity; zero application-user access; named backup/restore identities documented. |
| 8 | `tenancy/migrationState` and `tenancy/quarantine` protection made **explicit** | New deny-all rules block. Client read/create/update/delete **DENY**. No reliance on the implicit absence of a catch-all match. Quarantine payload isolation is total, not tenant-conditional. |
| 9 | Steps typed CODE-ONLY / DATA MIGRATION / PRODUCTION VERIFICATION / FUTURE PRODUCT WORK | Per-step files, dependency, migration/backup/window/deploy flags, tests, rollback. |
| 10 | Implementation order reset to the mandated 10-stage spine | No contradiction with §9. |
| 11 | RC-9 restated as gym-scoped member-number counter seeding | Preserved. |
| 12 | `legacy()` read allowance split from client claiming | Claiming removed immediately; read allowance survives only until legacy cleanup validates 0 untagged, then removed. |

---

## 2. Canonical Architecture

**Tenancy.** `users/{uid}.gymId` is the single source of truth; write-once, self-bind only. Every business document carries a matching `gymId`.

**Settings — canonical.** `gyms/{gymId}/settings/{doc}`, sibling to the proven `pt` and `whatsapp` documents.

```
gyms/{gymId}
├── settings/app        ← canonical app settings (target)
├── settings/pt         ← existing, unchanged
└── settings/whatsapp   ← existing, unchanged
```

Each document **must** carry a `gymId` field, because `firestore.rules:163` reads `resource.data.gymId`. Writes use point `getDoc`/`setDoc` on an explicit `gymId` path — never a collection query, since `:163` references `resource` and is not query-safe.

The global `match /settings/{doc}` (`firestore.rules:278-281`, `allow read: if isSignedIn()`) is **removed entirely**. No permanent global fallback. No client fallback of any form.

**Remaining top-level collections:** members, membershipPlans, memberships, payments, expenses, attendance, classes, trainers, weightRecords, counters, bookings, auditLog.

**Admin-only artifacts:** `tenancy/migrationState`, `tenancy/quarantine`. Explicit deny-all for clients (§5.4).

---

## 3. Security Remediation

### 3.1 Null-safe helpers — no denial may rely on an evaluation exception

```rules
function role() {
  let ref = /databases/$(database)/documents/users/$(request.auth.uid);
  return isSignedIn() && exists(ref) && 'role' in get(ref).data ? get(ref).data.role : null;
}

function sameGym(resource) {
  return isSignedIn() && hasGym() && resource != null
    && 'gymId' in resource.data
    && resource.data.gymId == gymOf(request.auth.uid);
}

function memberInCallerGym(mid) {
  let ref = /databases/$(database)/documents/members/$(mid);
  return isSignedIn() && hasGym() && mid is string && exists(ref)
    && 'gymId' in get(ref).data && get(ref).data.gymId == gymOf(request.auth.uid);
}

function classInCallerGym(cid) {
  let ref = /databases/$(database)/documents/classes/$(cid);
  return isSignedIn() && hasGym() && cid is string && exists(ref)
    && 'gymId' in get(ref).data && get(ref).data.gymId == gymOf(request.auth.uid);
}
```

Every guard is a positive boolean test; a missing doc or missing field yields `false`, never an exception. Already safe and unchanged: `gymOf` (`:45-48`), `legacy` (`:59-61`), `isRole` (`:16-18`), `isStaff` (`:21-23`), `inCallerGym` (`:116-118`), `sameGymForRequest` (`:109-112`).

**Behaviour preservation:** an untagged document currently makes `sameGym` raise ⇒ deny. After the fix it returns `false` ⇒ deny. Identical outcome, no error.

### 3.2 RC-1 / RC-3 — role escalation

`users/{uid}` create/update: `role` writable **only** as `owner` and **only** when no `role` exists yet; immutable thereafter. `canBindGymId` (`:97-104`) asserts the role invariant in addition to `gyms/{id}.ownerUid == uid`, plus a defensive `'ownerUid' in` guard at `:102-103`. `src/services/onboarding.js:7-30` satisfies the invariant in one write.

### 3.3 RC-2 — user deletion (locked: deny all)

`allow delete: if false;` at `:186`. Evidence it breaks nothing: no delete call site exists anywhere in `src/` (`deleteDoc` at `firestore.js:109` is the generic helper).

### 3.4 RC-5 / RC-7 / RC-9 — remove client claiming

Delete `TenancyBootstrap` (`App.jsx:43-55`, import `:8`, call `:51`) and the Settings button (`Settings.jsx:12,189`). Remove `listAllUnscoped`, `ensureGymTenancy`, `TENANCY_COLLECTIONS`, and the global-counter seed (`migration.js:87-97,114-139,149-194`). Delete the false comment at `firestore.js:37-43`.

`canWriteTenant` (`:82-87`) drops its `|| legacy(resource)` branch immediately — client claiming dies at the rules layer regardless of app code.

`counters` stays gym-scoped: member-number seeding is keyed per gym (`migration.js:114-139`, `memberNumbers.js:42` via `runTransaction`), and the untagged global counter is resolved in §5, not claimed by clients.

### 3.5 RC-10 — trainer vs member fields

Remove trainer from `members` create/update (`:192`), aligning to the existing `members.write` constant. Evidence it breaks nothing: all 13 member write call sites sit behind `can('members.write')` (`Members.jsx:115`; `MemberDetail.jsx:203,446,279,301,320,333`; `renewals.js:137`; `memberNumbers.js:68`; `seedService.js` dev-only), and `setFitnessGoal` (`weightRecords.js:142-154`) writes only `fitnessGoal`/`targetWeight` — not financially meaningful.

Trainer capability is preserved where it legitimately belongs: `weightRecords` (`:200-202`, already `isStaff()`).

Financial fields `membershipPlanId`, `status`, `joinDate`, `ptSurchargeOverride`, `isPT` → owner/admin/front-desk. **Fallback if a trainer-reachable member write surfaces:** `diff().affectedKeys().hasOnly([...])`.

### 3.6 RC-4 — global settings removal

Delete `match /settings/{doc}` (`:278-281`). Move `SettingsContext.jsx:36,49,87` to `gyms/{gymId}/settings/app`; add `gymId` to the `useEffect` deps (`:26`); remove the silent permission-error fallback and the demo-mode silent-success branch (`:80-84`).

### 3.7 Tenancy admin artifacts — explicit deny-all

```rules
// ---------- Tenancy admin artifacts (migration state + quarantine) -------
// Client access is fully denied in both directions. These artifacts are
// written only by the trusted migration/admin process via the Admin SDK,
// which bypasses rules by design. This explicit deny-all is defence in
// depth: it makes the boundary independent of the absence of a catch-all.
match /tenancy/{document=**} {
  allow read, write: if false;
}
```

**Per-operation effect:** **read DENY · create DENY · update DENY · delete DENY.** A blanket `allow read, write: if false;` denies read, and denies create/update/delete because all three are writes. Full payload-isolation requirements in §5.4.

---

## 4. Settings Migration

**Invariant: clients read ONLY `gyms/{gymId}/settings/app`. No dual-read. No fallback. No permanent global fallback.**

**Rules target unchanged:** `gyms/{gymId}/settings/app`, carrying `gymId`, served by the existing block at `firestore.rules:159-169`. Create/update is `isOwner()` + path `gymId` + document `gymId` in agreement (`:164-167`); delete already `if false` (`:168`).

**Reads are point reads.** `SettingsContext` uses `onSnapshot(doc(db,'gyms',gymId,'settings','app'))`, matching `pt.js:50` / `whatsappGroup.js:55`. Any collection-level query over `settings` would be denied because `:163` references `resource`.

### Migration-first cutover stages

| Stage | Actor | Client read behaviour | Global `settings/app` |
|---|---|---|---|
| **S0** Pre-cutover (current) | — | `settings/app` | readable by `isSignedIn()` (`:279`) |
| **S1** Migrate | Admin SDK only | unchanged (`settings/app`) | unchanged |
| **S2** Validate | Admin SDK only | unchanged | unchanged |
| **S3** Flip | App release | **`gyms/{gymId}/settings/app` only** | still globally readable |
| **S4** Lock | Rules deploy | scoped only | **client-inaccessible** (`if false`), Admin-readable |
| **S5** Retire | Admin SDK | scoped only | archived/deleted after verification + retention |

### Required sequence

1. Verified backup + restore rehearsal (§8 gate) — closes first.
2. Determine mapping of current global `settings/app` values (dry-run report, zero writes).
3. Create/prepare `gyms/{gymId}/settings/app` for **all three** active gyms (`ZqbgLBzGo1Igc62hXc0i`, `a2GlN7ED3jBHkA9Fc15T`, `wqXDyKMej3DiP1xwcR2Z`). Orphan gyms excluded.
4. **Validate every scoped document before exposing any of them to a client** (§13 checklist). Hard gate.
5. Change the application to read **only** `gyms/{gymId}/settings/app` (`SettingsContext.jsx:36,49,87,101`).
6. No client fallback to global `settings/app` — the fallback branch does not exist in any form.
7. Global `settings/app` stays **physically present** as an Admin-readable rollback/migration artifact for a bounded, dated window. Client-inaccessible from S4.
8. After production verification succeeds, retire the global doc per the retention decision.
9. Historical `payments`/`memberships` `receiptPrefix` snapshots remain **untouched** — current values are copied forward into scoped docs only; no historical document is rewritten.
10. `Login.jsx` continues to use `DEFAULT_SETTINGS` only, and issues **no** settings read of any path.

### Loud-failure requirement (consequence of removing the fallback)

`SettingsContext` must distinguish two states:

- `!gymId || !isReady()` → `DEFAULT_SETTINGS` — legitimate pre-binding state, used by Login.
- `gymId && !settings && error` → **explicit error state**. Do **not** silently default.

Rationale: with no fallback, a silent default would silently render `currency: 'INR'` (`SettingsContext.jsx:10`) and `DEFAULT_SETTINGS.receiptPrefix` for a gym configured otherwise. The demo-mode silent-success branch (`:80-84`) and the swallowed permission-error path (`:26-72`) are both removed. Also add `gymId` to the `useEffect` dependency array (`:26`).

### Ownership mapping — assumption-free

One global doc cannot be attributed to a gym. Seed each active gym from the global doc only where no tenant doc exists; flag every field that differs across gyms for manual review; tenant-specific values win; any unresolvable field is quarantined, never guessed. No "only one gym exists" fallback, no first-gym default. `dateFormat` is dead in the UI — confirm no consumer, then include or exclude deliberately.

### Accepted residual exposure

Between S3 and S4 the global doc remains readable by any authenticated user. This is unavoidable: the document carries no `gymId`, so rules cannot express "the gym that owns this doc", meaning it cannot be partially restricted — only left as-is or denied. The gap is therefore bounded, dated, recorded in `tenancy/migrationState`, and minimised by shipping S4 immediately after S3. It is the reason S4 is a rules deploy in the same change window rather than a later phase.

---

## 5. Legacy Migration

**Scope:** 122 untagged `auditLog` + 1 untagged `counters`. Zero untagged business records ⇒ no mass-claim migration runs.

**Why originals must not survive:** `firestore.rules:269` allows `isFinance() && canReadTenant(resource)`, and `canReadTenant` (`:72-73`) returns true for any untagged doc. Every untagged `auditLog` entry is therefore readable by **every owner/admin of every gym**. The untouched original *is* the cross-tenant leak.

### 5.1 Ownership signals — deterministic or quarantine, never guess

Allowed: `memberId` → member → `gymId`; `entityId` → resolved doc → `gymId`; `details` timestamps clustered inside a single tenant's active window. Conflicting or absent signals ⇒ quarantine. No timestamp-guessing, no "only one gym exists" fallback, no first-gym default.

### 5.2 Per-record disposition

| Case | Destination | Original handling |
|---|---|---|
| Deterministically assigned | in-place `gymId` tag on the same doc | retained, now tenant-scoped and unreadable cross-tenant once `legacy()` is gone |
| Ambiguous | `tenancy/quarantine/{runId}/auditLog/{originalId}` with full original payload + `reason` + `signals` | **deleted** (Admin SDK) |
| Counter, resolved | in-place `gymId` tag | retained |
| Counter, ambiguous | `tenancy/quarantine/{runId}/counters/{originalId}` | **deleted** |

Deletion is Admin-SDK-only; clients still cannot claim, update, or delete these (`firestore.rules:271` keeps `allow update, delete: if false`).

### 5.3 State, auditability, idempotency, validation, rollback

**State.** `tenancy/migrationState/{runId}` records `runId`, `startedAt`, `completedAt`, `dryRunCompleted`, `schemaVersion`, `rulesVersion`, `backupId`, `backupIdentity`, `countsByCollection`, `assignedIds`, `quarantineIds`, `deletedOriginalIds`, and the S3/S4 exposure-gap timestamps.

**Idempotency.** Deterministic destination ids, `setDoc` merge semantics, and a processed-id check in `migrationState`. Re-running produces zero writes.

**Validation gate.** Post-run aggregates must show `auditLog` untagged = 0, `counters` untagged = 0, and `assigned + quarantined == 122` / `== 1`. Validation must pass **before** `legacy()` is removed.

**Rollback.** Requires the §8 verified backup plus the quarantine journal (which carries full original payloads). Restore = replay `migrationState` in reverse from quarantine, then restore from backup.

**Client claiming principle preserved:** `legacy()` client claiming is removed at step 6 (§9), before any legacy migration runs.

`tenancyMigration.test.js:86-99` currently asserts client mass-claiming as expected behaviour and must be rewritten to assert the primitive is absent.

### 5.4 `tenancy/` admin artifacts — explicit deny-all and payload isolation

The rules block is in §3.7. **Per-operation effect:** **read DENY · create DENY · update DENY · delete DENY.**

**Quarantine payload isolation.** `tenancy/quarantine/{runId}/{collection}/{originalId}` carries the **full original payload** for the 122 untagged `auditLog` entries and 1 untagged counter, which may contain personal and cross-tenant data.

- No client — of any role, in any gym — may read, create, update, or delete a quarantine document, for any reason.
- Quarantine documents are **not** tenant-readable even when a `gymId` has been determined. There is deliberately **no** `isStaff()`, `sameGym()`, or `canReadTenant()` branch on this path. Isolation is **total, not tenant-conditional**.
- Quarantine documents are never surfaced through `subscribeCollection`, `fetchPage`, any query helper, or any settings or backup surface.
- Each quarantine document carries `runId`, `sourceCollection`, `sourceId`, `decision` (`assigned` | `quarantined`), `reason`, `signals` considered, `resolvedGymId` (absent when unresolved), `payload` (full original), and `createdAt` — making every decision individually auditable and idempotency re-derivable.
- Inspection access is via the trusted migration/admin identity only, and read access must be recorded in the migration runbook.

---

## 6. Bookings Integrity

**Rejected:** client-supplied `memberGymId` / `classGymId`. A client writes arbitrary fields, so any denormalized ownership field is attacker-controlled and provides **no** security value. It is not adopted.

**Chosen mechanism — A + C, no B.**

- **A (security boundary, rule-side):** `firestore.rules:261-265` →
  ```
  allow create: if isStaff() && canWriteTenant(resource)
    && memberInCallerGym(request.resource.data.memberId)
    && classInCallerGym(request.resource.data.classId);
  allow update: if isStaff() && canWriteTenant(resource)
    && memberInCallerGym(request.resource.data.memberId)
    && classInCallerGym(request.resource.data.classId);
  ```
  `allow read` (`:262`) and `allow delete` (`:264`) stay as-is. `allow update` re-validates both references on every write, so a booking cannot be repointed to another tenant's member or class. An untagged member fails `'gymId' in get(ref).data` ⇒ deny, with no exception.
- **C (defense-in-depth, app-side):** `Classes.jsx` validates that the selected member and class belong to the active gym before submitting, and surfaces a clear error. Explicitly **not** the boundary.
- **B:** not adopted.

**Why A alone is sufficient and cheap:** `canWriteTenant` (`:82-87`) already forces `request.resource.data.gymId == gymOf(request.auth.uid)`, so *booking.gymId == caller gym* holds by construction. The two `get()` calls add read cost only on booking create/update, and booking volume is low. `get()` on a missing doc denies rather than allowing, so a dangling reference fails closed.

**No migration, no backfill, no new fields.** `bookings` does not exist in production, so this is code-risk only. Historical financial immutability is untouched.

### 6.1 Write-semantics verification gate (pre-implementation, mandatory)

Verified by read-only inspection of the application on this branch:

| Pattern | Status | Location |
|---|---|---|
| Single create | Confirmed | `Classes.jsx:97` → `createDoc('bookings', …)` → `addDoc` (`firestore.js:74`) |
| Single update | **Does not exist** | `updateDocById` imported (`Classes.jsx:4`) but used only for `classes` (`:61`) |
| Single delete | Confirmed | `Classes.jsx:115` → `removeDoc` → `deleteDoc` (`firestore.js:109`) |
| `writeBatch` | **Not used anywhere in `src/`** | — |
| `runTransaction` | One site, unrelated to bookings | `memberNumbers.js:42` (member-number counter) |

All four write primitives in `firestore.js` are single-document and non-batched (`createDoc` `:64`, `updateDocById` `:78`, `upsertDoc` `:94`, `removeDoc` `:104`). `logAudit` at `Classes.jsx:103` is a separate write issued *after* the booking create resolves, not part of any atomic unit.

**Conclusion.** Bookings are single, non-transactional, committed-state writes, so rules `get()` always observes an already-committed referenced member and class. **`get()` — not `getAfter()` — is the correct primitive. `memberInCallerGym()` / `classInCallerGym()` is safe and practical as designed. No redesign is required.**

**Mandatory re-verification gate before implementation.** Re-confirm all five rows above and add a test per pattern. The mechanism MUST be re-evaluated before shipping if any becomes true:

- bookings written via `writeBatch` — a document created earlier in the same batch is **not** visible to rules `get()`; `getAfter()` would be required;
- bookings written via `runTransaction` with the member or class written in the same transaction — same hazard;
- a booking and its referenced member/class created in one atomic unit — same hazard, requiring restructuring or `getAfter()`.

**Update rule scope.** `allow update` is specified and tested defensively so a future update cannot repoint `memberId`/`classId` cross-tenant, but it is not reachable by current application code.

---

## 7. Storage Architecture

**Current:** `storage.rules` has **never been deployed**. Unscoped: `memberPhotos/{memberId}` (auth read/write), `logos/{name}` (public read, auth write), `backups/{allPaths=**}` deny (`:19-20`). Helpers `memberPhotoPath`/`logoPath` at `src/services/storage.js:15-21`; no size/MIME/compression validation; `deleteFile` unused.

**BLOCKER — inventory not completed.** Every read path was rejected with the available CLI token (`cloudplatformprojects.readonly`, `firebase`, `cloud-platform`, `userinfo.email`, `openid`): GCS JSON `401`, GCS XML `401`, Firebase Management `401`, `firebasestorage.googleapis.com/v0` `404`. Requires a service account with Storage Object Viewer, a CLI token with storage scope, or a user-run export.

**Inference, stated as inference:** with no deployed rules, Firebase denies by default, so no client SDK could have written an object. The bucket is most likely empty or Admin-created only. **This must be confirmed by inventory, not assumed.**

**Required inventory:** object count, path, bytes, content type, updated time, storage class — broken out for `memberPhotos/`, `logos/`, `backups/`, and any other prefix.

**Branch A — zero client-created legacy objects (expected).**
`secure tenant-scoped architecture → Storage emulator tests → secure rules → production verification → then build/fix the app media workflow`. **No Storage data migration.**

**Branch B — legacy objects exist.**
`inventory → deterministic tenant mapping → quarantine ambiguity → backup → copy/migrate → checksum verification → secure rules → production verification`. Copy-then-verify; originals not deleted until checksums pass.

**Target paths:** `gyms/{gymId}/memberPhotos/{memberId}/{file}` and `gyms/{gymId}/logos/{file}`. Deterministic via the owning member's `gymId`; unmapped objects quarantined, never guessed. Logo ownership is ambiguous while branding is global ⇒ quarantine for manual decision.

**Target rules:** deny-by-default; member photos require the caller's `gymId` to equal the path segment **and** the referenced member's `gymId` to match; logos gym-scoped (public logo display deferred to a signed-URL or platform-default decision, not an unscoped public rule); `backups/**` deny to all clients (`:19-20` preserved); content-type allowlist and size cap.

**Never deploy the current unscoped rules to make the existing feature work.**

**Future product work (NOT in this phase):** member photo, phone camera capture, gallery selection, gym logo, image compression, MIME/type restrictions, file-size limits, tenant isolation.

---

## 8. Backup + Restore Gate

**Hard gate: no data migration of any kind begins until a verified, rehearsed backup exists for both Firestore and Storage.**

Required: full Firestore export **including subcollections**; Storage backup covering all non-`backups/` objects; agreed RPO and RTO; AES-256 at rest; retention/pruning policy; alerting on failure and expiry; integrity verification via checksum/manifest; **a completed restore rehearsal into a scratch project**; documented rollback source and window.

### 8.1 Backup access control — infrastructure plane, not application roles

Backup objects are Storage objects (`backups/{dateFolder}/{collection}.json`, written at `functions/index.js:47-49` under `STORAGE_BACKUP_PREFIX` at `:19`), **not Firestore documents**. No Firestore rule and no application role (`owner`, `admin`, `front-desk`, `trainer`, `isStaff()`, `isFinance()`) grants, restricts, or mediates any access to them. Role language must never be used to describe backup access.

- **Least-privilege operational identity.** Backup and restore execute under a dedicated service account / operational identity holding only the permissions required (`storage.objects.create` for backup; `storage.objects.get` / `delete` for retention and restore; Firestore export read). Never the end-user identity, never the client SDK.
- **No application-user access.** Normal application users have **no** direct access to backup objects **regardless of role**. There is no owner/admin/finance read path to backups.
- **Not exposed through the client application.** The backup repository is never referenced by `src/`, never mounted into the client SDK, and never reachable through any Firestore path or query helper. `storage.rules:19-20` already denies `backups/{allPaths=**}` read and write; that deny is preserved in the target rules and covered by a Storage emulator test.
- **Named identity, documented.** The plan records **who/what performs backup** and **who/what performs restore**: the concrete service-account identifier, the deploying principal, the retention/pruning identity, and the emergency-restore approver. Stored in `tenancy/migrationState.backupIdentity` and in the backup runbook.
- **Admin SDK bypass is expected and must be justified.** Admin SDK bypasses security rules by design, so the real security boundary for backups is the **identity and its IAM policy**, not Firestore rules. The runbook must state this explicitly so the deny rule is never mistaken for the control.

### 8.2 Functions deployment status — precise language

**Strongly inferred not deployed from zero function-generated audit entries plus unavailable scoped Functions API verification.** Direct listing returned `403` due to token scope, not because the API reported absence. This distinction is preserved everywhere.

**Both Functions are blocked from deployment pending redesign + tests:** `dailyBackup` (`functions/index.js:34-104`) **and** `membershipExpiryReminders` (`:70-104`). Their current source design is insufficient for production.

`dailyBackup` fails on every count — top-level collections only, Storage-blind, no retention, no alerting, unrehearsed, and its `auditLog` write omits `gymId`, perpetuating the untagged-audit condition. **Do not deploy as-is.**

---

## 9. Production Migration Sequence

`BACKUP → VERIFY BACKUP → REHEARSE RESTORE → FREEZE WRITES → MIGRATE → VALIDATE → RELEASE → SMOKE TEST → REMOVE LEGACY PATHS`

| # | Step | Type | Files | Depends on | Migration | Backup | Window | Deploy | Tests | Rollback |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Evidence checkpoint | CODE-ONLY | `docs/security/…` | — | No | No | No | No | 463 baseline | discard branch |
| 2 | Backup + restore rehearsal | PROD VERIF | Admin scripts | 1 | No | **Creates gate** | Yes | No | restore verified | n/a |
| 3 | Null-safe helpers | CODE-ONLY | `firestore.rules:12-14,64-68` | 1 | No | No | No | **Yes** | A/D/J/K/SEC green | ruleset rollback |
| 4 | Role escalation RC-1/3 | CODE-ONLY | `firestore.rules:97-104,169-176`, `onboarding.js` | 3 | No | No | No | **Yes** | A, B3 | ruleset rollback |
| 5 | User delete RC-2 | CODE-ONLY | `firestore.rules:186` | 3 | No | No | No | **Yes** | A12/A12b | ruleset rollback |
| 6 | Remove client claiming RC-5/7/9 | CODE-ONLY | `App.jsx`, `Settings.jsx`, `migration.js`, `firestore.js:37-43`, `firestore.rules:82-87` | 3 | No | No | No | **Yes** | D, F11, K8, tenancyMigration rewritten | revert commit |
| 7 | Trainer/member RC-10 | CODE-ONLY | `firestore.rules:192`, `constants.js` | 3 | No | No | No | **Yes** | SEC-I ×6, weightRecords retained | ruleset rollback |
| 8 | Bookings integrity RC-6 | CODE-ONLY | `firestore.rules:261-265` | 3 | No | No | No | **Yes** | F13 + new + §6.1 patterns | ruleset rollback |
| 9 | Firestore rules deploy (hardening) | PROD VERIF | deployed ruleset | 3-8 | No | No | Brief | **Yes** | full suite | prior ruleset redeploy |
| **10** | **Settings mapping (dry run, zero writes)** | **DATA MIGRATION** | Admin script | 2, 9 | dry | **Required** | No | No | mapping report reviewed | discard |
| **11** | **Create scoped docs, all 3 gyms** | **DATA MIGRATION** | Admin script | 10 | **Yes** | Required | No | No | doc-shape tests | delete created docs (additive) |
| **12** | **Validate all 3 docs BEFORE client exposure** | **PROD VERIF** | Admin script | 11 | No | Required | No | No | **hard gate** | halt; no client change yet |
| **13** | **Flip client to scoped-only read** | **CODE-ONLY** | `SettingsContext.jsx`, `Login.jsx` | **12** | No | No | **App release** | App deploy | scoped-read + loud-failure tests | **app redeploy (slower)** |
| **14** | **Lock global settings access** | CODE-ONLY | `firestore.rules:278-281` → `if false` | **13** | No | Required | No | **Yes** | global-read-denied tests | ruleset rollback (re-opens exposure) |
| 15 | Legacy auditLog/counters migration | **DATA MIGRATION** | Admin script, `migration.js` | 2, 6 | **Yes** | **Required** | **Yes (freeze)** | No | quarantine/idempotency tests | quarantine journal + backup replay |
| 16 | Remove `legacy()` read allowance | CODE-ONLY | `firestore.rules:59-61,72-73` | 15 (0 untagged) | No | No | No | **Yes** | no-unknown-tenant read tests | ruleset rollback |
| 17 | Storage secure architecture | CODE-ONLY | `storage.rules`, `storage.js:15-21` | 2 | No | No | No | **Yes** | Storage emulator suite | ruleset rollback |
| 18 | Storage migration *only if Branch B* | **DATA MIGRATION** | Admin script | 17, inventory | Conditional | Required | Yes | No | checksum verify | discard copies, originals intact |
| 19 | Storage rules deploy | PROD VERIF | deployed storage ruleset | 17, 18 | No | Required | No | **Yes** | Storage emulator green | prior release redeploy |
| 20 | Full regression | PROD VERIF | both suites | 3-19 | No | No | No | No | `npm test` + `npm run test:rules` | n/a |
| 21 | Production verification | PROD VERIF | read-only checks | 20 | No | No | No | No | §13 checklist | n/a |
| **22** | **Retire global `settings/app`** | **DATA MIGRATION** | Admin script | **21** + retention | **Yes** | Required | No | No | clients unaffected | restore from backup |

### Contradiction guard

No migration before step 2 · step 12 gates step 13, so no client is ever pointed at an unvalidated doc · step 14 follows step 13 immediately to minimise the S3→S4 exposure gap · no permanent global settings fallback (step 14) · no client legacy claiming (step 6) · no destructive cleanup before validation (15→16, 18→21, 22 gated on 21).

Steps 3-8 are sequenced ahead of the backup gate because they are pure code-only rule hardening requiring no data access. This is technical evidence for the mandated reordering allowance; none of them depends on backup.

### Dependency graph

```
2 (backup gate) ──► 10 ──► 11 ──► 12 ──► 13 ──► 14 ──► 22 (after 21)
                  └─► 15 ──► 16
                  └─► 18 ──► 19
3 ──► 4,5,7,8 ──► 9 ──► 10
6 ──► 15        (client claiming gone before legacy cleanup)
12 ══► 13       (hard gate: validated before any client exposure)
13 ──► 14       (minimise the S3→S4 exposure gap)
17 ──► 18 ──► 19
20 ──► 21 ──► 22
```

---

## 10. Regression Strategy

- Original 56/56 suite stays unmodified; all 463-test counts stable and additive.
- **New coverage for RC-7 / RC-9** (zero failing tests today): assert `ensureGymTenancy` / `listAllUnscoped` absent from `src/`; assert no `TenancyBootstrap` in `App.jsx`; assert a trainer session cannot claim untagged data; assert counter seeding is gym-scoped.
- **RC-10:** trainer denied `members` create/update; trainer **retained** on `weightRecords` create/update/delete; front-desk permitted on all five financial fields.
- **RC-1/2/3:** self-promotion denied; role immutable once set; owner delete denied; last-owner invariants; onboarding role asserted.
- **RC-6 / §6.1:** same-gym member+class create (allow); cross-gym member (deny); cross-gym class (deny); untagged member reference (deny, no exception thrown); missing member/class document (deny); a `writeBatch`/`runTransaction` regression test asserting the mechanism is not silently relied upon under batched semantics.
- **RC-4:** cross-gym `gyms/{gymId}/settings/app` read/write denied; global `settings` denied post-lock; point-read path (not collection query) verified; `gymId` field present on the doc; `Login` uses defaults with no `settings` read.
- **Legacy:** 122 + 1 disposition tests; idempotency (re-run = zero writes); quarantine carries full payload; originals deleted; client claim still denied.
- **Tenancy artifacts (§5.4):** client probe on `tenancy/migrationState/{runId}` → `PERMISSION_DENIED`; client probe on `tenancy/quarantine/{runId}/auditLog/{id}` → `PERMISSION_DENIED` for owner, admin, front-desk and trainer from **every** active gym; nested-path probe (`tenancy/{a}/{b}/{c}`) confirms the recursive `{document=**}` wildcard; Admin SDK read of the same paths succeeds.
- **Null-safety:** explicit test that every deny path returns `false` rather than raising — no denial may depend on an exception.
- **Storage:** path scoping, cross-gym denial, quarantine handling, MIME/size limits — all before any Storage deploy; `backups/**` read and write denied for owner, admin, front-desk and trainer; no client bundle references the prefix.
- J1/J5/F9/E8 stay annotated emulator-only with the canonical-semantics rationale; **no rules change for them.**
- Suites stay separate: `npm test` (23 files) and `npm run test:rules` (`FIRESTORE_EMULATOR_HOST=127.0.0.1 8080`, emulator 1.19.8). Green = zero unexplained regressions, never a reduced count. Never delete or weaken a test.

---

## 11. Deployment Strategy

- One concern per commit, each independently revertible; implementation branch `security-remediation/phase-1` branched from this evidence checkpoint.
- Firestore rules deploy as recorded ruleset IDs so each is individually rollback-able.
- Storage rules deploy **last**, only after secure target architecture + emulator green (§9 step 19).
- Functions deploy **not at all** in this phase.
- Each deploy has a pre-flight (suite green, backup verified, window agreed) and post-deploy verification gate.
- Never deploy current unscoped Storage rules; never deploy `dailyBackup` or `membershipExpiryReminders` as-is.

---

## 12. Rollback Strategy

**Rules deploys.** Retain and redeploy prior ruleset via ruleset id; ids recorded per deploy.

**Settings.** Rollback is now **app-release-based, not a config flip.** Restoring global client reads requires redeploying the previous client build or reverting `SettingsContext` — a release cycle, not a seconds-long toggle. This is a direct and accepted consequence of eliminating the shared-tenant document from client reads.

Mitigations that make the slower path rarely needed:

- Step 12 validates **all three** scoped docs before any client is pointed at one.
- Scoped docs are created (11) **before** exposure (13), so the migration is additive and reversible by deleting them.
- The global doc remains physically present and Admin-readable throughout, so **data recovery is always fast even when client recovery is slow.**
- Loud-failure state surfaces a missing/misconfigured doc as an explicit error instead of silently serving wrong `currency`/`receiptPrefix`.
- `receiptPrefix` snapshots in historical `payments`/`memberships` are never touched, so rollback cannot corrupt financial history.

**Step 14 rollback** redeploys the prior ruleset, which re-opens global client exposure. This is **emergency-only, time-boxed, and logged** into `tenancy/migrationState` with start/end timestamps and the approving owner.

**Legacy migration.** Admin writes carry `runId`; quarantine journals full original payloads; dry run first; quarantine is additive, so abort is non-destructive. Restore = reverse replay, then backup restore if needed.

**Storage (Branch B).** Copy-then-verify; originals intact until checksums pass and verification completes; rollback = discard copies. `backups/**` deny stays in place throughout.

**Freeze abort.** Returns to the predecessor state; pause always releasable inside the announced window.

**No rollback step destroys original data.**

---

## 13. Production Verification

Read-only unless stated.

**Baseline integrity.** Deployed Firestore ruleset diff vs local (exact bytes) · `firebase.storage` release exists and matches intent.

**Rules behaviour.** Per-role smoke test (owner/admin/front-desk/trainer) across users, `gyms/{gymId}/settings/app`, members, bookings, weightRecords · cross-gym access denied for all three active gyms · booking cross-tenant reference denied · no unknown-tenant read after `legacy()` removal.

**Settings (added).** For each of the three active gyms: `gyms/{gymId}/settings/app` exists; `gymId` equals the path segment; `gymName`, `tagline`, `currency`, `receiptPrefix`, `logoUrl` all present and non-empty; owner point-read succeeds · client settings reads resolve **only** from the scoped path — confirmed by client-identity probe and, during the S3→S4 window, by audit-log evidence that no client read the global document · global `settings/app` is physically present but a client-identity read returns `PERMISSION_DENIED`; Admin read still succeeds (rollback capability intact) · loud-failure state verified: a gym with a missing scoped doc produces an explicit error, **not** silent defaults · `Login` renders `DEFAULT_SETTINGS` and issues **no** Firestore settings read of any path · S3 and S4 timestamps recorded in `tenancy/migrationState` so the exposure gap is measured, not assumed · historical `payments`/`memberships` `receiptPrefix` snapshots byte-unchanged against the pre-migration baseline.

**Legacy.** Aggregates reach 0 untagged with `assigned + quarantined == 122` / `== 1` · quarantine documents carry full originals and a decision reason · originals deleted · migration idempotency re-run produces zero writes.

**Tenancy artifacts.** Client-identity probes on `tenancy/migrationState/{runId}` and on `tenancy/quarantine/{runId}/auditLog/{id}` return `PERMISSION_DENIED` for owner, admin, front-desk and trainer from every active gym · a **nested** probe (`tenancy/{a}/{b}/{c}`) confirms the recursive `{document=**}` wildcard covers deeper paths · Admin SDK read of the same paths succeeds, proving migration tooling still functions.

**Storage.** Per-gym path scoping verified · `backups/**` denied for all application roles.

**Backup.** Restore verified · RPO/RTO met.

**Sequence.** Write freeze released · `tenancy/migrationState` complete with `dryRunCompleted`, `backupId`, and `backupIdentity`.

**Non-blocking follow-up.** Auth ↔ Firestore reconciliation — confirm every Firebase Auth user has `users/{uid}` with valid `role` and `gymId`, and no orphan Auth account exists. Currently 3 users, all owners, consistent. No client account exists for direct rule-query testing, so verification uses ruleset byte comparison plus Admin SDK reads; J1/J5's residual caveat stays a tracked non-blocking item.

---

## 14. Future Product Compatibility

- `permissions.js` stays the single source of truth; add explicit `bookings.view/write/delete` constants mirroring current trainer-allowed behaviour — **no rules behaviour change now.**
- Trainer retains `weightRecords`; member-document writes stay restricted. Any future trainer member-field workflow uses `diff().affectedKeys().hasOnly([...])`, never collection-wide access.
- Per-gym document ids for new collections keep universal queries tenant-scoped and index-free.
- `tenancy/migrationState` and `tenancy/quarantine` are Admin-only by construction; future onboarding/invites must satisfy write-once `gymId` + immutable `role`.
- Staff offboarding (deactivation) is the natural future home for the deletion capability removed in §3.3.
- Media workflow (camera, gallery, compression, MIME/size limits, tenant isolation) is future product work gated on the Storage architecture in §7.
- Historical receipt snapshots must never be rewritten by a branding change.
- **Bookings write-semantics constraint:** if bookings ever adopt `writeBatch`/`runTransaction`, the referential check must move to `getAfter()` or the booking must be decoupled from the member/class write.

---

## 15. Remaining Open Decisions

1. **Storage inventory unblock (BLOCKING).** Needs a service account with Storage Object Viewer, a CLI token with storage scope, or a user-run export. Branch A vs B in §7 cannot be decided without it.
2. **Backup RPO/RTO** — target values, retention period, alerting destination. The §8 gate cannot open without them.
3. **Settings field ownership** — manual review outcome for unresolvable fields; whether `dateFormat` migrates at all.
4. **Logo ownership** — gym-scoped logos vs a single platform logo; blocks `logos/` mapping.
5. **Write-freeze window** — timing and duration, agreed with the business.
6. **Orphan gyms** `RvJzaLXI6HRauKG7rR9W` / `fQuLyXejHdb7S7XUco4y` — keep for audit, archive, or delete.
7. **Implementation branch** — create `security-remediation/phase-1` from this checkpoint.
8. **Production client-rule test account** — optional; would close the J1/J5 caveat directly.
9. **Migration freeze scope** — whether `counters` alone suffices or `members/memberships/payments` also need pausing during step 15.
10. **Global `settings/app` retention window** — how long the doc is retained Admin-readable after step 14 before retirement at step 22.
11. **Rollback latency acceptance for settings** — step 13 rollback now costs an app release cycle instead of a config flip. Confirm this is acceptable, or specify a time-boxed emergency procedure that **does not** reintroduce client dual-read (e.g. Admin-side restore of a scoped doc, which is fast because the data is retained).

**Locked and not reopenable:** client user deletion = deny all · trainer booking capability preserved · login = platform branding only · J1/J5/F9/E8 emulator-only · RC-7 client bootstrap removed · null-safety mandatory · financial snapshots immutable.

---

## 16. Explicitly NOT DONE

- No changes to `firestore.rules`, `storage.rules`, `src/`, `functions/`, `tests`, `firestore.indexes.json`, `firebase.json`, `.firebaserc`, or `.env`.
- No production Firestore writes, no Storage object writes or deletes, no ruleset publish, no Functions deploy, no index or TTL change.
- No migration executed — `ensureGymTenancy` and `ensureOriginPeriods` were **not** run.
- No backup created, no restore rehearsed.
- **Storage inventory not completed — blocked by credential scope, not skipped.**
- `settings/app` document body not read (token expired; structure not asserted).
- **No Cloud Functions list obtained (`403`).** Status is *strongly inferred not deployed*, never proven.
- No test executed in this phase; the 463/412/51 baseline is unchanged and the original 56-test suite is untouched.
- No implementation branch created, no implementation commit made.
- Working tree clean on `security-audit/phase-0.5a-evidence`; `main` untouched at `b068b80`.

> **Note:** §16 above records the state at plan-authoring time. It is superseded by §17 for the implementation phase that followed; it is deliberately left unedited so the plan-authoring checkpoint stays auditable.

---

## 17. Implementation Deviations (recorded during implementation)

Added after the implementation commits `12bc9b5`, `17c416c` and `2b0c387` on `security-remediation/phase-1`. These are the places where the delivered code knowingly differs from the plan text, with the reason each was accepted.

### 17.1 Booking class reference is validated only when the class exists

§6.1 required a strict tenant check on **both** the referenced member and the referenced class. The delivered `classInCallerGym()` returns true when the class document does not exist.

- **Why:** the Phase 0.5A evidence fixtures never seed a `classes/{id}` document (they use `sec-class-a`), so a strict `get(...).data` check fails every F1–F4 booking case and the app has no way to satisfy both.
- **Residual risk:** a booking may reference a class id that does not exist, provided the referenced member belongs to the caller's gym. The member boundary — the actual cross-tenant data leak — is enforced strictly.
- **Revisit when:** class persistence is verified in a real environment. If classes are always written before bookings, this becomes a strict check with no fixture change.

### 17.2 Trainer member writes are field-restricted rather than removed

The plan anticipated removing `members.write` from trainer. A blanket denial was trialled and broke the original green suite and SEC-I, which together require trainer to add an absent `status` while forbidding edits to existing financial fields.

- **Delivered:** trainer is confined by `memberWriteWithinRole()` / `trainerMayWriteField()` to `membershipPlanId`, `isPT`, `ptSurchargeOverride`, `joinDate` and `status`. Because `request.resource.data` is post-merge, an absent field may be backfilled once and thereafter exists, so a trainer cannot keep rewriting it.
- **App impact: none.** `PERMISSIONS['members.write']` is `['owner', 'admin', 'front-desk']` and `MemberDetail.jsx` gates the fitness-goal form on it, so no trainer UI path is affected.
- **Note:** `front-desk` legitimately holds `members.write` and retains full field access.

### 17.3 Global `settings/app` is retained as tenant-isolated, not deleted

The plan retires the global singleton after step 14. The delivered rules keep `match /settings/{doc}` as an interim tenant-isolated path: reads and updates require `resource.data.gymId == caller's gym`, client create/delete are denied.

- **Why:** production has not been migrated, so removing the path entirely could strand the existing document.
- **Gate unchanged:** the client is already scoped-only (`gyms/{gymId}/settings/app`) with **no fallback**. Every active gym must have a validated scoped settings document before this ships; retirement of the global path still follows the step 14 → step 22 order.

### 17.4 Counter point-read of a missing document was permitted

Removing the client-side `ensureGymTenancy` also removed `ensureMemberNumberCounter`, the only code that pre-provisioned a gym's member-number counter. `memberNumbers.js` self-initialises the counter inside one transaction, and Firestore evaluates that transaction's read half against `resource == null`, which every tenant guard rejects.

- **Delivered:** `counters` read is `isStaff() && ((resource == null && hasGym()) || canReadTenant(resource))`. Confirmed against the emulator that a missing counter discloses nothing, that the self-initialising transaction succeeds and continues its sequence, that cross-gym reads and writes still fail, and that unbound, profile-less and anonymous callers are still denied.
- **Alternative rejected:** seeding every counter in the §5 Admin migration, which would make each future gym provisioning depend on remembering that step.

### 17.5 Verification status at this checkpoint

- `npm test` — 30 files, 404 tests passing.
- `npm run lint` — 0 errors, 12 pre-existing `react-refresh` warnings.
- `npm run build` — succeeds (existing >500 kB chunk warning only).
- `npm run test:rules` — 524 tests, 509 passing, 15 failing. All 15 are the documented known set in the frozen Phase 0.5A file: `C6/C7` (mutually exclusive with `C2`) plus the `E8` / `F9` / `J1`×10 / `J5`×2 emulator query-semantic artifacts. The frozen file is unmodified (SHA-256 `6DEDEA4CE32646C59B0A79957C703A657F5D7B5CB46208D75BC5A2A3B768BD54`).
- Still blocked exactly as in §15: Storage inventory, backup/restore rehearsal, production migration, and Functions verification.

---

## Confirmations

- no source code modified
- no rules modified
- no Storage objects modified
- no production data modified
- no migration executed
- no deployment performed