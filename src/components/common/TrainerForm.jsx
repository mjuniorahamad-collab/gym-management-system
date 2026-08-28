import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { trainerSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { toDateInputValue } from '@/utils/dateHelpers'

const EMPTY = { name: '', email: '', phone: '', specialization: '', hourlyRate: '', hireDate: '', active: true }

export function TrainerForm({ open, onClose, initial, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(trainerSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(initial ? { ...EMPTY, ...initial, hireDate: toDateInputValue(initial.hireDate) } : EMPTY)
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={initial ? 'Edit Trainer' : 'Add Trainer'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="trainer-form" loading={submitting}>
            {initial ? 'Save changes' : 'Add trainer'}
          </Button>
        </>
      }
    >
      <form id="trainer-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" error={errors.name?.message} required>
            <Input placeholder="e.g. Arjun Basnet" error={errors.name} {...register('name')} />
          </FormField>
          <FormField label="Specialization" error={errors.specialization?.message} required>
            <Input placeholder="e.g. Strength & Conditioning" error={errors.specialization} {...register('specialization')} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Email" error={errors.email?.message}>
            <Input type="email" placeholder="trainer@example.com" error={errors.email} {...register('email')} />
          </FormField>
          <FormField label="Phone" error={errors.phone?.message} required>
            <Input placeholder="98XXXXXXXX" error={errors.phone} {...register('phone')} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Hourly rate" error={errors.hourlyRate?.message} required>
            <Input type="number" min="0" step="0.01" placeholder="0.00" error={errors.hourlyRate} {...register('hourlyRate')} />
          </FormField>
          <FormField label="Hire date" error={errors.hireDate?.message}>
            <Input type="date" error={errors.hireDate} {...register('hireDate')} />
          </FormField>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" {...register('active')} />
          Active trainer
        </label>
      </form>
    </Modal>
  )
}
