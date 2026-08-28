import { forwardRef } from 'react'
import clsx from 'clsx'

export const Input = forwardRef(function Input({ className, error, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={clsx('input', error && 'input-error', className)}
      {...props}
    />
  )
})
