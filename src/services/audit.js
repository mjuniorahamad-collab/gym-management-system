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
      details: details || {},
      actor: actor ? { name: actor.name, role: actor.role } : null,
      actorId: actor ? actor.uid : null,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    console.error('Audit log failed:', e)
  }
}
