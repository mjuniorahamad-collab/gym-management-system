import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { expenseSchema } from '@/schemas/validationSchemas'
import { Modal } from '@/components/ui/Modal'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { EXPENSE_CATEGORIES } from '@/utils/constants'
import { toDateInputValue } from '@/utils/dateHelpers'

const EMPTY = { title: '', category: 'Rent', amount: '', date: toDateInputValue(), note: '' }

export function ExpenseForm({ open, onClose, initial, submitting, onSubmit }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(expenseSchema), defaultValues: EMPTY })

  useEffect(() => {
    if (!open) return
    reset(initial ? { ...EMPTY, ...initial, amount: initial.amount ?? '' } : EMPTY)
  }, [open, initial, reset])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={initial ? 'Edit Expense' : 'Add Expense'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="expense-form" loading={submitting}>
            {initial ? 'Save changes' : 'Add expense'}
          </Button>
        </>
      }
    >
      <form id="expense-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField label="Title" error={errors.title?.message} required>
          <Input placeholder="e.g. Electricity bill" error={errors.title} {...register('title')} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Category" error={errors.category?.message}>
            <Select error={errors.category} {...register('category')}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Amount" error={errors.amount?.message} required>
            <Input type="number" min="0" step="0.01" placeholder="0.00" error={errors.amount} {...register('amount')} />
          </FormField>
        </div>

        <FormField label="Date" error={errors.date?.message} required>
          <Input type="date" error={errors.date} {...register('date')} />
        </FormField>

        <FormField label="Note" error={errors.note?.message}>
          <Input placeholder="Optional note…" error={errors.note} {...register('note')} />
        </FormField>
      </form>
    </Modal>
  )
}
