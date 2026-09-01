import { createDoc, getById, removeDoc, updateDocById } from './firestore'
import { logAudit } from './audit'
import { parseDate } from '@/utils/dateHelpers'

const MAX_WEIGHT = 500

/**
 * Strictly parse a YYYY-MM-DD measurement date so days beyond the calendar
 * (e.g. Feb 30) are treated as invalid instead of being silently rolled over
 * by the platform's Date parser.
 */
function validDate(date) {
  const parsed = parseDate(date)
  if (!parsed) return null
  const normalized = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(
    parsed.getDate()
  ).padStart(2, '0')}`
  return normalized === String(date) ? parsed : null
}

/**
 * Validate a single weight measurement before persisting it. Shared by the
 * add and edit paths so invalid values are never written.
 *
 * - weight must be a positive number (decimals allowed) with a sensible max
 * - date must resolve to a real date
 *
 * Throws a descriptive error on invalid input.
 */
export function validateWeightRecord({ weight, date }) {
  const w = Number(weight)
  if (weight === undefined || weight === null || weight === '') {
    throw new Error('Weight is required')
  }
  if (!Number.isFinite(w) || w <= 0) {
    throw new Error('Weight must be a positive number')
  }
  if (w > MAX_WEIGHT) {
    throw new Error(`Weight seems too high (maximum ${MAX_WEIGHT} kg)`)
  }
  if (!date) {
    throw new Error('Date is required')
  }
  if (!validDate(date)) {
    throw new Error('Enter a valid date')
  }
  return { weight: w, date }
}

/**
 * Derive the member's weight progress from a flat list of weight records.
 *
 * This is the single source of truth for the Progress tab summary:
 *   - chronological: records sorted oldest → newest by measurement date
 *   - current: the latest (most recent date) measurement
 *   - starting: the earliest recorded measurement
 *   - change: current - starting (a signed value; negative = loss)
 *
 * Returns a plain object. Records with no valid date are ignored for the
 * chronological ordering.
 */
export function parseWeightHistory(records = []) {
  const valid = records.filter((r) => r && r.id && Number.isFinite(Number(r.weight)) && parseDate(r.date))
  const chronological = [...valid].sort(
    (a, b) => (parseDate(a.date).getTime() - parseDate(b.date).getTime()) || String(a.id).localeCompare(String(b.id))
  )
  const current = chronological.length ? chronological[chronological.length - 1] : null
  const starting = chronological.length ? chronological[0] : null
  const change =
    current && starting ? Math.round((Number(current.weight) - Number(starting.weight)) * 10) / 10 : null
  return { chronological, current, starting, change }
}

/**
 * Add a new weight measurement for a member. Never overwrites an existing
 * measurement — each call creates a fresh history entry. Returns the new id.
 */
export async function addWeightRecord(memberId, input) {
  if (!memberId) throw new Error('A member ID is required')
  const { weight, date } = validateWeightRecord(input)
  const id = await createDoc('weightRecords', {
    memberId,
    weight,
    date,
  })
  await logAudit({
    action: 'create',
    entity: 'weightRecords',
    entityId: id,
    details: { memberId, weight, date },
  })
  return id
}

/**
 * Correct an existing weight measurement (only weight + date can change). The
 * patch is whitelisted so unrelated fields can never be overwritten.
 * Returns the updated fields.
 */
export async function updateWeightRecord(recordId, input) {
  if (!recordId) throw new Error('A record ID is required')
  const { weight, date } = validateWeightRecord(input)
  await updateDocById('weightRecords', recordId, { weight, date })
  await logAudit({
    action: 'update',
    entity: 'weightRecords',
    entityId: recordId,
    details: { weight, date },
  })
  return { id: recordId, weight, date }
}

/**
 * Delete a single weight measurement. Only that one record is removed — other
 * entries and member profile data are untouched.
 */
export async function deleteWeightRecord(recordId) {
  if (!recordId) throw new Error('A record ID is required')
  await removeDoc('weightRecords', recordId)
  await logAudit({
    action: 'delete',
    entity: 'weightRecords',
    entityId: recordId,
    details: {},
  })
  return recordId
}

/**
 * Set (or clear) a member's fitness goal and optional target weight.
 *
 * The goal/target live on the member document as single current values (like
 * `status`/`notes`), never as a separate collection. Passing an empty goal
 * clears it. Target weight stays optional — it is not required for goals such
 * as Strength, General Fitness or Endurance.
 */
export async function setFitnessGoal(memberId, { fitnessGoal = '', targetWeight = '' } = {}) {
  if (!memberId) throw new Error('A member ID is required')
  const member = await getById('members', memberId)
  if (!member) throw new Error('Member not found')

  const patch = {}
  if (typeof fitnessGoal === 'string') patch.fitnessGoal = fitnessGoal

  if (targetWeight === '' || targetWeight === null || targetWeight === undefined) {
    patch.targetWeight = ''
  } else {
    const t = Number(targetWeight)
    if (!Number.isFinite(t) || t <= 0) throw new Error('Target weight must be a positive number')
    if (t > MAX_WEIGHT) throw new Error(`Target weight seems too high (maximum ${MAX_WEIGHT} kg)`)
    patch.targetWeight = t
  }

  await updateDocById('members', memberId, patch)
  await logAudit({
    action: 'update',
    entity: 'members',
    entityId: memberId,
    details: { fitnessGoal: patch.fitnessGoal, targetWeight: patch.targetWeight, action: 'set-goal' },
  })
  return { id: memberId, ...patch }
}
