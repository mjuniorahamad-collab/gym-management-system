import clsx from 'clsx'

const TONES = {
  indigo: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400',
  emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  sky: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400',
  rose: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
  violet: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400',
}

export function StatCard({ title, value, icon: Icon, tone = 'indigo', sub, loading }) {
  return (
    // Two of these fit side by side on a phone, so the four headline numbers are
    // visible without scrolling instead of four full-width cards.
    <div className="card p-3.5 sm:p-5">
      <div className="flex items-start justify-between gap-2 sm:items-center">
        <div className="min-w-0">
          <p className="line-clamp-2 text-[11px] font-medium leading-snug text-slate-500 dark:text-slate-400 sm:line-clamp-1 sm:text-sm">
            {title}
          </p>
          {loading ? (
            <div className="mt-2 h-6 w-16 animate-pulse rounded bg-slate-200 dark:bg-slate-800 sm:h-7 sm:w-24" />
          ) : (
            <p className="mt-1 truncate text-lg font-bold text-slate-900 dark:text-slate-100 sm:text-2xl">
              {value}
            </p>
          )}
          {sub && <p className="mt-1 truncate text-[10px] text-slate-400 sm:text-xs">{sub}</p>}
        </div>
        {Icon && (
          <div
            className={clsx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-11 sm:w-11 sm:rounded-xl',
              TONES[tone]
            )}
          >
            <Icon size={16} className="sm:hidden" />
            <Icon size={20} className="hidden sm:block" />
          </div>
        )}
      </div>
    </div>
  )
}
