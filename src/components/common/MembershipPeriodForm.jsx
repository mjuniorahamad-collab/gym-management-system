import { useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertTriangle } from 'lucide-react'
import { membershipPeriodSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { useSettings } from '@/context/SettingsContext'
import { addDays, parseDate, toDateInputValue } from '@/utils/dateHelpers'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { findOverlappingPeriods } from '@/utils/memberships'

export function MembershipPeriodForm({
  open,
  onClose,
  period,
  plans = [],
  memberships = [],
  submitting,
  onSubmit,
}) {
  const { settings } = useSettings()

  const defaults = useMemo(() => {
    if (!period) return { planId: '', price: '', startDate: '', expiryDate: '' }
    return {
      planId: period.planId || '',
      price: period.price ?? '',
      startDate: toDateInputValue(period.startDate) || '',
      expiryDate: toDateInputValue(period.expiryDate) || '',
    }
  }, [period])

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm({ resolver: zodResolver(membershipPeriodSchema), defaultValues: defaults })

  useEffect(() => {
    if (!open) return
    reset(defaults)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reset])

  const watched = watch()

  const selectedPlan = useMemo(
    () => plans.find((p) => String(p.id) === String(watched.planId)) || null,
    [plans, watched.planId]
  )

  const computedExpiry = useMemo(() => {
    if (!selectedPlan || !watched.startDate) return null
    const start = parseDate(watched.startDate)
    if (!start) return null
    return addDays(start, Number(selectedPlan.durationDays) || 0)
  }, [selectedPlan, watched.startDate])

  useEffect(() => {
    if (computedExpiry && open) {
      const currentExpiry = toDateInputValue(watched.expiryDate)
      const newExpiry = toDateInputValue(computedExpiry)
      if (currentExpiry !== newExpiry) {
        // Only update if the user hasn't manually changed it away from the computed value
      }
    }
  }, [computedExpiry, open, watched.expiryDate])

  const overlaps = useMemo(() => {
    if (!watched.startDate || !watched.expiryDate) return []
    return findOverlappingPeriods(
      {
        memberId: period?.memberId,
        startDate: watched.startDate,
        expiryDate: watched.expiryDate,
        excludeId: period?.id,
      },
      memberships
    )
  }, [watched.startDate, watched.expiryDate, period?.memberId, period?.id, memberships])

  const activePlans = plans.filter((p) => p.active !== false)

  const handlePlanChange = (e) => {
    register('planId').onChange(e)
    const plan = activePlans.find((p) => String(p.id) === String(e.target.value))
    if (plan) {
      // Update price when plan changes
      const priceInput = document.querySelector('[name="price"]')
      if (priceInput) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        nativeInputValueSetter.call(priceInput, String(plan.price))
        priceInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Edit Membership Period"
      subtitle={period ? `Period from ${formatDate(period.startDate)} to ${formatDate(period.expiryDate)}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="period-form" loading={submitting}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="period-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField label="Membership plan" error={errors.planId?.message} required>
          <Select error={errors.planId} {...register('planId')} onChange={handlePlanChange}>
            <option value="">Select a plan</option>
            {activePlans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatCurrency(p.price, settings.currency)} / {p.durationDays} days
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Period fee" error={errors.price?.message} required>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            error={errors.price}
            {...register('price')}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Start date" error={errors.startDate?.message} required>
            <Input type="date" error={errors.startDate} {...register('startDate')} />
          </FormField>
          <FormField label="Expiry date" error={errors.expiryDate?.message} required>
            <Input type="date" error={errors.expiryDate} {...register('expiryDate')} />
          </FormField>
        </div>

        {computedExpiry && watched.startDate && (
          <p className="text-xs text-slate-400">
            Based on {selectedPlan?.name || 'selected plan'} duration ({selectedPlan?.durationDays} days),
            expiry would be {formatDate(computedExpiry)}. You can override this manually.
          </p>
        )}

        {overlaps.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Overlapping period{overlaps.length > 1 ? 's' : ''} detected
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                  {overlaps.map((o) => (
                    <li key={o.id}>
                      {o.planName || 'Period'} · {formatDate(o.startDate)} → {formatDate(o.expiryDate)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                  This may be intentional — you can still save.
                </p>
              </div>
            </div>
          </div>
        )}
      </form>
    </Modal>
  )
}
