import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Clock, RefreshCcw, ShieldAlert, Users } from 'lucide-react'
import { MemberPhoto } from '@/components/common/MemberPhoto'
import { WhatsAppReminderButton } from '@/components/common/WhatsAppReminderButton'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs } from '@/components/ui/Tabs'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { AT_RISK_FILTERS } from '@/utils/churnRisk'

const MAX_ROWS = 40

const TIER_BADGES = {
  high: { tone: 'danger', label: 'High risk' },
  medium: { tone: 'warning', label: 'Watch' },
  low: { tone: 'neutral', label: 'Low' },
}

function VisitCell({ daysSinceVisit, lastVisit }) {
  if (daysSinceVisit === null) {
    return <span className="text-slate-400">Never</span>
  }
  return (
    <div className="whitespace-nowrap">
      <p className={daysSinceVisit >= 30 ? 'font-medium text-rose-600' : ''}>
        {daysSinceVisit === 0 ? 'Today' : `${daysSinceVisit}d ago`}
      </p>
      <p className="text-xs text-slate-400">{formatDate(lastVisit)}</p>
    </div>
  )
}

function SignalsCell({ row }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.reasons.map((reason) => (
        <Badge key={reason.key} tone={reason.tone}>
          {reason.label}
        </Badge>
      ))}
    </div>
  )
}

export function AtRiskMembersCard({
  rows = [],
  summary,
  settings,
  canFinance = false,
  canWrite = false,
  onRenew,
}) {
  const [filter, setFilter] = useState('all')

  const filtered = useMemo(() => {
    const list = filter === 'all' ? rows : rows.filter((r) => r.signals.includes(filter))
    return { rows: list.slice(0, MAX_ROWS), total: list.length }
  }, [rows, filter])

  const currency = settings?.currency
  const stats = summary || {
    total: rows.length,
    high: 0,
    valueAtRisk: 0,
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="At-Risk Members"
        subtitle="Built from last visit, unpaid dues and expiring renewals"
        actions={<Tabs tabs={AT_RISK_FILTERS} active={filter} onChange={setFilter} label="Risk filters" />}
      />

      <CardBody className="p-0">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-slate-200 bg-rose-50/60 px-5 py-4 dark:border-slate-800 dark:bg-rose-500/5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
              <ShieldAlert size={18} />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Members needing attention
              </p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100">{stats.total}</p>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              High risk
            </p>
            <p className="text-2xl font-black text-rose-600">{stats.high}</p>
          </div>
          {canFinance && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Dues at risk
              </p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100">
                {formatCurrency(stats.valueAtRisk || 0, currency)}
              </p>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No at-risk members"
            description="Members who stop visiting, fall behind on dues or approach expiry will appear here."
          />
        ) : filtered.rows.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="No members in this filter"
            description="Pick another risk signal to see the members it flags."
          />
        ) : (
          <>
            <div className="table-stack overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="th">Member</th>
                    <th className="th">Risk</th>
                    <th className="th hidden lg:table-cell">Why</th>
                    <th className="th hidden md:table-cell">Last visit</th>
                    {canFinance && <th className="th hidden sm:table-cell">Dues</th>}
                    <th className="th hidden lg:table-cell">Expires</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filtered.rows.map((row) => {
                    const tier = TIER_BADGES[row.tier] || TIER_BADGES.low
                    return (
                      <tr
                        key={row.member.id}
                        className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <td className="td" data-primary>
                          <Link to={`/members/${row.member.id}`} className="flex items-center gap-3">
                            <MemberPhoto member={row.member} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                                {row.member.name}
                              </p>
                              <p className="truncate text-xs text-slate-400">
                                {row.member.memberNo || row.member.phone || '—'}
                              </p>
                            </div>
                          </Link>
                        </td>
                        <td className="td whitespace-nowrap" data-label="Risk">
                          <Badge tone={tier.tone}>{tier.label}</Badge>
                          <p className="mt-1 text-xs text-slate-400">Score {row.score}</p>
                        </td>
                        <td className="td hidden lg:table-cell" data-label="Why">
                          <SignalsCell row={row} />
                        </td>
                        <td className="td hidden md:table-cell" data-label="Last visit">
                          <VisitCell daysSinceVisit={row.daysSinceVisit} lastVisit={row.lastVisit} />
                        </td>
                        {canFinance && (
                          <td className="td hidden whitespace-nowrap sm:table-cell" data-label="Dues">
                            {row.dueAmount > 0 ? (
                              <>
                                <p className="font-semibold text-rose-600">
                                  {formatCurrency(row.dueAmount, currency)}
                                </p>
                                {row.dueBucket && (
                                  <p className="text-xs text-slate-400">{row.dueBucket} days</p>
                                )}
                              </>
                            ) : (
                              <span className="text-slate-400">Clear</span>
                            )}
                          </td>
                        )}
                        <td className="td hidden whitespace-nowrap lg:table-cell" data-label="Expires">
                          {row.expiry ? (
                            <div className="flex items-center gap-1.5">
                              <Clock size={13} className="text-slate-400" />
                              <span>
                                {formatDate(row.expiry)}
                                {row.daysToExpiry !== null && (
                                  <span
                                    className={
                                      row.daysToExpiry < 0
                                        ? 'ml-1 text-xs font-medium text-rose-600'
                                        : 'ml-1 text-xs text-slate-400'
                                    }
                                  >
                                    ({row.daysToExpiry < 0 ? `${Math.abs(row.daysToExpiry)}d ago` : `${row.daysToExpiry}d`})
                                  </span>
                                )}
                              </span>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="td" data-actions>
                          <div className="flex items-center justify-end gap-1">
                            {canWrite && (
                              <Button
                                variant="outline"
                                size="sm"
                                title="Renew membership"
                                onClick={() => onRenew?.(row)}
                              >
                                <RefreshCcw size={14} /> Renew
                              </Button>
                            )}
                            <WhatsAppReminderButton
                              iconOnly
                              label="Send WhatsApp reminder"
                              memberName={row.member.name}
                              gymName={settings?.gymName}
                              planName={row.plan?.name}
                              expiryDate={row.expiry}
                              phone={row.member.phone}
                            />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {filtered.total > MAX_ROWS && (
              <p className="border-t border-slate-100 px-5 py-3 text-center text-xs text-slate-400 dark:border-slate-800">
                Showing the {MAX_ROWS} highest-risk members of {filtered.total}. Narrow the list with the
                filters above.
              </p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
