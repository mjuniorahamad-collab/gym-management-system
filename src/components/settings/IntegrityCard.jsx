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

/** `amountDue: 0 → 2500` for each disagreeing field, so a row reads as one fact. */
const describe = (row) =>
  (row.fields || []).map(
    (field) => `${field}: ${row.stored?.[field] ?? '—'} → ${row.expected?.[field] ?? '—'}`
  )

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

  // `load` never throws (the service returns a result), so there is nothing to
  // catch and no mounted flag to maintain here.
  useEffect(() => {
    load()
  }, [load])

  const { status, report, reason } = state
  // A partial report covers a slice of a large gym and is resumed next run. It
  // must never be rendered as "clean" — only a complete cycle can say that.
  // `coverage` is how much of the gym the cycle has looked at; `evidence` is what
  // the latest read confirmed. The card always says which is which, because a
  // cumulative coverage next to this-run drift reads as a contradiction.
  const coverage = report?.coverage || { membersScanned: 0, periodsScanned: 0 }
  const evidence = report?.evidence || { scope: 'cycle', members: 0, periods: 0, sample: [] }
  const partial = Boolean(report) && report.complete === false
  const clean = Boolean(report) && report.complete !== false && report.clean === true
  const driftedPeriods = Number(evidence.periods) || 0

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

        {status === 'ready' && partial && (
          <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
            <p className="font-semibold">Partial check — large gym</p>
            <p className="mt-1 text-xs">
              {coverage.membersScanned} member{coverage.membersScanned === 1 ? '' : 's'} scanned so far; the
              next scheduled run continues from here. Any drift below is from this run&rsquo;s page only, and
              this is not an all-clear.
            </p>
          </div>
        )}

        {status === 'ready' && clean && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">No drift found</p>
              <p className="mt-1 text-xs">
                {coverage.periodsScanned} membership period{coverage.periodsScanned === 1 ? '' : 's'} across{' '}
                {coverage.membersScanned} member{coverage.membersScanned === 1 ? '' : 's'} match the ledger.
                Last checked {formatWhen(report.generatedAt)}.
              </p>
            </div>
          </div>
        )}

        {status === 'ready' && report && !clean && (driftedPeriods > 0 || partial) && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">
                  {driftedPeriods} period{driftedPeriods === 1 ? '' : 's'} disagree with the ledger
                </p>
                <p className="mt-1 text-xs">
                  Across {evidence.members} member{evidence.members === 1 ? '' : 's'}
                  {partial ? ' in this run’s page' : ''}.
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
                    <th className="px-3 py-2">Stored → ledger</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(evidence.sample || []).slice(0, MAX_ROWS).map((row) => (
                    <tr key={`${row.memberId}-${row.periodId}`} className="align-top">
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-800 dark:text-slate-100">
                          {row.memberName || 'Unknown member'}
                        </p>
                        <p className="text-xs text-slate-400">{row.memberId}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                        {row.periodId}
                      </td>
                      <td colSpan={2} className="px-3 py-2 text-xs">
                        {describe(row).map((line) => (
                          <p key={line} className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
                            {line}
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(evidence.sample || []).length > MAX_ROWS && (
              <p className="text-xs text-slate-400">
                Showing {MAX_ROWS} of {(evidence.sample || []).length} sampled periods.
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
