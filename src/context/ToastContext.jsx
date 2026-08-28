import { createContext, useCallback, useContext, useMemo } from 'react'
import toast, { Toaster } from 'react-hot-toast'

const ToastContext = createContext({ toast })

export function ToastProvider({ children }) {
  const success = useCallback((message) => toast.success(message), [])
  const error = useCallback((message) => toast.error(message), [])
  const info = useCallback((message) => toast(message), [])
  const promise = useCallback((p, messages) => toast.promise(p, messages), [])

  const value = useMemo(
    () => ({ toast, success, error, info, promise }),
    [success, error, info, promise]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            borderRadius: '10px',
            background: 'var(--toast-bg, #1e293b)',
            color: '#f8fafc',
            fontSize: '0.875rem',
          },
          success: { iconTheme: { primary: '#10b981', secondary: '#fff' } },
          error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
        }}
      />
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
