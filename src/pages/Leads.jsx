import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarClock, Pencil, Plus, Trash2, UserCheck, UserPlus } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { createDoc, removeDoc, updateDocById } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { MemberForm } from '@/components/common/MemberForm'
import { LeadForm } from '@/components/common/LeadForm'
import { PageHeader } from '@/components/layout/PageHeader'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { Tabs } from '@/components/ui/Tabs'
import { formatDate } from '@/utils/formatters'
import { gymTodayKey } from '@/utils/gymTime'
import {
  LEAD_FOLLOW_UP_FILTERS,
  LEAD_STATUSES,
  countFollowUps,
  leadFollowUpState,
  leadStatusLabel,
  matchesLeadFollowUp,
  matchesLeadSearch,
  sortLeads,
} from '@/utils/leads'

const STATUS_TONES = {
  new: 'info',
  contacted: 'indigo',
  trial: 'warning',
  joined: 'success',
  lost: 'neutral',
}

const FOLLOW_UP_BADGES = {
  overdue: { tone: 'danger', label: 'Overdue' },
  today: { tone: 'warning', label: 'Due today' },
  upcoming: { tone: 'neutral', label: 'Upcoming' },
  none: { tone: 'neutral', label: 'No date' },
  closed: { tone: 'neutral', label: 'Closed' },
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('')
}

export default function Leads() {
  const { can } = useAuth()
  const { timezone } = useSettings()
  const toast = useToast()
  const navigate = useNavigate()

  const today = gymTodayKey(timezone)
  const { items: leads, loading, error, reload } = useCollection('leads')
  const { items: plans } = useCollection('membershipPlans')

  const [search, setSearch] = useState('')
  const [followUp, setFollowUp] = useState('all')
  const [status, setStatus] = useState('all')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [converting, setConverting] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const canWrite = can('members.write')
  const canDelete = can('members.delete')

  const planMap = useMemo(
    () => Object.fromEntries(plans.map((plan) => [plan.id, plan])),
    [plans]
  )

  const counts = useMemo(() => countFollowUps(leads, today), [leads, today])

  const rows = useMemo(() => {
    const filtered = leads.filter((lead) => {
      if (!matchesLeadSearch(lead, search)) return false
      if (status !== 'all' && lead.status !== status) return false
      return matchesLeadFollowUp(lead, followUp, today)
    })
    return sortLeads(filtered, today)
  }, [leads, search, status, followUp, today])

  const handleSave = async (values) => {
    setSubmitting(true)
    try {
      const payload = {
        name: values.name.trim(),
        phone: values.phone.trim(),
        source: values.source,
        interestedPlanId: values.interestedPlanId || '',
        followUpDate: values.followUpDate || '',
        status: values.status,
        notes: values.notes || '',
      }
      if (editing) {
        await updateDocById('leads', editing.id, payload)
        await logAudit({
          action: 'update',
          entity: 'leads',
          entityId: editing.id,
          details: { name: payload.name, status: payload.status },
        })
        toast.success('Lead updated')
      } else {
        const id = await createDoc('leads', payload)
        await logAudit({
          action: 'create',
          entity: 'leads',
          entityId: id,
          details: { name: payload.name, source: payload.source },
        })
        toast.success('Lead added')
      }
      setFormOpen(false)
      setEditing(null)
    } catch (e) {
      toast.error(e.message || 'Could not save lead')
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Convert the lead into a member.
   *
   * The member is created through the normal member path (so numbering,
   * projection and audit behave exactly as a front-desk registration), and the
   * lead is then marked joined in a second write. If that second write fails the
   * member still exists and the lead stays open for a retry — the member record
   * is the important half, and losing the link is recoverable.
   */
  const handleConvert = async (values) => {
    setSubmitting(true)
    try {
      const memberId = await createDoc('members', { ...values, memberUid: '', photoUrl: '' })
      await logAudit({
        action: 'create',
        entity: 'members',
        entityId: memberId,
        details: { name: values.name, fromLead: converting?.id || null },
      })
      await updateDocById('leads', converting.id, {
        status: 'joined',
        convertedMemberId: memberId,
        convertedAt: new Date().toISOString(),
      })
      await logAudit({
        action: 'update',
        entity: 'leads',
        entityId: converting.id,
        details: { name: values.name, convertedTo: memberId },
      })
      toast.success(`${values.name} added as a member`)
      setConverting(null)
      navigate(`/members/${memberId}`)
    } catch (e) {
      toast.error(e.message || 'Could not convert lead')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      await removeDoc('leads', deleting.id)
      await logAudit({
        action: 'delete',
        entity: 'leads',
        entityId: deleting.id,
        details: { name: deleting.name },
      })
      toast.success('Lead deleted')
      setDeleting(null)
    } catch (e) {
      toast.error(e.message || 'Could not delete lead')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Walk-in enquiries and the follow-up diary, so no enquiry stays on paper."
        actions={
          canWrite ? (
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus size={16} /> Add lead
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <CalendarClock size={18} />
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Follow up today
            </p>
            <p className="text-2xl font-black text-slate-900 dark:text-slate-100">{counts.today}</p>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Overdue
          </p>
          <p className="text-2xl font-black text-rose-600">{counts.overdue}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Open leads
          </p>
          <p className="text-2xl font-black text-slate-900 dark:text-slate-100">
            {leads.filter((lead) => lead.status !== 'joined' && lead.status !== 'lost').length}
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs tabs={LEAD_FOLLOW_UP_FILTERS} active={followUp} onChange={setFollowUp} label="Follow-up" />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name or phone…"
          className="w-full sm:w-64"
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="all">All statuses</option>
          {LEAD_STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : error ? (
          <LoadErrorState label="leads" message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title={leads.length === 0 ? 'No leads yet' : 'No leads in this view'}
            description={
              leads.length === 0
                ? 'Record a walk-in enquiry and set a follow-up date; it will show up here on that day.'
                : 'Try another follow-up filter or search.'
            }
            action={
              leads.length === 0 && canWrite ? (
                <Button
                  onClick={() => {
                    setEditing(null)
                    setFormOpen(true)
                  }}
                >
                  <Plus size={16} /> Add lead
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-stack overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="th">Lead</th>
                  <th className="th hidden sm:table-cell">Source</th>
                  <th className="th hidden lg:table-cell">Interested in</th>
                  <th className="th">Follow-up</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((lead) => {
                  const state = leadFollowUpState(lead, today)
                  const followUpBadge = FOLLOW_UP_BADGES[state] || FOLLOW_UP_BADGES.none
                  return (
                    <tr
                      key={lead.id}
                      className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <td className="td" data-primary>
                        <div className="flex items-center gap-3">
                          <div className="avatar bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                            {initials(lead.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                              {lead.name}
                            </p>
                            <p className="truncate text-xs text-slate-400">{lead.phone || '—'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="td hidden whitespace-nowrap sm:table-cell" data-label="Source">
                        {lead.source || '—'}
                      </td>
                      <td className="td hidden lg:table-cell" data-label="Interested in">
                        {lead.interestedPlanId && planMap[lead.interestedPlanId] ? (
                          <Badge tone="indigo">{planMap[lead.interestedPlanId].name}</Badge>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="td whitespace-nowrap" data-label="Follow-up">
                        {lead.followUpDate ? (
                          <div>
                            <p className="text-sm">{formatDate(lead.followUpDate)}</p>
                            <Badge tone={followUpBadge.tone}>{followUpBadge.label}</Badge>
                          </div>
                        ) : (
                          <Badge tone="neutral">No date</Badge>
                        )}
                      </td>
                      <td className="td" data-label="Status">
                        <Badge tone={STATUS_TONES[lead.status] || 'neutral'}>
                          {leadStatusLabel(lead.status)}
                        </Badge>
                      </td>
                      <td className="td" data-actions>
                        <div className="flex items-center justify-end gap-1">
                          {canWrite && lead.status !== 'joined' && (
                            <Button
                              variant="outline"
                              size="sm"
                              title="Convert to member"
                              onClick={() => setConverting(lead)}
                            >
                              <UserCheck size={14} /> Convert
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit lead"
                              onClick={() => {
                                setEditing(lead)
                                setFormOpen(true)
                              }}
                            >
                              <Pencil size={14} />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Delete lead"
                              onClick={() => setDeleting(lead)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <LeadForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        initial={editing}
        plans={plans}
        submitting={submitting}
        onSubmit={handleSave}
      />

      <MemberForm
        open={Boolean(converting)}
        onClose={() => setConverting(null)}
        initial={
          converting
            ? {
                name: converting.name || '',
                phone: converting.phone || '',
                membershipPlanId: converting.interestedPlanId || '',
                joinDate: today,
                notes: converting.notes || '',
              }
            : undefined
        }
        plans={plans}
        submitting={submitting}
        onSubmit={handleConvert}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={submitting}
        title="Delete lead?"
        message={`This will permanently remove ${deleting?.name || 'this lead'} from the follow-up list. Members already converted are not affected.`}
        confirmLabel="Delete lead"
      />
    </div>
  )
}
