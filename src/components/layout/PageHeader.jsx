export function PageHeader({ title, subtitle, actions, className }) {
  return (
    <div className={`mb-5 flex flex-wrap items-center justify-between gap-3 ${className || ''}`}>
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
