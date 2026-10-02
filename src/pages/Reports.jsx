import { useMemo } from 'react'
import { DollarSign, TrendingDown, TrendingUp, Users } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { exportPaymentsToCsv, exportExpensesToCsv, exportMembersToCsv } from '@/services/export'
import { useSettings } from '@/context/SettingsContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatCard } from '@/components/charts/StatCard'
import { RevenueChart } from '@/components/charts/RevenueChart'
import { MembersTrendChart } from '@/components/charts/MembersTrendChart'
import { CategoryPie } from '@/components/charts/CategoryPie'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { CSVExportButton } from '@/components/common/CSVExportButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { formatCurrency, formatNumber } from '@/utils/formatters'
import { addDays, lastNMonths, monthKey, parseDate } from '@/utils/dateHelpers'

export default function Reports() {
  const { settings } = useSettings()

  const members = useCollection('members')
  const payments = useCollection('payments')
  const expenses = useCollection('expenses')
  const attendance = useCollection('attendance')
  const plans = useCollection('membershipPlans')

  const loading =
    members.loading || payments.loading || expenses.loading || attendance.loading || plans.loading

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

  const totals = useMemo(() => {
    const key = monthKey(new Date())
    const revenue = payments.items.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    const costs = expenses.items.reduce((s, e) => s + (Number(e.amount) || 0), 0)
    const monthRevenue = payments.items
      .filter((p) => monthKey(parseDate(p.date)) === key)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)
    const monthCosts = expenses.items
      .filter((e) => monthKey(parseDate(e.date)) === key)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0)
    const active = members.items.filter((m) => m.status === 'active').length
    return { revenue, costs, monthRevenue, monthCosts, active }
  }, [payments.items, expenses.items, members.items])

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

  const planRevenue = useMemo(() => {
    const map = {}
    for (const p of payments.items) {
      const plan = plans.items.find((pl) => pl.id === p.planId)
      const name = plan?.name || (p.type === 'membership' ? 'Membership' : 'Other')
      map[name] = (map[name] || 0) + (Number(p.amount) || 0)
    }
    return Object.entries(map)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
  }, [payments.items, plans.items])

  const avgDailyCheckIns = useMemo(() => {
    if (attendance.items.length === 0) return 0
    const days = new Set(
      attendance.items.map((a) => parseDate(a.date)?.toDateString()).filter(Boolean)
    ).size
    return Math.round((attendance.items.length / Math.max(days, 1)) * 10) / 10
  }, [attendance.items])

  const maxPlanValue = Math.max(...planRevenue.map((p) => p.value), 1)

  if (loading) return <Spinner label="Preparing reports…" />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        subtitle="Business performance at a glance"
        actions={
          <>
            <CSVExportButton
              label="Members CSV"
              onExport={() => exportMembersToCsv(members.items, settings)}
            />
            <CSVExportButton
              label="Payments CSV"
              onExport={() => exportPaymentsToCsv(payments.items, settings)}
            />
            <CSVExportButton label="Expenses CSV" onExport={() => exportExpensesToCsv(expenses.items)} />
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total revenue" value={formatCurrency(totals.revenue, settings.currency)} icon={DollarSign} tone="emerald" />
        <StatCard title="Total expenses" value={formatCurrency(totals.costs, settings.currency)} icon={TrendingDown} tone="rose" />
        <StatCard title="Net (this month)" value={formatCurrency(totals.monthRevenue - totals.monthCosts, settings.currency)} icon={TrendingUp} tone="indigo" sub={`${formatCurrency(totals.monthRevenue, settings.currency)} in · ${formatCurrency(totals.monthCosts, settings.currency)} out`} />
        <StatCard title="Active members" value={formatNumber(totals.active)} icon={Users} tone="sky" sub={`Avg ${avgDailyCheckIns} check-ins/day`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Cash flow" subtitle="Revenue vs expenses, last 6 months" />
          <CardBody>
            <RevenueChart data={series} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Member growth" subtitle="New members per month" />
          <CardBody>
            <MembersTrendChart data={membersTrend} />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Expenses by category" subtitle="Last 6 months" />
          <CardBody>
            {expensePie.length === 0 ? (
              <EmptyState title="No expense data" />
            ) : (
              <CategoryPie data={expensePie} />
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Revenue by plan" subtitle="Where your income comes from" />
          <CardBody className="space-y-4">
            {planRevenue.length === 0 ? (
              <EmptyState title="No payment data yet" />
            ) : (
              planRevenue.map((item) => (
                <div key={item.name}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{item.name}</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrency(item.value, settings.currency)}
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500"
                      style={{ width: `${(item.value / maxPlanValue) * 100}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
