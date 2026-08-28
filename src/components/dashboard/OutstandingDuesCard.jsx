import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronUp, Wallet } from 'lucide-react'
import { MemberPhoto } from '@/components/common/MemberPhoto'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatCurrency } from '@/utils/formatters'

export function OutstandingDuesCard({ rows = [], totalDue = 0, count = 0, settings, canWrite, onRecord }) {
  const [expanded, setExpanded] = useState(true)
  const currency = settings?.currency

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Outstanding Dues"
        subtitle="Members with unpaid membership amounts"
        actions={
          rows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          ) : undefined
        }
      />

      <CardBody className="p-0">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-slate-200 bg-amber-50/60 px-5 py-4 dark:border-slate-800 dark:bg-amber-500/5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <Wallet size={18} />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Total outstanding due
              </p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100">
                {formatCurrency(totalDue, currency)}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Members with dues
            </p>
            <p className="text-2xl font-black text-slate-900 dark:text-slate-100">{count}</p>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No outstanding dues"
            description="All memberships are fully paid. Members with a remaining due will appear here."
          />
        ) : !expanded ? null : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="th">Member</th>
                  <th className="th hidden lg:table-cell">Plan</th>
                  <th className="th">Total amount</th>
                  <th className="th hidden sm:table-cell">Paid</th>
                  <th className="th">Remaining due</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr
                    key={r.member.id}
                    className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <td className="td">
                      <Link to={`/members/${r.member.id}`} className="flex items-center gap-3">
                        <MemberPhoto member={r.member} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                            {r.member.name}
                          </p>
                          <p className="truncate text-xs text-slate-400">
                            {r.member.memberNo || '—'}
                          </p>
                        </div>
                      </Link>
                    </td>
                    <td className="td hidden lg:table-cell">
                      <Badge tone="indigo">{r.plan.name}</Badge>
                    </td>
                    <td className="td whitespace-nowrap">
                      {formatCurrency(r.planAmount, currency)}
                    </td>
                    <td className="td hidden whitespace-nowrap text-emerald-600 sm:table-cell">
                      {formatCurrency(r.totalPaid, currency)}
                    </td>
                    <td className="td whitespace-nowrap font-semibold text-rose-600">
                      {formatCurrency(r.dueAmount, currency)}
                    </td>
                    <td className="td">
                      <div className="flex justify-end">
                        {canWrite && (
                          <Button
                            variant="outline"
                            size="sm"
                            title="Record payment"
                            onClick={() => onRecord(r.member, r.dueAmount, r.targetMembershipId)}
                          >
                            Record Payment
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
