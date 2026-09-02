import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { memberSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { toDateInputValue } from '@/utils/dateHelpers'

const EMPTY = {
  name: '',
  email: '',
  phone: '',
  gender: 'Male',
  dob: '',
  address: '',
  fatherName: '',
  emergencyName: '',
  emergencyPhone: '',
  notes: '',
  membershipPlanId: '',
  status: 'active',
  joinDate: '',
}

export function MemberForm({ open, onClose, initial, plans, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(memberSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(
      initial
        ? {
            ...EMPTY,
            ...initial,
            dob: toDateInputValue(initial.dob),
            joinDate: toDateInputValue(initial.joinDate),
          }
        : EMPTY
    )
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={initial ? 'Edit Member' : 'Add Member'}
      subtitle={initial ? `Update ${initial.name}'s profile` : 'Register a new member'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="member-form" loading={submitting}>
            {initial ? 'Save changes' : 'Add member'}
          </Button>
        </>
      }
    >
      <form id="member-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" error={errors.name?.message} required>
            <Input placeholder="e.g. Aarav Shrestha" error={errors.name} {...register('name')} />
          </FormField>
          <FormField label="Father's name" error={errors.fatherName?.message}>
            <Input placeholder="Optional" error={errors.fatherName} {...register('fatherName')} />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Phone" error={errors.phone?.message} required>
            <Input placeholder="98XXXXXXXX" error={errors.phone} {...register('phone')} />
          </FormField>
          <FormField label="Gender" error={errors.gender?.message}>
            <Select error={errors.gender} {...register('gender')}>
              {['Male', 'Female', 'Other'].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Date of birth" error={errors.dob?.message}>
            <Input type="date" error={errors.dob} {...register('dob')} />
          </FormField>
          <FormField label="Join date" error={errors.joinDate?.message}>
            <Input type="date" error={errors.joinDate} {...register('joinDate')} />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Membership plan" error={errors.membershipPlanId?.message}>
            <Select error={errors.membershipPlanId} {...register('membershipPlanId')}>
              <option value="">No plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Status" error={errors.status?.message}>
            <Select error={errors.status} {...register('status')}>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="frozen">Frozen</option>
            </Select>
          </FormField>
        </div>

        <FormField label="Address" error={errors.address?.message}>
          <Input placeholder="Area, City" error={errors.address} {...register('address')} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Emergency contact name" error={errors.emergencyName?.message}>
            <Input placeholder="Contact person" error={errors.emergencyName} {...register('emergencyName')} />
          </FormField>
          <FormField label="Emergency contact phone" error={errors.emergencyPhone?.message}>
            <Input placeholder="98XXXXXXXX" error={errors.emergencyPhone} {...register('emergencyPhone')} />
          </FormField>
        </div>

        <FormField label="Notes" error={errors.notes?.message}>
          <textarea
            rows={3}
            className="input"
            placeholder="Health notes, preferences, reminders…"
            {...register('notes')}
          />
        </FormField>
      </form>
    </Modal>
  )
}
