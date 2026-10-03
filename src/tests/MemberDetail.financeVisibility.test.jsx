/**
 * Roles that can read `members` and `memberships` but NOT `payments`.
 *
 * ## Why this test exists
 *
 * firestore.rules gates the payments collection on isFinance() (owner/admin), and
 * App.jsx routes every finance page behind finance.view (owner/admin). So
 * front-desk and trainer load MemberDetail with an empty payments list.
 *
 * computeMemberLedger derives paid/due purely from that payments list - there is
 * no denormalised fallback on the membership period - so for those roles every
 * period computed as paid=0 and due=full price. The page then presented those
 * figures as fact: a per-period "X paid / Y due" line, a "Total outstanding"
 * banner, an "Amount paid" row on the overview, and a PT dialog quoting a charge
 * offset against a period that appeared unpaid.
 *
 * That is worse than a disclosure leak, because a disclosure leak at least leaks
 * true data. These roles were shown confidently wrong balances. Separately,
 * "Record payment" was gated on members.write (which includes front-desk) while
 * the payments create rule requires isFinance(), so front-desk got a button that
 * could only ever fail a permission check.
 *
 * These assertions pin the masking so the gating cannot be quietly reverted, and
 * they document that the correct figures still reach the roles entitled to them.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const mockState = {
  role: 'front-desk',
  member: null,
  plans: { items: [], loading: false },
  payments: { items: [], loading: false },
  memberships: { items: [], loading: false },
  attendance: { items: [], loading: false },
  weights: { items: [], loading: false },
}

vi.mock('@/context/AuthContext', async () => {
  // `can` is re-exported by AuthContext, so the real permission table is used and
  // the role swap below drives the real finance.view / finance.write answers.
  const { can } = await vi.importActual('@/utils/permissions')
  return {
    useAuth: () => ({
      profile: { role: mockState.role, gymId: 'gym-1' },
      user: { uid: 'u1' },
      can,
    }),
  }
})

vi.mock('@/firebase', () => ({
  db: {},
  storage: {},
  auth: {},
  isFirebaseConfigured: false,
}))

vi.mock('@/services/storage', () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  uploadImage: vi.fn(),
}))

// MemberDetail destructures { settings, timezone } from this hook.
vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({
    settings: { currency: 'INR', receiptPrefix: 'RCPT-' },
    timezone: 'Asia/Kolkata',
  }),
}))

vi.mock('@/hooks/useFirestoreCollection', () => ({
  usePaginatedCollection: (name) => mockState[name] || { items: [], loading: false },
  useCollection: (name) => mockState[name] || { items: [], loading: false },
  useDocument: () => ({ data: null, loading: false }),
}))

vi.mock('@/services/firestore', () => ({
  getById: vi.fn(async () => mockState.member),
  updateDocById: vi.fn(),
  removeDoc: vi.fn(),
  createDoc: vi.fn(),
  listAll: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/services/ownerContext', () => ({ getGymId: () => 'gym-1' }))
vi.mock('@/utils/dues', async () => {
  const actual = await vi.importActual('@/utils/dues')
  return { ...actual, computeMemberLedger: actual.computeMemberLedger }
})

const MEMBER = {
  id: 'm1',
  name: 'Asha',
  searchName: 'asha',
  gymId: 'gym-1',
  status: 'active',
  joinDate: '2026-01-01',
  membershipPlanId: 'plan-gold',
  isPT: false,
}

const PERIOD = {
  id: 'p1',
  gymId: 'gym-1',
  memberId: 'm1',
  planId: 'plan-gold',
  startDate: '2026-01-01',
  expiryDate: '2026-12-31',
}

const PLAN = { id: 'plan-gold', gymId: 'gym-1', name: 'Gold', price: 10000, durationDays: 365 }

async function renderAs(role) {
  mockState.role = role
  mockState.member = MEMBER
  mockState.plans = { items: [PLAN], loading: false }
  mockState.payments = { items: [], loading: false }
  mockState.memberships = { items: [PERIOD], loading: false }

  const MemberDetail = (await import('@/pages/MemberDetail')).default
  render(
    <MemoryRouter initialEntries={['/members/m1']}>
      <Routes>
        <Route path="/members/:id" element={<MemberDetail />} />
      </Routes>
    </MemoryRouter>
  )
  return MemberDetail
}

describe('MemberDetail financial visibility', () => {
  beforeEach(() => {
    vi.resetModules()
    mockState.role = 'front-desk'
  })

  describe('front-desk (can read members, cannot read payments)', () => {
    it('does not offer the Payments tab at all', async () => {
      await renderAs('front-desk')
      // The empty state it used to show was labelled "No payments yet", which
      // reads as a factual claim about the member rather than a withheld view.
      expect(screen.queryByText(/^Payments \(/)).toBeNull()
    })

    it('shows no dues figures on the overview', async () => {
      await renderAs('front-desk')
      expect(screen.queryByText('Amount paid')).toBeNull()
      expect(screen.queryByText('Due (all periods)')).toBeNull()
    })

    it('does not offer Record payment, which the rules would deny', async () => {
      await renderAs('front-desk')
      // members.write includes front-desk, so this used to render for them while
      // the payments create rule requires isFinance().
      expect(screen.queryByRole('button', { name: /Record payment/i })).toBeNull()
    })

    it('still offers non-financial member editing', async () => {
      // The fix must not over-reach: masking money must not disable the member
      // record work that members.write legitimately authorises.
      await renderAs('front-desk')
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.queryByRole('button', { name: /Record payment/i })).toBeNull()
      expect(screen.getByText('Overview')).toBeInTheDocument()
    })

    it('still shows the plan price, which is not payment-derived', async () => {
      // getMembershipCharge reads the plan document, which staff can read, so the
      // PT price panel is accurate for every role and must stay visible.
      await renderAs('front-desk')
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.getByText('Gold')).toBeInTheDocument()
    })
  })

  describe('owner (can read payments)', () => {
    it('offers the Payments tab', async () => {
      await renderAs('owner')
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.getByText(/^Payments \(/)).toBeInTheDocument()
    })

    it('shows the dues rows it is entitled to', async () => {
      await renderAs('owner')
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.getByText('Amount paid')).toBeInTheDocument()
      expect(screen.getByText('Due (all periods)')).toBeInTheDocument()
    })

    it('offers Record payment', async () => {
      await renderAs('owner')
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.getByRole('button', { name: /Record payment/i })).toBeInTheDocument()
    })
  })

  describe('trainer (can read members, cannot read payments)', () => {
    it('does not offer the Payments tab', async () => {
      await renderAs('trainer')
      expect(screen.queryByText(/^Payments \(/)).toBeNull()
    })
  })
})