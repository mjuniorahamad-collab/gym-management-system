/**
 * SECURE IMAGE READS — INLINE BYTES
 *
 * `useSecureImage` gained a third source: bytes that are already in hand, i.e.
 * the base64 thumbnail returned by `memberPhotos/{memberId}` or
 * `gyms/{gymId}/settings/branding`. The ordering rules matter:
 *
 *   inline bytes -> stored object path -> legacy stored URL
 *
 * Inline bytes must never trigger a fetch (there is nothing to fetch, and the
 * bucket does not exist for this project), and they must beat a path, otherwise
 * every avatar would still try to reach Cloud Storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useSecureImage } from '@/hooks/useSecureImage'

const { mocks } = vi.hoisted(() => ({ mocks: { readObjectUrl: vi.fn() } }))

vi.mock('@/services/storage', () => ({ readObjectUrl: mocks.readObjectUrl }))

function Probe({ path, legacyUrl, dataUrl }) {
  const { url, loading, error } = useSecureImage(path, legacyUrl, dataUrl)
  return (
    <div>
      <span data-testid="url">{url || ''}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ? String(error.message) : ''}</span>
    </div>
  )
}

const text = (container, id) => container.querySelector(`[data-testid="${id}"]`).textContent
const PATH = 'gyms/gym-alpha/memberPhotos/m1/photo.jpg'
const INLINE = 'data:image/webp;base64,AAAA'

describe('useSecureImage inline bytes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readObjectUrl.mockResolvedValue('blob:from-storage')
    global.URL.createObjectURL = vi.fn(() => 'blob:from-storage')
    global.URL.revokeObjectURL = vi.fn()
  })

  it('renders supplied bytes without fetching anything', async () => {
    const { container } = render(<Probe dataUrl={INLINE} />)

    await waitFor(() => expect(text(container, 'url')).toBe(INLINE))
    expect(text(container, 'loading')).toBe('false')
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })

  it('prefers supplied bytes over a stored object path', async () => {
    const { container } = render(<Probe path={PATH} dataUrl={INLINE} />)

    await waitFor(() => expect(text(container, 'url')).toBe(INLINE))
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })

  it('prefers supplied bytes over a legacy URL', async () => {
    const { container } = render(<Probe legacyUrl="https://legacy/token" dataUrl={INLINE} />)

    await waitFor(() => expect(text(container, 'url')).toBe(INLINE))
  })

  it('ignores blank bytes and falls back to the path', async () => {
    const { container } = render(<Probe path={PATH} dataUrl="   " />)

    await waitFor(() => expect(mocks.readObjectUrl).toHaveBeenCalledWith(PATH))
    await waitFor(() => expect(text(container, 'url')).toBe('blob:from-storage'))
  })

  it('swaps the image when the bytes change for another member', async () => {
    const { container, rerender } = render(<Probe dataUrl={INLINE} />)
    await waitFor(() => expect(text(container, 'url')).toBe(INLINE))

    rerender(<Probe dataUrl="data:image/webp;base64,BBBB" />)
    await waitFor(() => expect(text(container, 'url')).toBe('data:image/webp;base64,BBBB'))
  })
})
