import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { fetchDuesDriftReport } from '@/services/integrity'

/**
 * DATA INTEGRITY — what the nightly dues reconciliation found.
 *
 * This card only REPORTS. It is deliberately not a "fix" button: a period whose
 * cached figures disagree may have been re-priced on purpose by a human, and
 * rewriting it automatically would silently discard that decision. The one
 * action here is "check again", which just asks the server for the latest report.
 *
 * States it must handle honestly, because each is a different operational fact:
 *   - the job has never run for this gym  → "no report yet", not "all clear"
 *   - the job ran and found nothing       → clean, with when it ran
 *   - the job ran and found drift         → count + the sampled periods
 *   - the report cannot be read           → say so; never imply health
 */
const MAX_ROWS = 10

const formatWhen = (iso) => {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return 'unknown time'
  return date.toLocaleString()
}

const describe = (row) => {
  const fields = (row.fields || []).join(', ')
  const stored = (row.fields || []).map((f) => `${f}: ${row.stored?.[f] ?? '—'}`).join(' · ')
  const expected = (row.fields || []).map((f) => `${f}: ${row.expected?.[f] ?? '—'}`).join(' · ')
  return { fields, stored, expected }
}

export function IntegrityCard() {
  const [state, setState] = useState({ status: 'loading', report: null, reason: null })

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, status: 'loading' }))
    const result = await fetchDuesDriftReport()
    if (!result.ok) {
      setState({ status: result.reason === 'offline-mode' ? 'unavailable' : 'error', report: null, reason: result.reason })
      return
    }
    setState({ status: result.report ? 'ready' : 'never-run', report: result.report, reason: null })
  }, [])

  useEffect(() => {
    let active = true
    // `load` is stable; the guard only prevents a late response writing state
    // into an unmounted card.
    load().catch(() => {
      if (active) setState({ status: 'error', report: null, reason: 'report unavailable' })
    })
    return () => {
      active = false
    }
  }, [load])

  const { status, report, reason } = state

  return (
    <Card>
      <CardHeader
        title="Data integrity"
        subtitle="Nightly dues reconciliation · report only, nothing is changed automatically"
        actions={<ShieldCheck size={16} className="text-slate-400" />}
      />
      <CardBody className="space-y-4">
        {status === 'loading' && <p className="text-sm text-slate-500 dark:text-slate-400">Checking…</p>}

        {status === 'unavailable' && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Available in a deployed environment — the nightly reconciliation runs there, not in demo mode.
          </p>
        )}

        {status === 'error' && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <p className="font-semibold">The integrity report could not be read</p>
            <p className="mt-1 break-words text-xs">{reason}</p>
          </div>
        )}

        {status === 'never-run' && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No report yet — the nightly check has not run for this gym. That is not the same as &ldquo;all clear&rdquo;.
          </p>
        )}

        {status === 'ready' && report?.clean && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">No drift found</p>
              <p className="mt-1 text-xs">
                {report.periodsScanned} membership period{report.periodsScanned === 1 ? '' : 's'} across{' '}
                {report.membersScanned} member{report.membersScanned === 1 ? '' : 's'} match the ledger.
                Last checked {formatWhen(report.generatedAt)}.
              </p>
            </div>
          </div>
        )}

        {status === 'ready' && report && !report.clean && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">
                  {report.driftedPeriods} period{report.driftedPeriods === 1 ? '' : 's'} disagree with the ledger
                </p>
                <p className="mt-1 text-xs">
                  Across {report.driftedMembers} member{report.driftedMembers === 1 ? '' : 's'}.
                  Last checked {formatWhen(report.generatedAt)}. Nothing has been changed — a deliberate
                  price edit is not drift, so these need a human to look before anything is rewritten.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Member</th>
                    <th className="px-3 py-2">Period</th>
                    <th className="px-3 py-2">Stored</th>
                    <th className="px-3 py-2">Ledger says</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(report.sample || []).slice(0, MAX_ROWS).map((row) => {
                    const d = describe(row)
                    return (
                      <tr key={`${row.memberId}-${row.periodId}`} className="align-top">
                        <td className="px-3 py-2">
                          <p className="font-medium text-slate-800 dark:text-slate-100">
                            {row.memberName || 'Unknown member'}
                          </p>
                          <p className="text-xs text-slate-400">{row.memberId}</p>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                          <p>{row.periodId}</p>
                          <p className="text-slate-400">{d.fields}</p>
                        </td>
                        <td className="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{d.stored}</td>
                        <td className="px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">{d.expected}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {(report.sample || []).length > MAX_ROWS && (
              <p className="text-xs text-slate-400">
                Showing {MAX_ROWS} of {(report.sample || []).length} sampled periods.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={load} loading={status === 'loading'}>
            <RefreshCw size={14} /> Check again
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
