import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { leadSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { LEAD_SOURCES, LEAD_STATUSES } from '@/utils/leads'
import { toDateInputValue } from '@/utils/dateHelpers'

const EMPTY = {
  name: '',
  phone: '',
  source: 'Walk-in',
  interestedPlanId: '',
  followUpDate: '',
  status: 'new',
  notes: '',
}

export function LeadForm({ open, onClose, initial, plans = [], submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(leadSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(
      initial
        ? {
            ...EMPTY,
            name: initial.name || '',
            phone: initial.phone || '',
            source: initial.source || 'Walk-in',
            interestedPlanId: initial.interestedPlanId || '',
            followUpDate: toDateInputValue(initial.followUpDate),
            status: initial.status || 'new',
            notes: initial.notes || '',
          }
        : EMPTY
    )
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={initial ? 'Edit Lead' : 'Add Walk-in Lead'}
      subtitle={
        initial
          ? `Update ${initial.name}'s enquiry and follow-up`
          : 'Record an enquiry so it does not get lost on paper'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="lead-form" loading={submitting}>
            {initial ? 'Save changes' : 'Add lead'}
          </Button>
        </>
      }
    >
      <form id="lead-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Name" error={errors.name?.message} required>
            <Input placeholder="e.g. Rahul Sharma" error={errors.name} {...register('name')} />
          </FormField>
          <FormField label="Phone" error={errors.phone?.message} required>
            <Input placeholder="98XXXXXXXX" error={errors.phone} {...register('phone')} />
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Source" error={errors.source?.message}>
            <Select error={errors.source} {...register('source')}>
              {LEAD_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Interested plan" error={errors.interestedPlanId?.message}>
            <Select error={errors.interestedPlanId} {...register('interestedPlanId')}>
              <option value="">Not decided</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Follow-up date"
            error={errors.followUpDate?.message}
            hint="The day you promised to call back. This drives the due/overdue list."
          >
            <Input type="date" error={errors.followUpDate} {...register('followUpDate')} />
          </FormField>
          <FormField label="Status" error={errors.status?.message}>
            <Select error={errors.status} {...register('status')}>
              {LEAD_STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <FormField label="Notes" error={errors.notes?.message}>
          <textarea
            rows={3}
            className="input"
            placeholder="What did they ask about? Budget, timing, trial…"
            {...register('notes')}
          />
        </FormField>
      </form>
    </Modal>
  )
}
