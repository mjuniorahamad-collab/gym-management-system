import { forwardRef } from 'react'
import clsx from 'clsx'

export const Select = forwardRef(function Select({ className, children, error, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={clsx('input cursor-pointer', error && 'input-error', className)}
      {...props}
    >
      {children}
    </select>
  )
})
