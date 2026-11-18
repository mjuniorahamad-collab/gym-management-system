# Firestore index cleanup — proposal only, nothing deleted

Status: **proposal, not a change.** `firestore.indexes.json` still contains all 30 entries and no index has been
removed from any project. This document exists so deletion can be approved, scheduled and reversed deliberately
instead of during a feature push.

Basis: audit §27 (`AUDIT-gym-management-system.md`) — every query built in `src/` and `functions/` was traced to the
constraints it sends and matched against `firestore.indexes.json`. Result: **15 of 30 reachable, 15 not, 0 missing.**
Every Tier A entry below was re-traced a second time while writing this revision; the evidence column is that trace.

**Update — Tier A removed.** Tier A (10 indexes: #15, #18–26) has since been deleted from `firestore.indexes.json` in
its own commit, leaving **20 entries**: the 15 reachable ones plus the 5 Tier B entries. §2 is kept as the record of
what was removed and why, and §5 is the procedure that was used (and that Tier B would follow). Index numbers (#1–#30)
below refer to the pre-cleanup order in audit §27, not to positions in the current file.

---

## 1. What deleting an index does and does not do

| | |
| --- | --- |
| Data loss | **None.** Indexes are derived from documents, not the documents themselves. |
| Read/write billing | **Unchanged.** Firestore bills per document operation, not per index. |
| Storage billing | Some reduction, since composite index entries are stored. On a gym-sized dataset that is small enough not to be the reason to act. |
| Real benefit | Fewer index entries to maintain on every write, faster index deploys, and no false confidence that a query shape is supported. Hygiene, not cost. |
| Risk | If a query *does* need the index it fails at query time with `failed-precondition` (the SDK logs the console link that creates it). It never breaks a build or a deploy. |
| Reversal | Re-add the JSON block and redeploy; the index rebuilds from existing documents in minutes at this size. No backfill. |

A missing index fails at query time, not at deploy time. That is why deletion is only safe for shapes **no code can
currently build** — which is exactly what the trace below establishes.

---

## 2. Tier A — removed in the cleanup commit (10 indexes)

No code path in `src/` or `functions/` (tests and the vendored bundle excluded) constructs these queries. A future
server-side filter + date ordering, or a cross-tenant view, is what would bring any of them back; today nothing does.

| # | Index | Evidence (current code) |
| --- | --- | --- |
| 15 | `counters(gymId, createdAt)` | Counters are only touched by point reads/writes: `doc(db, 'counters', …)` ([memberNumbers.js:18](../src/services/memberNumbers.js#L18), [receipts.js:30](../src/services/receipts.js#L30)) and `tx.get('counters', …)` ([payments.js:141](../src/services/payments.js#L141)). No `useCollection('counters')` exists. Stronger: counter documents are written through `upsert`, which stamps `gymId` + `updatedAt` and **no `createdAt`** ([firestore.js:122-135](../src/services/firestore.js#L122), writer at [firestore.js:184-190](../src/services/firestore.js#L184)), so this index could not serve an ordered counters listing even if one were added. |
| 18 | `members(status, searchName)` | Every members query is tenant-scoped first: `scopedConstraints()` always prepends `where('gymId','==',gymId)` ([firestore.js:45](../src/services/firestore.js#L45)) and `fetchPage` appends filters and then the order field ([firestore.js:243-249](../src/services/firestore.js#L243)); the Members page orders by `searchName` ([Members.jsx:124](../src/pages/Members.jsx#L124)). An index with `status` first cannot serve a `gymId`-prefixed query — wrong prefix. |
| 19 | `members(status, createdAt)` | No surface orders members by `createdAt` with a status filter: the only `createdAt`-ordered members reads are the unfiltered tenant list ([firestore.js:78](../src/services/firestore.js#L78), [firestore.js:220](../src/services/firestore.js#L220)), served by index #1, and the Members page orders by `searchName` ([Members.jsx:124](../src/pages/Members.jsx#L124)). |
| 20 | `payments(memberId, date)` | Per-member payments are read with one equality and **deliberately no `orderBy`**: `listAll('payments', { where: { memberId } })` ([memberLedger.js:24](../src/services/memberLedger.js#L24)) and `listAll` only adds `orderBy('createdAt')` when no filter is given ([firestore.js:77-78](../src/services/firestore.js#L77)). The functions side is the same shape: `where('memberId','==',…)` plus `where('gymId','==',…)`, no ordering ([sources.js:113-114](../functions/projection/sources.js#L113), [duesDrift.js:121](../functions/projection/duesDrift.js#L121)) — served by single-field indexes plus index merging. |
| 21 | `payments(method, date)` | Method is a client-side filter, not a constraint: `if (method !== 'all' && p.method !== method) return false` ([Payments.jsx:75](../src/pages/Payments.jsx#L75)). The query itself is the tenant subscription in #8. |
| 22 | `attendance(memberId, date)` | Attendance is always read gym-scoped: `useCollection('attendance')` ([Attendance.jsx:31](../src/pages/Attendance.jsx#L31), [MemberDetail.jsx:83](../src/pages/MemberDetail.jsx#L83), Dashboard, Reports). The per-member view filters in JS ([MemberDetail.jsx:151-156](../src/pages/MemberDetail.jsx#L151)). |
| 23 | `bookings(classId, date)` | Bookings for a class are filtered in JS: `bookingsForClass = (classId) => bookings.filter(…)` ([Classes.jsx:62-63](../src/pages/Classes.jsx#L62)); Dashboard also reads the whole tenant list. |
| 24 | `expenses(category, date)` | Category is a client-side filter: `if (category !== 'all' && e.category !== category) return false` ([Expenses.jsx:50](../src/pages/Expenses.jsx#L50)). The query is the tenant subscription in #9. |
| 25 | `classes(dayOfWeek, startTime)` | The weekly table is built by grouping and sorting in JS ([Classes.jsx:48-59](../src/pages/Classes.jsx#L48)); the query is the tenant subscription in #11. |
| 26 | `auditLog(entity, timestamp)` | `auditLog` is written only: `createDoc('auditLog', …)` ([audit.js:48](../src/services/audit.js#L48)). There is no `useCollection('auditLog')` and no query builder anywhere that reads the collection. |

## 3. Tier B — still declared, keep until a decision is made (5 indexes)

Not reachable either, but each is a deliberate placeholder for work that is either planned or one switch away.
Deleting them now would make a planned feature undeployable.

| # | Index | Why it is kept | Condition to delete |
| --- | --- | --- | --- |
| 14 | `auditLog(gymId, createdAt)` | `auditLog` is write-only today, but writes go through `createDoc`, which does stamp `createdAt`, so an admin/audit screen paging by date would use this index as declared | Delete only if the audit viewer is dropped from the roadmap |
| 16 | `weightRecords(memberId, date)` | MemberDetail filters weight records in JS ([MemberDetail.jsx:180](../src/pages/MemberDetail.jsx#L180)); moving that tab to an ordered query is the obvious next optimisation | Delete once it is decided that tab stays client-filtered |
| 27 | `payments(gymId, date)` | Required by `src/services/rangeQueries.js`, which is **prepared and deliberately not enabled** | **Do not delete** while `rangeQueries.js` exists |
| 28 | `expenses(gymId, date)` | Same | Same |
| 29 | `attendance(gymId, date)` | Same | Same |

Tier B notes:

- #27–29 are load-bearing for a feature that is one switch away. `src/tests/compositeIndexCoverage.test.js` asserts
  them through `RANGE_FIELDS` (`rangeShape`), so deleting them turns that test red — the intended tripwire. If the
  range-query module is abandoned, delete the module, its test block and these three indexes **together**.
- #14 and #16 are cheap to keep and avoid re-deciding the same question next quarter.

---

## 4. Pre-delete verification

1. **Re-trace the code.** This document's trace is the authoritative check. Re-run it (grep for `orderBy(`, `where(`
   and the collection names in `src/` and `functions/`, tests and `vendor/` excluded) after any feature lands, because
   one new `where` + `orderBy` pair can change the list.
2. **Diff the file against the project.** `firebase deploy --only firestore:indexes` makes the file the source of
   truth: any index that exists in the project but not in the file is **deleted**, and anything created by hand in the
   console is not in the file. List the project's indexes in the console and diff them against the 30 entries first,
   so a console-created index is not removed by surprise.
3. **Do not expect usage stats to help.** The Firebase console lists composite indexes with their build **status**
   (Building / Enabled); it does not expose per-index last-used or "unused" data for Firestore Standard edition, and
   `firebase firestore:indexes` only prints the declared configuration. So there is no free "this index served zero
   queries" report to check before deleting.
4. **Accept that the canary is the real test.** No error-reporting provider is installed (`src/services/telemetry.js`
   is only the seam, §17.3), so historical `failed-precondition` errors are not retained anywhere either. The practical
   verification is: delete, then exercise Members (every filter, including Frozen), Dashboard, Reports and MemberDetail.
   A `failed-precondition` there is immediate, unambiguous, and fixed by redeploying the previous file.
5. **Snapshot.** Keep `firestore.indexes.json` at the commit before cleanup as the rollback artifact. A single cleanup
   commit is enough; no separate backup is needed.

## 5. Execution order (Tier A was done this way; repeat for Tier B)

1. New branch, one commit that only removes the approved blocks from `firestore.indexes.json` (Tier A, or Tier A plus
   any Tier B entry whose condition is met). Nothing else in the commit.
2. `npx vitest run` — `compositeIndexCoverage.test.js` must stay green; a red run means a still-used index was targeted.
3. If a formatting change is wanted too, make it a **separate** commit first: the current file has one non-Prettier
   spot (`}` then `    {` between the `membershipFreezes` and `memberships` blocks), so `prettier --check` fails on the
   file as it stands, before any cleanup. Otherwise skip the Prettier step — it verifies formatting, not indexes.
4. `firebase deploy --only firestore:indexes` (needs an authenticated CLI; no Blaze plan required).
5. Console → Firestore → Indexes: confirm the remaining entries are `Enabled` and the deleted ones are gone.
6. Run the canary from §4.4. Roll back on any `failed-precondition`.
7. Rollback: `git revert <commit>` → redeploy indexes → wait for `Enabled`.

## 6. Not proposed

- No index is deleted in this change.
- No query is rewritten to use or stop using an index.
- No `fieldOverrides`, no single-field index settings, no TTL or vector index changes.
- No change to `rangeQueries.js` or to which read path any page uses.

**Recommendation:** Tier A is done. Keep Tier B (5) declared until the audit-viewer decision is actually made; if the
range-query module is enabled, #27–29 become load-bearing rather than placeholders, and if it is removed, its test block
and those three indexes should go together.
