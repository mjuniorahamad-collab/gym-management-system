import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useSettings } from '@/context/SettingsContext'
import { formatCurrency, formatDate } from '@/utils/formatters'

export function DeletePeriodConfirm({
  open,
  onClose,
  period,
  payments = [],
  submitting,
  onConfirm,
}) {
  const { settings } = useSettings()

  const linkedPayments = useMemo(
    () => payments.filter((p) => p && p.membershipId === period?.id),
    [payments, period?.id]
  )

  if (!period) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Delete Membership Period"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={submitting}>
            Delete period
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400">
            <AlertTriangle size={20} />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              This will permanently delete this membership period
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Any payments linked to this period will be reallocated to other periods automatically.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {period.label || period.planName || 'Membership period'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {formatDate(period.startDate)} → {formatDate(period.expiryDate)}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Badge>{formatCurrency(period.price, settings.currency)}</Badge>
            {period.paid > 0 && (
              <Badge tone={period.due > 0 ? 'warning' : 'success'}>
                {formatCurrency(period.paid, settings.currency)} paid
              </Badge>
            )}
          </div>
        </div>

        {linkedPayments.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {linkedPayments.length} payment{linkedPayments.length > 1 ? 's' : ''} will be reallocated
            </p>
            <ul className="mt-2 space-y-1">
              {linkedPayments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between text-xs text-amber-700 dark:text-amber-400"
                >
                  <span>{formatDate(p.date)} · {p.method}</span>
                  <span className="font-medium">{formatCurrency(p.amount, settings.currency)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
              These payments will become unallocated and automatically settle other open periods by date order (FIFO).
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
