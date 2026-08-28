import { useState } from 'react'
import { Pencil, Plus, Trash2, UserPlus } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { createDoc, removeDoc, updateDocById } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { downloadCsv } from '@/services/export'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { TrainerForm } from '@/components/common/TrainerForm'
import { CSVExportButton } from '@/components/common/CSVExportButton'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { formatCurrency, formatDate } from '@/utils/formatters'

export default function Trainers() {
  const { can } = useAuth()
  const toast = useToast()

  const { items: trainers, loading } = useCollection('trainers')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const canWrite = can('trainers.write')

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      if (editing) {
        await updateDocById('trainers', editing.id, values)
        await logAudit({ action: 'update', entity: 'trainers', entityId: editing.id, details: { name: values.name } })
        toast.success('Trainer updated')
      } else {
        const id = await createDoc('trainers', { ...values, hireDate: values.hireDate || '' })
        await logAudit({ action: 'create', entity: 'trainers', entityId: id, details: { name: values.name } })
        toast.success('Trainer added')
      }
      setFormOpen(false)
      setEditing(null)
    } catch (e) {
      toast.error(e.message || 'Could not save trainer')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      await removeDoc('trainers', deleting.id)
      await logAudit({ action: 'delete', entity: 'trainers', entityId: deleting.id, details: { name: deleting.name } })
      toast.success('Trainer deleted')
      setDeleting(null)
    } catch (e) {
      toast.error(e.message || 'Could not delete trainer')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Trainers"
        subtitle="Manage your coaching staff"
        actions={
          canWrite && (
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus size={16} /> Add trainer
            </Button>
          )
        }
      />

      <div className="card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : trainers.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No trainers yet"
            description="Add your first trainer to assign classes."
            action={
              canWrite ? (
                <Button onClick={() => setFormOpen(true)}>
                  <Plus size={16} /> Add trainer
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="th">Trainer</th>
                  <th className="th hidden sm:table-cell">Specialization</th>
                  <th className="th hidden md:table-cell">Hourly rate</th>
                  <th className="th hidden lg:table-cell">Hired</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {trainers.map((trainer) => (
                  <tr key={trainer.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="td">
                      <p className="font-medium text-slate-900 dark:text-slate-100">{trainer.name}</p>
                      <p className="text-xs text-slate-400">{trainer.email || trainer.phone}</p>
                    </td>
                    <td className="td hidden sm:table-cell">{trainer.specialization}</td>
                    <td className="td hidden whitespace-nowrap md:table-cell">
                      {formatCurrency(trainer.hourlyRate)}/hr
                    </td>
                    <td className="td hidden whitespace-nowrap lg:table-cell">{formatDate(trainer.hireDate)}</td>
                    <td className="td">
                      <Badge tone={trainer.active ? 'success' : 'neutral'}>
                        {trainer.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        {canWrite && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => {
                              setEditing(trainer)
                              setFormOpen(true)
                            }}
                          >
                            <Pencil size={16} />
                          </Button>
                        )}
                        {can('settings.write') && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                            title="Delete"
                            onClick={() => setDeleting(trainer)}
                          >
                            <Trash2 size={16} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <CSVExportButton
          onExport={() =>
            downloadCsv(
              `trainers-${new Date().toISOString().slice(0, 10)}.csv`,
              trainers.map((t) => ({
                Name: t.name,
                Email: t.email,
                Phone: t.phone,
                Specialization: t.specialization,
                Rate: t.hourlyRate,
                Active: t.active ? 'Yes' : 'No',
              }))
            )
          }
        />
      </div>

      <TrainerForm
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
        title="Delete trainer?"
        message={`This will remove ${deleting?.name} from the staff directory. Their classes will need reassigning.`}
        confirmLabel="Delete trainer"
      />
    </div>
  )
}
