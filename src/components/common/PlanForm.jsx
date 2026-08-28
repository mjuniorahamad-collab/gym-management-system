import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { planSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

const EMPTY = { name: '', durationDays: 30, price: '', features: '', active: true }

export function PlanForm({ open, onClose, initial, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(planSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(initial ? { ...EMPTY, ...initial, features: (initial.features || []).join(', ') } : EMPTY)
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={initial ? 'Edit Plan' : 'New Membership Plan'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="plan-form" loading={submitting}>
            {initial ? 'Save changes' : 'Create plan'}
          </Button>
        </>
      }
    >
      <form id="plan-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField label="Plan name" error={errors.name?.message} required>
          <Input placeholder="e.g. Annual" error={errors.name} {...register('name')} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Duration (days)" error={errors.durationDays?.message} required>
            <Input type="number" min="1" error={errors.durationDays} {...register('durationDays')} />
          </FormField>
          <FormField label="Price" error={errors.price?.message} required>
            <Input type="number" min="0" step="0.01" placeholder="0.00" error={errors.price} {...register('price')} />
          </FormField>
        </div>

        <FormField label="Features" error={errors.features?.message} hint="Comma-separated, e.g. Unlimited access, Free PT session">
          <textarea rows={3} className="input" placeholder="Unlimited access, 2 group classes / week" {...register('features')} />
        </FormField>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" {...register('active')} />
          Plan is active
        </label>
      </form>
    </Modal>
  )
}
