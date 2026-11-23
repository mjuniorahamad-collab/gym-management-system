# Gym Management System

A production-ready gym management system built with **React + Vite**, **Tailwind CSS**, **Firebase
Authentication**, **Cloud Firestore** and **Cloud Storage**.

## Features

- 🔐 **Secure admin login** — Firebase Auth with role-based access (`owner`, `admin`, `front-desk`, `trainer`)
- 📊 **Dashboard & analytics** — revenue, expenses, member growth, expiring memberships, today's check-ins
- 👥 **Member management** — CRUD, search, filters, photo upload, QR member cards
- 🧑‍🏫 **Trainer management** — CRUD with specializations and hourly rates
- 📅 **Class scheduling & bookings** — weekly schedule, capacity, member bookings
- ✅ **Attendance tracking** — manual + QR check-in/out
- 💳 **Membership plans & payments** — plans, receipts, payment logging
- 💸 **Expense tracking** — categories, filters, CSV export
- 📈 **Reports & charts** — cash flow, member growth, expense breakdown, revenue by plan
- 🎨 **Dark/light mode** — persisted, respects system preference
- 📱 **Fully responsive** — mobile-first layout with a collapsible sidebar
- 🛡️ **Security-first** — Firestore + Storage security rules, CSRF-safe forms, audit log
- 🧪 **Quality** — ESLint, Prettier, Vitest tests, offline-first Firestore persistence
- 🏠 **Demo mode** — explore the entire app with sample data without configuring Firebase

## Tech stack

| Layer      | Choice                                                     |
| ---------- | ---------------------------------------------------------- |
| Frontend   | React 18, Vite 5                                           |
| Styling    | Tailwind CSS 3 (class-based dark mode)                     |
| Routing    | React Router 6                                              |
| Forms      | React Hook Form + Zod                                      |
| Charts     | Recharts                                                    |
| Icons      | lucide-react                                                |
| Backend    | Firebase Auth, Cloud Firestore, Cloud Storage              |
| Automation | Cloud Functions (expiry reminders, daily backups)           |
| Tests      | Vitest + Testing Library                                    |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure Firebase
cp .env.example .env        # then fill in your Firebase project keys

# 3. Run the development server
npm run dev                 # http://localhost:5173
```

> **No Firebase yet?** Leave `.env` unset. The login page shows an **"Explore demo mode"**
> button that loads in-memory sample data so you can test every screen.

### First login (real Firebase)

The very first account that signs in on a fresh project automatically becomes the **Owner**.
Create that user in Firebase Console → Authentication, then sign in with it in the app.
There is **no staff-invite screen**. Adding a staff member is an administrative (Console / Admin SDK)
step, by design: a client can never create another account's profile, and a role can never be changed
after it is written (`firestore.rules` → `roleWriteOnce()`). To add staff:

1. Firebase Console → Authentication → **Add user** (email + password). Copy the new **UID**.
2. Firestore → collection `users` → document with that UID:
   `{ name, email, role: 'admin' | 'front-desk' | 'trainer', gymId: '<your gymId>' }`.
3. The role is now permanent for that account; to change it, delete the auth user and recreate.

Use the same `gymId` as the owner's `users/{uid}.gymId`. Any other value isolates the staff member
from the gym's data.

## Scripts

| Command            | Description                            |
| ------------------ | -------------------------------------- |
| `npm run dev`      | Start the Vite dev server              |
| `npm run build`    | Production build to `dist/`            |
| `npm run preview`  | Preview the production build           |
| `npm run lint`     | Run ESLint                             |
| `npm run lint:fix` | Auto-fix lint issues                   |
| `npm run format`   | Format with Prettier                   |
| `npm run test`     | Run the Vitest suite (once)            |
| `npm run test:watch` | Run tests in watch mode             |
| `npm run smoke:hosting` | Check the live site against `dist/` (see Deploying) |
| `npm run rollback` | Dry-run (default) or apply a hosting / Firestore rules rollback |

## Project structure

```
src/
├── components/
│   ├── layout/     Sidebar, Topbar, ThemeToggle, ProtectedRoute, RoleGuard, OnlineIndicator
│   ├── ui/         Reusable primitives: Button, Card, Modal, Badge, Input, Select, Forms…
│   ├── charts/     StatCard + Recharts wrappers
│   └── common/     MemberPhoto, forms, ReceiptModal, AuditLogTable, CSVExportButton
├── context/        AuthContext, ThemeContext, ToastContext, SettingsContext
├── firebase/       Firebase config + offline-first initialization
├── hooks/          useCollection, usePaginatedCollection, auth/theme/settings
├── pages/          One file per route
├── schemas/        Zod validation schemas for every form
├── services/       Firestore CRUD, storage, CSV export, audit log, seeding, demo store
├── utils/          constants, formatters, permissions, date helpers
└── tests/          Vitest unit + component tests
```

## Data model (Firestore collections)

- `users/{uid}` — staff profiles and roles
- `members` — profiles, plan reference, status, `memberUid` (self-service, v2)
- `trainers` — coaches and hourly rates
- `membershipPlans` — durations, pricing, features
- `payments` — member payments, methods, receipts
- `expenses` — operating costs by category
- `attendance` — check-in/out with source (manual / QR)
- `classes` — weekly schedule, capacity, trainer
- `bookings` — member bookings against classes
- `auditLog` — append-only change history
- `settings/app` — gym name, currency, branding, receipt prefix

## Roles & permissions

| Permission         | Owner | Admin | Front Desk | Trainer |
| ------------------ | :---: | :---: | :--------: | :-----: |
| View members       |  ✅   |  ✅   |     ✅     |   ✅    |
| Edit members       |  ✅   |  ✅   |     ✅     |   ✕     |
| Delete members     |  ✅   |  ✅   |     ✕     |   ✕     |
| Finance (view)     |  ✅   |  ✅   |     ✕     |   ✕     |
| Finance (write)    |  ✅   |  ✅   |     ✕     |   ✕     |
| Trainers (write)   |  ✅   |  ✅   |     ✕     |   ✕     |
| Attendance (write) |  ✅   |  ✅   |     ✅     |   ✕     |
| Settings / owner   |  ✅   |  ✕    |     ✕     |   ✕     |
| Audit log          |  ✅   |  ✅   |     ✕     |   ✕     |

## Security

- **Firestore rules** (`firestore.rules`) enforce auth + role checks on every collection —
  finance collections are admin/owner only, audit log is append-only.
- **Multi-gym isolation**: every business record is scoped to a `gymId`. The caller's gym is
  derived server-side from `users/{uid}.gymId`, which can only be bound once and is frozen
  afterwards — clients can never freely assign or change their gym.
- **Storage rules** (`storage.rules`) protect member photos and backup output.
- **Composite indexes** are pre-declared in `firestore.indexes.json` for search + filter queries.
- Passwords never touch the app — Firebase Auth handles them.
- An **audit log** records who created, updated or deleted financial and member records.

### Provisioning a gym (owner-of-record)

To let a gym owner sign in and claim their data, provision an owner-of-record document in the
**`gyms`** collection (Firebase Console → Firestore → Start collection `gyms`, document ID = your
chosen `gymId`, e.g. `gym-abc`):

```jsonc
// gyms/gym-abc
{
  "ownerUid": "<the Firestore UID of the owner's Firebase Auth account>",
  "name": "My Gym",
  "createdAt": "<ISO timestamp, e.g. 2026-01-01T00:00:00.000Z>"
}
```

That `gyms` document is the only thing that authorizes ownership — the rules let the matching
`ownerUid` bind it to their `users/{uid}` profile exactly once. Until it is provisioned, a new
account cannot claim a dataset, and on first login the app runs a safe, idempotent backfill
(`Settings → Re-sync gym tenancy`) that tags any existing records with the bound gym. Re-running
never overwrites an existing gymId or destroys data.


## Deploying to Firebase

Deploys run from GitHub Actions (`.github/workflows/deploy.yml`), not from a laptop, and ship in
three reviewable stages instead of one `firebase deploy`.

### One-time setup

1. Create a service account with `Firebase Hosting Admin`, `Firebase Rules Admin` and Cloud Datastore
   index permissions, and store its JSON key as the repository secret `FIREBASE_SERVICE_ACCOUNT`.
2. Optional repository variables: `FIREBASE_PROJECT_ID` (default `himalye-wonders-gym`) and
   `FIREBASE_HOSTING_URL` (default `https://<project-id>.web.app`, used by the post-deploy smoke check).
3. Cloud Functions are **not** part of this workflow — they need Blaze. Deploy them separately.

### Triggering a deploy

Actions → **Deploy (hosting · Firestore rules · indexes)** → *Run workflow*, branch `main`, and pick
`deploy_scope`:

| `deploy_scope` | What it touches | When to use it |
| --- | --- | --- |
| `hosting` (default) | the new `dist/` bundle only | first, so the bundle can be verified before the security surface moves |
| `hosting+rules` | adds `firestore:rules` | after the new bundle is confirmed on the live origin |
| `hosting+rules+indexes` | adds `firestore:indexes` — the **only destructive step** | last, and only after reading the index diff |

Every run first requires a green `ci.yml` run for the same commit plus the `FIREBASE_SERVICE_ACCOUNT`
secret, so a red commit cannot be deployed. When indexes are in scope, `scripts/index-diff.mjs`
prints what the deploy would create and delete before anything is touched, and fails the run unless
`confirm_index_deletions` is ticked. **`firebase deploy --only firestore:indexes` deletes every
project index that is absent from `firestore.indexes.json`** — the first run after the cleanup is
expected to plan ~10 deletions; review them in the job summary.

After the hosting step, `scripts/smoke-hosting.mjs` compares the live URL with the bundle that was
just built: the served `index.html` must reference the same hashed entry files, the entry bytes must
match (sha256), and a deep link (`/login`) must serve the app through the SPA rewrite. It also checks
the cache policy `firebase.json` declares, because header rules match the original request path and
the last match wins: the shell (`/` and the deep link) must answer `Cache-Control: no-cache`, and every
`/assets/**` file must answer `immutable`. A deploy that publishes a stale or broken bundle, or that
loses the cache policy, fails the job there, before rules or indexes move. The same check can be run by
hand against the live site: `npm run smoke:hosting` (add
`-- --base-url=https://<project-id>.web.app` for another project).

The workflow is dispatch-only for now; the `push: branches: [main]` trigger in the file is the
Phase 2 switch for auto-deploy, and every gate above still applies.

### Previewing a hosting change before merge

`.github/workflows/preview.yml` runs on every pull request to `main`: it builds the branch, deploys it to
a Firebase Hosting **preview channel** (`pr-<number>`), runs the same `scripts/smoke-hosting.mjs` check
against that URL, and posts the URL as one sticky PR comment. So a stale shell, wrong asset bytes, a
broken SPA rewrite or a reordered `headers` array fails on the PR instead of after merge.

- **Hosting only.** A preview channel never carries rules, indexes or storage rules; those still ship
  through the staged scopes above.
- Channels expire after **7 days** (`--expires 7d`), so closed PRs do not accumulate. One channel per PR
  is reused on every push.
- The URL is public but unguessable and serves the same login-gated bundle.
- **Fork PRs are skipped**, because they never receive `FIREBASE_SERVICE_ACCOUNT`.
- It is not a required check: a hosting change can still be merged without it, so treat a failing preview
  as a blocker by convention, not by branch protection.
- If the comment step fails with `403 Resource not accessible by integration`, set
  Settings → Actions → General → Workflow permissions to **Read and write**.

### Deploying from your machine (break-glass, same order)

`git push` deploys nothing, and there is no supported one-shot `firebase deploy`:

```bash
npm ci && npm run lint && npm run build && npm test
firebase deploy --only hosting --project <project-id>
npm run smoke:hosting -- --base-url=https://<project-id>.web.app
firebase deploy --only firestore:rules --project <project-id>
firebase deploy --only firestore:indexes --project <project-id>   # read the diff first
firebase deploy --only storage --project <project-id>             # FIRST-TIME: verify uploads
firebase deploy --only functions --project <project-id>           # needs Blaze
```

> ⚠️ Make sure the project in `.firebaserc` (or `--project`) is right and that the first admin user
exists before rules move, so the deploy cannot lock you out.

### Rolling back (incident procedure)

A rollback republishes a known-good release. Nothing is deleted: the bad hosting release and the bad
ruleset stay in the history, so the incident can be diffed afterwards.
`scripts/rollback-release.mjs` plans a rollback for **hosting** or **Firestore rules**, and writes
nothing unless it is given `--apply`. A dry run only calls the list/get endpoints and prints the live
release plus the candidates it would pick.

1. **Freeze the pipeline.** Cancel any running *Deploy* run in Actions. The workflow's
   `concurrency: deploy-${{ github.ref }}` group queues a new dispatch behind it, so nothing ships
   while you are rolling back. Do not dispatch a deploy to "fix" the problem.
2. **Plan it (dry run).** Default target is the previous release / the previous ruleset. Add
   `--to=<version id>` or `--to=<ruleset id>` to pick another one from the printed candidates.

   ```bash
   TOKEN="$(gcloud auth print-access-token)"
   npm run rollback -- --target=hosting --project=himalye-wonders-gym --access-token="$TOKEN"
   npm run rollback -- --target=rules   --project=himalye-wonders-gym --access-token="$TOKEN"
   ```

3. **Apply, then verify.** Re-run the same command with `--apply`. For hosting, prove the live origin
   is the older bundle with `npm run smoke:hosting`; for rules, sign in and open one payment, because a
   rules regression only shows up on a real read/write.

   ```bash
   npm run rollback -- --target=hosting --project=himalye-wonders-gym --access-token="$TOKEN" --apply
   npm run smoke:hosting
   ```

Permissions: `firebasehosting.releases.create` for hosting, and `firebaserules.rulesets.create` plus
`firebaserules.releases.update` for rules. Neither path calls `firebaserules.googleapis.com:test` — the
call that still 403s for the deploy service account — so a rules rollback does not wait on
`roles/firebaserules.admin`. **Neither path has been exercised against the production project yet:**
the first real use is a dry run, then `--apply`, then the verification step above.

## Production deployment checklist

Nothing deploys on `git push`. Hosting, Firestore rules and indexes ship as separate steps, and each
one is checked on the live origin before the next is allowed to run.

**Before the first dispatch**

- [ ] Secret `FIREBASE_SERVICE_ACCOUNT` exists, plus optional variables `FIREBASE_PROJECT_ID` and
      `FIREBASE_HOSTING_URL`.
- [ ] `main` CI is green — the deploy workflow re-checks this for the exact commit and refuses otherwise.
- [ ] Storage rules have been released at least once (`firebase deploy --only storage`). If the bucket
      has never had rules, client uploads are denied and member photos / logos do not work. Storage is
      not part of the workflow.
- [ ] Cloud Functions are deployed (`firebase deploy --only functions`, Blaze required), otherwise
      membership `status` is never derived server-side, expiry reminders never run and there is no
      nightly backup.
- [ ] Build `.env` from `.env.example`. `VITE_ENABLE_SEEDING` must stay `false` in production.

**Staged deploy**

1. `deploy_scope=hosting` — publishes `dist/`, then the smoke check proves the live URL is that build
   (same entry hashes, same bytes, deep link through the SPA rewrite).
2. Load the app once and check the browser console for CSP violations (`firebase.json` ships a
   Content-Security-Policy). If anything is wrong, roll back to the previous bundle before continuing.
3. `deploy_scope=hosting+rules` — the Firestore rules move. Re-check login, tenancy and one payment.
4. `deploy_scope=hosting+rules+indexes` — read the index diff in the job summary first; the first run
   after the cleanup is expected to plan ~10 deletions, and the job refuses to continue unless
   `confirm_index_deletions` is ticked.

Before the rules move (step 3), confirm in the Firebase Console:

- [ ] `gyms/{gymId}` exists for every gym, with `ownerUid` and `receiptPrefix` (required before any
      receipt can be issued — `receiptPrefixGuard` fails closed).
- [ ] `users/{uid}` exists for every staff account with `role` + `gymId`.

> Data reset: the audit branch contains no production data. To start clean, delete the test
> collections from Firestore (or use a fresh Firebase project) **before** creating the first real
> gym, then provision `gyms/{gymId}` as described above.

## Cloud Functions

The `functions/` folder ships two scheduled jobs:

1. **Daily backup** — exports every collection to `gs://<bucket>/backups/<date>/`.
2. **Membership expiry reminders** — flags memberships expiring within 7 days and writes an
   audit entry. Email/SMS delivery is a documented TODO (`sendReminderEmail`).

Deploy with `firebase deploy --only functions`.

## Roadmap (v2 ideas)

- Member self-service portal (login with their own account — data model ready via `memberUid`)
- Email/SMS reminders via Cloud Functions
- ID-card printing with QR codes
- Payment gateway integration
- PWA installable / offline-friendly shell
- Multi-location support

## License

Private project. All rights reserved.
