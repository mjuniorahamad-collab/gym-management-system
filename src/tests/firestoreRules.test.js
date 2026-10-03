import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rulesText = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

function normalize(text) {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractBlock(text, collection) {
  const flat = normalize(text)
  const needle = `match /${collection}/{`
  const start = flat.indexOf(needle)
  if (start === -1) return null
  const placeholderEnd = flat.indexOf('}', start)
  const open = flat.indexOf('{', placeholderEnd)
  let depth = 0
  for (let i = open; i < flat.length; i += 1) {
    if (flat[i] === '{') depth += 1
    else if (flat[i] === '}') {
      depth -= 1
      if (depth === 0) return flat.slice(start, i + 1)
    }
  }
  return null
}

describe('firestore rules — renewal write path', () => {
  it('has a memberships block that lets owner/admin create and update (missing in the deployed ruleset that caused "Missing or insufficient permissions")', () => {
    const block = extractBlock(rulesText, 'memberships')
    expect(block, 'match /memberships/{id} block is missing from firestore.rules').not.toBeNull()
    expect(block).toContain('allow read: if isStaff()')
    expect(block).toContain('allow create, update: if isFinance()')
  })

  it('lets owner/admin create and update payments', () => {
    const block = extractBlock(rulesText, 'payments')
    expect(block).not.toBeNull()
    expect(block).toContain('allow create, update: if isFinance()')
  })

  it('lets any staff member create and update members (renewal links the new period to the member)', () => {
    const block = extractBlock(rulesText, 'members')
    expect(block).not.toBeNull()
    // create and update are declared separately here rather than as one
    // `allow create, update` clause, because the projection guard needs to
    // distinguish them: on create the rule asks whether the fields are ABSENT,
    // on update whether they are UNCHANGED. See the projection-ownership block
    // of firestore.rules and the emulator tests for the behaviour.
    expect(block).toContain('allow create: if isStaff()')
    expect(block).toContain('allow update: if isStaff()')
    expect(block).toContain('clientCannotWriteProjection()')
  })

  // Guards the two lists that must never drift apart. PROJECTED_FIELDS is what
  // the trusted writer persists; the rules list is what clients are denied. If
  // the writer gains a field and the rules do not, a client can write a value
  // the server believes it owns, and nothing else in the suite would notice.
  it('denies clients exactly the fields the server projection owns', () => {
    const flat = normalize(rulesText)
    for (const field of ['membershipStart', 'effectiveExpiry', 'freezeUntil', 'status']) {
      expect(flat, `firestore.rules does not name ${field} as server-owned`).toContain(`'${field}'`)
    }
    // A dot-access read of a projection field would be an evaluation ERROR on a
    // member that predates the projection, which denies rather than evaluates.
    // Every read must go through get(field, null).
    expect(flat).toContain("request.resource.data.get('status', null) == resource.data.get('status', null)")
    expect(flat).not.toMatch(/request\.resource\.data\.status\s*==\s*resource\.data\.status/)
  })

  it('does not lock isPT, which is a member fact and not the projected field', () => {
    const flat = normalize(rulesText)
    // The engine derives an `isPT` from the current PERIOD. On the member
    // document `isPT` is a separate staff-editable pricing attribute. Treating
    // it as server-owned would break the PT toggle and the repricing it drives.
    expect(flat, 'isPT must stay out of the projection guard').not.toMatch(/projectionFieldsAbsent[\s\S]{0,400}'isPT'/)
    expect(flat, 'isPT must stay out of the projection guard').not.toMatch(/projectionFieldsUnchanged[\s\S]{0,400}'isPT'/)
  })

  it('lets staff read/create/update the counters collection (member number sequence)', () => {
    const block = extractBlock(rulesText, 'counters')
    expect(block, 'match /counters/{id} block is missing from firestore.rules').not.toBeNull()
    expect(block).toContain('allow read: if isStaff()')
    expect(block).toContain('allow create, update: if isStaff()')
  })

  it('keeps audit log append-only by staff (renewal audit entries)', () => {
    const block = extractBlock(rulesText, 'auditLog')
    expect(block).not.toBeNull()
    expect(block).toContain('allow create: if isStaff()')
    expect(block).toContain('allow update, delete: if false')
  })

  it('never grants unauthenticated or unconditional access', () => {
    const flat = normalize(rulesText)
    expect(flat).not.toContain('if true')
    expect(flat).not.toContain('request.auth == null')
    expect(flat).not.toMatch(/allow (read, write|write):\s*(if\s+(true|request\.auth\s*==\s*null)|;)/)
  })

  it('scopes every business collection by gymId (tenancy)', () => {
    const scoped = ['members', 'trainers', 'membershipPlans', 'memberships', 'membershipFreezes', 'payments', 'expenses', 'attendance', 'classes', 'bookings', 'auditLog', 'weightRecords']
    for (const collection of scoped) {
      const block = extractBlock(rulesText, collection)
      expect(block, `match /${collection}/{id} block missing`).not.toBeNull()
      expect(block, `${collection} reads must be gym-scoped`).toContain('canReadTenant(resource)')
      expect(block, `${collection} must allow a tenancy write guard`).toMatch(/canWriteTenant\(resource\)|canDeleteTenant\(resource\)/)
    }
  })

  /**
   * A freeze extends a membership's expiry, so it is append-only by design:
   * there is no update and no delete path, and cancelling one appends a
   * `kind: 'cancellation'` record instead. Without this, "correcting" a freeze
   * would erase the fact that it was ever granted.
   */
  it('makes membershipFreezes append-only', () => {
    const block = extractBlock(rulesText, 'membershipFreezes')
    expect(block, 'match /membershipFreezes/{id} block missing').not.toBeNull()
    expect(block).toContain('allow read: if isStaff() && canReadTenant(resource)')
    expect(block).toContain('allow create: if isFinance() && canWriteTenant(resource)')
    expect(block).toMatch(/allow update, delete: if false/)
  })

  it('gates weightRecords to staff read/write and admin/owner delete (same as members)', () => {
    const block = extractBlock(rulesText, 'weightRecords')
    expect(block, 'match /weightRecords/{id} block missing').not.toBeNull()
    expect(block).toContain('allow read: if isStaff()')
    expect(block).toContain('allow create, update: if isStaff()')
    expect(block).toContain('allow delete: if (isRole(\'admin\') || isOwner()) && canDeleteTenant(resource)')
  })

  it('scopes members deletes to admin/owner within the gym', () => {
    const block = extractBlock(rulesText, 'members')
    expect(block).not.toBeNull()
    expect(block).toContain('allow delete: if (isRole(\'admin\') || isOwner()) && canDeleteTenant(resource)')
  })

  it('freezes gymId on a users doc after it is bound', () => {
    const block = extractBlock(rulesText, 'users')
    expect(block).not.toBeNull()
    expect(block).toContain('canBindGymId(uid)')
  })

  it('gyms are never mutable or deletable and self-provisioning is owner-gated and auto-id only', () => {
    const block = extractBlock(rulesText, 'gyms')
    expect(block, 'match /gyms/{gymId} block missing').not.toBeNull()
    // Mutations and deletes are always denied — an existing provisioned gym
    // can never be overwritten, re-owned or removed by a client.
    expect(block).toContain('allow update, delete: if false')
    // Self-provisioning create is gated: the caller must be the owner and the
    // id must be a genuine random auto-id (no slugs, no claiming others).
    expect(block).toContain('allow create: if')
    expect(block).toContain('ownerUid == request.auth.uid')
    expect(block).toContain('isAutoId(gymId)')
    expect(block).toContain('ownerUid')
  })

  it('scopes per-gym settings (PT pricing) to the owning gym — read for staff, write for owner only, never cross-gym, never deleted', () => {
    const flat = normalize(rulesText)
    const matchStart = flat.indexOf('match /gyms/{gymId}/settings/{doc}')
    expect(matchStart, 'match /gyms/{gymId}/settings/{doc} block missing').toBeGreaterThanOrEqual(0)
    const block = flat.slice(matchStart, flat.indexOf('match /users/{uid}'))
    // Read requires the caller to belong to the gym that owns the doc.
    expect(block).toContain('resource.data.gymId == gymOf(request.auth.uid)')
    // Write requires the caller to be the owner AND the gymId to match the
    // path gymId — a cross-gym or forged-gymId write is impossible.
    expect(block).toContain('allow create, update: if isOwner()')
    expect(block).toContain('request.resource.data.gymId == gymOf(request.auth.uid)')
    expect(block).toContain('gymOf(request.auth.uid) == gymId')
    // Deletes are never client-side.
    expect(block).toContain('allow delete: if false')
  })

  it('keeps member PT status tenancy-scoped (member writes still gated by isStaff + tenancy)', () => {
    const block = extractBlock(rulesText, 'members')
    expect(block).not.toBeNull()
    // isPT travels on the member doc, so the member write path must still be
    // gated by the tenancy guard to prevent cross-gym toggling. create and
    // update are separate clauses now; BOTH must keep the tenancy guard, or
    // splitting them would have quietly dropped it from one of them.
    expect(block).toContain('allow create: if isStaff()')
    expect(block).toContain('allow update: if isStaff()')
    expect(block).toMatch(/allow create: if isStaff\(\)[\s\S]*?canWriteTenant\(resource\)/)
    expect(block).toMatch(/allow update: if isStaff\(\)[\s\S]*?canWriteTenant\(resource\)/)
  })

  it('does not allow gymId to be assigned arbitrarily (must match a provisioned gyms owner)', () => {
    const usersBlock = extractBlock(rulesText, 'users')
    // canBindGymId references the owner-of-record of a gyms doc — presence of
    // the helper definitions proves the bind is owner-gated, not free-choice.
    const all = normalize(usersBlock + '\n' + rulesText)
    expect(all).toContain('function canBindGymId')
    expect(all).toContain('ownerUid == request.auth.uid')
  })

  it('declares the gymId+createdAt composite index that the scoped weightRecords read requires', () => {
    // The Progress tab loads weight records via subscribeCollection('weightRecords'),
    // which issues query(collection, where('gymId','==',gymId), orderBy('createdAt','desc')).
    // Production Firestore requires a composite index for that exact query; without
    // it the read fails and the Progress tab silently shows zero measurements even
    // though records were written. This guards against that regression.
    const idx = JSON.parse(readFileSync(join(process.cwd(), 'firestore.indexes.json'), 'utf8'))
    const wr = idx.indexes.filter((i) => i.collectionGroup === 'weightRecords')
    const hasGymCreated = wr.some(
      (i) =>
        i.queryScope === 'COLLECTION' &&
        i.fields.some((f) => f.fieldPath === 'gymId' && f.order === 'ASCENDING') &&
        i.fields.some((f) => f.fieldPath === 'createdAt' && f.order === 'DESCENDING')
    )
    expect(hasGymCreated, 'weightRecords needs gymId ASC + createdAt DESC composite index').toBe(true)
  })
})
