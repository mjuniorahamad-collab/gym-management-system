import { Link } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-6 text-center dark:bg-slate-950">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <SearchX size={30} />
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">404 — Page not found</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          The page you are looking for does not exist or has moved.
        </p>
      </div>
      <Link to="/">
        <Button>Back to dashboard</Button>
      </Link>
    </div>
  )
}
