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
    // navigator.clipboard is only exposed in a secure context. On plain http://
    // - which is how a gym on a LAN address is commonly reached - it is absent
    // entirely, and the previous `navigator.clipboard?.writeText(summary)`
    // short-circuited to undefined and reported success without copying
    // anything. Check the API exists before claiming the copy worked.
    const clipboard = navigator?.clipboard
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      toast.error('Copying is not supported in this browser. Select the summary text to copy it manually.')
      return
    }
    try {
      await clipboard.writeText(summary)
      toast.success('Summary copied to clipboard')
    } catch {
      // A real rejection: permission denied, document not focused, etc.
      toast.error('Could not copy the summary. Select the summary text to copy it manually.')
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

      {/*
        The print portal must only exist while this modal is open. index.css
        forces `#print-member-summary { display: block !important }` inside
        @media print, so a permanently mounted portal would be appended to
        EVERY print on the page - including the membership card and payment
        receipt prints. Gating on `open` matches the membership card portal in
        MemberDetail.jsx and keeps each print target exclusive.
      */}
      {open &&
        createPortal(
          <div id="print-member-summary" className="print-member-summary" aria-hidden="true">
            <SummaryContent summary={summary} />
          </div>,
          document.body
        )}
    </>
  )
}
