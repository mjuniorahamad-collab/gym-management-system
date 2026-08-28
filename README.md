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
Add more staff under **Settings → Load sample data / manage roles** (update `users/{uid}` role docs).

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

```bash
# 1. One-time: install the Firebase CLI and log in
npm i -g firebase-tools
firebase login

# 2. Point the project at your Firebase project
firebase use --add            # select your project

# 3. Build the frontend
npm run build

# 4. Deploy everything
firebase deploy               # hosting + firestore rules + storage rules + functions

# Or deploy piece by piece:
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only storage
firebase deploy --only functions
```

> ⚠️ Before deploying, set your project in `.firebaserc` (or via `firebase use`) and make sure
> the first admin user exists so rules don't lock you out.

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
