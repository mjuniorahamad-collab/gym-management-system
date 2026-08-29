import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Building2, Dumbbell, KeyRound, Mail, ShieldCheck, User } from 'lucide-react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { gymOnboardingSchema, loginSchema, signupSchema } from '@/schemas/validationSchemas'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { useSettings } from '@/context/SettingsContext'
import { provisionOwnerGym } from '@/services/onboarding'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ThemeToggle } from '@/components/layout/ThemeToggle'

const MODE_SIGNIN = 'signin'
const MODE_SIGNUP = 'signup'

export default function Login() {
  const {
    user,
    profile,
    loading,
    isConfigured,
    pendingOnboarding,
    signIn,
    signUp,
    completeOnboarding,
    demoSignIn,
  } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState(MODE_SIGNIN)
  const [submitting, setSubmitting] = useState(false)
  const [onboardingError, setOnboardingError] = useState(null)

  const loginForm = useForm({ resolver: zodResolver(loginSchema) })
  const signupForm = useForm({ resolver: zodResolver(signupSchema) })
  const onboardingForm = useForm({ resolver: zodResolver(gymOnboardingSchema) })

  useEffect(() => {
    // Only auto-navigate once the user is BOUND to a gym. A brand-new owner
    // (no gym yet) stays on this screen to complete onboarding. Requiring a
    // bound profile is deliberate: if bootstrap ever fails without resolving
    // a profile, the user must not be dropped into a data-less dashboard.
    if (!loading && user && !pendingOnboarding && profile?.gymId) {
      navigate(location.state?.from || '/', { replace: true })
    }
  }, [loading, user, pendingOnboarding, profile, navigate, location.state])

  if (loading) return null
  if (user && !pendingOnboarding && profile?.gymId)
    return <Navigate to={location.state?.from || '/'} replace />

  const handleSignIn = async (values) => {
    setSubmitting(true)
    try {
      await signIn(values.email, values.password)
      // Redirect happens via the effect above (after profile bootstrap binds).
    } catch {
      // error surfaced via AuthContext + inline below
    } finally {
      setSubmitting(false)
    }
  }

  const handleSignUp = async (values) => {
    setSubmitting(true)
    try {
      await signUp(values.name, values.email, values.password)
      // After sign-up the user is unbound → pendingOnboarding becomes true and
      // the onboarding step is shown automatically.
    } catch {
      // error surfaced via AuthContext + inline below
    } finally {
      setSubmitting(false)
    }
  }

  const handleOnboarding = async (values) => {
    setSubmitting(true)
    setOnboardingError(null)
    try {
      const gymId = await provisionOwnerGym({
        name: values.gymName,
        tagline: values.tagline || '',
      })
      await completeOnboarding(gymId)
      toast.success('Your gym is ready!')
    } catch (e) {
      setOnboardingError(e.message || 'Could not create your gym')
      toast.error(e.message || 'Could not create your gym')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDemo = async () => {
    setSubmitting(true)
    try {
      await demoSignIn()
    } finally {
      setSubmitting(false)
    }
  }

  // Onboarding step — renders instead of the auth forms while an unbound owner
  // creates their own gym for the first time.
  if (pendingOnboarding) {
    return (
      <div className="flex min-h-screen">
        <div className="relative hidden flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-700 via-indigo-600 to-emerald-600 p-10 lg:flex">
          <div className="absolute -left-20 -top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute -bottom-24 -right-16 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
          <div className="relative max-w-md text-white">
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
              <Building2 size={28} />
            </div>
            <h1 className="text-4xl font-extrabold leading-tight">Welcome aboard</h1>
            <p className="mt-3 text-lg text-white/85">
              Set up your gym in minutes. Members, payments, classes and analytics — all in one place,
              scoped securely to your own tenant.
            </p>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center p-6">
          <div className="absolute right-4 top-4">
            <ThemeToggle />
          </div>
          <div className="w-full max-w-sm">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-emerald-600 text-white">
                <Building2 size={22} />
              </div>
              <div>
                <p className="font-bold">Gym Management System</p>
                <p className="text-xs text-slate-400">Create your gym</p>
              </div>
            </div>

            <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Create your gym</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              You don&rsquo;t have a gym yet. Give it a name to provision your Owner account and get started.
            </p>

            {!isConfigured && (
              <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                <p className="font-semibold">Firebase is not configured.</p>
                <p className="mt-1">
                  Copy <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">.env.example</code>{' '}
                  to <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">.env</code> and add
                  your Firebase keys, then restart the dev server.
                </p>
              </div>
            )}

            {onboardingError && (
              <div className="mt-5 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                {onboardingError}
              </div>
            )}

            <form onSubmit={onboardingForm.handleSubmit(handleOnboarding)} className="mt-6 space-y-4" noValidate>
              <FormField label="Gym name" error={onboardingForm.formState.errors.gymName?.message} required>
                <div className="relative">
                  <Building2 size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder="e.g. Powerhouse Gym"
                    className="pl-9"
                    error={onboardingForm.formState.errors.gymName}
                    {...onboardingForm.register('gymName')}
                  />
                </div>
              </FormField>

              <FormField label="Tagline (optional)" error={onboardingForm.formState.errors.tagline?.message}>
                <Input
                  placeholder="A short tagline for your gym"
                  error={onboardingForm.formState.errors.tagline}
                  {...onboardingForm.register('tagline')}
                />
              </FormField>

              <Button type="submit" loading={submitting} className="w-full" size="lg">
                Create my gym
              </Button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-700 via-indigo-600 to-emerald-600 p-10 lg:flex">
        <div className="absolute -left-20 -top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute -bottom-24 -right-16 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="relative max-w-md text-white">
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Dumbbell size={28} />
          </div>
          <h1 className="text-4xl font-extrabold leading-tight">Gym Management System</h1>
          <p className="mt-3 text-lg text-white/85">
            {settings.gymName || 'Your gym'}
            {settings.tagline ? ` · ${settings.tagline}` : ''}
          </p>
          <ul className="mt-10 space-y-4 text-sm text-white/90">
            <li className="flex items-center gap-3">
              <ShieldCheck size={18} className="shrink-0" /> Role-based, secure access for your whole team
            </li>
            <li className="flex items-center gap-3">
              <KeyRound size={18} className="shrink-0" /> Members, payments, classes and analytics in one place
            </li>
          </ul>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-emerald-600 text-white">
              <Dumbbell size={22} />
            </div>
            <div>
              <p className="font-bold">Gym Management System</p>
              <p className="text-xs text-slate-400">{settings.gymName}</p>
            </div>
          </div>

          {/* Sign in / Create account toggle */}
          <div className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setMode(MODE_SIGNIN)}
              className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                mode === MODE_SIGNIN
                  ? 'bg-white text-slate-900 shadow dark:bg-slate-700 dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <KeyRound size={15} /> Sign in
            </button>
            <button
              type="button"
              onClick={() => setMode(MODE_SIGNUP)}
              className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                mode === MODE_SIGNUP
                  ? 'bg-white text-slate-900 shadow dark:bg-slate-700 dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <User size={15} /> Create account
            </button>
          </div>

          {mode === MODE_SIGNIN ? (
            <>
              <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Welcome back</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Sign in to manage your gym.</p>

              {!isConfigured && (
                <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <p className="font-semibold">Firebase is not configured.</p>
                  <p className="mt-1">
                    Copy <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">.env.example</code>{' '}
                    to <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">.env</code> and add
                    your Firebase keys, then restart the dev server.
                  </p>
                </div>
              )}

              <form onSubmit={loginForm.handleSubmit(handleSignIn)} className="mt-6 space-y-4" noValidate>
                <FormField label="Email" error={loginForm.formState.errors.email?.message}>
                  <div className="relative">
                    <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@himalye.com"
                      className="pl-9"
                      error={loginForm.formState.errors.email}
                      {...loginForm.register('email')}
                    />
                  </div>
                </FormField>

                <FormField label="Password" error={loginForm.formState.errors.password?.message}>
                  <div className="relative">
                    <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                      className="pl-9"
                      error={loginForm.formState.errors.password}
                      {...loginForm.register('password')}
                    />
                  </div>
                </FormField>

                <Button type="submit" loading={submitting || loading} className="w-full" size="lg">
                  Sign in
                </Button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Create an account</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Sign up as the Owner of your gym. You&rsquo;ll set up your gym right after.
              </p>

              {!isConfigured && (
                <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <p className="font-semibold">Firebase is not configured.</p>
                  <p className="mt-1">
                    Copy <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">.env.example</code>{' '}
                    to <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">.env</code> and add
                    your Firebase keys, then restart the dev server.
                  </p>
                </div>
              )}

              <form onSubmit={signupForm.handleSubmit(handleSignUp)} className="mt-6 space-y-4" noValidate>
                <FormField label="Your name" error={signupForm.formState.errors.name?.message} required>
                  <div className="relative">
                    <User size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      autoComplete="name"
                      placeholder="Jane Owner"
                      className="pl-9"
                      error={signupForm.formState.errors.name}
                      {...signupForm.register('name')}
                    />
                  </div>
                </FormField>

                <FormField label="Email" error={signupForm.formState.errors.email?.message} required>
                  <div className="relative">
                    <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@himalye.com"
                      className="pl-9"
                      error={signupForm.formState.errors.email}
                      {...signupForm.register('email')}
                    />
                  </div>
                </FormField>

                <FormField label="Password" error={signupForm.formState.errors.password?.message} required>
                  <div className="relative">
                    <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 6 characters"
                      className="pl-9"
                      error={signupForm.formState.errors.password}
                      {...signupForm.register('password')}
                    />
                  </div>
                </FormField>

                <FormField label="Confirm password" error={signupForm.formState.errors.confirmPassword?.message} required>
                  <div className="relative">
                    <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-enter your password"
                      className="pl-9"
                      error={signupForm.formState.errors.confirmPassword}
                      {...signupForm.register('confirmPassword')}
                    />
                  </div>
                </FormField>

                <Button type="submit" loading={submitting} className="w-full" size="lg">
                  Create account
                </Button>
              </form>
            </>
          )}

          {!isConfigured && (
            <div className="mt-4">
              <div className="relative my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                <span className="text-xs text-slate-400">or</span>
                <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleDemo}
                loading={submitting}
              >
                Explore demo mode
              </Button>
            </div>
          )}

          <p className="mt-6 text-center text-xs text-slate-400">
            {mode === MODE_SIGNIN
              ? 'New here? Create an account, then set up your own gym.'
              : 'Already have an account? Use the Sign in tab above.'}
          </p>
        </div>
      </div>
    </div>
  )
}
