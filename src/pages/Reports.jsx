import { useMemo, useState } from 'react'
import { CalendarRange, DollarSign, TrendingDown, TrendingUp, Users } from 'lucide-react'
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
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { Spinner } from '@/components/ui/Spinner'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatNumber } from '@/utils/formatters'
import { addDaysToKey, resolveGymTimezone } from '@/utils/gymTime'
import {
  averageDailyCheckIns,
  defaultReportRange,
  expensesByCategory,
  monthlyCashFlow,
  monthlyNewMembers,
  normalizeReportRange,
  rangeDayCount,
  rangeTotals,
  revenueByPlan,
} from '@/utils/reportRange'

const PRESETS = [
  { label: 'This month', kind: 'month' },
  { label: 'Last 30 days', kind: 'days', days: 29 },
  { label: 'Last 90 days', kind: 'days', days: 89 },
  { label: 'Last 6 months', kind: 'months' },
  { label: 'Year to date', kind: 'ytd' },
]

export default function Reports() {
  const { settings, timezone } = useSettings()
  const tz = resolveGymTimezone(timezone)

  const members = useCollection('members')
  const payments = useCollection('payments')
  const expenses = useCollection('expenses')
  const attendance = useCollection('attendance')
  const plans = useCollection('membershipPlans')

  const loading =
    members.loading || payments.loading || expenses.loading || attendance.loading || plans.loading

  const loadError = members.error || payments.error || expenses.error || attendance.error || plans.error

  // Initialise from the current gym-local day. Held in state so a half-typed
  // range (start moved past end) does not blank the report mid-edit.
  const [range, setRange] = useState(() => defaultReportRange(tz))
  const [draft, setDraft] = useState(() => {
    const initial = defaultReportRange(tz)
    return { from: initial?.from || '', to: initial?.to || '' }
  })
  const [rangeError, setRangeError] = useState('')

  const applyRange = (next) => {
    const normalized = normalizeReportRange(next.from, next.to)
    if (!normalized) {
      setRangeError('Enter a valid range whose end is on or after its start.')
      return
    }
    setRangeError('')
    setRange(normalized)
    setDraft({ from: normalized.from, to: normalized.to })
  }

  const applyPresetTo = (preset) => {
    const now = new Date()
    // Today in the gym's zone, as a YYYY-MM-DD key. Reused as the range end so
    // a preset never straddles two days for a device in another zone.
    const todayKey = defaultReportRange(tz, now).to

    if (preset.kind === 'ytd') {
      applyRange({ from: `${todayKey.slice(0, 4)}-01-01`, to: todayKey })
      return
    }
    if (preset.kind === 'month') {
      applyRange({ from: `${todayKey.slice(0, 7)}-01`, to: todayKey })
      return
    }
    if (preset.kind === 'months') {
      applyRange(defaultReportRange(tz, now))
      return
    }
    if (preset.kind === 'days') {
      applyRange({ from: addDaysToKey(todayKey, -preset.days), to: todayKey })
    }
  }

  const series = useMemo(
    () => monthlyCashFlow(payments.items, expenses.items, range, tz),
    [payments.items, expenses.items, range, tz]
  )

  const totals = useMemo(
    () =>
      rangeTotals(
        { payments: payments.items, expenses: expenses.items, members: members.items },
        range,
        tz
      ),
    [payments.items, expenses.items, members.items, range, tz]
  )

  const membersTrend = useMemo(
    () => monthlyNewMembers(members.items, range, tz),
    [members.items, range, tz]
  )

  const expensePie = useMemo(
    () => expensesByCategory(expenses.items, range, tz),
    [expenses.items, range, tz]
  )

  const planRevenue = useMemo(
    () => revenueByPlan(payments.items, plans.items, range, tz),
    [payments.items, plans.items, range, tz]
  )

  const avgDailyCheckIns = useMemo(
    () => averageDailyCheckIns(attendance.items, range, tz),
    [attendance.items, range, tz]
  )

  const maxPlanValue = Math.max(...planRevenue.map((p) => p.value), 1)
  const dayCount = rangeDayCount(range)
  const rangeLabel = range ? `${range.from} to ${range.to}` : ''

  if (loading) return <Spinner label="Preparing reports…" />

  if (loadError) {
    return (
      <LoadErrorState
        label="reports"
        message={loadError}
        onRetry={() => {
          members.reload()
          payments.reload()
          expenses.reload()
          attendance.reload()
          plans.reload()
        }}
      />
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        subtitle="Business performance over a date range you choose"
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
            <CSVExportButton
              label="Expenses CSV"
              onExport={() => exportExpensesToCsv(expenses.items)}
            />
          </>
        }
      />

      <Card>
        <CardHeader
          title="Date range"
          subtitle={`All figures below cover these ${dayCount} calendar days in ${tz}${
            rangeError ? '' : rangeLabel ? ` (${rangeLabel})` : ''
          }`}
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300" htmlFor="report-from">
                From
              </label>
              <Input
                id="report-from"
                type="date"
                value={draft.from}
                max={draft.to || undefined}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                className="w-44"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300" htmlFor="report-to">
                To
              </label>
              <Input
                id="report-to"
                type="date"
                value={draft.to}
                min={draft.from || undefined}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                className="w-44"
              />
            </div>
            <Button type="button" onClick={() => applyRange(draft)}>
              Apply range
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => applyPresetTo(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {rangeError ? (
            <p role="alert" className="text-sm font-medium text-rose-600 dark:text-rose-400">
              {rangeError}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Revenue"
          value={formatCurrency(totals.revenue, settings.currency)}
          icon={DollarSign}
          tone="emerald"
          sub={`in range · ${dayCount} days`}
        />
        <StatCard
          title="Expenses"
          value={formatCurrency(totals.costs, settings.currency)}
          icon={TrendingDown}
          tone="rose"
          sub="in range"
        />
        <StatCard
          title="Net"
          value={formatCurrency(totals.net, settings.currency)}
          icon={TrendingUp}
          tone="indigo"
          sub={`${formatCurrency(totals.revenue, settings.currency)} in · ${formatCurrency(totals.costs, settings.currency)} out`}
        />
        <StatCard
          title="Active members"
          value={formatNumber(totals.active)}
          icon={Users}
          tone="sky"
          sub={`Avg ${avgDailyCheckIns} check-ins/day`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Cash flow" subtitle="Revenue vs expenses, by month in range" />
          <CardBody>
            <RevenueChart data={series} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Member growth" subtitle="New members per month in range" />
          <CardBody>
            <MembersTrendChart data={membersTrend} />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Expenses by category" subtitle="Within the selected range" />
          <CardBody>
            {expensePie.length === 0 ? (
              <EmptyState title="No expense data in this range" />
            ) : (
              <CategoryPie data={expensePie} />
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Revenue by plan" subtitle="Where income comes from, within the range" />
          <CardBody className="space-y-4">
            {planRevenue.length === 0 ? (
              <EmptyState title="No payment data in this range" />
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
                      style={{ width: `${(item.value / maxPlanValue) * 100}%` } }
                    />
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
        Figures are filtered in the browser over the loaded collection. Bounded server-side date
        queries need a <code>gymId + date</code> composite index that is not deployed yet.
      </p>
    </div>
  )
}