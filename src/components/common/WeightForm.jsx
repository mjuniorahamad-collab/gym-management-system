import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { weightRecordSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { toDateInputValue } from '@/utils/dateHelpers'

const EMPTY = { weight: '', date: toDateInputValue() }

export function WeightForm({ open, onClose, initial, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(weightRecordSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(
      initial
        ? { ...EMPTY, ...initial, weight: initial.weight ?? '', date: toDateInputValue(initial.date) }
        : EMPTY
    )
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={initial ? 'Edit Measurement' : 'Add Measurement'}
      subtitle={initial ? 'Correct this weight measurement' : 'Record a new weight measurement'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="weight-form" loading={submitting}>
            {initial ? 'Save changes' : 'Add measurement'}
          </Button>
        </>
      }
    >
      <form id="weight-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Weight (kg)" error={errors.weight?.message} required>
            <Input
              type="number"
              min="0"
              step="0.1"
              placeholder="e.g. 72.5"
              error={errors.weight}
              {...register('weight')}
            />
          </FormField>
          <FormField label="Measurement date" error={errors.date?.message} required>
            <Input type="date" error={errors.date} {...register('date')} />
          </FormField>
        </div>
      </form>
    </Modal>
  )
}
