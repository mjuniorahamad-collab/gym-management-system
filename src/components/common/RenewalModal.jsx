import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertTriangle, RefreshCcw } from 'lucide-react'
import { renewalSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { useToast } from '@/context/ToastContext'
import { useSettings } from '@/context/SettingsContext'
import { renewMembership } from '@/services/renewals'
import { recordPayment } from '@/services/payments'
import { toDateInputValue } from '@/utils/dateHelpers'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { computeMemberLedger } from '@/utils/dues'
import { getMembershipCharge } from '@/utils/pt'
import {
  getMembershipPeriod,
  getRenewalPaymentSummary,
  resolveEffectiveStart,
  PAYMENT_STATUS_LABELS,
} from '@/utils/renewal'
import { findOverlappingPeriods } from '@/utils/memberships'
import { PAYMENT_METHODS } from '@/utils/constants'

const STATUS_TONES = { paid: 'success', partial: 'warning', due: 'danger' }

function defaultsFor(currentPlan) {
  return {
    planId: currentPlan?.id || '',
    effectiveMode: 'previous-expiry',
    customDate: '',
    amount: '',
    method: 'Cash',
    date: toDateInputValue(),
    note: '',
  }
}

export function RenewalModal({ open, onClose, member, currentPlan, currentExpiry, plans, payments = [], memberships = [], onRenewed, ptSurcharge = 0 }) {
  const toast = useToast()
  const { settings } = useSettings()
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm({ resolver: zodResolver(renewalSchema), defaultValues: defaultsFor(currentPlan) })

  // Explicit split-collection state: by default a renewal charges ONLY the
  // new period. Collecting an older balance requires the owner to opt in,
  // and is stored as its own payment targeted at that old period.
  const [alsoCollect, setAlsoCollect] = useState(false)
  const [collectAmount, setCollectAmount] = useState('')

  useEffect(() => {
    if (!open) return
    reset(defaultsFor(currentPlan))
    setAlsoCollect(false)
    setCollectAmount('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reset])

  const watched = watch()

  const selectedPlan = useMemo(
    () => plans.find((p) => String(p.id) === String(watched.planId)) || null,
    [plans, watched.planId]
  )

  // Effective start reflects the owner's choice: previous expiry, today, or a
  // custom date. The membership period (start + expiry) is derived from it;
  // the payment's own date is tracked separately and never overwritten.
  const effectiveStart = useMemo(
    () =>
      resolveEffectiveStart({
        mode: watched.effectiveMode,
        currentExpiry,
        customDate: watched.customDate,
      }),
    [watched.effectiveMode, currentExpiry, watched.customDate]
  )

  const period = useMemo(
    () => getMembershipPeriod({ currentExpiry, plan: selectedPlan, effectiveStartDate: effectiveStart }),
    [currentExpiry, selectedPlan, effectiveStart]
  )

  const renewalOverlaps = useMemo(() => {
    if (!period || !member) return []
    const startInput = toDateInputValue(period.startDate)
    const overlaps = findOverlappingPeriods(
      { memberId: member.id, startDate: startInput, expiryDate: toDateInputValue(period.expiryDate) },
      memberships
    )
    // Backdating to the previous expiry is contiguous (an existing period ends
    // exactly on the new start). That boundary touch is NOT a real overlap, so
    // suppress it — genuine overlaps (starting before an existing expiry) still warn.
    return overlaps.filter((o) => o.expiryDate !== startInput)
  }, [period, member, memberships])

  // Single source of truth: outstanding balances come from the finance
  // ledger, never from ad-hoc formulas.
  const ledger = useMemo(
    () =>
      member
        ? computeMemberLedger({
            member,
            plans,
            payments,
            memberships,
            ptSurcharge,
            ptSurchargeOverride: member?.ptSurchargeOverride,
          })
        : null,
    [member, plans, payments, memberships, ptSurcharge]
  )

  const previousDue = ledger?.totals.due || 0
  const targetMembershipId = ledger?.targetMembershipId

  const summary = useMemo(
    () =>
      getRenewalPaymentSummary({
        planPrice: getMembershipCharge({
          plan: selectedPlan,
          isPT: Boolean(member?.isPT),
          ptSurcharge,
          ptSurchargeOverride: member?.ptSurchargeOverride,
        }).total,
        paidAmount: watched.amount,
      }),
    [selectedPlan, watched.amount, member, ptSurcharge]
  )

  const charge = useMemo(
    () =>
      getMembershipCharge({
        plan: selectedPlan,
        isPT: Boolean(member?.isPT),
        ptSurcharge,
        ptSurchargeOverride: member?.ptSurchargeOverride,
      }),
    [selectedPlan, member, ptSurcharge]
  )

  const rawCollect = Number(collectAmount)
  const collectAmt =
    alsoCollect && Number.isFinite(rawCollect) && rawCollect > 0
      ? Math.min(rawCollect, previousDue)
      : 0

  // Renewals are single-purpose: they charge ONLY the new period unless the
  // owner explicitly opts into also collecting the previous outstanding.
  const totalPayable = summary.price + collectAmt

  const [submitting, setSubmitting] = useState(false)

  const submit = async (values) => {
    if (submitting) return
    setSubmitting(true)
    try {
      const result = await renewMembership({
        member,
        plan: selectedPlan,
        currentExpiry,
        effectiveStartDate: toDateInputValue(effectiveStart),
        paidAmount: values.amount,
        method: values.method,
        date: values.date,
        note: values.note,
        receiptPrefix: settings.receiptPrefix,
        effectivePrice: charge.total,
        isPT: Boolean(member?.isPT),
        ptSurcharge: charge.addon,
      })

      if (collectAmt > 0 && targetMembershipId) {
        await recordPayment({
          values: {
            memberId: member.id,
            membershipId: targetMembershipId,
            amount: String(collectAmt),
            method: values.method,
            date: values.date,
            note: 'Previous balance collection',
          },
          memberName: member.name,
          type: 'membership',
          receiptPrefix: settings.receiptPrefix,
        })
      }

      toast.success(
        collectAmt > 0
          ? `Membership renewed · ${formatCurrency(collectAmt, settings.currency)} applied to previous balance`
          : 'Membership renewed'
      )
      onRenewed?.(result)
    } catch (e) {
      toast.error(e.message || 'Could not renew membership')
    } finally {
      setSubmitting(false)
    }
  }

  const activePlans = plans.filter((p) => p.active !== false)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Renew Membership"
      subtitle={member ? `${member.name} · ${settings.gymName}` : settings.gymName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="renewal-form" loading={submitting}>
            <RefreshCcw size={16} /> Renew &amp; charge
          </Button>
        </>
      }
    >
      <form id="renewal-form" aria-label="Renewal form" onSubmit={handleSubmit(submit)} className="space-y-5" noValidate>
        {/* Current membership */}
        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current membership</h4>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">Member</p>
              <div className="flex items-center gap-2">
                <p className="font-semibold text-slate-900 dark:text-slate-100">{member?.name || '—'}</p>
                <StatusBadge status={member?.status} />
              </div>
            </div>
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">Current plan</p>
              <p className="font-semibold text-slate-900 dark:text-slate-100">{currentPlan?.name || 'No plan'}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">Current expiry</p>
              <p className="font-semibold text-slate-900 dark:text-slate-100">{currentExpiry ? formatDate(currentExpiry) : '—'}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">Outstanding due</p>
              <p className="font-semibold text-slate-900 dark:text-slate-100">
                {previousDue > 0 ? formatCurrency(previousDue, settings.currency) : 'None'}
              </p>
            </div>
          </div>
        </section>

        {/* New membership */}
        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">New membership</h4>
          <div className="mt-3 space-y-4">
            <FormField label="Membership plan" error={errors.planId?.message} required>
              <Select error={errors.planId} {...register('planId')}>
                <option value="">Select a plan</option>
                {activePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatCurrency(p.price, settings.currency)} / {p.durationDays} days
                  </option>
                ))}
              </Select>
            </FormField>
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Renewal starts</p>
              <div role="radiogroup" aria-label="Renewal starts" className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="radio"
                    value="previous-expiry"
                    {...register('effectiveMode')}
                    className="h-4 w-4 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="font-medium">Previous expiry</span>
                  <span className="text-slate-400">
                    {currentExpiry ? formatDate(currentExpiry) : '—'}
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="radio"
                    value="today"
                    {...register('effectiveMode')}
                    className="h-4 w-4 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="font-medium">Today</span>
                  <span className="text-slate-400">{formatDate(new Date())}</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="radio"
                    value="custom"
                    {...register('effectiveMode')}
                    className="h-4 w-4 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="font-medium">Custom date</span>
                  {watched.effectiveMode === 'custom' && (
                    <Input
                      type="date"
                      className="w-44"
                      aria-label="Custom effective date"
                      error={errors.customDate}
                      {...register('customDate')}
                    />
                  )}
                </label>
              </div>
              {errors.customDate && (
                <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{errors.customDate.message}</p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-sm text-slate-500 dark:text-slate-400">Effective from</p>
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  {period ? formatDate(period.startDate) : '—'}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-500 dark:text-slate-400">New expiry</p>
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  {period ? formatDate(period.expiryDate) : '—'}
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-400">
              The membership is considered active from the effective date above. The payment received
              date is recorded separately in the Payment section — it is never changed to match the
              effective date.
            </p>
            {renewalOverlaps.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div>
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      Overlapping period{renewalOverlaps.length > 1 ? 's' : ''} detected
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                      {renewalOverlaps.map((o) => (
                        <li key={o.id}>
                          {o.planName || 'Period'} · {formatDate(o.startDate)} → {formatDate(o.expiryDate)}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                      This effective period overlaps an existing membership. No balance changes are
                      applied automatically — confirm this is intentional before saving.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Payment */}
        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Payment</h4>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">Previous outstanding due</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {formatCurrency(previousDue, settings.currency)}
              </span>
            </div>

            {/* Explicit opt-in: never absorb old dues silently. */}
            {previousDue > 0 && targetMembershipId && (
              <>
                <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={alsoCollect}
                    onChange={(e) => setAlsoCollect(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    Also collect previous outstanding ({formatCurrency(previousDue, settings.currency)})
                  </span>
                </label>
                {alsoCollect && (
                  <FormField
                    label="Amount applied to previous balance"
                    hint={`Max ${formatCurrency(previousDue, settings.currency)} — recorded as its own payment against that period`}
                    className="sm:col-span-2"
                  >
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      max={String(previousDue)}
                      value={collectAmount}
                      onChange={(e) => setCollectAmount(e.target.value)}
                      aria-label="Collect previous balance"
                    />
                  </FormField>
                )}
              </>
            )}

            <div className="flex items-center justify-between border-t border-slate-100 pt-2 dark:border-slate-800">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Total amount payable now</span>
              <span className="font-bold text-slate-900 dark:text-slate-100">{formatCurrency(totalPayable, settings.currency)}</span>
            </div>
            {collectAmt > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">→ Applied to previous period</span>
                <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatCurrency(collectAmt, settings.currency)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">Membership plan — base price</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">{formatCurrency(charge.base, settings.currency)}</span>
            </div>
            {charge.addon > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Personal Training surcharge</span>
                <span className="font-medium text-slate-800 dark:text-slate-100">{formatCurrency(charge.addon, settings.currency)}</span>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Personal Training</span>
                <span className="font-medium text-slate-400">None</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">New period total</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">{formatCurrency(charge.total, settings.currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">Remaining due (new period)</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">{formatCurrency(summary.due, settings.currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">Previous due remaining after</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {formatCurrency(Math.max(0, previousDue - collectAmt), settings.currency)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">Payment status</span>
              <Badge tone={STATUS_TONES[summary.status] || 'neutral'}>{PAYMENT_STATUS_LABELS[summary.status]}</Badge>
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <FormField label="Amount paid now" error={errors.amount?.message} hint="Leave 0 to record a due membership" required>
              <Input type="number" min="0" step="0.01" placeholder="0.00" error={errors.amount} {...register('amount')} />
            </FormField>
            <FormField label="Method" error={errors.method?.message} required>
              <Select error={errors.method} {...register('method')}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Payment received date" error={errors.date?.message} hint="When the money was actually received" required>
              <Input type="date" aria-label="Payment received date" error={errors.date} {...register('date')} />
            </FormField>
            <FormField label="Note" error={errors.note?.message}>
              <Input placeholder="e.g. Renewed for 3 months" error={errors.note} {...register('note')} />
            </FormField>
          </div>
        </section>
      </form>
    </Modal>
  )
}
