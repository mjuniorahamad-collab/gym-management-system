import { useEffect, useId, useRef } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }) {
  const panelRef = useRef(null)
  const previouslyFocused = useRef(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement

    // Move focus into the dialog. Without this, keyboard and screen-reader
    // users stay on the trigger behind the overlay and tab through the page
    // underneath an aria-modal dialog.
    panelRef.current?.focus()

    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      // Return focus to whatever opened the dialog.
      const target = previouslyFocused.current
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus()
      }
    }
  }, [open, onClose])

  if (!open) return null

  const sizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={clsx(
          // A phone gets a sheet: full width, anchored to the bottom edge, tall
          // enough for a keyboard, and scrollable inside — a centred card with
          // a 70vh cap used to hide the primary action behind the keyboard.
          'relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-900',
          'rounded-t-2xl border border-slate-200 sm:max-h-[85vh] sm:rounded-xl dark:border-slate-700',
          'animate-scale-in',
          'focus:outline-none',
          sizes[size]
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-200 dark:bg-slate-700 sm:hidden" />
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3.5 dark:border-slate-800 sm:px-5 sm:py-4">
          <div>
            {title && (
              <h3 id={titleId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {title}
              </h3>
            )}
            {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-slate-800 dark:bg-slate-950 sm:px-5 sm:py-4 [&>button]:flex-1 sm:[&>button]:flex-none">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
