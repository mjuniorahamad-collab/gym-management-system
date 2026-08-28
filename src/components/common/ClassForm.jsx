import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { classSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { DAYS_OF_WEEK } from '@/utils/constants'

const EMPTY = {
  name: '',
  description: '',
  dayOfWeek: 'Monday',
  startTime: '07:00',
  endTime: '08:00',
  trainerId: '',
  capacity: 15,
  active: true,
}

export function ClassForm({ open, onClose, initial, trainers, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(classSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(initial ? { ...EMPTY, ...initial } : EMPTY)
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={initial ? 'Edit Class' : 'Add Class'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="class-form" loading={submitting}>
            {initial ? 'Save changes' : 'Add class'}
          </Button>
        </>
      }
    >
      <form id="class-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField label="Class name" error={errors.name?.message} required>
          <Input placeholder="e.g. Morning Yoga" error={errors.name} {...register('name')} />
        </FormField>

        <FormField label="Description" error={errors.description?.message}>
          <textarea rows={2} className="input" placeholder="Short description…" {...register('description')} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Day" error={errors.dayOfWeek?.message}>
            <Select error={errors.dayOfWeek} {...register('dayOfWeek')}>
              {DAYS_OF_WEEK.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Trainer" error={errors.trainerId?.message}>
            <Select error={errors.trainerId} {...register('trainerId')}>
              <option value="">Unassigned</option>
              {trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Start time" error={errors.startTime?.message}>
            <Input type="time" error={errors.startTime} {...register('startTime')} />
          </FormField>
          <FormField label="End time" error={errors.endTime?.message}>
            <Input type="time" error={errors.endTime} {...register('endTime')} />
          </FormField>
          <FormField label="Capacity" error={errors.capacity?.message}>
            <Input type="number" min="1" error={errors.capacity} {...register('capacity')} />
          </FormField>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" {...register('active')} />
          Class is active
        </label>
      </form>
    </Modal>
  )
}
