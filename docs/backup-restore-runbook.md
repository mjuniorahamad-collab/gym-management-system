# Firestore backup & restore — runbook

Status: **dumps run nightly and the first one completed on 2026-11-24 (554 documents);
nothing has been restored yet.** `.github/workflows/backup.yml` dumps the production
database every night by the free path in §2 and keeps 14 days of artifacts.
`functions/dailyBackup` still needs Blaze and is not deployed. Until a restore (§4) has
passed and the counts are checked against the console, this is a schedule, not a
recovery plan.

| | |
| --- | --- |
| Project | `himalye-wonders-gym` (`.firebaserc`) |
| Database | Firestore Native, `(default)` |
| Live site | https://himalye-wonders-gym.web.app |
| Rules / indexes | In git (`firestore.rules`, `firestore.indexes.json`) — already "backed up", nothing to export |
| Storage | Not in use, so nothing to back up (bucket rules were never released) |
| Auth users | **Not covered by a Firestore export.** See §5 |

If the database is lost today, every gym's members, payments, attendance and audit
log are lost with it. A `--delete-database` click, a bad script with Admin
credentials, or a mistaken mass delete is unrecoverable. That is the gap this
runbook closes.

---

## 1. The two paths

| | A. Managed export (Blaze) | B. JSON dump (free, Spark) |
| --- | --- | --- |
| Cost | Requires billing enabled (Blaze). One **document read per exported document**, plus Cloud Storage for the files. A gym-sized database is thousands of documents, so a monthly export is cents. | Free: reads stay inside the Spark quota (50k/day), files land on your disk. |
| Setup | Billing, a GCS bucket, an IAM role, optionally Scheduler + Function | A service-account key and a script you run yourself |
| Output | Firestore's own export format — restored with one `gcloud firestore import` | NDJSON you have to write back |
| Restore fidelity | Complete, exact, one command | Field types are preserved by the Admin SDK, but it is a re-write: timestamps of documents, and anything written during the dump, differ |
| Automation | Scheduled, hands-off | Manual, so the real RPO is "when you last remembered" |
| Verdict | **The right long-term answer**, when billing is acceptable | **The right answer today**, while there is no budget |

Do B now, keep this runbook's A section for the day billing is approved.

---

## 2. Path B — free JSON dump and restore

### 2.1 What runs today

`.github/workflows/backup.yml` (nightly at 01:15 Asia/Kathmandu, plus **Run workflow**):

1. signs in with the same `FIREBASE_SERVICE_ACCOUNT` secret the deploy uses — no new
   credential and no bucket, so nothing here needs Blaze;
2. runs `node scripts/backup-firestore.mjs --project=himalye-wonders-gym --out=…`
   (`npm run backup:firestore` locally);
3. uploads `backup/<timestamp>/` as the artifact `firestore-backup-<run id>` and prints
   `_manifest.json` in the run summary;
4. **fails** on an empty dump, so a credentials problem cannot upload a green artifact
   called "backup".

**First run — 2026-11-24, run `45390079046`:** 554 documents across 14 collections
(`auditLog` 311, `payments` 73, `memberships` 52, `members` 39, `membershipPlans` 20,
`attendance` 15, `weightRecords` 15, `gyms` 12, `expenses` 7, `counters` 4, `users` 3,
`classes` 1, `settings` 1, `trainers` 1), artifact `firestore-backup-45390079046`
(41,090 bytes, retained until 2026-12-08). The nightly run starts at 01:15 Asia/Kathmandu;
run it by hand from **Actions → Firestore backup (JSON, free) → Run workflow**.

Still open: those counts have not been compared with the console by the owner, and no
restore has been rehearsed.

The service account needs read access to every collection (`roles/datastore.viewer`,
included in Editor and in the Firebase Admin SDK role). The job only ever calls `--out`;
restoring is deliberately an operator action.

### 2.2 The dump format

| File | Contents |
| --- | --- |
| `documents.ndjson` | one JSON line per document: `{"path": "members/<id>", "data": {…}}`, sorted by path |
| `_manifest.json` | `format`, `project`, `dumpedAt`, total `documents`, per-collection counts |

Subcollections are walked recursively, so the file stays complete if the schema grows
one. Firestore value types that plain JSON cannot carry are tagged and rebuilt on
restore — `timestamp`, `geopoint`, `reference`, `bytes` — because writing a timestamp
back as a map would silently corrupt the field.

### 2.3 Local run (free)

```bash
npm ci --prefix functions          # the Admin SDK lives in functions/
gcloud auth application-default login   # or: export GOOGLE_APPLICATION_CREDENTIALS=~/gym-backups/key.json
node scripts/backup-firestore.mjs --out="$HOME/gym-backups/$(date +%F)"
```

Check the printed counts against the console's document counts before you trust the
folder. `backups/` is git-ignored on purpose: a dump is member data.

### 2.4 Retention

Keep **14 daily** and **4 weekly** dumps, and copy one off the laptop (an encrypted
archive in cloud storage or an external disk) — a backup on the same disk as the
project, or only in the CI account of the same organisation, is not a backup. Never
delete the last two dumps until a restore rehearsal (§4) has passed on the newer one.

### 2.5 Restore

Restore is a **write** into the target project and it replaces documents at the same
paths. Always dry-run first, and always name the target so a rehearsal cannot reach
production:

```bash
node scripts/backup-firestore.mjs --restore="$HOME/gym-backups/2026-11-24" --dry-run
node scripts/backup-firestore.mjs --restore="$HOME/gym-backups/2026-11-24" --project=demo-himalye-gym
```

Spark allows 20k writes/day, so a large restore may need a second run.

---

## 3. Path A — managed export (when Blaze is approved)

Prerequisites, from the Firebase docs: billing enabled (which upgrades the project
to Blaze), a Cloud Storage bucket in the same location as the database, and an
account with `roles/datastore.importExportAdmin` (Owner also works).

```bash
# once
gcloud storage buckets create gs://himalye-wonders-gym-backups --location=asia-south1

# export (one document read per document exported)
gcloud firestore export gs://himalye-wonders-gym-backups/firestore/$(date +%Y%m%d-%H%M) \
  --project=himalye-wonders-gym

# restore — writes the export back, overwriting documents with the same id
gcloud firestore import gs://himalye-wonders-gym-backups/firestore/<timestamp> \
  --project=himalye-wonders-gym
```

Cost control: exports are billed reads and do **not** show in the console usage
panel (the docs warn about exactly this), so add a GCS lifecycle rule that deletes
`firestore/` objects older than 30 days instead of paying to keep every one.

Automation, once billing exists: `functions/dailyBackup` already wraps the export;
deploy it with a Cloud Scheduler trigger and give its service account
`roles/datastore.importExportAdmin`.

---

## 4. Restore rehearsal (free, do this before you need it)

A restore that has never been run is a hope, not a plan. Rehearse against the
emulator, which costs nothing:

```bash
firebase emulators:start --project demo-himalye-gym --only firestore
# in another shell, with credentials available for the demo project, point the same
# script at the emulator:
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node scripts/backup-firestore.mjs --restore="$HOME/gym-backups/2026-11-24" --project=demo-himalye-gym
```

Then read a few documents back (console at `127.0.0.1:8080`, or `curl` the emulator
REST API) and confirm counts match `_manifest.json`. Record the date of the last
passing rehearsal in this file.

| Rehearsal | Dump used | Result |
| --- | --- | --- |
| _none yet_ | | |

---

## 5. What this does not cover

- **Auth users.** Email/password accounts and their UIDs live in Firebase Auth, not
  Firestore. A Firestore restore re-creates the profile documents but not the
  sign-in accounts; users would have to sign up again, and `users/{uid}` documents
  would then point at new UIDs. Exporting Auth users needs the Admin SDK
  (`admin.auth().listUsers()`), which is free but is a separate script. Back up
  Auth before the first real client.
- **Storage objects.** Nothing is stored today. When photos/logos go live, the
  bucket needs its own copy (`gcloud storage rsync`).
- **Rules and indexes.** Already versioned in git; roll back with
  `scripts/rollback-release.mjs`, not with a restore.
- **Point-in-time recovery.** Firestore PITR is a Blaze feature with its own
  retention window; it is not a substitute for an off-project copy.

---

## 6. Checklist before hand-over

- [ ] A dump exists for today — locally or as the nightly `firestore-backup-*` artifact
      — and `_manifest.json` counts match the console.
- [ ] One dump is stored off this machine.
- [ ] A restore rehearsal passed on the emulator (§4) and is recorded above.
- [ ] The key file is not in the repository and never will be
      (`git status` clean, key stored outside the project folder).
- [ ] Someone other than the developer knows this file exists and where dumps live.
