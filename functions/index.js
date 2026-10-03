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
 * (e.g. Resend, Twilio, Mailgun) inside `sendReminderEmail` and uncomment.
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

const STORAGE_BACKUP_PREFIX = 'backups'
const REMINDER_WINDOW_DAYS = 7

function daysUntil(target) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(target)
  end.setHours(0, 0, 0, 0)
  return Math.round((end.getTime() - start.getTime()) / 86400000)
}

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
 * Reads members + membershipPlans, then writes an auditLog entry per member.
 */
export const membershipExpiryReminders = onSchedule(
  {
    schedule: 'every day 08:00',
    timeZone: 'Asia/Kathmandu',
    memory: '256MiB',
  },
  async () => {
    const db = firestore()
    const plansSnap = await db.collection('membershipPlans').get()
    const plans = Object.fromEntries(plansSnap.docs.map((d) => [d.id, d.data()]))

    const membersSnap = await db.collection('members').get()
    const expiring = []

    for (const doc of membersSnap.docs) {
      const member = doc.data()
      if (member.status !== 'active' || !member.joinDate || !member.membershipPlanId) continue
      const plan = plans[member.membershipPlanId]
      if (!plan) continue

      const start = new Date(member.joinDate)
      const end = new Date(start.getTime() + plan.durationDays * 86400000)
      const left = daysUntil(end)
      if (left >= 0 && left <= REMINDER_WINDOW_DAYS) {
        expiring.push({ member: doc.id, name: member.name, daysLeft: left })
        await db.collection('auditLog').add({
          action: 'expiry-reminder',
          entity: 'members',
          entityId: doc.id,
          actor: { name: 'Cloud Function', role: 'system' },
          details: { name: member.name, daysLeft: left },
          timestamp: new Date().toISOString(),
        })
        // TODO: send the member an email/SMS here via your provider.
        await sendReminderEmail(member.name, member.email, left)
      }
    }

    console.log(`Expiring in ${REMINDER_WINDOW_DAYS} days:`, expiring)
    return { ok: true, count: expiring.length }
  }
)

async function sendReminderEmail(name, email, daysLeft) {
  if (!email) return
  // TODO: integrate an email/SMS provider (Resend, Twilio, Mailgun, ...).
  // Example (Resend):
  //   const { Resend } = await import('resend')
  //   const resend = new Resend(process.env.RESEND_API_KEY)
  //   await resend.emails.send({
  //     from: 'Himalye Wonders Gym <no-reply@yourdomain.com>',
  //     to: [email],
  //     subject: 'Your gym membership is expiring soon',
  //     text: `Hi ${name}, your membership expires in ${daysLeft} days. Renew today!`,
  //   })
  console.log(`[placeholder] Reminder for ${name} (${email}): ${daysLeft} days left`)
}
