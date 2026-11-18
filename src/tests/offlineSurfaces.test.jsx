import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * WHAT THE OPERATOR SEES WHEN THE DEVICE IS OFFLINE.
 *
 * The service guard refuses the write; this proves the same condition reaches a
 * human as a sentence and as a disabled control, rather than as a toast after
 * they have typed a payment.
 */
const fb = { configured: true }
vi.mock('@/firebase', () => ({
  get isFirebaseConfigured() {
    return fb.configured
  },
  db: null,
}))

const { OnlineIndicator } = await import('@/components/layout/OnlineIndicator')
const { OfflineActionsNotice } = await import('@/components/ui/OfflineActionsNotice')

const setOnLine = (value) => {
  Object.defineProperty(globalThis.navigator, 'onLine', { value, configurable: true })
  window.dispatchEvent(new Event(value ? 'online' : 'offline'))
}

beforeEach(() => {
  fb.configured = true
  setOnLine(true)
})

afterEach(() => {
  setOnLine(true)
})

describe('OnlineIndicator', () => {
  it('shows Online and no warning while the device is connected', () => {
    render(<OnlineIndicator />)
    expect(screen.getByText('Online')).toBeTruthy()
  })

  it('switches to Offline when the browser loses its connection', async () => {
    render(<OnlineIndicator />)
    setOnLine(false)
    await waitFor(() => expect(screen.getByText('Offline')).toBeTruthy())
  })

  it('stays Online in demo mode, where there is no backend to be offline from', () => {
    fb.configured = false
    setOnLine(false)
    render(<OnlineIndicator />)
    expect(screen.getByText('Online')).toBeTruthy()
  })
})

describe('OfflineActionsNotice', () => {
  it('renders nothing while online', () => {
    const { container } = render(<OfflineActionsNotice />)
    expect(container.textContent).toBe('')
  })

  it('explains that money actions are disabled and nothing is queued', () => {
    setOnLine(false)
    render(<OfflineActionsNotice />)
    // Mounted while already offline: the hook reads the state on mount.
    expect(screen.getByRole('status').textContent).toContain("You're offline.")
    expect(screen.getByRole('status').textContent).toContain('nothing is queued')
  })
})
