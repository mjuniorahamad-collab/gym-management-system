import { createPortal } from 'react-dom'
import { Copy, MessageCircle, Printer } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/context/ToastContext'
import { buildMemberSummary } from '@/utils/memberSummary'
import { buildWhatsAppUrl } from '@/utils/membership'

function SummaryContent({ summary }) {
  return (
    <pre className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 font-sans text-sm leading-relaxed text-slate-800 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-100">
      {summary}
    </pre>
  )
}

export function ShareSummaryModal({ open, onClose, member, plan, expiry, ptCharge, ledger, settings, whatsAppLink }) {
  const toast = useToast()

  const summary = buildMemberSummary({
    member,
    plan,
    expiry,
    ptCharge,
    ledger,
    settings,
    whatsAppLink,
  })

  const handleWhatsApp = () => {
    const result = buildWhatsAppUrl(member?.phone, summary)
    if (!result.ok) {
      toast.error(result.error || 'Phone number is missing or invalid for WhatsApp')
      return
    }
    window.open(result.url, '_blank', 'noopener,noreferrer')
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(summary)
      toast.success('Summary copied to clipboard')
    } catch {
      toast.error('Could not copy summary to clipboard')
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Member Summary"
        subtitle="Preview and share a customer-facing summary with the member."
        footer={
          <>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <Copy size={14} /> Copy Summary
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer size={14} /> Print / PDF
            </Button>
            <Button variant="success" size="sm" onClick={handleWhatsApp}>
              <MessageCircle size={14} /> WhatsApp
            </Button>
          </>
        }
      >
        <SummaryContent summary={summary} />
      </Modal>

      {createPortal(
        <div id="print-member-summary" className="print-member-summary" aria-hidden="true">
          <SummaryContent summary={summary} />
        </div>,
        document.body
      )}
    </>
  )
}
