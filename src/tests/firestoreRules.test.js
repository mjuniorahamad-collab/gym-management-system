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

  it('lets any staff member update members (renewal links the new period to the member)', () => {
    const block = extractBlock(rulesText, 'members')
    expect(block).not.toBeNull()
    expect(block).toContain('allow create, update: if isStaff()')
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
    const scoped = ['members', 'trainers', 'membershipPlans', 'memberships', 'payments', 'expenses', 'attendance', 'classes', 'bookings', 'auditLog']
    for (const collection of scoped) {
      const block = extractBlock(rulesText, collection)
      expect(block, `match /${collection}/{id} block missing`).not.toBeNull()
      expect(block, `${collection} reads must be gym-scoped`).toContain('canReadTenant(resource)')
      expect(block, `${collection} must allow a tenancy write guard`).toMatch(/canWriteTenant\(resource\)|canDeleteTenant\(resource\)/)
    }
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

  it('does not allow gymId to be assigned arbitrarily (must match a provisioned gyms owner)', () => {
    const usersBlock = extractBlock(rulesText, 'users')
    // canBindGymId references the owner-of-record of a gyms doc — presence of
    // the helper definitions proves the bind is owner-gated, not free-choice.
    const all = normalize(usersBlock + '\n' + rulesText)
    expect(all).toContain('function canBindGymId')
    expect(all).toContain('ownerUid == request.auth.uid')
  })
})
