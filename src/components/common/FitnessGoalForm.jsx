import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { fitnessGoalSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { FITNESS_GOALS } from '@/utils/constants'

const EMPTY = { fitnessGoal: '', targetWeight: '' }

export function FitnessGoalForm({ open, onClose, initial, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(fitnessGoalSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset({
      fitnessGoal: initial?.fitnessGoal || '',
      targetWeight: initial?.targetWeight ?? '',
    })
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Fitness Goal"
      subtitle="Set or update this member's fitness goal and optional target weight"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="fitness-goal-form" loading={submitting}>
            Save goal
          </Button>
        </>
      }
    >
      <form id="fitness-goal-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField label="Goal" hint="Optional — choose a goal or leave unset">
          <Select error={errors.fitnessGoal} {...register('fitnessGoal')}>
            <option value="">Goal not set</option>
            {FITNESS_GOALS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Target weight (kg)"
          hint="Optional — helpful for weight-based goals, not required for strength or general fitness"
          error={errors.targetWeight?.message}
        >
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="e.g. 70"
            error={errors.targetWeight}
            {...register('targetWeight')}
          />
        </FormField>
      </form>
    </Modal>
  )
}
