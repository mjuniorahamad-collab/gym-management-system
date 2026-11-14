import { createDoc, isReady } from './firestore'

let actor = null

export function setActor(profile) {
  actor = profile
    ? {
        uid: profile.uid || null,
        name: profile.name || 'Unknown',
        role: profile.role || 'staff',
      }
    : null
}

/**
 * Firestore rejects `undefined` anywhere in a document ("Unsupported field
 * value: undefined"), and this module deliberately never throws — so a single
 * unset optional field used to drop the ENTIRE audit entry, silently. Callers
 * legitimately write `x || undefined` for optional details (a legacy payment
 * with no `memberName`, say), which is exactly the case that lost the record of
 * a deleted payment.
 *
 * Undefined object properties are removed and undefined array slots become
 * null, which is valid Firestore data and keeps the entry.
 */
function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : withoutUndefined(v)))
  // Plain objects only: a Date, a Firestore Timestamp or a FieldValue sentinel
  // passed through `details` must reach Firestore untouched.
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue
      out[key] = withoutUndefined(val)
    }
    return out
  }
  return value
}

/**
 * Append an entry to the audit log. Never throws — auditing must not
 * break normal operations if it fails.
 */
export async function logAudit({ action, entity, entityId, details }) {
  if (!isReady()) return
  try {
    await createDoc('auditLog', {
      action,
      entity,
      entityId: entityId || null,
      details: withoutUndefined(details || {}),
      actor: actor ? { name: actor.name, role: actor.role } : null,
      actorId: actor ? actor.uid : null,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    console.error('Audit log failed:', e)
  }
}
