import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WhatsAppGroupButton } from '@/components/common/WhatsAppGroupButton'
import { openWhatsAppGroupInvite } from '@/services/whatsappGroup'

vi.mock('@/services/whatsappGroup', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    openWhatsAppGroupInvite: vi.fn(),
  }
})

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('WhatsAppGroupButton — Member Detail invite action', () => {
  beforeEach(() => {
    openWhatsAppGroupInvite.mockReset()
  })

  it('shows the WhatsApp Group action when a link is configured', () => {
    render(<WhatsAppGroupButton link="https://chat.whatsapp.com/abc123" />)
    expect(screen.getByRole('button', { name: /WhatsApp Group/i })).toBeInTheDocument()
  })

  it('opens a member chat pre-filled with the invite when clicked', () => {
    openWhatsAppGroupInvite.mockResolvedValue({ ok: true })
    render(
      <WhatsAppGroupButton
        link="https://chat.whatsapp.com/abc123"
        memberName="Umar"
        phone="9801234567"
        gymName="Himalye Wonders Gym"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp Group/i }))
    expect(openWhatsAppGroupInvite).toHaveBeenCalledWith({
      memberName: 'Umar',
      phone: '9801234567',
      link: 'https://chat.whatsapp.com/abc123',
      gymName: 'Himalye Wonders Gym',
    })
  })

  it('shows an error and copies the link when the member has no valid phone', async () => {
    openWhatsAppGroupInvite.mockResolvedValue({
      ok: false,
      reason: 'Phone number is missing or invalid for WhatsApp',
      fallbackCopy: 'https://chat.whatsapp.com/abc123',
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    global.navigator = { clipboard: { writeText } }
    render(
      <WhatsAppGroupButton
        link="https://chat.whatsapp.com/abc123"
        memberName="Umar"
        phone=""
        gymName="Himalye Wonders Gym"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp Group/i }))
    expect(openWhatsAppGroupInvite).toHaveBeenCalled()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://chat.whatsapp.com/abc123'))
  })

  it('shows a muted "not configured" message when no link is configured', () => {
    render(<WhatsAppGroupButton link="" />)
    expect(screen.queryByRole('button', { name: /WhatsApp Group/i })).toBeNull()
    expect(screen.getByText('WhatsApp group link not configured.')).toBeInTheDocument()
  })

  it('hides the action when a link is configured but the user cannot write', () => {
    const { container } = render(<WhatsAppGroupButton link="https://chat.whatsapp.com/abc123" canWrite={false} />)
    expect(container.firstChild).toBeNull()
  })
})
