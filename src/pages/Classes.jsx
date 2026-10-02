import { useMemo, useState } from 'react'
import { CalendarDays, Clock, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { createDoc, removeDoc, updateDocById } from '@/services/firestore'
import { DEMO_GYM_ID, getGymId } from '@/services/ownerContext'
import { logAudit } from '@/services/audit'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { ClassForm } from '@/components/common/ClassForm'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { DAYS_OF_WEEK } from '@/utils/constants'

export default function Classes() {
  const { can } = useAuth()
  const toast = useToast()

  const { items: classes, loading } = useCollection('classes')
  const { items: trainers } = useCollection('trainers')
  const { items: bookings } = useCollection('bookings')
  const { items: members } = useCollection('members')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [bookingFor, setBookingFor] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [selectedMember, setSelectedMember] = useState('')

  const trainerMap = useMemo(() => Object.fromEntries(trainers.map((t) => [t.id, t])), [trainers])
  const memberMap = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members])

  const canWrite = can('classes.write')

  const grouped = useMemo(() => {
    const map = {}
    for (const day of DAYS_OF_WEEK) map[day] = []
    for (const gymClass of classes.filter((c) => c.active)) {
      const key = gymClass.dayOfWeek || 'Monday'
      if (!map[key]) map[key] = []
      map[key].push(gymClass)
    }
    for (const day of DAYS_OF_WEEK) {
      map[day].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
    }
    return map
  }, [classes])

  const bookingsForClass = (classId) =>
    bookings.filter((b) => b.classId === classId && b.status === 'booked')

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      if (editing) {
        await updateDocById('classes', editing.id, values)
        await logAudit({ action: 'update', entity: 'classes', entityId: editing.id, details: { name: values.name } })
        toast.success('Class updated')
      } else {
        const id = await createDoc('classes', values)
        await logAudit({ action: 'create', entity: 'classes', entityId: id, details: { name: values.name } })
        toast.success('Class added')
      }
      setFormOpen(false)
      setEditing(null)
    } catch (e) {
      toast.error(e.message || 'Could not save class')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      await removeDoc('classes', deleting.id)
      await logAudit({ action: 'delete', entity: 'classes', entityId: deleting.id, details: { name: deleting.name } })
      toast.success('Class deleted')
      setDeleting(null)
    } catch (e) {
      toast.error(e.message || 'Could not delete class')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddBooking = async () => {
    if (!bookingFor || !selectedMember) return

    // Defense-in-depth only: firestore.rules resolves both references server-side
    // and remains the authoritative boundary. This rejects an obviously invalid
    // selection before the write so staff see a readable message instead of a raw
    // PERMISSION_DENIED. The gym id is resolved with the same fallback createDoc
    // stamps onto the document, so demo mode stays consistent with the write path.
    const activeGymId = getGymId() || DEMO_GYM_ID
    if (memberMap[selectedMember]?.gymId !== activeGymId) {
      toast.error('That member does not belong to this gym')
      return
    }
    if (bookingFor.gymId !== activeGymId) {
      toast.error('That class does not belong to this gym')
      return
    }

    setSubmitting(true)
    try {
      await createDoc('bookings', {
        classId: bookingFor.id,
        memberId: selectedMember,
        date: new Date().toISOString(),
        status: 'booked',
      })
      await logAudit({ action: 'create', entity: 'bookings', entityId: bookingFor.id, details: { memberId: selectedMember } })
      toast.success('Member booked')
      setSelectedMember('')
    } catch (e) {
      toast.error(e.message || 'Could not create booking')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveBooking = async (booking) => {
    try {
      await removeDoc('bookings', booking.id)
      toast.success('Booking removed')
    } catch (e) {
      toast.error(e.message || 'Could not remove booking')
    }
  }

  if (loading) return <Spinner label="Loading classes…" />

  return (
    <div>
      <PageHeader
        title="Class Schedule"
        subtitle="Weekly classes and member bookings"
        actions={
          canWrite && (
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus size={16} /> Add class
            </Button>
          )
        }
      />

      {classes.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={CalendarDays}
            title="No classes scheduled"
            description="Add classes to build your weekly schedule."
            action={
              canWrite ? (
                <Button onClick={() => setFormOpen(true)}>
                  <Plus size={16} /> Add class
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {DAYS_OF_WEEK.map((day) => (
            <div key={day} className="card p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {day}
              </h3>
              <div className="space-y-3">
                {grouped[day].length === 0 && (
                  <p className="text-xs text-slate-400">No classes</p>
                )}
                {grouped[day].map((gymClass) => {
                  const list = bookingsForClass(gymClass.id)
                  const full = list.length >= (gymClass.capacity || 0)
                  return (
                    <div key={gymClass.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {gymClass.name}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
                            <Clock size={12} /> {gymClass.startTime}–{gymClass.endTime}
                          </p>
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {trainerMap[gymClass.trainerId]?.name || 'Unassigned'}
                          </p>
                        </div>
                        <div className="flex gap-0.5">
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => {
                                setEditing(gymClass)
                                setFormOpen(true)
                              }}
                            >
                              <Pencil size={14} />
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                              onClick={() => setDeleting(gymClass)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => setBookingFor(gymClass)}
                        className="mt-3 flex w-full items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      >
                        <span className="flex items-center gap-1.5">
                          <Users size={13} /> Manage bookings
                        </span>
                        <Badge tone={full ? 'danger' : 'info'}>
                          {list.length}/{gymClass.capacity || 0}
                        </Badge>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <ClassForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        initial={editing}
        trainers={trainers}
        submitting={submitting}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={submitting}
        title="Delete class?"
        message={`This will remove ${deleting?.name} from the schedule.`}
        confirmLabel="Delete class"
      />

      <Modal
        open={Boolean(bookingFor)}
        onClose={() => setBookingFor(null)}
        size="md"
        title={bookingFor?.name}
        subtitle="Manage member bookings"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Select value={selectedMember} onChange={(e) => setSelectedMember(e.target.value)} className="flex-1">
              <option value="">Select a member…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button onClick={handleAddBooking} loading={submitting} disabled={!selectedMember}>
              Book
            </Button>
          </div>

          {bookingsForClass(bookingFor?.id).length === 0 ? (
            <EmptyState title="No bookings yet" />
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {bookingsForClass(bookingFor?.id).map((b) => (
                <div key={b.id} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="avatar bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                      {memberMap[b.memberId]?.name?.slice(0, 1) || '?'}
                    </div>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {memberMap[b.memberId]?.name || 'Unknown'}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" className="text-red-500" onClick={() => handleRemoveBooking(b)}>
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
