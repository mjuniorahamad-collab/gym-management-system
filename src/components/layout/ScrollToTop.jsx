import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * A single-page app keeps the window scroll position across route changes, so
 * opening a member from halfway down a long list used to land in the middle of
 * their profile. On a phone that reads as "the page jumped".
 *
 * Only the pathname is watched: changing a tab or a filter on the same screen
 * must not yank the list back to the top.
 */
export function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return null
}
