import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowLeft, CreditCard, Pencil, Plus, Printer, QrCode, RefreshCcw, ScrollText, Trash2 } from 'lucide-react'
import { getById, updateDocById } from '@/services/firestore'
import { recordPayment } from '@/services/payments'
import { editMembershipPeriod, deleteMembershipPeriod } from '@/services/memberships'
import { useCollection } from '@/hooks/useFirestore'
import { logAudit } from '@/services/audit'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { MemberPhoto } from '@/components/common/MemberPhoto'
import { MembershipCard } from '@/components/common/MembershipCard'
import { MemberForm } from '@/components/common/MemberForm'
import { PaymentForm } from '@/components/common/PaymentForm'
import { RenewalModal } from '@/components/common/RenewalModal'
import { MembershipPeriodForm } from '@/components/common/MembershipPeriodForm'
import { DeletePeriodConfirm } from '@/components/common/DeletePeriodConfirm'
import { ReceiptModal } from '@/components/common/ReceiptModal'
import { WhatsAppReminderButton } from '@/components/common/WhatsAppReminderButton'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Tabs } from '@/components/ui/Tabs'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatCurrency, formatDate, formatDateTime } from '@/utils/formatters'
import { addDays, daysUntil, parseDate } from '@/utils/dateHelpers'
import { computeMemberLedger } from '@/utils/dues'
import { PAYMENT_STATUS_LABELS } from '@/utils/renewal'

export default function MemberDetail() {
  const { id } = useParams()
  const { can } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()

  const [member, setMember] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [renewOpen, setRenewOpen] = useState(false)
  const [renewalResult, setRenewalResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [tab, setTab] = useState('overview')
  const [qrOpen, setQrOpen] = useState(false)
  const [editPeriodOpen, setEditPeriodOpen] = useState(false)
  const [editPeriod, setEditPeriod] = useState(null)
  const [deletePeriodOpen, setDeletePeriodOpen] = useState(false)
  const [deletePeriod, setDeletePeriod] = useState(null)

  const plans = useCollection('membershipPlans')
  const payments = useCollection('payments')
  const attendance = useCollection('attendance')
  const memberships = useCollection('memberships')
  const membersCol = useCollection('members')

  const reload = async () => {
    const data = await getById('members', id)
    setMember(data)
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const plan = useMemo(() => planFor(member, plans.items), [member, plans.items])
  const memberPayments = useMemo(
    () => payments.items.filter((p) => p.memberId === id).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [payments.items, id]
  )
  const memberAttendance = useMemo(
    () =>
      attendance.items
        .filter((a) => a.memberId === id)
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [attendance.items, id]
  )

  const expiry = useMemo(() => {
    if (!member?.joinDate || !plan) return null
    return addDays(parseDate(member.joinDate) || new Date(), plan.durationDays || 0)
  }, [member, plan])

  const daysLeft = expiry ? daysUntil(expiry) : null

  const memberMemberships = useMemo(
    () =>
      memberships.items
        .filter((m) => m.memberId === id)
        .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || ''))),
    [memberships.items, id]
  )
  const latestMembershipId = memberMemberships[0]?.id

  // Single source of truth: every figure on this page derives from the
  // finance ledger (periods + payments), never from stored snapshots.
  const ledger = useMemo(() => {
    if (!member) return null
    return computeMemberLedger({
      member,
      plans: plans.items,
      payments: payments.items,
      memberships: memberships.items,
    })
  }, [member, plans.items, payments.items, memberships.items])

  // History rows, newest period first.
  const ledgerPeriodsDesc = useMemo(
    () =>
      ledger
        ? [...ledger.periods].sort((a, b) =>
            String(b.startDate?.toISOString?.() || b.startDate || '').localeCompare(
              String(a.startDate?.toISOString?.() || a.startDate || '')
            )
          )
        : [],
    [ledger]
  )

  const canWrite = can('members.write')
  const canFinanceWrite = can('finance.write')

  const handleRenewed = (result) => {
    setRenewOpen(false)
    setRenewalResult(result)
    reload()
  }

  const handleUpdate = async (values) => {
    setSubmitting(true)
    try {
      await updateDocById('members', id, { ...values, searchName: (values.name || '').toLowerCase() })
      await logAudit({ action: 'update', entity: 'members', entityId: id, details: { name: values.name } })
      toast.success('Member updated')
      setEditOpen(false)
      reload()
    } catch (e) {
      toast.error(e.message || 'Could not update member')
    } finally {
      setSubmitting(false)
    }
  }

  const handlePhoto = async (url) => {
    await updateDocById('members', id, { photoUrl: url })
    await logAudit({ action: 'update', entity: 'members', entityId: id, details: { photo: true } })
    reload()
  }

  const handlePayment = async (values) => {
    setSubmitting(true)
    try {
      await recordPayment({
        values,
        memberName: member?.name || '',
        planName:
          plans.items.find((p) => String(p.id) === String(values.planId))?.name ||
          plan?.name ||
          '',
        receiptPrefix: settings.receiptPrefix,
      })
      toast.success('Payment recorded')
      setPayOpen(false)
      // Membership status/expiry are never mutated here — reactivating an
      // expired membership is the Renewal flow's job, and mutating joinDate
      // on an ad-hoc payment corrupted the period timeline.
    } catch (e) {
      toast.error(e.message || 'Could not save payment')
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditPeriod = async (values) => {
    setSubmitting(true)
    try {
      await editMembershipPeriod({
        periodId: editPeriod.id,
        memberId: id,
        patch: {
          planId: values.planId,
          planName: plans.items.find((p) => String(p.id) === String(values.planId))?.name || '',
          price: Number(values.price),
          startDate: values.startDate,
          expiryDate: values.expiryDate,
        },
      })
      toast.success('Membership period updated')
      setEditPeriodOpen(false)
      setEditPeriod(null)
      reload()
    } catch (e) {
      toast.error(e.message || 'Could not update period')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeletePeriod = async () => {
    setSubmitting(true)
    try {
      const result = await deleteMembershipPeriod({ periodId: deletePeriod.id, memberId: id })
      const count = result.affectedPayments.length
      toast.success(
        count > 0
          ? `Period deleted · ${count} payment${count > 1 ? 's' : ''} reallocated`
          : 'Membership period deleted'
      )
      setDeletePeriodOpen(false)
      setDeletePeriod(null)
      reload()
    } catch (e) {
      toast.error(e.message || 'Could not delete period')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <Spinner label="Loading member…" />
  if (!member) {
    return (
      <EmptyState
        title="Member not found"
        description="This member may have been deleted."
        action={
          <Link to="/members">
            <Button variant="outline">Back to members</Button>
          </Link>
        }
      />
    )
  }

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'payments', label: `Payments (${memberPayments.length})` },
    { key: 'attendance', label: `Attendance (${memberAttendance.length})` },
  ]

  return (
    <div className="space-y-5">
      <Link to="/members" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
        <ArrowLeft size={16} /> Back to members
      </Link>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Profile card */}
        <Card className="lg:col-span-2">
          <CardBody>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <MemberPhoto member={member} size="xl" editable={canWrite} onUpload={handlePhoto} />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">{member.name}</h2>
                    <StatusBadge status={member.status} />
                  </div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {member.email || 'No email'} · {member.phone}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {plan && <Badge tone="indigo">{plan.name}</Badge>}
                    {member.gender && <Badge tone="neutral">{member.gender}</Badge>}
                    <Badge tone="neutral">Joined {formatDate(member.joinDate)}</Badge>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                {canFinanceWrite && (
                  <Button variant="success" size="sm" onClick={() => setRenewOpen(true)}>
                    <RefreshCcw size={14} /> Renew
                  </Button>
                )}
                {canWrite && (
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil size={14} /> Edit
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setQrOpen(true)}>
                  <QrCode size={14} /> Member card
                </Button>
              </div>
            </div>

            <div className="mt-6">
              <Tabs tabs={tabs} active={tab} onChange={setTab} />
            </div>

            <div className="mt-5">
              {tab === 'overview' && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Card>
                    <CardHeader title="Contact details" />
                    <CardBody className="space-y-2 text-sm">
                      <InfoRow label="Address" value={member.address} />
                      <InfoRow label="Date of birth" value={formatDate(member.dob)} />
                      <InfoRow label="Emergency contact" value={member.emergencyName} />
                      <InfoRow label="Emergency phone" value={member.emergencyPhone} />
                    </CardBody>
                  </Card>
                  <Card>
                    <CardHeader title="Membership" />
                    <CardBody className="space-y-2 text-sm">
                      <InfoRow label="Plan" value={plan?.name || 'No plan'} />
                      <InfoRow label="Started" value={formatDate(member.joinDate)} />
                      <InfoRow label="Expires" value={expiry ? formatDate(expiry) : '—'} />
                      <InfoRow
                        label="Time left"
                        value={
                          daysLeft === null
                            ? '—'
                            : daysLeft < 0
                              ? 'Expired'
                              : `${daysLeft} day${daysLeft === 1 ? '' : 's'}`
                        }
                      />
                    </CardBody>
                  </Card>
                  {member.notes && (
                    <Card className="sm:col-span-2">
                      <CardHeader title="Notes" />
                      <CardBody>
                        <p className="text-sm text-slate-600 dark:text-slate-300">{member.notes}</p>
                      </CardBody>
                    </Card>
                  )}
                </div>
              )}

              {tab === 'payments' && (
                <div className="space-y-5">
                  {ledgerPeriodsDesc.length > 0 && (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800">
                      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Membership history</h4>
                        <p className="mt-0.5 text-xs text-slate-400">
                          Each period keeps its own financial state — paying for one never clears another.
                        </p>
                      </div>
                      <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {ledgerPeriodsDesc.map((p) => (
                          <div key={p.id || `implicit-${p.label}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                            <div className="min-w-0">
                              <p className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                                {p.label}
                                {p.implicit && <Badge tone="neutral">Earlier · pre-records</Badge>}
                              </p>
                              <p className="text-xs text-slate-400">
                                {formatDate(p.startDate)} → {formatDate(p.expiryDate)}
                              </p>
                            </div>
                            <div className="flex items-center gap-3 text-right">
                              <div>
                                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                  {formatCurrency(p.price, settings.currency)}
                                </p>
                                <p className="text-xs text-slate-400">
                                  {formatCurrency(p.paid, settings.currency)} paid
                                  {p.due > 0 ? ` · ${formatCurrency(p.due, settings.currency)} due` : ' · Paid in full'}
                                </p>
                              </div>
                              <Badge tone={p.due > 0 ? 'warning' : 'success'}>
                                {PAYMENT_STATUS_LABELS[p.status] || (p.due > 0 ? 'Partial' : 'Paid')}
                              </Badge>
                              {!p.implicit && canFinanceWrite && (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => { setEditPeriod(p); setEditPeriodOpen(true) }}
                                    className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                                    aria-label="Edit period"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setDeletePeriod(p); setDeletePeriodOpen(true) }}
                                    className="rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                                    aria-label="Delete period"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      {ledger.totals.due > 0 && (
                        <div className="flex items-center justify-between border-t border-slate-200 bg-amber-50/60 px-4 py-2.5 text-sm dark:border-slate-800 dark:bg-amber-500/5">
                          <span className="font-semibold text-slate-700 dark:text-slate-200">Total outstanding</span>
                          <span className="font-bold text-rose-600">{formatCurrency(ledger.totals.due, settings.currency)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end">
                    {canWrite && (
                      <Button size="sm" onClick={() => setPayOpen(true)}>
                        <Plus size={14} /> Record payment
                      </Button>
                    )}
                  </div>
                  {memberPayments.length === 0 ? (
                    <EmptyState icon={CreditCard} title="No payments yet" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="border-b border-slate-200 dark:border-slate-800">
                          <tr>
                            <th className="th">Date</th>
                            <th className="th">Amount</th>
                            <th className="th">Method</th>
                            <th className="th">Receipt</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {memberPayments.map((p) => (
                            <tr key={p.id}>
                              <td className="td whitespace-nowrap">{formatDate(p.date)}</td>
                              <td className="td font-semibold">{formatCurrency(p.amount, settings.currency)}</td>
                              <td className="td">{p.method}</td>
                              <td className="td text-xs text-slate-400">{p.receiptNo || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {tab === 'attendance' && (
                <div className="overflow-hidden">
                  {memberAttendance.length === 0 ? (
                    <EmptyState icon={ScrollText} title="No attendance recorded" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="border-b border-slate-200 dark:border-slate-800">
                          <tr>
                            <th className="th">Date</th>
                            <th className="th">Check-in</th>
                            <th className="th">Check-out</th>
                            <th className="th">Source</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {memberAttendance.slice(0, 20).map((a) => (
                            <tr key={a.id}>
                              <td className="td whitespace-nowrap">{formatDate(a.date)}</td>
                              <td className="td whitespace-nowrap">{formatDateTime(a.checkIn)}</td>
                              <td className="td whitespace-nowrap">{a.checkOut ? formatDateTime(a.checkOut) : '—'}</td>
                              <td className="td">
                                <Badge tone="neutral">{a.source === 'qr' ? 'QR' : 'Manual'}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        {/* Sidebar */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Membership summary" />
            <CardBody className="space-y-4">
              <div className="rounded-xl bg-gradient-to-br from-indigo-600 to-emerald-600 p-5 text-white">
                <p className="text-xs font-semibold uppercase tracking-wide text-white/70">Plan</p>
                <p className="mt-1 text-xl font-bold">{plan?.name || 'No active plan'}</p>
                {plan && (
                  <p className="mt-2 text-sm text-white/85">
                    {formatCurrency(plan.price, settings.currency)} · {plan.durationDays} days
                  </p>
                )}
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span>Expires</span>
                  <span className="font-semibold">{expiry ? formatDate(expiry) : '—'}</span>
                </div>
                {ledger && (ledger.totals.billed > 0 || ledger.periods.length > 0) && (
                  <>
                    <div className="mt-1 flex items-center justify-between text-sm">
                      <span>Amount paid</span>
                      <span className="font-semibold">{formatCurrency(ledger.totals.paid, settings.currency)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-sm">
                      <span>Due (all periods)</span>
                      <span className="font-semibold">
                        {ledger.totals.due === 0
                          ? 'Paid in full'
                          : formatCurrency(ledger.totals.due, settings.currency)}
                      </span>
                    </div>
                  </>
                )}
              </div>
              {canWrite && (
                <Button className="w-full" onClick={() => setPayOpen(true)}>
                  <CreditCard size={16} /> Record payment
                </Button>
              )}
              {canFinanceWrite && (
                <Button variant="success" className="w-full" onClick={() => setRenewOpen(true)}>
                  <RefreshCcw size={16} /> Renew membership
                </Button>
              )}
              {expiry && daysLeft !== null && daysLeft <= 7 && (
                <WhatsAppReminderButton
                  className="w-full"
                  memberName={member.name}
                  gymName={settings.gymName}
                  planName={plan?.name}
                  expiryDate={expiry}
                  phone={member.phone}
                />
              )}
              <Link to="/payments">
                <Button variant="outline" className="w-full">
                  Go to payments
                </Button>
              </Link>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Member card (QR)" />
            <CardBody className="flex flex-col items-center gap-3 text-center">
              <QRCodeSVG value={member.id} size={140} fgColor="#0f172a" className="rounded-lg" />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Scan at the front desk to check in instantly.
              </p>
              <Button variant="outline" size="sm" onClick={() => setQrOpen(true)}>
                <Printer size={14} /> View &amp; print
              </Button>
            </CardBody>
          </Card>
        </div>
      </div>

      <MemberForm
        open={editOpen}
        onClose={() => setEditOpen(false)}
        initial={member}
        plans={plans.items}
        submitting={submitting}
        onSubmit={handleUpdate}
      />

      <PaymentForm
        open={payOpen}
        onClose={() => setPayOpen(false)}
        members={membersCol.items}
        plans={plans.items}
        payments={payments.items}
        memberships={memberships.items}
        submitting={submitting}
        onSubmit={handlePayment}
        initial={{
          memberId: member.id,
          membershipId: ledger?.targetMembershipId || latestMembershipId || '',
          planId: member.membershipPlanId || '',
        }}
      />

      <RenewalModal
        open={renewOpen}
        onClose={() => setRenewOpen(false)}
        member={member}
        currentPlan={plan}
        currentExpiry={expiry}
        plans={plans.items}
        payments={payments.items}
        memberships={memberships.items}
        onRenewed={handleRenewed}
      />

      <ReceiptModal
        open={Boolean(renewalResult)}
        onClose={() => setRenewalResult(null)}
        payment={renewalResult?.payment}
        member={member}
        plan={renewalResult ? plans.items.find((p) => String(p.id) === String(renewalResult.membership.planId)) || null : null}
        summary={
          renewalResult
            ? {
                planAmount: renewalResult.membership.price,
                totalPaid: renewalResult.membership.amountPaid,
                dueAmount: renewalResult.membership.amountDue,
                paidInFull: renewalResult.membership.amountDue === 0,
              }
            : null
        }
        settings={settings}
      />

      <MembershipPeriodForm
        open={editPeriodOpen}
        onClose={() => { setEditPeriodOpen(false); setEditPeriod(null) }}
        period={editPeriod}
        plans={plans.items}
        memberships={memberships.items}
        submitting={submitting}
        onSubmit={handleEditPeriod}
      />

      <DeletePeriodConfirm
        open={deletePeriodOpen}
        onClose={() => { setDeletePeriodOpen(false); setDeletePeriod(null) }}
        period={deletePeriod}
        payments={payments.items}
        submitting={submitting}
        onConfirm={handleDeletePeriod}
      />

      {qrOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setQrOpen(false)} />
          <div className="relative z-10 w-full max-w-sm animate-scale-in rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <MembershipCard member={member} plan={plan} expiry={expiry} settings={settings} />
            <Button size="sm" onClick={() => window.print()} className="mt-4 w-full">
              <Printer size={14} /> Print card
            </Button>
          </div>
        </div>
      )}

      {qrOpen &&
        createPortal(
          <div id="print-membership-card" className="print-membership-card" aria-hidden="true">
            <MembershipCard member={member} plan={plan} expiry={expiry} settings={settings} />
          </div>,
          document.body
        )}
    </div>
  )
}

function planFor(member, plans) {
  return plans.find((p) => String(p.id) === String(member?.membershipPlanId)) || null
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className="text-right font-medium text-slate-700 dark:text-slate-200">{value || '—'}</span>
    </div>
  )
}
