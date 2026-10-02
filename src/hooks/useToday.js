import { useEffect, useState } from 'react'

/**
 * Returns today's local date string, re-rendering when the calendar day rolls
 * over.
 *
 * A page that derives "today" during render keeps yesterday's value until
 * something unrelated forces a re-render, so an attendance or dashboard tab
 * left open overnight keeps reporting - and stamping - the previous day.
 *
 * The timer is scheduled for the first moment of the next local midnight and
 * re-armed after every tick, which keeps it correct across DST shifts and
 * laptop sleep.
 */
export function useToday() {
  const [today, setToday] = useState(() => new Date().toDateString())

  useEffect(() => {
    let timer = null

    const schedule = () => {
      const now = new Date()
      const nextMidnight = new Date(now)
      nextMidnight.setHours(24, 0, 0, 0)
      timer = setTimeout(() => {
        setToday(new Date().toDateString())
        schedule()
      }, Math.max(nextMidnight - now, 1000))
    }

    schedule()
    return () => clearTimeout(timer)
  }, [])

  return today
}