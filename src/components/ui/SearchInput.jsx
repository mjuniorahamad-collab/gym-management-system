import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  debounce = 300,
  className,
}) {
  const [local, setLocal] = useState(value || '')
  const timer = useRef(null)

  useEffect(() => setLocal(value || ''), [value])

  const handleChange = (e) => {
    const next = e.target.value
    setLocal(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange?.(next), debounce)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <div className={`relative ${className || ''}`}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        value={local}
        onChange={handleChange}
        placeholder={placeholder}
        className="input pl-9"
      />
    </div>
  )
}
