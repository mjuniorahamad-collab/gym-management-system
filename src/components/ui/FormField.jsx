export function FormField({ label, error, hint, required, children, className }) {
  return (
    <div className={className}>
      {/*
        The control is wrapped BY the label rather than referenced via htmlFor.
        Children are not always a bare control - Login.jsx wraps its Input in a
        positioned <div> for an icon - so a cloned id would land on the wrapper
        and break association. Implicit association names the first labelable
        descendant in either shape, and makes the label click-to-focus.

        hint/error stay OUTSIDE the label so they never become part of the
        control's accessible name.
      */}
      {label ? (
        <label className="block">
          <span className="label">
            {label}
            {required && <span className="ml-0.5 text-red-500">*</span>}
          </span>
          {children}
        </label>
      ) : (
        children
      )}
      {hint && !error && <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}