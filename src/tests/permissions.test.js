import { describe, expect, it } from 'vitest'
import { can, isAtLeast, permissionsFor, roleLabel } from '@/utils/permissions'

describe('can', () => {
  it('grants finance access to owner and admin only', () => {
    expect(can('owner', 'finance.write')).toBe(true)
    expect(can('admin', 'finance.write')).toBe(true)
    expect(can('front-desk', 'finance.write')).toBe(false)
    expect(can('trainer', 'finance.write')).toBe(false)
  })

  it('grants membership viewing to all staff', () => {
    expect(can('front-desk', 'members.view')).toBe(true)
    expect(can('trainer', 'members.view')).toBe(true)
  })

  it('restricts settings to owner only', () => {
    expect(can('owner', 'settings.write')).toBe(true)
    expect(can('admin', 'settings.write')).toBe(false)
  })

  it('grants booking management to every staff role', () => {
    // Bookings CRUD is offered to all staff that can open the Classes page, and
    // firestore.rules enforces the tenant boundary on bookings rather than the
    // role, so trainer access must not be narrowed here.
    for (const perm of ['bookings.view', 'bookings.write', 'bookings.delete']) {
      expect(can('owner', perm)).toBe(true)
      expect(can('admin', perm)).toBe(true)
      expect(can('front-desk', perm)).toBe(true)
      expect(can('trainer', perm)).toBe(true)
    }
  })

  it('keeps the full member editor away from trainer only', () => {
    // Distinct from bookings: the rules apply a field-level restriction to
    // trainer writes, so the UI must not offer the full member editor to them.
    expect(can('owner', 'members.write')).toBe(true)
    expect(can('admin', 'members.write')).toBe(true)
    expect(can('front-desk', 'members.write')).toBe(true)
    expect(can('trainer', 'members.write')).toBe(false)
  })

  it('returns false for unknown permissions', () => {
    expect(can('owner', 'nope')).toBe(false)
    expect(can(null, 'members.view')).toBe(false)
  })
})

describe('isAtLeast', () => {
  it('compares role levels', () => {
    expect(isAtLeast('admin', 'front-desk')).toBe(true)
    expect(isAtLeast('trainer', 'admin')).toBe(false)
    expect(isAtLeast(null, 'owner')).toBe(false)
  })
})

describe('permissionsFor', () => {
  it('builds a permission map for a role', () => {
    const map = permissionsFor('admin')
    expect(map['finance.write']).toBe(true)
    expect(map['settings.write']).toBe(false)
  })
})

describe('roleLabel', () => {
  it('labels known roles and falls back', () => {
    expect(roleLabel('front-desk')).toBe('Front Desk')
    expect(roleLabel('weird')).toBe('weird')
    expect(roleLabel()).toBe('—')
  })
})
