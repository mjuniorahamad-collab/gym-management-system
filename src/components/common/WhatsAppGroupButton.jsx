import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/context/ToastContext'
import { openWhatsAppGroupInvite } from '@/services/whatsappGroup'

/**
 * Per-member WhatsApp group invite action. Opens a WhatsApp chat with the
 * member pre-filled with an invitation containing the gym's group invite link.
 * Nothing is ever sent or added to a group automatically. When unconfigured it
 * shows a muted "not configured" message instead of the action; when the member
 * has no valid phone the group link is copied so the owner is never stranded.
 */
export function WhatsAppGroupButton({ link, memberName, phone, gymName, canWrite = true, className }) {
  const toast = useToast()

  const handleInvite = async () => {
    const result = await openWhatsAppGroupInvite({ memberName, phone, link, gymName })
    if (!result.ok) {
      toast.error(result.reason || 'Could not open WhatsApp. Try copy the invite link from Settings.')
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

  if (!link || !link.trim()) {
    return <p className="text-center text-xs text-slate-400">WhatsApp group link not configured.</p>
  }

  if (!canWrite) {
    return null
  }

  return (
    <Button variant="outline" className={className} onClick={handleInvite}>
      <MessageCircle size={16} /> WhatsApp Group
    </Button>
  )
}