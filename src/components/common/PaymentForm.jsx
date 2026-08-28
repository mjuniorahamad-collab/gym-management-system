import { useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { paymentSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { PAYMENT_METHODS } from '@/utils/constants'
import { toDateInputValue } from '@/utils/dateHelpers'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { computeMemberLedger } from '@/utils/dues'
import { useSettings } from '@/context/SettingsContext'

const EMPTY = { memberId: '', planId: '', amount: '', method: 'Cash', date: toDateInputValue(), note: '' }

export function PaymentForm({ open, onClose, members, plans, payments = [], memberships = [], submitting, onSubmit, initial }) {
  const { settings } = useSettings()
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({ resolver: zodResolver(paymentSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(initial ? { ...EMPTY, ...initial, amount: initial.amount ?? '' } : EMPTY)
  }, [open, initial, reset])

  const watched = watch()
  const member = useMemo(
    () => members.find((m) => m.id === watched.memberId),
    [members, watched.memberId]
  )

  // Single source of truth: the finance ledger drives every figure shown.
  const ledger = useMemo(
    () =>
      member
        ? computeMemberLedger({ member, plans, payments, memberships })
        : null,
    [member, plans, payments, memberships]
  )

  const openTargets = useMemo(
    () =>
      (ledger?.periods || [])
        .filter((p) => !p.implicit && p.due > 0)
        .map((p) => ({
          id: p.id,
          label: `${p.label} · ${formatDate(p.startDate)} – ${formatDate(p.expiryDate)} · due ${formatCurrency(p.due, settings.currency)}`,
        })),
    [ledger, settings.currency]
  )

  // Keep the allocation valid when the member changes after opening.
  useEffect(() => {
    if (!open || !ledger) return
    const knownIds = new Set(ledger.periods.filter((p) => p.id).map((p) => p.id))
    const current = watched.membershipId || ''
    if (current && !knownIds.has(current)) {
      setValue('membershipId', ledger.targetMembershipId || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ledger])

  const selectedPeriod = useMemo(
    () => (ledger?.periods || []).find((p) => p.id === watched.membershipId) || null,
    [ledger, watched.membershipId]
  )

  const amount = Number(watched.amount)
  const dueAfter =
    selectedPeriod && Number.isFinite(amount) && amount > 0
      ? Math.max(0, selectedPeriod.due - amount)
      : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Record Payment"
      subtitle="Log an incoming payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="payment-form" loading={submitting}>
            Save payment
          </Button>
        </>
      }
    >
      <form id="payment-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField label="Member" error={errors.memberId?.message} required>
          <Select error={errors.memberId} {...register('memberId')}>
            <option value="">Select a member</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Apply to membership period"
          error={errors.membershipId?.message}
          hint={
            openTargets.length > 0
              ? 'The payment is allocated ONLY to the chosen period — other balances stay untouched.'
              : 'No unpaid periods — the payment will be stored as unallocated credit.'
          }
        >
          <Select {...register('membershipId')}>
            <option value="">Unallocated / general</option>
            {openTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </FormField>

        {selectedPeriod && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span>
                Period fee: <span className="font-semibold">{formatCurrency(selectedPeriod.price, settings.currency)}</span>
              </span>
              <span>
                Paid so far: <span className="font-semibold">{formatCurrency(selectedPeriod.paid, settings.currency)}</span>
              </span>
              <span>
                Remaining due:{' '}
                <span className={selectedPeriod.due === 0 ? 'font-semibold text-emerald-600' : 'font-semibold'}>
                  {selectedPeriod.due === 0 ? 'Paid in full' : formatCurrency(selectedPeriod.due, settings.currency)}
                </span>
              </span>
            </div>
            {dueAfter !== null && (
              <p className="mt-1 text-xs text-indigo-500 dark:text-indigo-300">
                Due on this period after this payment:{' '}
                {dueAfter === 0 ? 'None — period paid in full' : formatCurrency(dueAfter, settings.currency)}
                {ledger.totals.due > 0 ? ` · Total outstanding stays ${formatCurrency(Math.max(0, ledger.totals.due - Math.min(amount || 0, selectedPeriod.due)), settings.currency)}` : ''}
              </p>
            )}
          </div>
        )}

        {!selectedPeriod && ledger && ledger.totals.due > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            No period selected. Total outstanding across all periods:{' '}
            <span className="font-semibold">{formatCurrency(ledger.totals.due, settings.currency)}</span>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Plan (optional)" error={errors.planId?.message}>
            <Select error={errors.planId} {...register('planId')}>
              <option value="">No plan linked</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Amount" error={errors.amount?.message} required>
            <Input type="number" min="0" step="0.01" placeholder="0.00" error={errors.amount} {...register('amount')} />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Method" error={errors.method?.message}>
            <Select error={errors.method} {...register('method')}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Date" error={errors.date?.message} required>
            <Input type="date" error={errors.date} {...register('date')} />
          </FormField>
        </div>

        <FormField label="Note" error={errors.note?.message}>
          <Input placeholder="e.g. Monthly membership" error={errors.note} {...register('note')} />
        </FormField>
      </form>
    </Modal>
  )
}
