import { useEffect, useState } from 'react'
import { readObjectUrl } from '@/services/storage'

/**
 * Resolves a Storage object PATH into a displayable blob URL.
 *
 * Why this exists (D1): `getDownloadURL` returns a bearer token. Once that URL
 * is stored in a member or settings document it stops being an access decision
 * and becomes a permanent capability — the rules are never consulted again, and
 * anyone who ever saw the URL keeps access after the member moves gyms or the
 * staff role is revoked. Reading the bytes instead means every render is
 * authorised by `storage.rules` at the moment it happens, and the token lives
 * only in the request.
 *
 * `legacyUrl` exists only for documents written before Phase 3B, which have no
 * stored path and therefore no way to be fetched securely yet. It is used
 * STRICTLY when there is no path:
 *
 *   - path present  -> read the bytes; never touch the legacy URL. A stored path
 *                      that cannot be read is a real failure (revoked access,
 *                      missing object) and must be visible, not papered over.
 *   - path absent   -> render the legacy URL so the record is not blanked while
 *                      it awaits migration.
 *
 * Once a document carries a path, the URL is dead weight and should be dropped
 * from it by the migration.
 *
 * Blob URLs are revoked on unmount and whenever the path changes, otherwise the
 * image bytes stay resident for the lifetime of the document.
 */
export function useSecureImage(path, legacyUrl) {
  const [state, setState] = useState({ url: null, loading: false, error: null })

  useEffect(() => {
    const target = typeof path === 'string' ? path.trim() : ''

    if (!target) {
      // No path: pre-3B document. Show what we have and claim nothing more.
      setState({ url: legacyUrl || null, loading: false, error: null })
      return
    }

    let cancelled = false
    let objectUrl = null

    // Clear immediately rather than keeping the previous object URL: while the
    // path changes (list navigation) the old value belongs to a DIFFERENT member
    // or gym, and rendering it would show one person's photo under another's
    // name.
    setState({ url: null, loading: true, error: null })

    readObjectUrl(target)
      .then((url) => {
        if (cancelled) {
          // Unmounted or superseded while in flight; do not leak the bytes.
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setState({ url, loading: false, error: null })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ url: null, loading: false, error: err })
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, legacyUrl])

  return state
}