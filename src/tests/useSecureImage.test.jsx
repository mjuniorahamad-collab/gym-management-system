/**
 * STORAGE PHASE 3C — SECURE RUNTIME IMAGE READS
 *
 * useSecureImage is the component-level half of D1: it turns a stored object
 * PATH into a blob URL whose fetch is authorised by storage.rules at render
 * time, and it owns the revoke lifecycle so image bytes do not accumulate.
 *
 * The subtle behaviours worth pinning are the ones that fail silently:
 * revocation, stale-read races, and the rule that a legacy URL may only be used
 * when the document has no path at all.
 */
import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useSecureImage } from '@/hooks/useSecureImage'

const { mocks } = vi.hoisted(() => ({ mocks: { readObjectUrl: vi.fn() } }))

vi.mock('@/services/storage', () => ({ readObjectUrl: mocks.readObjectUrl }))

/** Surfaces the hook's state as text so effects can be asserted without UI. */
function Probe({ path, legacyUrl }) {
  const { url, loading, error } = useSecureImage(path, legacyUrl)
  return (
    <div>
      <span data-testid="url">{url || ''}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ? String(error.message) : ''}</span>
    </div>
  )
}

const text = (c, id) => c.querySelector(`[data-testid="${id}"]`).textContent
const PATH_A = 'gyms/gym-alpha/memberPhotos/m1/photo.jpg'
const PATH_B = 'gyms/gym-alpha/memberPhotos/m2/photo.jpg'

describe('useSecureImage', () => {
  let createObjectURL
  let revokeObjectURL

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readObjectUrl.mockResolvedValue('blob:a')
    createObjectURL = vi.fn(() => 'blob:a')
    revokeObjectURL = vi.fn()
    global.URL.createObjectURL = createObjectURL
    global.URL.revokeObjectURL = revokeObjectURL
  })

  it('fetches the path and exposes the resulting URL', async () => {
    const { container } = render(<Probe path={PATH_A} />)
    await waitFor(() => expect(text(container, 'url')).toBe('blob:a'))
    expect(mocks.readObjectUrl).toHaveBeenCalledWith(PATH_A)
    expect(text(container, 'loading')).toBe('false')
  })

  it('reports loading, then settles', async () => {
    let resolve
    mocks.readObjectUrl.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(<Probe path={PATH_A} />)

    await waitFor(() => expect(text(container, 'loading')).toBe('true'))
    expect(text(container, 'url')).toBe('')
    resolve('blob:a')
    await waitFor(() => expect(text(container, 'loading')).toBe('false'))
  })

  it('revokes the previous URL when the path changes', async () => {
    const { container, rerender } = render(<Probe path={PATH_A} />)
    await waitFor(() => expect(text(container, 'url')).toBe('blob:a'))

    rerender(<Probe path={PATH_B} />)
    await waitFor(() => expect(mocks.readObjectUrl).toHaveBeenCalledWith(PATH_B))
    // Without this the bytes for member m1 stay resident forever.
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:a'))
  })

  it('revokes on unmount', async () => {
    const { container, unmount } = render(<Probe path={PATH_A} />)
    await waitFor(() => expect(text(container, 'url')).toBe('blob:a'))
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a')
  })

  // Navigating a member list re-points the same component at a different person.
  // If the in-flight read for m1 resolves after the switch, it would overwrite
  // m2's image with m1's photo.
  it('discards a slow read that was superseded by a newer path', async () => {
    const pending = {}
    mocks.readObjectUrl.mockImplementation(
      (p) => new Promise((resolve) => { pending[p] = resolve })
    )
    const { container, rerender } = render(<Probe path={PATH_A} />)
    await waitFor(() => expect(mocks.readObjectUrl).toHaveBeenCalledWith(PATH_A))

    rerender(<Probe path={PATH_B} />)
    await waitFor(() => expect(mocks.readObjectUrl).toHaveBeenCalledWith(PATH_B))

    // m1's read lands late and must be discarded, not displayed.
    pending[PATH_A]('blob:stale')
    pending[PATH_B]('blob:fresh')
    await waitFor(() => expect(text(container, 'url')).toBe('blob:fresh'))
    // The discarded URL is revoked rather than leaked.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stale')
  })

  it('surfaces a denied read as an error', async () => {
    mocks.readObjectUrl.mockRejectedValue(new Error('storage/unauthorized'))
    const { container } = render(<Probe path={PATH_A} />)
    await waitFor(() => expect(text(container, 'error')).toBe('storage/unauthorized'))
    expect(text(container, 'url')).toBe('')
  })

  // A document with no path is pre-3C. It must still render, and it must not
  // trigger a read, because there is nothing secure to read from.
  it('falls back to the legacy URL when the document has no path', async () => {
    const { container } = render(<Probe path="" legacyUrl="https://legacy/token" />)
    await waitFor(() => expect(text(container, 'url')).toBe('https://legacy/token'))
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('renders nothing when there is neither a path nor a legacy URL', async () => {
    const { container } = render(<Probe path="" legacyUrl="" />)
    await waitFor(() => expect(text(container, 'url')).toBe(''))
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })

  // The important one. If a document HAS a path, the stored token is bypassed
  // even when the secure read fails, so a rules denial cannot be masked by an
  // expired-but-still-working URL.
  it('never falls back to the legacy URL when a path is present', async () => {
    mocks.readObjectUrl.mockRejectedValue(new Error('storage/unauthorized'))
    const { container } = render(<Probe path={PATH_A} legacyUrl="https://legacy/token" />)
    await waitFor(() => expect(text(container, 'error')).toBe('storage/unauthorized'))
    expect(text(container, 'url')).toBe('')
  })

  it('ignores a whitespace-only path', async () => {
    const { container } = render(<Probe path="   " legacyUrl="https://legacy/token" />)
    await waitFor(() => expect(text(container, 'url')).toBe('https://legacy/token'))
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })
})