import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'Something went wrong' }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6 dark:bg-slate-950">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card dark:border-slate-800 dark:bg-slate-900">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400">
              <AlertTriangle size={24} />
            </div>
            <h1 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
              Something went wrong
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{this.state.message}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false, message: null })
                window.location.reload()
              }}
              className="btn-primary mt-5"
            >
              <RefreshCw size={16} /> Reload page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
