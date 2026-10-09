import { useMemo, useState, useEffect } from 'react'
import { CreditCard, DollarSign, Plus, Receipt as ReceiptIcon, TrendingUp, Trash2 } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { recordPayment, deletePayment } from '@/services/payments'
import { requireReceiptPrefix } from '@/services/receiptPrefixGuard'
import { getPtSurcharge } from '@/services/pt'
import { exportPaymentsToCsv } from '@/services/export'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { PaymentForm } from '@/components/common/PaymentForm'
import { ReceiptModal } from '@/components/common/ReceiptModal'
import { CSVExportButton } from '@/components/common/CSVExportButton'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatCard } from '@/components/charts/StatCard'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { Pagination } from '@/components/ui/Pagination'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { PAYMENT_METHODS } from '@/utils/constants'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { monthKey, parseDate } from '@/utils/dateHelpers'
import { computeMemberLedger } from '@/utils/dues'

const PAGE_SIZE = 20

export default function Payments() {
  const { can } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()

  const { items: payments, loading, error, reload } = useCollection('payments')
  const { items: members } = useCollection('members')
  const { items: plans } = useCollection('membershipPlans')
  const { items: memberships } = useCollection('memberships')

  const [search, setSearch] = useState('')
  const [method, setMethod] = useState('all')
  const [formOpen, setFormOpen] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [ptSurcharge, setPtSurcharge] = useState(0)

  useEffect(() => {
    let mounted = true
    getPtSurcharge()
      .then((v) => {
        if (mounted) setPtSurcharge(v)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [can])

  const memberMap = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members])
  const planMap = useMemo(() => Object.fromEntries(plans.map((p) => [p.id, p])), [plans])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return [...payments]
      .filter((p) => {
        const member = memberMap[p.memberId]
        const name = (p.memberName || member?.name || '').toLowerCase()
        if (q && !name.includes(q) && !String(p.receiptNo || '').toLowerCase().includes(q)) return false
        if (method !== 'all' && p.method !== method) return false
        return true
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  }, [payments, memberMap, search, method])

  const summary = useMemo(() => {
    const current = monthKey(new Date())
    const total = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    // Deliberately NOT `filtered`: these cards summarise the books, so the
    // figure must not change because someone typed in the search box or picked
    // a payment method. It also disagreed with the "Total collected" card
    // directly above it, which already used the unfiltered list.
    const thisMonth = payments
      .filter((p) => monthKey(parseDate(p.date)) === current)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)
    return { total, thisMonth }
  }, [payments])

  const canWrite = can('finance.write')

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      await recordPayment({
        values,
        memberName: memberMap[values.memberId]?.name || '',
        planName: planMap[values.planId]?.name || '',
        receiptPrefix: await requireReceiptPrefix(settings.receiptPrefix, 'Payments'),
      })
      toast.success('Payment recorded')
      setFormOpen(false)
    } catch (e) {
      toast.error(e.message || 'Could not save payment')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      // Same source of truth as creation: the service removes the document
      // AND recalculates the affected membership periods so paid amounts,
      // dues, statuses and dashboard totals revert correctly.
      await deletePayment({ payment: deleting })
      toast.success('Payment deleted')
      setDeleting(null)
    } catch (e) {
      toast.error(e.message || 'Could not delete payment')
    } finally {
      setSubmitting(false)
    }
  }

  const shown = filtered.slice(0, visible)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payments"
        subtitle="Track all incoming payments"
        actions={
          canWrite && (
            <Button
              onClick={() => {
                setReceipt(null)
                setFormOpen(true)
              }}
            >
              <Plus size={16} /> Record payment
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Total revenue" value={formatCurrency(summary.total, settings.currency)} icon={DollarSign} tone="emerald" />
        <StatCard title="This month" value={formatCurrency(summary.thisMonth, settings.currency)} icon={TrendingUp} tone="sky" />
        <StatCard title="Payments recorded" value={payments.length} icon={CreditCard} tone="indigo" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search member or receipt…" className="w-full sm:w-72" />
        <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-44">
          <option value="all">All methods</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <div className="ml-auto">
          <CSVExportButton onExport={() => exportPaymentsToCsv(filtered, settings)} />
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : error ? (
          <LoadErrorState label="payments" message={error} onRetry={reload} />
        ) : shown.length === 0 ? (
          <EmptyState icon={ReceiptIcon} title="No payments found" description="Record your first payment to get started." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="th">Date</th>
                    <th className="th">Member</th>
                    <th className="th hidden md:table-cell">Plan</th>
                    <th className="th">Amount</th>
                    <th className="th hidden sm:table-cell">Method</th>
                    <th className="th hidden lg:table-cell">Receipt</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {shown.map((p) => {
                    const member = memberMap[p.memberId]
                    const plan = planMap[p.planId]
                    return (
                      <tr key={p.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="td whitespace-nowrap">{formatDate(p.date)}</td>
                        <td className="td font-medium text-slate-900 dark:text-slate-100">
                          {p.memberName || member?.name || 'Unknown'}
                        </td>
                        <td className="td hidden md:table-cell">{plan?.name || '—'}</td>
                        <td className="td font-semibold text-emerald-600">
                          {formatCurrency(p.amount, settings.currency)}
                        </td>
                        <td className="td hidden sm:table-cell">
                          <Badge tone="neutral">{p.method}</Badge>
                        </td>
                        <td className="td hidden whitespace-nowrap text-xs text-slate-400 lg:table-cell">
                          {p.receiptNo || '—'}
                        </td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon" title="Receipt" onClick={() => setReceipt(p)}>
                              <ReceiptIcon size={16} />
                            </Button>
                            {can('settings.write') && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                                title="Delete"
                                onClick={() => setDeleting(p)}
                              >
                                <Trash2 size={16} />
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
            <Pagination
              hasMore={visible < filtered.length}
              loading={loading}
              onLoadMore={() => setVisible((v) => v + PAGE_SIZE)}
              showing={shown.length}
              total={filtered.length}
            />
          </>
        )}
      </div>

      <PaymentForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        members={members}
        plans={plans}
        payments={payments}
        memberships={memberships}
        submitting={submitting}
        onSubmit={handleSubmit}
        ptSurcharge={ptSurcharge}
      />

      <ReceiptModal
        open={Boolean(receipt)}
        onClose={() => setReceipt(null)}
        payment={receipt}
        member={receipt ? memberMap[receipt.memberId] : null}
        plan={receipt ? planForReceipt(receipt, memberMap, planMap) : null}
        summary={
        receipt
          ? receiptSummary(receipt, { members, plans, payments, memberships, ptSurcharge })
          : null
      }
        settings={settings}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={submitting}
        title="Delete payment?"
        message={`This will permanently remove the ${formatCurrency(deleting?.amount, settings.currency)} payment.`}
        confirmLabel="Delete payment"
      />
    </div>
  )
}

function planForReceipt(payment, memberMap, planMap) {
  const fromPayment = planMap[payment?.planId]
  if (fromPayment) return fromPayment
  const member = memberMap[payment?.memberId]
  return member ? planMap[member.membershipPlanId] || null : null
}

/**
 * Receipt figures come from the finance ledger so they match every other
 * screen: the payment's own period (or the member's totals when the payment
 * is unallocated), never the member's CURRENT plan price.
 */
function receiptSummary(receipt, { members, plans, payments, memberships, ptSurcharge }) {
  const member = members.find((m) => m.id === receipt.memberId)
  if (!member) return null
  // ptSurcharge matters for the unallocated fallback below. An undocumented
  // (implicit) period is reconstructed at plan + PT surcharge, so omitting it
  // printed a receipt showing the bare plan price and therefore a LOWER total
  // than the PT member was actually charged. Allocated receipts are unaffected
  // because a stored period carries its own price snapshot.
  const ledger = computeMemberLedger({ member, plans, payments, memberships, ptSurcharge })

  if (receipt.membershipId) {
    const period = ledger.periods.find((p) => p.id === receipt.membershipId)
    if (period) {
      return {
        planAmount: period.price,
        totalPaid: period.paid,
        dueAmount: period.due,
        paidInFull: period.due === 0 && period.price > 0,
      }
    }
  }

  // Unallocated payment — show the member-wide position.
  return {
    planAmount: ledger.totals.billed,
    totalPaid: ledger.totals.paid,
    dueAmount: ledger.totals.due,
    paidInFull: ledger.totals.due === 0 && ledger.totals.billed > 0,
  }
}
