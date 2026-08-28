import clsx from 'clsx'

export function Skeleton({ className }) {
  return (
    <div className={clsx('animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800', className)} />
  )
}

export function TableSkeleton({ rows = 5, cols = 5 }) {
  return (
    <div className="space-y-3 p-5">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}
