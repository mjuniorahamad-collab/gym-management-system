# Firestore backup & restore — runbook

Status: **no backup exists today.** Nothing exports the production database on any
schedule, and no restore has ever been rehearsed. `functions/dailyBackup` was written
but never deployed (it needs Blaze). This document is the manual procedure until one
of the two paths below is set up.

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

### 2.1 One-time setup (free)

1. Google Cloud console → **IAM & Admin → Service accounts** →
   `https://console.cloud.google.com/iam-admin/serviceaccounts?project=himalye-wonders-gym`
   → *Create service account*, name it `firestore-backup-reader`.
2. Grant it exactly one role: **Cloud Datastore Import Export Admin**
   (`roles/datastore.importExportAdmin`) — needed for the Admin SDK to read every
   collection — or, for a read-only dump, **Datastore Viewer** (`roles/datastore.viewer`).
3. Keys → *Add key → JSON* → download. **This file is a credential.** Keep it out of
   the repo (never under the project folder), and set
   `GOOGLE_APPLICATION_CREDENTIALS` to its path only for the run.
4. `firebase-admin` is already installed under `functions/node_modules`.

### 2.2 Dump

Save this outside the repository (for example `~/gym-backups/dump.mjs`) and run it
from `functions/` so `firebase-admin` resolves:

```js
// node dump.mjs <output-dir>   — run from functions/, credentials via GOOGLE_APPLICATION_CREDENTIALS
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
initializeApp({ credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS) })
const db = getFirestore()
mkdirSync(out, { recursive: true })

const NDJSON = (docs) => docs.map((d) => JSON.stringify(d)).join('\n') + '\n'

async function dump() {
  const counts = {}
  for (const collection of await db.listCollections()) {
    const docs = await collection.get() // whole-collection read; fine at this size
    writeFileSync(join(out, `${collection.id}.ndjson`), NDJSON(docs.docs.map((d) => ({ id: d.id, ...d.data() }))))
    counts[collection.id] = docs.size
  }
  writeFileSync(join(out, '_manifest.json'), JSON.stringify({ dumpedAt: new Date().toISOString(), counts }, null, 2))
  console.log(counts)
}

dump().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

Subcollections are not walked by the loop above. There are none in this schema
today (every collection is top-level with a `gymId` field, per
`src/services/firestore.js`), but add a recursive walk before that changes.

```bash
cd functions
export GOOGLE_APPLICATION_CREDENTIALS=~/gym-backups/key.json
node ~/gym-backups/dump.mjs ~/gym-backups/$(date +%Y-%m-%d)
```

`_manifest.json` is the proof the run finished: check its counts against the
console's document counts before you trust the folder.

### 2.3 Retention

Keep **14 daily** and **4 weekly** dumps, and copy one off the laptop (an encrypted
archive in cloud storage or an external disk) — a backup on the same disk as the
project is not a backup. Never delete the last two dumps until a restore rehearsal
(§4) has passed on the newer one.

### 2.4 Restore

Restore is a **write** back into the target project, and it will overwrite documents
with the same id. Set the target explicitly so a rehearsal cannot hit production:

```js
// node restore.mjs <dump-dir> <project-id>
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, projectId] = process.argv.slice(2)
initializeApp({ credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS), projectId })
const db = getFirestore()
db.settings({ ignoreUndefinedProperties: true })

async function restore() {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
    const collection = file.replace(/\.ndjson$/, '')
    const rows = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    for (let i = 0; i < rows.length; i += 400) {
      const batch = db.batch()
      for (const { id, ...data } of rows.slice(i, i + 400)) batch.set(db.collection(collection).doc(id), data)
      await batch.commit()
    }
    console.log(`${collection}: ${rows.length} documents`)
  }
}

restore().catch((err) => {
  console.error(err)
  process.exit(1)
})
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
# in another shell, with GOOGLE_APPLICATION_CREDENTIALS pointing at a key for the
# demo project, point restore.mjs at the emulator:
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node restore.mjs ~/gym-backups/2026-11-24 demo-himalye-gym
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

- [ ] A dump exists for today and `_manifest.json` counts match the console.
- [ ] One dump is stored off this machine.
- [ ] A restore rehearsal passed on the emulator (§4) and is recorded above.
- [ ] The key file is not in the repository and never will be
      (`git status` clean, key stored outside the project folder).
- [ ] Someone other than the developer knows this file exists and where dumps live.
