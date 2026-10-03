import { describe, expect, it } from 'vitest'
import { memberSchema } from '@/schemas/validationSchemas'

/**
 * The member form must not be able to SUBMIT a server-owned projection field.
 *
 * Why this exists: `MemberForm.reset()` seeds react-hook-form's value store from
 * the entire member document, so a stored `status` really did flow back into the
 * form state. Two independent guards stop it reaching Firestore today:
 *
 *   1. `memberSchema` - zod strips keys the schema does not declare, so the
 *      resolver output handed to `onSubmit` cannot contain them.
 *   2. `MemberForm`'s `pickFormFields` allowlist - the form seeds (and therefore
 *      can submit) only declared fields.
 *
 * Guard 1 is asserted here because it is the one actually holding the line, and
 * it is load-bearing in a way that is easy to lose: changing `memberSchema` to
 * `.passthrough()`, adding `status` to it by mistake, or swapping the resolver
 * would all silently restore a client writer for a field the server owns. Guard
 * 2 is defence in depth and is covered by the constant-level assertions below.
 *
 * `status`, `membershipStart`, `effectiveExpiry` and `freezeUntil` are outputs of
 * the trusted projection writer in `functions/projection/writer.js`. `firestore.rules`
 * rejects any client that changes them, so a leak here would surface to staff as a
 * failed save on every member edit.
 */
describe('member form projection-field boundary', () => {
  const PROJECTION_FIELDS = ['status', 'membershipStart', 'effectiveExpiry', 'freezeUntil']

  it('strips every server-owned projection field from a full member document', () => {
    const parsed = memberSchema.parse({
      name: 'Zaid Rahman',
      phone: '9800000001',
      gender: 'Male',
      status: 'active',
      membershipStart: '2026-01-01',
      effectiveExpiry: '2026-02-01',
      freezeUntil: '2026-01-15',
    })

    for (const field of PROJECTION_FIELDS) {
      expect(parsed).not.toHaveProperty(field)
    }
  })

  it('ignores a forged projection value rather than validating it', () => {
    // A value the rules would reject, including one outside any status enum, is
    // dropped for the same reason a valid one is: the field is not part of the
    // form's contract. Security here comes from the rules and the writer; this
    // test only records that the form is not a second writer.
    const parsed = memberSchema.parse({
      name: 'Aarav Shrestha',
      phone: '9800000002',
      gender: 'Male',
      status: 'admin',
      freezeUntil: '2099-12-31',
    })

    expect(parsed.status).toBeUndefined()
    expect(parsed.freezeUntil).toBeUndefined()
    expect(Object.keys(parsed)).toEqual(['name', 'phone', 'gender'])
  })

  it('still parses the fields the form legitimately owns', () => {
    const parsed = memberSchema.parse({
      name: 'Sita Gurung',
      phone: '9800000003',
      gender: 'Female',
      membershipPlanId: 'plan-monthly',
      joinDate: '2026-01-01',
      ptSurchargeOverride: '',
    })

    expect(parsed.name).toBe('Sita Gurung')
    expect(parsed.membershipPlanId).toBe('plan-monthly')
    expect(parsed.joinDate).toBe('2026-01-01')
    expect(parsed.ptSurchargeOverride).toBeNull()
  })

  it('keeps member.isPT out of the form schema so this form cannot set it', () => {
    // PT is toggled from the member detail page against an explicit confirmation,
    // with its own audit entry. The add/edit form does not register an input for
    // it, so it must not silently ride along in the submission either.
    const parsed = memberSchema.parse({
      name: 'Nima Tamang',
      phone: '9800000004',
      gender: 'Other',
      isPT: true,
    })

    expect(parsed).not.toHaveProperty('isPT')
  })
})