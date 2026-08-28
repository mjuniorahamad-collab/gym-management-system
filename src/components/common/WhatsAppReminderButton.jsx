import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/context/ToastContext'
import { buildWhatsAppMessage, buildWhatsAppUrl } from '@/utils/membership'

/**
 * Opens WhatsApp with a pre-filled, personalized renewal reminder for a member.
 * Nothing is sent automatically; an invalid/missing phone shows an error toast.
 */
export function WhatsAppReminderButton({
  memberName,
  gymName,
  planName,
  expiryDate,
  phone,
  variant = 'outline',
  size = 'sm',
  label = 'Send WhatsApp Reminder',
  iconOnly = false,
  className,
}) {
  const toast = useToast()

  const handleClick = () => {
    const message = buildWhatsAppMessage({ memberName, gymName, planName, expiryDate })
    const result = buildWhatsAppUrl(phone, message)
    if (!result.ok) {
      toast.error(result.error || 'Phone number is missing or invalid for WhatsApp')
      return
    }
    window.open(result.url, '_blank', 'noopener,noreferrer')
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={handleClick}
      title={iconOnly ? label : undefined}
    >
      <MessageCircle size={iconOnly ? 16 : 15} />
      {iconOnly ? null : label}
    </Button>
  )
}
