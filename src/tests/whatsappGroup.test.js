import { describe, expect, it, vi, beforeEach } from 'vitest'
import { whatsAppLinkSchema } from '@/schemas/validationSchemas'
import {
  getWhatsAppLink,
  setWhatsAppLink,
  clearWhatsAppLink,
  openWhatsAppGroup,
  openWhatsAppGroupInvite,
} from '@/services/whatsappGroup'

// Force the service into demo/offline (mock) mode: with Firebase unconfigured,
// isReady() is false and the module-level mockLink is the store. This lets us
// exercise save/persist/update/clear without a live backend.
vi.mock('@/firebase', () => ({
  isFirebaseConfigured: false,
  db: null,
}))

describe('whatsAppLinkSchema validation', () => {
  it('accepts a standard WhatsApp group invite link', () => {
    expect(whatsAppLinkSchema.safeParse('https://chat.whatsapp.com/AbCdEfGhIjKl').success).toBe(true)
  })

  it('accepts the chats.whatsapp.com and channel invite forms', () => {
    expect(whatsAppLinkSchema.safeParse('https://chats.whatsapp.com/AbCdEfGhIjKl').success).toBe(true)
    expect(whatsAppLinkSchema.safeParse('https://www.whatsapp.com/channel/abcd1234').success).toBe(true)
  })

  it('accepts an empty value (clears/disable)', () => {
    expect(whatsAppLinkSchema.safeParse('').success).toBe(true)
    expect(whatsAppLinkSchema.safeParse('   ').success).toBe(true)
  })

  it('trims surrounding whitespace', () => {
    const parsed = whatsAppLinkSchema.safeParse('  https://chat.whatsapp.com/xyz  ')
    expect(parsed.success).toBe(true)
    expect(parsed.data).toBe('https://chat.whatsapp.com/xyz')
  })

  it('rejects unrelated URLs', () => {
    expect(whatsAppLinkSchema.safeParse('https://google.com').success).toBe(false)
    expect(whatsAppLinkSchema.safeParse('https://example.com/group').success).toBe(false)
  })

  it('rejects malformed and dangerous values', () => {
    expect(whatsAppLinkSchema.safeParse('not-a-url').success).toBe(false)
    expect(whatsAppLinkSchema.safeParse('javascript:alert(1)').success).toBe(false)
    expect(whatsAppLinkSchema.safeParse('https://chat.whatsapp.com/').success).toBe(false)
    expect(whatsAppLinkSchema.safeParse('https://').success).toBe(false)
  })
})

describe('whatsappGroup service — per-gym invite link persistence (mock mode)', () => {
  beforeEach(() => {
    // reset the module-level mock store between tests
    return clearWhatsAppLink()
  })

  it('saves a valid WhatsApp group link', async () => {
    await setWhatsAppLink('https://chat.whatsapp.com/abc123')
    expect(await getWhatsAppLink()).toBe('https://chat.whatsapp.com/abc123')
  })

  it('persists after a reload (re-reading returns the saved value)', async () => {
    await setWhatsAppLink('https://chat.whatsapp.com/abc123')
    // simulate a fresh read
    expect(await getWhatsAppLink()).toBe('https://chat.whatsapp.com/abc123')
  })

  it('updates an existing link', async () => {
    await setWhatsAppLink('https://chat.whatsapp.com/oldlink')
    await setWhatsAppLink('https://chat.whatsapp.com/newlink')
    expect(await getWhatsAppLink()).toBe('https://chat.whatsapp.com/newlink')
  })

  it('clears/disables the link', async () => {
    await setWhatsAppLink('https://chat.whatsapp.com/abc123')
    await clearWhatsAppLink()
    expect(await getWhatsAppLink()).toBe('')
  })

  it('does not persist an invalid link', async () => {
    await expect(setWhatsAppLink('https://google.com')).rejects.toThrow()
    expect(await getWhatsAppLink()).toBe('')
  })
})

describe('openWhatsAppGroup — voluntary invite/join with graceful fallback', () => {
  beforeEach(() => {
    delete global.window
  })

  it('opens the configured link in a new window when allowed', async () => {
    const open = vi.fn(() => true)
    global.window = { open }
    const result = await openWhatsAppGroup('https://chat.whatsapp.com/abc123')
    expect(open).toHaveBeenCalledWith('https://chat.whatsapp.com/abc123', '_blank', 'noopener,noreferrer')
    expect(result.ok).toBe(true)
  })

  it('copies the link to the clipboard when the popup is blocked (no stranded user)', async () => {
    global.window = { open: () => false }
    const writeText = vi.fn().mockResolvedValue(undefined)
    global.navigator = { clipboard: { writeText } }
    const result = await openWhatsAppGroup('https://chat.whatsapp.com/abc123')
    expect(writeText).toHaveBeenCalledWith('https://chat.whatsapp.com/abc123')
    expect(result.copied).toBe(true)
  })

  it('reports failure when neither open nor clipboard is available', async () => {
    global.window = { open: () => false }
    global.navigator = {}
    const result = await openWhatsAppGroup('https://chat.whatsapp.com/abc123')
    expect(result.ok).toBe(false)
  })
})

describe('openWhatsAppGroupInvite — member-specific pre-filled invite', () => {
  const link = 'https://chat.whatsapp.com/abc123'
  const memberPayload = { memberName: 'Umar', phone: '9801234567', link, gymName: 'Himalye Wonders Gym' }

  beforeEach(() => {
    delete global.window
    delete global.navigator
  })

  it('opens a member wa.me chat pre-filled with the gym invite link', async () => {
    const open = vi.fn(() => true)
    global.window = { open }
    await openWhatsAppGroupInvite(memberPayload)
    const url = open.mock.calls[0][0]
    expect(open).toHaveBeenCalledTimes(1)
    expect(url.startsWith(`https://wa.me/919801234567?text=`)).toBe(true)
    const decoded = decodeURIComponent(url.split('?text=')[1])
    expect(decoded).toContain('Hi Umar, welcome to Himalye Wonders Gym!')
    expect(decoded).toContain('Please join our gym WhatsApp group using this link:')
    expect(decoded).toContain(link)
  })

  it('does NOT open a chat when the phone is missing (graceful fallback)', async () => {
    const open = vi.fn(() => true)
    global.window = { open }
    const result = await openWhatsAppGroupInvite({ ...memberPayload, phone: '' })
    expect(open).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.fallbackCopy).toBe(link)
    expect(result.reason).toBeTruthy()
  })

  it('does NOT open a chat when the phone is invalid (graceful fallback)', async () => {
    const open = vi.fn(() => true)
    global.window = { open }
    const result = await openWhatsAppGroupInvite({ ...memberPayload, phone: '12345' })
    expect(open).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.fallbackCopy).toBe(link)
  })

  it('copies the group link when the popup is blocked', async () => {
    global.window = { open: () => false }
    const writeText = vi.fn().mockResolvedValue(undefined)
    global.navigator = { clipboard: { writeText } }
    const result = await openWhatsAppGroupInvite(memberPayload)
    expect(writeText).toHaveBeenCalledWith(link)
    expect(result.copied).toBe(true)
  })
})
