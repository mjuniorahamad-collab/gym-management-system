export function PageHeader({ title, subtitle, actions, className }) {
  return (
    <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-5 ${className || ''}`}>
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100 sm:text-xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 sm:text-sm">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto [&>button]:flex-1 sm:[&>button]:flex-none">
          {actions}
        </div>
      )}
    </div>
  )
}
