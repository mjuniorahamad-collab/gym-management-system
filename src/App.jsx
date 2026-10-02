import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider } from '@/context/ThemeContext'
import { ToastProvider } from '@/context/ToastContext'
import { AuthProvider } from '@/context/AuthContext'
import { SettingsProvider } from '@/context/SettingsContext'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { RoleGuard } from '@/components/layout/RoleGuard'
import { Layout } from '@/components/layout/Layout'
import { Spinner } from '@/components/ui/Spinner'

const Login = lazy(() => import('@/pages/Login'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Members = lazy(() => import('@/pages/Members'))
const MemberDetail = lazy(() => import('@/pages/MemberDetail'))
const MemberPortal = lazy(() => import('@/pages/MemberPortal'))
const Trainers = lazy(() => import('@/pages/Trainers'))
const Classes = lazy(() => import('@/pages/Classes'))
const Attendance = lazy(() => import('@/pages/Attendance'))
const Plans = lazy(() => import('@/pages/Plans'))
const Payments = lazy(() => import('@/pages/Payments'))
const Expenses = lazy(() => import('@/pages/Expenses'))
const Reports = lazy(() => import('@/pages/Reports'))
const Settings = lazy(() => import('@/pages/Settings'))
const NotFound = lazy(() => import('@/pages/NotFound'))

const STAFF_ROLES = ['owner', 'admin', 'front-desk', 'trainer']

function PageLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Spinner label="Loading page…" />
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <SettingsProvider>
              <BrowserRouter>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route path="/login" element={<Login />} />

                    <Route
                      element={
                        <ProtectedRoute>
                          <Layout />
                        </ProtectedRoute>
                      }
                    >
                      <Route index element={<Dashboard />} />

                      <Route path="members" element={<Members />} />
                      <Route path="members/:id" element={<MemberDetail />} />
                      <Route
                        path="trainers"
                        element={
                          <RoleGuard roles={STAFF_ROLES} permission="trainers.view">
                            <Trainers />
                          </RoleGuard>
                        }
                      />
                      <Route path="classes" element={<Classes />} />
                      <Route path="attendance" element={<Attendance />} />
                      <Route
                        path="plans"
                        element={
                          <RoleGuard roles={['owner', 'admin']} permission="finance.view">
                            <Plans />
                          </RoleGuard>
                        }
                      />
                      <Route
                        path="payments"
                        element={
                          <RoleGuard roles={['owner', 'admin']} permission="finance.view">
                            <Payments />
                          </RoleGuard>
                        }
                      />
                      <Route
                        path="expenses"
                        element={
                          <RoleGuard roles={['owner', 'admin']} permission="finance.view">
                            <Expenses />
                          </RoleGuard>
                        }
                      />
                      <Route
                        path="reports"
                        element={
                          <RoleGuard roles={['owner', 'admin']} permission="reports.view">
                            <Reports />
                          </RoleGuard>
                        }
                      />
                      <Route
                        path="settings"
                        element={
                          <RoleGuard roles={['owner']}>
                            <Settings />
                          </RoleGuard>
                        }
                      />
                      <Route path="portal" element={<MemberPortal />} />
                    </Route>

                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>
              </BrowserRouter>
            </SettingsProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
