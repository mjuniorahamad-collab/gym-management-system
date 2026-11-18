import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Login from '@/pages/Login'

const { authValue, toastValue } = vi.hoisted(() => ({
  authValue: {
    user: null,
    profile: null,
    loading: false,
    error: null,
    isConfigured: true,
    pendingOnboarding: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    completeOnboarding: vi.fn(),
    demoSignIn: vi.fn(),
  },
  toastValue: { success: vi.fn(), error: vi.fn(), info: vi.fn(), promise: vi.fn() },
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))
vi.mock('@/context/SettingsContext', () => ({ useSettings: () => ({ settings: { gymName: '', tagline: '' } }) }))
vi.mock('@/context/ToastContext', () => ({ useToast: () => ({ toast: toastValue, ...toastValue }) }))
vi.mock('react-router-dom', () => ({
  Navigate: () => null,
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}))
vi.mock('@/services/onboarding', () => ({ provisionOwnerGym: vi.fn() }))
vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => null }))

function submitSignIn(email = 'owner@himalye.com', password = 'secret123') {
  fireEvent.change(screen.getByPlaceholderText('you@himalye.com'), { target: { value: email } })
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: password } })
  fireEvent.submit(document.querySelector('form'))
}

function switchToSignUp() {
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
}

function submitSignUp() {
  fireEvent.change(screen.getByPlaceholderText('Jane Owner'), { target: { value: 'Jane Owner' } })
  fireEvent.change(screen.getByPlaceholderText('you@himalye.com'), { target: { value: 'jane@himalye.com' } })
  fireEvent.change(screen.getByPlaceholderText('At least 6 characters'), { target: { value: 'secret123' } })
  fireEvent.change(screen.getByPlaceholderText('Re-enter your password'), { target: { value: 'secret123' } })
  fireEvent.submit(document.querySelector('form'))
}

describe('Login authentication failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a clear message for wrong credentials instead of failing silently', async () => {
    authValue.signIn.mockRejectedValue({
      code: 'auth/invalid-credential',
      message: 'Firebase: Invalid login credentials.',
    })

    render(<Login />)
    submitSignIn()

    await waitFor(() => expect(screen.getByText('Incorrect email or password.')).toBeInTheDocument())
    // Technical detail must never reach the DOM.
    expect(screen.queryByText(/Invalid login credentials/)).toBeNull()
    expect(screen.queryByText(/Firebase:/)).toBeNull()
  })

  it('shows a network message when the auth service is unreachable', async () => {
    authValue.signIn.mockRejectedValue({
      code: 'auth/network-request-failed',
      message: 'Firebase: Failed to fetch.',
    })

    render(<Login />)
    submitSignIn()

    await waitFor(() =>
      expect(
        screen.getByText("Can't reach the server. Check your internet connection and try again.")
      ).toBeInTheDocument()
    )
    expect(screen.queryByText(/Failed to fetch/)).toBeNull()
  })

  it('shows a disabled-account message', async () => {
    authValue.signIn.mockRejectedValue({ code: 'auth/user-disabled', message: 'Firebase: user disabled' })

    render(<Login />)
    submitSignIn()

    await waitFor(() =>
      expect(screen.getByText('This account has been disabled. Please contact support.')).toBeInTheDocument()
    )
    expect(screen.queryByText(/user disabled/)).toBeNull()
  })

  it('falls back to a generic message for unexpected failures without leaking internals', async () => {
    authValue.signIn.mockRejectedValue({
      code: 'auth/unexpected-thing',
      message: 'stack-trace-ABC at firebase.auth.internal',
    })

    render(<Login />)
    submitSignIn()

    await waitFor(() => expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument())
    expect(screen.queryByText(/stack-trace-ABC/)).toBeNull()
    expect(screen.queryByText(/firebase\.auth/)).toBeNull()
  })

  it('shows the duplicate-account message on sign-up', async () => {
    authValue.signUp.mockRejectedValue({
      code: 'auth/email-already-in-use',
      message: 'Firebase: The email address is already in use by another account.',
    })

    render(<Login />)
    switchToSignUp()
    submitSignUp()

    await waitFor(() =>
      expect(
        screen.getByText('An account with this email already exists. Try signing in instead.')
      ).toBeInTheDocument()
    )
    expect(screen.queryByText(/already in use by another account/)).toBeNull()
  })

  it('clears the error banner when switching between sign in and create account', async () => {
    authValue.signIn.mockRejectedValue({ code: 'auth/invalid-credential', message: 'Firebase: bad creds' })

    render(<Login />)
    submitSignIn()
    await waitFor(() => expect(screen.getByText('Incorrect email or password.')).toBeInTheDocument())

    switchToSignUp()
    expect(screen.queryByText('Incorrect email or password.')).toBeNull()
  })
})
