import { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertCircle,
  CalendarClock,
  CreditCard,
  Dumbbell,
  RefreshCcw,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { useCollection } from '@/hooks/useFirestore'
import { loadSampleData } from '@/services/seedService'
import { recordPayment } from '@/services/payments'
import { getPtSurcharge } from '@/services/pt'
import { StatCard } from '@/components/charts/StatCard'
import { RevenueChart } from '@/components/charts/RevenueChart'
import { MembersTrendChart } from '@/components/charts/MembersTrendChart'
import { CategoryPie } from '@/components/charts/CategoryPie'
import { MemberPhoto } from '@/components/common/MemberPhoto'
import { WhatsAppReminderButton } from '@/components/common/WhatsAppReminderButton'
import { RenewalModal } from '@/components/common/RenewalModal'
import { ReceiptModal } from '@/components/common/ReceiptModal'
import { PaymentForm } from '@/components/common/PaymentForm'
import { OutstandingDuesCard } from '@/components/dashboard/OutstandingDuesCard'
import { MigrationBanner } from '@/components/dashboard/MigrationBanner'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs } from '@/components/ui/Tabs'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { PageHeader } from '@/components/layout/PageHeader'
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '@/utils/formatters'
import { lastNMonths, monthKey, parseDate, addDays } from '@/utils/dateHelpers'
import { getCurrentMembershipExpiry, getDaysRemaining, getExpiryBucket, matchesExpiryFilter } from '@/utils/membership'
import { computeMemberFinanceRollups } from '@/utils/dues'

const MAX_EXPIRING_ROWS = 50

const EXPIRY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'expired', label: 'Expired' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: '3days', label: 'Within 3 days' },
  { key: '7days', label: 'Within 7 days' },
]

const EXPIRY_BADGES = {
  expired: { tone: 'danger', label: 'Expired' },
  today: { tone: 'danger', label: 'Due today' },
  tomorrow: { tone: 'warning', label: 'Due tomorrow' },
  '3days': { tone: 'warning', label: 'Within 3 days' },
  '7days': { tone: 'neutral', label: 'Within 7 days' },
}

export default function Dashboard() {
  const { can } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()

  const [expiryFilter, setExpiryFilter] = useState('all')
  const [renewTarget, setRenewTarget] = useState(null)
  const [renewalResult, setRenewalResult] = useState(null)
  const [payTarget, setPayTarget] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [ptSurcharge, setPtSurcharge] = useState(0)

  useEffect(() => {
    let mounted = true
    getPtSurcharge()
      .then((v) => {
        if (mounted) setPtSurcharge(v)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [can])

  const canFinance = can('finance.view')
  const canFinanceWrite = can('finance.write')

  const members = useCollection('members')
  const payments = useCollection('payments', { disabled: !canFinance })
  const expenses = useCollection('expenses', { disabled: !canFinance })
  const attendance = useCollection('attendance')
  const plans = useCollection('membershipPlans')
  const bookings = useCollection('bookings')
  const memberships = useCollection('memberships')

  const loading =
    members.loading || payments.loading || expenses.loading || attendance.loading || plans.loading

  const errors = [
    ['Members', members.error],
    ['Payments', payments.error],
    ['Expenses', expenses.error],
    ['Attendance', attendance.error],
    ['Membership plans', plans.error],
    ['Bookings', bookings.error],
  ].filter(([, msg]) => msg)
  const error = errors[0]?.[1] || null
  const errorSource = errors[0]?.[0] || null

  const planMap = useMemo(
    () => Object.fromEntries(plans.items.map((p) => [p.id, p])),
    [plans.items]
  )
  const memberMap = useMemo(
    () => Object.fromEntries(members.items.map((m) => [m.id, m])),
    [members.items]
  )

  // One ledger pass feeds both the dues card and the origin-period banner.
  // These used to be two separate memos calling computeMemberLedger with
  // identical arguments - and computeMemberLedger re-filters the whole payments
  // array per member, so the second memo doubled the dominant cost on every
  // payment, membership, member, plan or PT-surcharge change.
  const { dues, pendingOriginPeriods } = useMemo(
    () =>
      canFinance
        ? computeMemberFinanceRollups({
            members: members.items,
            plans: plans.items,
            payments: payments.items,
            memberships: memberships.items,
            ptSurcharge,
          })
        : { dues: { rows: [], totalDue: 0, count: 0 }, pendingOriginPeriods: 0 },
    [canFinance, members.items, plans.items, payments.items, memberships.items, ptSurcharge]
  )

  // Members with an undocumented origin period (pre-records history), counted by
  // the rollup above.

  const expiringRows = useMemo(() => {
    const rows = []
    for (const member of members.items) {
      const plan = planMap[member.membershipPlanId]
      const expiry = getCurrentMembershipExpiry(member, plan, memberships.items)
      if (!expiry) continue
      const days = getDaysRemaining(expiry)
      if (days === null || !matchesExpiryFilter(days, 'all')) continue
      rows.push({ member, plan, expiry, days })
    }
    rows.sort((a, b) => {
      const byDays = Math.abs(a.days) - Math.abs(b.days)
      if (byDays !== 0) return byDays
      return String(a.member.name || '').localeCompare(String(b.member.name || ''))
    })
    return rows
  }, [members.items, planMap, memberships.items])

  const filteredExpiring = useMemo(() => {
    const list =
      expiryFilter === 'all'
        ? expiringRows
        : expiringRows.filter((r) => matchesExpiryFilter(r.days, expiryFilter))
    return {
      rows: list.slice(0, MAX_EXPIRING_ROWS),
      truncated: list.length > MAX_EXPIRING_ROWS,
      total: list.length,
    }
  }, [expiringRows, expiryFilter])

  const stats = useMemo(() => {
    const activeMembers = members.items.filter((m) => m.status === 'active')
    const now = new Date()
    const todayKey = monthKey(now)
    const todayStart = now.toDateString()

    const monthlyIncome = payments.items
      .filter((p) => monthKey(parseDate(p.date)) === todayKey)
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0)

    const monthlyExpense = expenses.items
      .filter((e) => monthKey(parseDate(e.date)) === todayKey)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)

    const todayCheckIns = attendance.items.filter(
      (a) => parseDate(a.date)?.toDateString() === todayStart
    ).length

    return {
      totalMembers: members.items.length,
      activeMembers: activeMembers.length,
      monthlyIncome,
      monthlyExpense,
      todayCheckIns,
    }
  }, [members.items, payments.items, expenses.items, attendance.items])

  const series = useMemo(() => {
    const months = lastNMonths(6)
    return months.map((key) => {
      const label = new Date(key.split('-')[0], Number(key.split('-')[1]) - 1, 1).toLocaleDateString(
        'en-US',
        { month: 'short' }
      )
      const income = payments.items
        .filter((p) => monthKey(parseDate(p.date)) === key)
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
      const expense = expenses.items
        .filter((e) => monthKey(parseDate(e.date)) === key)
        .reduce((s, e) => s + (Number(e.amount) || 0), 0)
      return { label, income, expense }
    })
  }, [payments.items, expenses.items])

  const membersTrend = useMemo(() => {
    const months = lastNMonths(6)
    return months.map((key) => ({
      label: new Date(key.split('-')[0], Number(key.split('-')[1]) - 1, 1).toLocaleDateString(
        'en-US',
        { month: 'short' }
      ),
      newMembers: members.items.filter((m) => monthKey(parseDate(m.joinDate)) === key).length,
    }))
  }, [members.items])

  const expensePie = useMemo(() => {
    const sixMonthsAgo = addDays(new Date(), -180)
    const map = {}
    for (const e of expenses.items) {
      const d = parseDate(e.date)
      if (!d || d < sixMonthsAgo) continue
      const cat = e.category || 'Other'
      map[cat] = (map[cat] || 0) + (Number(e.amount) || 0)
    }
    return Object.entries(map)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
  }, [expenses.items])

  const recentCheckIns = useMemo(
    () =>
      [...attendance.items]
        .sort((a, b) => String(b.checkIn || b.date || '').localeCompare(String(a.checkIn || a.date || '')))
        .slice(0, 6),
    [attendance.items]
  )

  const upcomingBookings = bookings.items.length

  const handleLoadSample = async () => {
    try {
      await loadSampleData()
      toast.success('Sample data loaded')
    } catch (e) {
      toast.error(e.message || 'Could not load sample data')
    }
  }

  const handleRenewed = (result) => {
    setRenewTarget(null)
    setRenewalResult(result)
  }

  const handleRecordPayment = async (values) => {
    setSubmitting(true)
    try {
      const memberName = payTarget?.member?.name || memberMap[values.memberId]?.name || ''
      await recordPayment({
        values,
        memberName,
        planName: planMap[values.planId]?.name || '',
        receiptPrefix: settings.receiptPrefix,
      })
      toast.success('Payment recorded')
      setPayTarget(null)
    } catch (e) {
      toast.error(e.message || 'Could not save payment')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-28 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Some data could not be loaded</p>
            <p className="mt-1 break-words text-xs">
              {errorSource && <span className="font-semibold">{errorSource}: </span>}
              {error}
            </p>
          </div>
        </div>
      )}

      <PageHeader
        title="Dashboard"
        subtitle="Overview of your gym at a glance."
        actions={
          members.items.length === 0 && can('seed.data') ? (
            <Button onClick={handleLoadSample}>
              <Sparkles size={16} /> Load sample data
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Members"
          value={formatNumber(stats.totalMembers)}
          icon={Users}
          tone="indigo"
        />
        <StatCard
          title="Active Members"
          value={formatNumber(stats.activeMembers)}
          icon={Dumbbell}
          tone="emerald"
          sub={`${formatNumber(upcomingBookings)} upcoming bookings`}
        />
        {canFinance && (
          <StatCard
            title="Revenue This Month"
            value={formatCurrency(stats.monthlyIncome, settings.currency)}
            icon={CreditCard}
            tone="sky"
          />
        )}
        {canFinance && (
          <StatCard
            title="Expenses This Month"
            value={formatCurrency(stats.monthlyExpense, settings.currency)}
            icon={TrendingUp}
            tone="rose"
          />
        )}
      </div>

      {canFinance && <MigrationBanner pendingMembers={pendingOriginPeriods} />}

      {canFinance && (
        <OutstandingDuesCard
          rows={dues.rows}
          totalDue={dues.totalDue}
          count={dues.count}
          settings={settings}
          canWrite={canFinanceWrite}
          onRecord={(member, dueAmount, targetMembershipId) =>
            setPayTarget({ member, dueAmount, targetMembershipId })
          }
        />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Memberships Expiring Soon"
          subtitle="Expired and expiring within the next 7 days"
          actions={
            <Tabs tabs={EXPIRY_FILTERS} active={expiryFilter} onChange={setExpiryFilter} />
          }
        />
        <CardBody className="p-0">
          {members.loading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : filteredExpiring.rows.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No memberships due"
              description={
                expiryFilter === 'all'
                  ? 'Memberships expiring within the next 7 days will appear here.'
                  : 'No members fall into this expiry window.'
              }
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="th">Member</th>
                      <th className="th hidden md:table-cell">Phone</th>
                      <th className="th hidden lg:table-cell">Plan</th>
                      <th className="th">Expires</th>
                      <th className="th">Days left</th>
                      <th className="th">Status</th>
                      <th className="th text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredExpiring.rows.map(({ member, plan, expiry, days }) => (
                      <tr
                        key={member.id}
                        className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <td className="td">
                          <Link to={`/members/${member.id}`} className="flex items-center gap-3">
                            <MemberPhoto member={member} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                                {member.name}
                              </p>
                              <p className="truncate text-xs text-slate-400">
                                {member.email || member.memberNo || '—'}
                              </p>
                            </div>
                          </Link>
                        </td>
                        <td className="td hidden whitespace-nowrap md:table-cell">
                          {member.phone || '—'}
                        </td>
                        <td className="td hidden lg:table-cell">
                          {plan ? (
                            <Badge tone="indigo">{plan.name}</Badge>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="td whitespace-nowrap">{formatDate(expiry)}</td>
                        <td className="td whitespace-nowrap">{daysLabel(days)}</td>
                        <td className="td">
                          <ExpiryBadge days={days} />
                        </td>
                        <td className="td">
                          <div className="flex justify-end gap-1">
                            {canFinanceWrite && (
                              <Button
                                variant="outline"
                                size="sm"
                                title="Renew membership"
                                onClick={() => setRenewTarget({ member, plan, expiry })}
                              >
                                <RefreshCcw size={14} /> Renew
                              </Button>
                            )}
                            <WhatsAppReminderButton
                              iconOnly
                              label="Send WhatsApp reminder"
                              memberName={member.name}
                              gymName={settings.gymName}
                              planName={plan?.name}
                              expiryDate={expiry}
                              phone={member.phone}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredExpiring.truncated && (
                <p className="border-t border-slate-100 px-5 py-3 text-center text-xs text-slate-400 dark:border-slate-800">
                  Showing the {MAX_EXPIRING_ROWS} most relevant results. Use the filters above to narrow
                  the list.
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {canFinance && (
          <Card>
            <CardHeader
              title="Revenue vs Expenses"
              subtitle="Last 6 months"
              actions={<Activity size={16} className="text-slate-400" />}
            />
            <CardBody>
              <RevenueChart data={series} />
            </CardBody>
          </Card>
        )}

        <Card className={canFinance ? '' : 'lg:col-span-2'}>
          <CardHeader title="New Members" subtitle="Last 6 months" />
          <CardBody>
            <MembersTrendChart data={membersTrend} />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className={canFinance ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader
            title="Recent Check-ins"
            subtitle="Latest activity at the front desk"
            actions={
              <Link to="/attendance">
                <Button variant="ghost" size="sm">
                  View all
                </Button>
              </Link>
            }
          />
          <CardBody className="p-0">
            {recentCheckIns.length === 0 ? (
              <EmptyState title="No check-ins yet" description="Check-ins will appear here." />
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {recentCheckIns.map((a) => (
                  <div key={a.id} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="avatar bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                        {memberMap[a.memberId]?.name?.slice(0, 1) || '?'}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                          {memberMap[a.memberId]?.name || 'Unknown member'}
                        </p>
                        <p className="text-xs text-slate-400">
                          Checked in {formatDateTime(a.checkIn || a.date)}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={memberMap[a.memberId]?.status} />
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {canFinance && (
          <Card>
            <CardHeader title="Expense Breakdown" subtitle="Last 6 months" />
            <CardBody>
              {expensePie.length === 0 ? (
                <EmptyState title="No expenses recorded" />
              ) : (
                <>
                  <CategoryPie data={expensePie} />
                  <div className="mt-3 space-y-1.5">
                    {expensePie.map((item) => (
                      <div key={item.name} className="flex items-center justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">{item.name}</span>
                        <span className="font-medium text-slate-800 dark:text-slate-100">
                          {formatCurrency(item.value, settings.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      <PaymentForm
        open={Boolean(payTarget)}
        onClose={() => setPayTarget(null)}
        members={members.items}
        plans={plans.items}
        payments={payments.items}
        memberships={memberships.items}
        submitting={submitting}
        onSubmit={handleRecordPayment}
        initial={
          payTarget
            ? {
                memberId: payTarget.member.id,
                planId: payTarget.member.membershipPlanId || '',
                membershipId: payTarget.targetMembershipId || '',
                amount: String(payTarget.dueAmount || ''),
              }
            : undefined
        }
        ptSurcharge={ptSurcharge}
      />

      <RenewalModal
        open={Boolean(renewTarget)}
        onClose={() => setRenewTarget(null)}
        member={renewTarget?.member}
        currentPlan={renewTarget?.plan}
        currentExpiry={renewTarget?.expiry}
        plans={plans.items}
        payments={payments.items}
        memberships={memberships.items}
        onRenewed={handleRenewed}
        ptSurcharge={ptSurcharge}
      />

      <ReceiptModal
        open={Boolean(renewalResult)}
        onClose={() => setRenewalResult(null)}
        payment={renewalResult?.payment}
        member={renewalResult ? memberMap[renewalResult.membership.memberId] : null}
        plan={renewalResult ? planMap[renewalResult.membership.planId] || null : null}
        summary={
          renewalResult
            ? {
                planAmount: renewalResult.membership.price,
                totalPaid: renewalResult.membership.amountPaid,
                dueAmount: renewalResult.membership.amountDue,
                paidInFull: renewalResult.membership.amountDue === 0,
              }
            : null
        }
        settings={settings}
      />
    </div>
  )
}

function daysLabel(days) {
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'Due today'
  return `${days}d left`
}

function ExpiryBadge({ days }) {
  const config = EXPIRY_BADGES[getExpiryBucket(days)]
  if (!config) return <Badge tone="neutral">—</Badge>
  return <Badge tone={config.tone}>{config.label}</Badge>
}
