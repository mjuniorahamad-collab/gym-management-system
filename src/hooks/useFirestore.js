import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPage, subscribeCollection } from '@/services/firestore'
import { useAuth } from '@/context/AuthContext'

/** Realtime subscription to a whole collection (best for small collections). */
export function useCollection(name, options = {}) {
  const { disabled = false } = options
  const { user, profile, error: authError } = useAuth()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (disabled) {
      setItems([])
      setError(null)
      setLoading(false)
      return
    }
    // Never run Firestore listeners without a signed-in user.
    if (!user) {
      setItems([])
      setError(null)
      setLoading(false)
      return
    }
    // Wait for the caller's profile/role to resolve before querying. The
    // security rules derive access from the users/{uid} profile, so querying
    // before it exists only produces denied reads that never retry.
    if (!profile) {
      setItems([])
      if (authError) {
        setError(authError)
        setLoading(false)
      } else {
        setError(null)
        setLoading(true)
      }
      return
    }

    setLoading(true)
    setError(null)
    let unsubscribe
    try {
      unsubscribe = subscribeCollection(
        name,
        (data) => {
          setItems(data)
          setLoading(false)
        },
        (err) => {
          setError(err?.message || 'Failed to load data')
          setLoading(false)
        }
      )
    } catch (e) {
      // A synchronous failure (e.g. failed Firestore client) must not leave
      // the UI in a perpetual loading state.
      setError(e?.message || 'Failed to load data')
      setLoading(false)
      return
    }
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [name, disabled, user, profile, authError])

  return { items, loading, error }
}

/**
 * Paginated list with filters + text search + cursor-based "load more".
 * Uses getDocs (not realtime) so queries stay efficient on larger datasets.
 */
export function usePaginatedCollection(name, options = {}) {
  const { user, profile, error: authError } = useAuth()
  const optionsRef = useRef(options)
  optionsRef.current = options
  const key = JSON.stringify({ name, ...options })

  const [items, setItems] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const lastRef = useRef(null)

  const load = useCallback(async (mode) => {
    setError(null)
    try {
      const res = await fetchPage({
        ...optionsRef.current,
        name,
        startAfterRef: mode === 'next' ? lastRef.current : null,
      })
      setItems((prev) => (mode === 'next' ? [...prev, ...res.items] : res.items))
      lastRef.current = res.last
      setHasMore(res.hasMore)
    } catch (e) {
      setError(e?.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [name])

  useEffect(() => {
    lastRef.current = null
    setItems([])
    setHasMore(false)
    setError(null)
    // Never run Firestore queries without a signed-in user.
    if (!user) {
      setLoading(false)
      return
    }
    // Wait for the caller's profile/role to resolve before querying (see
    // useCollection). Queries fired before the users/{uid} profile exists are
    // denied by the security rules and never retry.
    if (!profile) {
      if (authError) {
        setError(authError)
        setLoading(false)
      } else {
        setLoading(true)
      }
      return
    }
    setLoading(true)
    load('first')
  }, [key, load, user, profile, authError])

  const loadMore = useCallback(() => {
    if (user && profile && hasMore && !loading) load('next')
  }, [user, profile, hasMore, loading, load])

  const reload = useCallback(() => {
    if (user && profile) load('first')
  }, [user, profile, load])

  return { items, loading, error, hasMore, loadMore, reload }
}
