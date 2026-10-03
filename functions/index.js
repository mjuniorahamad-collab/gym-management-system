/**
 * Gym Management System — Cloud Functions
 *
 * Scheduled jobs (v2 automation layer):
 * 1. dailyBackup               — exports all Firestore collections to Storage
 * 2. membershipExpiryReminders — flags memberships expiring in the next 7 days
 *
 * Deploy:  npm run deploy   (runs `npm run build` first — see predeploy)
 *
 * NOTE: Email/SMS delivery is intentionally left as a TODO. Wire in a provider
 * (e.g. Resend, Twilio, Mailgun) as the `deliver` option in
 * ./projection/reminders.js — there is no provider, and none is called.
 *
 * ## Module system
 *
 * This package is ESM (`"type": "module"`). The projection engine is BUNDLED
 * from the frontend's canonical `src/utils/` into `vendor/projection.mjs` by
 * `npm run build`, because a deployed function cannot import anything outside
 * this directory. `vendor/` is generated output — never edit it by hand, and
 * never add a second copy of the projection logic here.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { firestore, storage } from './projection/admin.js'
import { runExpiryReminderJob, REMINDER_WINDOW_DAYS } from './projection/reminders.js'

/**
 * Callable: ask the trusted writer to recompute one member's projection.
 * See ./projection/reproject.js for the authorization chain.
 */
export { reprojectMember } from './projection/reproject.js'

const STORAGE_BACKUP_PREFIX = 'backups'

/**
 * Daily backup of every collection to Cloud Storage.
 * Reads from emulator-safe environment if configured.
 */
export const dailyBackup = onSchedule(
  {
    schedule: 'every day 02:00',
    timeZone: 'Asia/Kathmandu',
    memory: '256MiB',
  },
  async () => {
    const db = firestore()
    const dateFolder = new Date().toISOString().slice(0, 10)
    const collections = await db.listCollections()

    for (const col of collections) {
      const snap = await col.get()
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      const bucket = storage().bucket()
      const file = bucket.file(`${STORAGE_BACKUP_PREFIX}/${dateFolder}/${col.id}.json`)
      await file.save(JSON.stringify(data, null, 2), {
        contentType: 'application/json',
        resumable: false,
      })
      console.log(`Backed up ${col.id}: ${data.length} docs`)
    }

    await db.collection('auditLog').add({
      action: 'backup',
      entity: 'system',
      entityId: null,
      actor: { name: 'Cloud Function', role: 'system' },
      details: { date: dateFolder },
      timestamp: new Date().toISOString(),
    })

    return { ok: true, date: dateFolder }
  }
)

/**
 * Flags memberships expiring within the next 7 days so staff can follow up.
 *
 * Rebuilt on the authoritative membership model: expiry is derived from
 * `memberships` + `membershipFreezes` through the canonical engine, in each
 * gym's own timezone, rather than from `joinDate + plan.durationDays` and a
 * cached `member.status`. The eligibility window is unchanged (0..7 days
 * inclusive). See ./projection/reminders.js for why each old input was wrong.
 *
 * Read-only: it no longer writes an auditLog document per reminded member.
 */
export const membershipExpiryReminders = onSchedule(
  {
    schedule: 'every day 08:00',
    timeZone: 'Asia/Kathmandu',
    memory: '256MiB',
  },
  async () => {
    const result = await runExpiryReminderJob(firestore())
    console.log(
      `Expiring within ${REMINDER_WINDOW_DAYS} days: ${result.due} (delivered ${result.delivered})`
    )
    return { ok: true, ...result, reminders: undefined }
  }
)
