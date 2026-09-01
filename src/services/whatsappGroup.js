import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db, isFirebaseConfigured } from '@/firebase'
import { getGymId } from './ownerContext'
import { logAudit } from './audit'
import { whatsAppLinkSchema } from '@/schemas/validationSchemas'
import { buildWhatsAppGroupInviteMessage, buildWhatsAppUrl } from '@/utils/membership'

/**
 * Per-gym WhatsApp group invite link.
 *
 * Stored tenant-safely as the singleton document `gyms/{gymId}/settings/whatsapp`.
 * This is a SUB-COLLECTION of the owner-of-record gym document — it carries
 * gymId and inherits the per-gym security gating in firestore.rules, so one
 * gym can never read or write another gym's group invite link. The global
 * `settings/app` singleton is deliberately NOT used because it is shared
 * across tenants.
 *
 * A missing document means "no WhatsApp group configured" → treated as an
 * empty link (the member action is hidden). Each gym sets its own link. The
 * link is never used to force or silently add anyone to a group — it only
 * opens the voluntary invite/join flow for the owner to share.
 */

const SETTINGS_SUB = 'settings'
const WHATSAPP_DOC = 'whatsapp'

// Module-level cache used only in demo/offline (mock) mode, mirroring the
// mockStore pattern so the UI stays testable without Firebase.
let mockLink = ''

function isReady() {
  return isFirebaseConfigured && Boolean(db)
}

function whatsappRef() {
  const gymId = getGymId()
  if (!gymId && isReady()) {
    throw new Error('No gym selected — WhatsApp group settings are scoped to a gym')
  }
  return { gymId, ref: doc(db, 'gyms', gymId, SETTINGS_SUB, WHATSAPP_DOC) }
}

/**
 * Read the current gym's WhatsApp group invite link.
 *
 * Returns an empty string when unset or not readable (the action is simply
 * hidden), so callers never surface raw Firestore errors to members.
 *
 * @returns {Promise<string>} the configured invite link ('' if not configured)
 */
export async function getWhatsAppLink() {
  if (!isReady()) return mockLink
  const { ref } = whatsappRef()
  try {
    const snap = await getDoc(ref)
    if (!snap.exists()) return ''
    const data = snap.data()
    return typeof data.link === 'string' ? data.link : ''
  } catch {
    return ''
  }
}

/**
 * Set the current gym's WhatsApp group invite link (owner-only gated in rules).
 * An empty string clears/disables the link.
 *
 * @param {string} link trimmed invite link or ''
 * @returns {Promise<void>}
 */
export async function setWhatsAppLink(link) {
  const parsed = whatsAppLinkSchema.parse(link)
  if (!isReady()) {
    mockLink = parsed
    return
  }
  const { gymId, ref } = whatsappRef()
  await setDoc(ref, { link: parsed, gymId, updatedAt: new Date() }, { merge: true })
  await logAudit({
    action: 'update',
    entity: 'settings',
    entityId: `whatsapp-${gymId}`,
    details: { linkSet: parsed !== '' },
  })
}

/**
 * Clear/disable the current gym's WhatsApp group link. This is modeled as an
 * update (empty link), not a delete, so the existing rule that denies settings
 * deletes stays intact.
 *
 * @returns {Promise<void>}
 */
export async function clearWhatsAppLink() {
  await setWhatsAppLink('')
}

/**
 * Open the configured invite link in the safest browser-compatible way. The
 * invite/join flow is voluntary — nothing is ever sent or added automatically.
 * If the browser blocks the popup, the link is copied to the clipboard so the
 * owner is never stranded without a usable action.
 *
 * @param {string} link the configured group invite link
 * @returns {Promise<{ok: boolean}>}
 */
export async function openWhatsAppGroup(link) {
  const opened = Boolean(window.open(link, '_blank', 'noopener,noreferrer'))
  if (!opened && link && typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(link)
      return { ok: true, copied: true }
    } catch {
      return { ok: false }
    }
  }
  return { ok: opened }
}

/**
 * Open a WhatsApp chat with a specific member, pre-filling an invitation that
 * contains the gym's configured group invite link. Nothing is ever sent
 * automatically — the owner presses Send in WhatsApp decides. The member joins
 * voluntarily. If the member has no valid phone the WhatsApp chat is NOT
 * attempted; the group invite link is returned via `fallbackCopy` so the owner
 * can still share it manually (the caller shows the existing-style error and
 * copies the link).
 *
 * @param {object} opts
 * @param {string} opts.memberName member's display name
 * @param {string} opts.phone member's stored phone number
 * @param {string} opts.link the configured gym group invite link
 * @param {string} [opts.gymName] configured gym name (used in the message)
 * @returns {Promise<{ok: boolean, copied?: boolean, reason?: string, fallbackCopy?: string}>}
 */
export async function openWhatsAppGroupInvite({ memberName, phone, link, gymName }) {
  const normalized = buildWhatsAppUrl(phone, buildWhatsAppGroupInviteMessage({ memberName, gymName, link }))
  if (!normalized.ok) {
    // No usable phone → never attempt a chat. Surface the existing-style
    // fallback and let the owner copy the group invite link instead.
    return { ok: false, reason: normalized.error || 'Phone number is missing or invalid for WhatsApp', fallbackCopy: link }
  }
  const opened = Boolean(window.open(normalized.url, '_blank', 'noopener,noreferrer'))
  if (!opened && link && typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(link)
      return { ok: true, copied: true, fallbackCopy: link }
    } catch {
      return { ok: false, reason: 'Could not open WhatsApp', fallbackCopy: link }
    }
  }
  return { ok: opened, fallbackCopy: link }
}

export { WHATSAPP_DOC }
