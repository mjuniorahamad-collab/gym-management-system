import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { render, screen, fireEvent } from '@testing-library/react'
import { useCollection, usePaginatedCollection } from '@/hooks/useFirestore'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { LOAD_ERROR } from '@/utils/loadErrors'

const { mocks, authValue } = vi.hoisted(() => ({
  mocks: {
    subscribeCollection: vi.fn(),
    fetchPage: vi.fn(),
  },
  authValue: {
    user: { uid: 'u1' },
    profile: { uid: 'u1', role: 'owner', gymId: 'g1' },
    loading: false,
    error: null,
  },
}))

vi.mock('@/services/firestore', () => ({
  subscribeCollection: mocks.subscribeCollection,
  fetchPage: mocks.fetchPage,
  isReady: vi.fn(() => true),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))

const RAW_PERMISSION = {
  code: 'permission-denied',
  message: 'Missing or insufficient permissions. (firestore.rules:412)',
}

describe('LoadErrorState component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the stable message and never the raw Firebase error', () => {
    render(<LoadErrorState label="payments" message={RAW_PERMISSION} onRetry={vi.fn()} />)

    expect(screen.getByText("Couldn't load payments")).toBeInTheDocument()
    expect(screen.getByText(LOAD_ERROR.PERMISSION)).toBeInTheDocument()
    expect(screen.queryByText(/Missing or insufficient/)).toBeNull()
    expect(screen.queryByText(/firestore\.rules/)).toBeNull()
    expect(screen.queryByText(/permission-denied/)).toBeNull()
  })

  it('invokes onRetry when Try again is clicked', () => {
    const onRetry = vi.fn()
    render(<LoadErrorState label="members" message={RAW_PERMISSION} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('useCollection load-error sanitisation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores a stable user-facing message when the subscription reports a raw Firebase error', async () => {
    mocks.subscribeCollection.mockImplementation((name, onData, onError) => {
      onError(RAW_PERMISSION)
      return () => {}
    })

    const { result } = renderHook(() => useCollection('payments'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe(LOAD_ERROR.PERMISSION)
    expect(String(result.current.error)).not.toContain('Missing or insufficient')
    expect(String(result.current.error)).not.toContain('firestore.rules')
    expect(String(result.current.error)).not.toContain('permission-denied')
  })

  it('distinguishes a legitimate empty collection from a failure', async () => {
    mocks.subscribeCollection.mockImplementation((name, onData) => {
      onData([])
      return () => {}
    })

    const { result } = renderHook(() => useCollection('payments'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.items).toEqual([])
  })

  it('recovers through reload() — the retry re-subscribes and clears the error', async () => {
    let attempts = 0
    mocks.subscribeCollection.mockImplementation((name, onData, onError) => {
      attempts += 1
      if (attempts === 1) onError(RAW_PERMISSION)
      else onData([])
      return () => {}
    })

    const { result } = renderHook(() => useCollection('payments'))
    await waitFor(() => expect(result.current.error).toBe(LOAD_ERROR.PERMISSION))

    act(() => result.current.reload())

    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.items).toEqual([])
    expect(attempts).toBe(2)
  })

  it('sanitises paginated fetch failures the same way', async () => {
    mocks.fetchPage.mockRejectedValue({
      code: 'permission-denied',
      message: 'Missing or insufficient permissions.',
    })

    const { result } = renderHook(() => usePaginatedCollection('members', {}))

    await waitFor(() => expect(result.current.error).toBe(LOAD_ERROR.PERMISSION))
    expect(String(result.current.error)).not.toContain('Missing or insufficient')
  })
})
