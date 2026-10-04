import { createPortal } from 'react-dom'
import { Printer } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { PAYMENT_STATUS_LABELS } from '@/utils/renewal'
import { useSecureImage } from '@/hooks/useSecureImage'

const STATUS_TONES = { paid: 'success', partial: 'warning', due: 'danger' }

function ReceiptContent({ payment, member, plan, settings, summary, receiptNo, logoSrc }) {
  // A receipt is a customer-facing financial document. It must never carry a
  // gym name this gym did not choose: the previous `'Himalye Wonders Gym'`
  // fallback printed that business's name on receipts belonging to every other
  // gym in the system. An unset name renders as an explicit marker instead, so
  // the gap is visible on the printed page rather than silently filled in.
  const gymName = typeof settings?.gymName === 'string' ? settings.gymName.trim() : ''

  return (
    <div className="space-y-4">
      <div className="border-b border-dashed border-slate-300 pb-3 text-center dark:border-slate-700">
        {logoSrc && (
          <img src={logoSrc} alt="logo" className="mx-auto mb-2 h-12 w-12 rounded-full object-cover" />
        )}
        <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
          {gymName || 'Gym name not set'}
        </h3>
        {settings?.tagline && <p className="text-xs text-slate-400">{settings.tagline}</p>}
      </div>

      <div className="text-sm text-slate-600 dark:text-slate-300">
        <div className="flex justify-between">
          <span className="text-slate-400">Receipt No.</span>
          <span className="font-semibold">{receiptNo}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-slate-400">Date</span>
          <span>{formatDate(payment.date)}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-slate-400">Member</span>
          <span className="font-semibold">{member?.name || payment.memberName || '—'}</span>
        </div>
        {plan && (
          <div className="mt-1 flex justify-between">
            <span className="text-slate-400">Plan</span>
            <span>{plan.name}</span>
          </div>
        )}
        {!plan && payment.planName && (
          <div className="mt-1 flex justify-between">
            <span className="text-slate-400">Plan</span>
            <span>{payment.planName}</span>
          </div>
        )}
        {payment.startDate && payment.expiryDate && (
          <div className="mt-1 flex justify-between">
            <span className="text-slate-400">Membership period</span>
            <span>
              {formatDate(payment.startDate)} – {formatDate(payment.expiryDate)}
            </span>
          </div>
        )}
        {payment.paymentStatus && (
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-400">Payment status</span>
            <Badge tone={STATUS_TONES[payment.paymentStatus] || 'neutral'}>
              {PAYMENT_STATUS_LABELS[payment.paymentStatus] || payment.paymentStatus}
            </Badge>
          </div>
        )}
        <div className="mt-1 flex justify-between">
          <span className="text-slate-400">Method</span>
          <span>{payment.method}</span>
        </div>
        {payment.note && (
          <div className="mt-1 flex justify-between">
            <span className="text-slate-400">Note</span>
            <span>{payment.note}</span>
          </div>
        )}
      </div>

      {summary && summary.planAmount > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/50">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Plan / Membership Amount</span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">
              {formatCurrency(summary.planAmount, settings?.currency)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-400">Amount Paid (this payment)</span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">
              {formatCurrency(payment.amount, settings?.currency)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-slate-400">Total Paid</span>
            <span className="font-semibold text-emerald-600">
              {formatCurrency(summary.totalPaid, settings?.currency)}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-dashed border-slate-300 pt-2 dark:border-slate-700">
            <span className="font-semibold text-slate-700 dark:text-slate-200">Amount Due / Remaining</span>
            <span className="text-base font-bold text-amber-600">
              {summary.dueAmount === 0 ? 'Paid in full' : formatCurrency(summary.dueAmount, settings?.currency)}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between border-t border-dashed border-slate-300 pt-3 dark:border-slate-700">
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Total Paid</span>
          <span className="text-lg font-bold text-emerald-600">
            {formatCurrency(payment.amount, settings?.currency)}
          </span>
        </div>
      )}

      <p className="text-center text-[11px] text-slate-400">
        Thank you for training with {settings?.gymName || 'us'}!
      </p>
    </div>
  )
}

export function ReceiptModal({ open, onClose, payment, member, plan, settings, summary }) {
  // The logo is fetched once here from the stored path and handed to both the
  // modal and the print copy, so opening a receipt costs a single read. Reading
  // it inside each ReceiptContent instead would download it twice, and the
  // print copy is the one that must not be racing a network call.
  const { url: logoSrc, loading: logoLoading } = useSecureImage(
    settings?.logoPath,
    settings?.logoUrl
  )

  if (!payment) return null

  // `payment.receiptNo` is authoritative. Only when it is absent do we fall
  // back to the gym's own configured prefix. The previous default here was the
  // literal 'HWG', which stamped one gym's receipt numbering onto every other
  // gym's un-numbered payments — and that number then gets persisted onto the
  // payment record. With no prefix configured, print an explicit marker so the
  // gap is visible on the receipt instead of being invented.
  const receiptPrefix = typeof settings?.receiptPrefix === 'string' ? settings.receiptPrefix.trim() : ''
  const receiptNo =
    payment.receiptNo ||
    (receiptPrefix
      ? `${receiptPrefix}-${payment.id?.slice(0, 6).toUpperCase()}`
      : 'Not assigned')
  const receiptProps = { payment, member, plan, settings, summary, receiptNo, logoSrc }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="sm"
        title="Payment Receipt"
        footer={
          // Printing while the logo is still in flight would silently produce a
          // receipt with no gym branding, which is the document a member keeps.
          // The button waits instead.
          <Button variant="outline" size="sm" onClick={() => window.print()} disabled={logoLoading}>
            <Printer size={14} /> {logoLoading ? 'Preparing…' : 'Print'}
          </Button>
        }
      >
        <ReceiptContent {...receiptProps} />
      </Modal>

      {createPortal(
        <div id="print-receipt" className="print-receipt" aria-hidden="true">
          <ReceiptContent {...receiptProps} />
        </div>,
        document.body
      )}
    </>
  )
}
