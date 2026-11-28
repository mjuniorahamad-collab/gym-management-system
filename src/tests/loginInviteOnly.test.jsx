/**
 * SIGNUP IS INVITE-ONLY — what the user sees
 *
 * A signed-in account with no profile and no gym either HAS an invitation (it may
 * create its gym) or it does not (it may not, and must be told plainly). The
 * security decision lives in firestore.rules; this suite pins the two screens the
 * app is allowed to show so a future refactor cannot quietly offer the
 * "Create your gym" form to an uninvited account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Login from '@/pages/Login'

const { authValue, toastValue } = vi.hoisted(() => ({
  authValue: {
    user: null,
    profile: null,
    loading: false,
    error: null,
    isConfigured: true,
    pendingOnboarding: false,
    inviteRequired: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    completeOnboarding: vi.fn(),
    demoSignIn: vi.fn(),
  },
  toastValue: { success: vi.fn(), error: vi.fn(), info: vi.fn(), promise: vi.fn() },
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))
vi.mock('@/context/SettingsContext', () => ({
  useSettings: () => ({ settings: { gymName: '', tagline: '' } }),
}))
vi.mock('@/context/ToastContext', () => ({ useToast: () => ({ toast: toastValue, ...toastValue }) }))
vi.mock('react-router-dom', () => ({
  Navigate: () => null,
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}))
vi.mock('@/services/onboarding', () => ({ provisionOwnerGym: vi.fn() }))
vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => null }))

const signedInUnbound = { uid: 'new-uid', email: 'new-owner@example.com' }

beforeEach(() => {
  vi.clearAllMocks()
  authValue.user = signedInUnbound
  authValue.profile = null
  authValue.loading = false
  authValue.pendingOnboarding = false
  authValue.inviteRequired = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an uninvited account', () => {
  beforeEach(() => {
    authValue.inviteRequired = true
  })

  it('is told the app is invite-only instead of being offered the create-gym form', () => {
    render(<Login />)

    expect(screen.getByText('Access is invite-only')).toBeInTheDocument()
    expect(screen.getByText(/new-owner@example.com/)).toBeInTheDocument()
    expect(screen.queryByText('Create your gym')).toBeNull()
    expect(screen.queryByText('Gym name')).toBeNull()
  })

  it('can sign out from that screen', () => {
    render(<Login />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(authValue.signOut).toHaveBeenCalled()
  })
})

describe('an invited account', () => {
  it('is offered the create-gym step', () => {
    authValue.pendingOnboarding = true
    render(<Login />)

    expect(screen.getByRole('heading', { name: 'Create your gym' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create my gym' })).toBeInTheDocument()
    expect(screen.queryByText('Access is invite-only')).toBeNull()
  })
})

describe('the sign-in form', () => {
  it('says a new gym needs an invitation', () => {
    authValue.user = null
    render(<Login />)

    expect(
      screen.getByText('New here? Creating a gym needs an invitation from the app owner.')
    ).toBeInTheDocument()
  })
})
