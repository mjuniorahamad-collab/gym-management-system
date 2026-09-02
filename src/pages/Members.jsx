import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Pencil, Plus, Trash2, UserPlus } from 'lucide-react'
import { usePaginatedCollection, useCollection } from '@/hooks/useFirestore'
import { createDoc, removeDoc, updateDocById } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { getWhatsAppLink, openWhatsAppGroupInvite } from '@/services/whatsappGroup'
import { getPtSurcharge } from '@/services/pt'
import { getMembershipCharge } from '@/utils/pt'
import { exportMembersToCsv } from '@/services/export'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { MemberForm } from '@/components/common/MemberForm'
import { MemberPhoto } from '@/components/common/MemberPhoto'
import { CSVExportButton } from '@/components/common/CSVExportButton'
import { PageHeader } from '@/components/layout/PageHeader'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { formatDate } from '@/utils/formatters'
import { addDays, toDateInputValue } from '@/utils/dateHelpers'

export default function Members() {
  const { can } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [whatsAppLink, setWhatsAppLink] = useState('')
  const [pendingInvite, setPendingInvite] = useState(null)
  const whatsAppLinkRef = useRef('')
  const ptSurchargeRef = useRef(0)

  useEffect(() => {
    let active = true
    getWhatsAppLink()
      .then((link) => {
        if (!active) return
        setWhatsAppLink(link)
        whatsAppLinkRef.current = link
      })
      .catch(() => {
        if (active) whatsAppLinkRef.current = ''
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    getPtSurcharge()
      .then((value) => {
        if (active) ptSurchargeRef.current = Number(value) || 0
      })
      .catch(() => {
        if (active) ptSurchargeRef.current = 0
      })
    return () => {
      active = false
    }
  }, [])

  const handleWhatsAppInvite = async () => {
    const result = await openWhatsAppGroupInvite({
      memberName: pendingInvite?.name || pendingInvite || '',
      phone: pendingInvite?.phone || '',
      link: whatsAppLink || whatsAppLinkRef.current,
      gymName: settings.gymName,
    })
    setPendingInvite(null)
    if (!result.ok) {
      toast.error(result.reason || 'Could not open WhatsApp. Share the invite link from Settings.')
      if (result.fallbackCopy) {
        try {
          await navigator.clipboard?.writeText(result.fallbackCopy)
          toast.success('Invite link copied to clipboard')
        } catch {
          // No clipboard — the error toast above is the fallback.
        }
      }
    } else if (result.copied) {
      toast.success('Invite link copied to clipboard')
    }
  }

  const plans = useCollection('membershipPlans')
  const planMap = Object.fromEntries(plans.items.map((p) => [p.id, p]))

  const {
    items: members,
    loading,
    hasMore,
    loadMore,
    reload,
  } = usePaginatedCollection('members', {
    pageSize: 20,
    orderField: 'searchName',
    direction: 'asc',
    filters: status !== 'all' ? [{ field: 'status', op: '==', value: status }] : [],
    search: search.trim() ? { field: 'searchName', value: search.trim().toLowerCase() } : null,
  })

  const canWrite = can('members.write')
  const canDelete = can('members.delete')

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      const payload = {
        ...values,
        searchName: (values.name || '').toLowerCase(),
        email: values.email || '',
        dob: values.dob || '',
        address: values.address || '',
        fatherName: values.fatherName || '',
        emergencyName: values.emergencyName || '',
        emergencyPhone: values.emergencyPhone || '',
        notes: values.notes || '',
        joinDate: values.joinDate || '',
        membershipPlanId: values.membershipPlanId || '',
      }
      if (editing) {
        await updateDocById('members', editing.id, payload)
        await logAudit({ action: 'update', entity: 'members', entityId: editing.id, details: { name: payload.name } })
        toast.success('Member updated')
      } else {
        const id = await createDoc('members', { ...payload, memberUid: '', photoUrl: '' })
        await logAudit({ action: 'create', entity: 'members', entityId: id, details: { name: payload.name } })

        // Every membership period is a first-class record. When a new member
        // starts on a plan, create their origin period so dues, history and
        // renewals all account through the same ledger from day one.
        const originPlan = planMap[payload.membershipPlanId]
        if (originPlan) {
          const start = payload.joinDate || toDateInputValue()
          const duration = Number(originPlan.durationDays)
          const expiry =
            Number.isFinite(duration) && duration > 0
              ? toDateInputValue(addDays(new Date(`${start}T12:00:00`), duration))
              : ''
          const originCharge = getMembershipCharge({
            plan: originPlan,
            isPT: Boolean(payload.isPT),
            ptSurcharge: ptSurchargeRef.current,
            ptSurchargeOverride: payload.ptSurchargeOverride,
          })
          try {
            await createDoc('memberships', {
              memberId: id,
              planId: originPlan.id,
              planName: originPlan.name,
              startDate: start,
              expiryDate: expiry,
              price: originCharge.total,
              basePrice: originCharge.base,
              ptSurcharge: originCharge.addon,
              isPT: Boolean(payload.isPT),
              amountPaid: 0,
              amountDue: originCharge.total,
              paymentStatus: 'due',
              paymentId: null,
              receiptNo: null,
              note: 'Initial membership',
            })
            await logAudit({
              action: 'create',
              entity: 'memberships',
              entityId: null,
              details: { member: payload.name, originPeriod: true, price: originCharge.total },
            })
          } catch (periodError) {
            // Member creation must not fail because period creation was not
            // permitted (e.g. front-desk role); finance roles can backfill.
            console.error('Could not create origin membership period:', periodError)
          }
        }

        toast.success('Member added')

        // Optional, non-blocking: if this gym has a WhatsApp group invite
        // link, offer to invite the newly added member. Member creation is
        // already committed and never depends on WhatsApp, so this is purely
        // a convenience the owner can skip.
        if (whatsAppLinkRef.current) {
          setPendingInvite({ name: payload.name, phone: payload.phone || '' })
        }
      }
      setFormOpen(false)
      setEditing(null)
      reload()
    } catch (e) {
      toast.error(e.message || 'Could not save member')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      await removeDoc('members', deleting.id)
      await logAudit({ action: 'delete', entity: 'members', entityId: deleting.id, details: { name: deleting.name } })
      toast.success('Member deleted')
      setDeleting(null)
      reload()
    } catch (e) {
      toast.error(e.message || 'Could not delete member')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Members"
        subtitle={`${members.length} shown`}
        actions={
          <>
            {canWrite && (
              <Button
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                <Plus size={16} /> Add member
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search members…"
          className="w-full sm:w-72"
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="frozen">Frozen</option>
        </Select>
        <div className="ml-auto">
          <CSVExportButton
            onExport={() =>
              exportMembersToCsv(
                members.map((m) => ({ ...m, planName: planMap[m.membershipPlanId]?.name })),
                settings
              )
            }
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : members.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No members found"
            description={
              search || status !== 'all'
                ? 'Try adjusting your search or filters.'
                : 'Add your first member to get started.'
            }
            action={
              canWrite ? (
                <Button
                  onClick={() => {
                    setEditing(null)
                    setFormOpen(true)
                  }}
                >
                  <Plus size={16} /> Add member
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="th">Member</th>
                    <th className="th hidden md:table-cell">Phone</th>
                    <th className="th hidden lg:table-cell">Plan</th>
                    <th className="th">Status</th>
                    <th className="th hidden sm:table-cell">Joined</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {members.map((member) => (
                    <tr key={member.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="td">
                        <Link to={`/members/${member.id}`} className="flex items-center gap-3">
                          <MemberPhoto member={member} size="sm" />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1 truncate font-medium text-slate-900 dark:text-slate-100">
                              <span className="truncate">{member.name}</span>
                              {member.isPT && <Badge tone="indigo" className="shrink-0 px-1.5 py-0 text-[10px]">PT</Badge>}
                            </p>
                            <p className="truncate text-xs text-slate-400">
                              {member.email || member.memberNo || '—'}
                            </p>
                          </div>
                        </Link>
                      </td>
                      <td className="td hidden whitespace-nowrap md:table-cell">{member.phone}</td>
                      <td className="td hidden lg:table-cell">
                        {planMap[member.membershipPlanId] ? (
                          <Badge tone="indigo">{planMap[member.membershipPlanId].name}</Badge>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="td">
                        <StatusBadge status={member.status} />
                      </td>
                      <td className="td hidden whitespace-nowrap sm:table-cell">
                        {formatDate(member.joinDate)}
                      </td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-1">
                          <Link to={`/members/${member.id}`}>
                            <Button variant="ghost" size="icon" title="View">
                              <Eye size={16} />
                            </Button>
                          </Link>
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditing(member)
                                setFormOpen(true)
                              }}
                            >
                              <Pencil size={16} />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                              title="Delete"
                              onClick={() => setDeleting(member)}
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
            <Pagination hasMore={hasMore} loading={loading} onLoadMore={loadMore} showing={members.length} />
          </>
        )}
      </div>

      <MemberForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        initial={editing}
        plans={plans.items}
        submitting={submitting}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={submitting}
        title="Delete member?"
        message={`This will permanently remove ${deleting?.name}. Payments and attendance history for this member will be kept.`}
        confirmLabel="Delete member"
      />

      <ConfirmDialog
        open={Boolean(pendingInvite)}
        onCancel={() => setPendingInvite(null)}
        onConfirm={handleWhatsAppInvite}
        title={`Invite ${pendingInvite?.name || ''} to WhatsApp Group?`}
        message="This opens a WhatsApp chat with the member, pre-filled with an invite to your gym's WhatsApp group. Nothing is sent automatically — the member joins voluntarily."
        confirmLabel="Invite to WhatsApp Group"
      />
    </div>
  )
}
