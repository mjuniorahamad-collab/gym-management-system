import { useState } from 'react'
import { BadgePercent, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { createDoc, removeDoc, updateDocById } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { PlanForm } from '@/components/common/PlanForm'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { Spinner } from '@/components/ui/Spinner'
import { formatCurrency } from '@/utils/formatters'

export default function Plans() {
  const { can } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()

  const { items: plans, loading, error, reload } = useCollection('membershipPlans')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const canWrite = can('finance.write')

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      const features = (values.features || '')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
      const payload = { ...values, features }
      if (editing) {
        await updateDocById('membershipPlans', editing.id, payload)
        await logAudit({ action: 'update', entity: 'membershipPlans', entityId: editing.id, details: { name: values.name } })
        toast.success('Plan updated')
      } else {
        const id = await createDoc('membershipPlans', payload)
        await logAudit({ action: 'create', entity: 'membershipPlans', entityId: id, details: { name: values.name } })
        toast.success('Plan created')
      }
      setFormOpen(false)
      setEditing(null)
    } catch (e) {
      toast.error(e.message || 'Could not save plan')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      await removeDoc('membershipPlans', deleting.id)
      await logAudit({ action: 'delete', entity: 'membershipPlans', entityId: deleting.id, details: { name: deleting.name } })
      toast.success('Plan deleted')
      setDeleting(null)
    } catch (e) {
      toast.error(e.message || 'Could not delete plan')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleActive = async (plan) => {
    try {
      await updateDocById('membershipPlans', plan.id, { active: !plan.active })
      toast.success(`${plan.name} ${plan.active ? 'deactivated' : 'activated'}`)
    } catch (e) {
      toast.error(e.message || 'Could not update plan')
    }
  }

  if (loading) return <Spinner label="Loading plans…" />

  if (error) return <LoadErrorState label="membership plans" message={error} onRetry={reload} />

  return (
    <div>
      <PageHeader
        title="Membership Plans"
        subtitle="Pricing and membership options"
        actions={
          canWrite && (
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus size={16} /> New plan
            </Button>
          )
        }
      />

      {plans.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={BadgePercent}
            title="No plans yet"
            description="Create your first membership plan."
            action={
              canWrite ? (
                <Button onClick={() => setFormOpen(true)}>
                  <Plus size={16} /> New plan
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={`card flex flex-col p-6 transition-opacity ${plan.active ? '' : 'opacity-60'}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{plan.name}</h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {plan.durationDays} day{plan.durationDays === 1 ? '' : 's'}
                  </p>
                </div>
                <Badge tone={plan.active ? 'success' : 'neutral'}>{plan.active ? 'Active' : 'Inactive'}</Badge>
              </div>

              <p className="mt-4 text-3xl font-extrabold text-indigo-600 dark:text-indigo-400">
                {formatCurrency(plan.price, settings.currency)}
              </p>

              {Array.isArray(plan.features) && plan.features.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                      <Check size={15} className="mt-0.5 shrink-0 text-emerald-500" />
                      {feature}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-6 flex gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                {canWrite && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      setEditing(plan)
                      setFormOpen(true)
                    }}
                  >
                    <Pencil size={14} /> Edit
                  </Button>
                )}
                {canWrite && (
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => toggleActive(plan)}>
                    {plan.active ? 'Deactivate' : 'Activate'}
                  </Button>
                )}
                {can('settings.write') && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-500"
                    onClick={() => setDeleting(plan)}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <PlanForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        initial={editing}
        submitting={submitting}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={submitting}
        title="Delete plan?"
        message={`This will remove the "${deleting?.name}" plan. Members already assigned to it are unaffected.`}
        confirmLabel="Delete plan"
      />
    </div>
  )
}
