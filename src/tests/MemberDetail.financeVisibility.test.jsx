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
 *
 * ## Why this file must NOT use vi.resetModules() or a dynamic import
 *
 * This suite used to re-import the page on every test:
 *
 *   beforeEach(() => { vi.resetModules() })
 *   const MemberDetail = (await import('@/pages/MemberDetail')).default
 *
 * That is broken in two independent ways.
 *
 * 1. Two React graphs. `render`/`screen` are statically imported, so they come
 *    from the first module registry. `vi.resetModules()` throws that registry
 *    away, so the dynamically imported page — and the `react` it imports —
 *    belongs to a SECOND registry. ReactDOM then renders a component whose hooks
 *    come from a React copy that has never had a dispatcher installed for it, so
 *    `useState` updates are lost. The page never leaves `<Spinner/>`, every
 *    positive assertion times out at 5000ms, and the file runs ~28s for 9 tests
 *    because the 1293-line page is cold-transformed 9 times.
 *
 * 2. Vacuous passes. Because nothing rendered, `queryBy*` assertions for the
 *    ABSENCE of finance UI passed trivially - they would still pass if the
 *    permission gating were deleted outright. A test that cannot fail is not a
 *    test.
 *
 * Neither is fixed by raising a timeout. The page reads `can` inside the
 * component body (MemberDetail.jsx), so swapping `mockState.role` re-renders with
 * the new role on its own; re-importing is never needed. MemberDetail is
 * therefore imported once, statically, and every test first awaits a post-load
 * element, which both fixes the module graph and makes each absence assertion
 * meaningful.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import MemberDetail from '@/pages/MemberDetail'

const mockState = {
  role: 'front-desk',
  member: null,
  plans: { items: [], loading: false },
  payments: { items: [], loading: false },
  memberships: { items: [], loading: false },
  attendance: { items: [], loading: false },
  membershipPlans: { items: [], loading: false },
  weights: { items: [], loading: false },
}

vi.mock('@/context/AuthContext', async () => {
  // The real AuthContext exposes a ROLE-BOUND one-argument `can`
  // (AuthContext.jsx: `can: (permission) => can(profile?.role, permission)`), and
  // callers invoke `can('finance.view')`. Handing back the raw two-argument
  // `can(role, permission)` here makes every lookup resolve `PERMISSIONS[undefined]`
  // and therefore return false, silently hiding finance UI from every role.
  const { can } = await vi.importActual('@/utils/permissions')
  return {
    useAuth: () => ({
      profile: { role: mockState.role, gymId: 'gym-1' },
      user: { uid: 'u1' },
      can: (permission) => can(mockState.role, permission),
    }),
  }
})

vi.mock('@/firebase', () => ({
  db: {},
  storage: {},
  auth: {},
  isFirebaseConfigured: false,
}))

// MemberPhoto uploads via uploadMemberPhoto(gymId, memberId, file); the old
// uploadFile / deleteFile / uploadImage helpers no longer exist.
vi.mock('@/services/storage', () => ({
  uploadMemberPhoto: vi.fn(),
}))

// MemberDetail destructures { settings, timezone } from this hook.
vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({
    settings: { currency: 'INR', receiptPrefix: 'RCPT-' },
    timezone: 'Asia/Kolkata',
  }),
}))

// MemberDetail imports `useCollection` from `@/hooks/useFirestore`, so mocking
// only `useFirestoreCollection` leaves the real hook in place and every
// collection (plans, payments, memberships) resolves empty.
vi.mock('@/hooks/useFirestore', () => ({
  useCollection: (name) => mockState[name] || { items: [], loading: false },
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
  // `computeMemberLedger` prices a period from `period.price`. Without it the
  // period prices at 0, counts as settled, and is dropped from the open-period
  // list -- so the owner's ledger stays empty and the dues rows never render.
  price: 10000,
}

const PLAN = { id: 'plan-gold', gymId: 'gym-1', name: 'Gold', price: 10000, durationDays: 365 }

/**
 * Renders the page as `role` and resolves once it has finished loading.
 *
 * MemberDetail returns a bare `<Spinner/>` until its mount reads resolve
 * (MemberDetail.jsx returns the spinner when `loading`). The member name heading
 * is rendered only after that, and it is not gated on any permission, so awaiting
 * it is a reliable "the page is now fully rendered" signal. Every test awaits
 * this before asserting, which is what makes the absence assertions real.
 */
async function renderLoaded(role) {
  mockState.role = role
  mockState.member = MEMBER
  mockState.plans = { items: [PLAN], loading: false }
  mockState.membershipPlans = { items: [PLAN], loading: false }
  mockState.payments = { items: [], loading: false }
  mockState.memberships = { items: [PERIOD], loading: false }

  render(
    <MemoryRouter initialEntries={['/members/m1']}>
      <Routes>
        <Route path="/members/:id" element={<MemberDetail />} />
      </Routes>
    </MemoryRouter>
  )

  return screen.findByRole('heading', { name: MEMBER.name })
}

describe('MemberDetail financial visibility', () => {
  beforeEach(() => {
    // Role and data are reset here. `vi.resetModules()` is deliberately NOT
    // used: see the note at the top of this file.
    mockState.role = 'front-desk'
  })

  describe('front-desk (can read members, cannot read payments)', () => {
    it('does not offer the Payments tab at all', async () => {
      // Proves the page actually rendered before the absence is asserted, so
      // this cannot pass merely because a spinner was still on screen.
      expect(await renderLoaded('front-desk')).toBeInTheDocument()
      // The empty state it used to show was labelled "No payments yet", which
      // reads as a factual claim about the member rather than a withheld view.
      expect(screen.queryByText(/^Payments \(/)).toBeNull()
    })

    it('shows no dues figures on the overview', async () => {
      expect(await renderLoaded('front-desk')).toBeInTheDocument()
      expect(screen.queryByText('Amount paid')).toBeNull()
      expect(screen.queryByText('Due (all periods)')).toBeNull()
    })

    it('does not offer Record payment, which the rules would deny', async () => {
      expect(await renderLoaded('front-desk')).toBeInTheDocument()
      // members.write includes front-desk, so this used to render for them while
      // the payments create rule requires isFinance().
      expect(screen.queryByRole('button', { name: /Record payment/i })).toBeNull()
    })

    it('still offers non-financial member editing', async () => {
      // The fix must not over-reach: masking money must not disable the member
      // record work that members.write legitimately authorises.
      expect(await renderLoaded('front-desk')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Record payment/i })).toBeNull()
      expect(screen.getByText('Overview')).toBeInTheDocument()
    })

    it('still shows the plan price, which is not payment-derived', async () => {
      // getMembershipCharge reads the plan document, which staff can read, so the
      // PT price panel is accurate for every role and must stay visible.
      expect(await renderLoaded('front-desk')).toBeInTheDocument()
      // The plan name is surfaced in more than one place (the header badge and
      // the "Membership summary" panel), so assert on presence rather than count.
      expect((await screen.findAllByText(/Gold/i)).length).toBeGreaterThan(0)
    })
  })

  describe('owner (can read payments)', () => {
    it('offers the Payments tab', async () => {
      expect(await renderLoaded('owner')).toBeInTheDocument()
      expect(await screen.findByText(/^Payments \(/)).toBeInTheDocument()
    })

    it('shows the dues rows it is entitled to', async () => {
      expect(await renderLoaded('owner')).toBeInTheDocument()
      expect(await screen.findByText('Amount paid')).toBeInTheDocument()
      expect(await screen.findByText('Due (all periods)')).toBeInTheDocument()
    })

    it('offers Record payment', async () => {
      expect(await renderLoaded('owner')).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: /Record payment/i })).toBeInTheDocument()
    })
  })

  describe('trainer (can read members, cannot read payments)', () => {
    it('does not offer the Payments tab', async () => {
      expect(await renderLoaded('trainer')).toBeInTheDocument()
      expect(screen.queryByText(/^Payments \(/)).toBeNull()
    })

    it('does not offer Record payment', async () => {
      // trainer is absent from both members.write and finance.write, so the
      // button must not appear. Front-desk alone would not catch a regression
      // that gates Record payment on members.write, because front-desk holds it.
      expect(await renderLoaded('trainer')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Record payment/i })).toBeNull()
    })
  })
})