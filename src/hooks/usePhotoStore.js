import { useEffect, useState } from 'react'
import { loadGymLogo, loadMemberPhoto } from '@/services/photoStore'

/**
 * Loads one stored image from Firestore and owns its lifecycle.
 *
 * A one-shot read, deliberately not a listener: an avatar does not change while
 * it is on screen, and 20 member rows should not each hold a subscription open.
 * The bytes come back as a data URL, so there is no blob to revoke — the same
 * string is also what `useSecureImage` accepts as its highest-priority source.
 *
 * `refresh()` re-reads after an upload. The component also renders the bytes the
 * upload returned, so the new image appears without waiting for this read.
 */
function useStoredImage(loader, id) {
  const [state, setState] = useState({ dataUrl: null, loading: false, error: null })
  const [nonce, setNonce] = useState(0)

  const target = typeof id === 'string' ? id.trim() : ''

  useEffect(() => {
    if (!target) {
      setState({ dataUrl: null, loading: false, error: null })
      return
    }

    let cancelled = false
    setState({ dataUrl: null, loading: true, error: null })

    loader(target)
      .then((dataUrl) => {
        if (cancelled) return
        setState({ dataUrl: dataUrl || null, loading: false, error: null })
      })
      .catch((error) => {
        if (cancelled) return
        // A denial or a missing collection is shown as initials, not as a
        // broken image and not as the previous member's face.
        setState({ dataUrl: null, loading: false, error })
      })

    return () => {
      cancelled = true
    }
    // `loader` is a module-level function in both callers; re-running on its
    // identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, nonce])

  return {
    ...state,
    refresh: () => setNonce((value) => value + 1),
  }
}

/** Member avatar bytes from memberPhotos/{memberId}. */
export function useMemberPhoto(memberId) {
  return useStoredImage(loadMemberPhoto, memberId)
}

/** Gym logo bytes from gyms/{gymId}/settings/branding. */
export function useGymLogo(gymId) {
  return useStoredImage(loadGymLogo, gymId)
}
