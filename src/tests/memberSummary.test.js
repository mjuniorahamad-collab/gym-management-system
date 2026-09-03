import { describe, expect, it } from 'vitest'
import { buildMemberSummary } from '@/utils/memberSummary'

const baseMember = {
  id: 'm1',
  name: 'Umar',
  phone: '9801234567',
  joinDate: '2026-07-01',
  fatherName: '',
  isPT: false,
  gymId: 'gym-a',
  notes: 'Internal admin note',
}

const basePlan = { id: 'p1', name: 'Monthly', price: 1500, durationDays: 30 }

const basePtCharge = { base: 1500, addon: 0, total: 1500 }

const baseLedger = { totals: { billed: 1500, paid: 1500, due: 0 } }

const baseSettings = { gymName: 'ABC Fitness', currency: 'INR' }

function build(overrides = {}) {
  return buildMemberSummary({
    member: baseMember,
    plan: basePlan,
    expiry: new Date(2026, 8, 30),
    ptCharge: basePtCharge,
    ledger: baseLedger,
    settings: baseSettings,
    whatsAppLink: '',
    ...overrides,
  })
}

describe('buildMemberSummary', () => {
  it('renders the correct member identity', () => {
    const summary = build()
    expect(summary).toContain('Hi Umar,')
    expect(summary).toContain('Here is your membership summary:')
    expect(summary).toContain('ABC Fitness')
  })

  it('renders membership correctly', () => {
    const summary = build()
    expect(summary).toContain('Membership: Monthly')
    expect(summary).toContain('Started: Jul 1, 2026')
    expect(summary).toContain('Valid until: Sep 30, 2026')
  })

  it('renders the current total correctly', () => {
    const summary = build({ ptCharge: { base: 1500, addon: 1000, total: 2500 } })
    expect(summary).toContain('Total: ₹2,500')
  })

  it('renders the paid amount correctly', () => {
    const summary = build({ ledger: { totals: { billed: 2500, paid: 1500, due: 1000 } } })
    expect(summary).toContain('Paid: ₹1,500')
  })

  it('renders the due amount correctly', () => {
    const summary = build({ ledger: { totals: { billed: 2500, paid: 1500, due: 1000 } } })
    expect(summary).toContain('Due: ₹1,000')
  })

  it('renders a PT member with the correct PT amount', () => {
    const summary = build({
      member: { ...baseMember, isPT: true },
      ptCharge: { base: 1500, addon: 1000, total: 2500 },
    })
    expect(summary).toContain('Personal Training: ₹1,000')
    expect(summary).toContain('Total: ₹2,500')
  })

  it('respects the per-member PT override through the passed ptCharge', () => {
    const summary = build({
      member: { ...baseMember, isPT: true, ptSurchargeOverride: 500 },
      ptCharge: { base: 1500, addon: 500, total: 2000 },
    })
    expect(summary).toContain('Personal Training: ₹500')
    expect(summary).toContain('Total: ₹2,000')
  })

  it('does not include a PT line for a regular member', () => {
    const summary = build()
    expect(summary).not.toContain('Personal Training')
    expect(summary).toContain('Plan: ₹1,500')
    expect(summary).toContain('Total: ₹1,500')
  })

  it('includes Father Name only when present', () => {
    expect(build()).not.toContain("Father's Name")
    expect(build({ member: { ...baseMember, fatherName: 'Ahmed' } })).toContain("Father's Name: Ahmed")
  })

  it('does not expose internal/private fields', () => {
    const summary = build()
    expect(summary).not.toContain('m1')
    expect(summary).not.toContain('gym-a')
    expect(summary).not.toContain('Internal admin note')
    expect(summary).not.toContain('notes')
  })

  it('does not expose a member number if present', () => {
    const summary = build({ member: { ...baseMember, memberNo: 'MEM-0001' } })
    expect(summary).not.toContain('MEM-0001')
  })

  it('appends the WhatsApp group link when a link is provided', () => {
    const summary = build({ whatsAppLink: 'https://chat.whatsapp.com/abc' })
    expect(summary).toContain('Join our WhatsApp group: https://chat.whatsapp.com/abc')
  })

  it('does not append a group link when none is provided', () => {
    const summary = build({ whatsAppLink: '' })
    expect(summary).not.toContain('Join our WhatsApp group')
  })
})
