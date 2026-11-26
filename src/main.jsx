import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { pwaUpdates } from '@/utils/pwaUpdates'
import { reloadOnStaleChunk } from '@/utils/staleChunk'

// After a deploy, this tab's in-memory shell still points at chunk hashes that no
// longer exist. Vite fires this event when such a lazy import fails; reload once
// so the open tab refreshes instead of breaking a route with an error screen.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnStaleChunk()) event.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Installable PWA: register the app-shell worker in the built app only.
//
// In `vite dev` the worker would cache modules that HMR is rewriting, which
// produces "my change did not appear" bugs that look like application bugs.
// Registration is also failure-tolerant: no service worker still means a working
// web app, so a broken register call must never surface to the user.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      // A waiting worker becomes the "new version available" prompt; see
      // src/components/common/PwaUpdatePrompt.jsx.
      .then((registration) => pwaUpdates.register(registration))
      .catch(() => undefined)
  })
}
