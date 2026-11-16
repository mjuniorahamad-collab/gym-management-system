/**
 * BACKUP / RESTORE — the two halves of a backup that actually exists.
 *
 * `dailyBackup` wrote every collection to a Storage object, and nothing ever
 * verified that the result could be put back. A backup nobody has restored is a
 * hope, not a recovery plan: the failure modes (a collection silently missing
 * from the export, a document that loses its id, a restore that overwrites live
 * data with stale rows) are all invisible until the day it is needed.
 *
 * This module is deliberately plain data in / plain data out, so the round trip
 * can be exercised against the emulator without Storage or a scheduler:
 *
 *   exportAllCollections(db)        -> { [collection]: [{ id, ...data }] }
 *   restoreAllCollections(db, dump) -> { [collection]: count }
 *   compareBackup(db, dump)         -> { missing, extra, changed, total }
 *
 * `restoreAllCollections` is a DRILL tool: it writes documents at their original
 * ids with `set`, which REPLACES a document wholesale. Point it at an empty or
 * dedicated project, never at production data you still need. `dryRun: true`
 * reports exactly the same counts and writes nothing, which is what the drill
 * script uses to prove reachability without touching anything.
 */

/** Every top-level collection as `{ collection: [{ id, ...data }] }`. */
export async function exportAllCollections(db) {
  const collections = await db.listCollections()
  const dump = {}
  for (const col of collections) {
    const snap = await col.get()
    dump[col.id] = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  }
  return dump
}

/** Firestore's batch limit is 500 writes; stay well inside it. */
const BATCH_SIZE = 400

/**
 * Write a dump back, one collection at a time.
 *
 * Returns the per-collection document count that was written (or, for a dry run,
 * the count that WOULD have been written). Ids are preserved exactly: a restore
 * that re-keys documents silently breaks every reference the app makes.
 */
export async function restoreAllCollections(db, dump, { dryRun = false } = {}) {
  const written = {}
  for (const [name, rows] of Object.entries(dump || {})) {
    if (!Array.isArray(rows)) throw new Error(`restore: collection "${name}" is not an array`)
    written[name] = rows.length
    if (dryRun) continue

    let batch = db.batch()
    let queued = 0
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || row.id === '') {
        throw new Error(`restore: a row in "${name}" has no document id`)
      }
      const { id, ...data } = row
      batch.set(db.collection(name).doc(id), data)
      queued += 1
      if (queued === BATCH_SIZE) {
        await batch.commit()
        batch = db.batch()
        queued = 0
      }
    }
    if (queued) await batch.commit()
  }
  return written
}

/**
 * Compare a dump against the database as it is now.
 *
 * `changed` is a shallow field comparison (stable-ordered JSON), which is what a
 * drill needs: it proves a restore reproduced the same values, not just the same
 * document count. Dates are compared through their JSON form, so a Firestore
 * Timestamp that survives the round trip compares equal.
 */
export async function compareBackup(db, dump) {
  const result = { missing: [], extra: [], changed: [], total: 0 }
  for (const [name, rows] of Object.entries(dump || {})) {
    const expected = new Map(rows.map((row) => [row.id, row]))
    const snap = await db.collection(name).get()
    const actual = new Map(snap.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]))
    result.total += expected.size

    for (const [id, row] of expected) {
      const now = actual.get(id)
      if (!now) {
        result.missing.push(`${name}/${id}`)
        continue
      }
      const { id: _id, ...expectedData } = row
      const { id: _nowId, ...actualData } = now
      if (stableJson(expectedData) !== stableJson(actualData)) {
        result.changed.push(`${name}/${id}`)
      }
    }
    for (const id of actual.keys()) {
      if (!expected.has(id)) result.extra.push(`${name}/${id}`)
    }
  }
  return result
}

/** Deterministic JSON so key order cannot produce a false "changed". */
function stableJson(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}
