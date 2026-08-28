import { Loader2 } from 'lucide-react'

export function Spinner({ label = 'Loading…', className }) {
  return (
    <div className={className || 'flex w-full items-center justify-center gap-2 py-12 text-slate-500 dark:text-slate-400'}>
      <Loader2 size={20} className="animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function InlineSpinner() {
  return <Loader2 size={18} className="animate-spin" />
}
