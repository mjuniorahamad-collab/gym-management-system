import { useEffect, useState } from 'react'
import { useSettings } from '@/context/SettingsContext'
import { gymDayBoundsUtc, gymDayKey } from '@/utils/gymTime'

/**
 * Returns today's calendar day **in the gym's timezone** as `YYYY-MM-DD`,
 * re-rendering when that day rolls over.
 *
 * Two things this fixes. It used to return `new Date().toDateString()`, so the
 * gym's day was whichever day the viewing device happened to be on — a phone on
 * a roaming connection saw a different "today" from the front desk, and every
 * attendance record it wrote was bucketed against the wrong day. And a page that
 * derives "today" during render keeps the old value until something unrelated
 * forces a re-render, so a tab left open overnight keeps reporting — and
 * stamping — the previous day.
 *
 * The timer is armed for the first millisecond after gym-local midnight and
 * re-armed after every tick, so it stays correct across DST transitions and
 * laptop sleep. The 1s floor matters: if the machine wakes late or the clock
 * jumps backwards, we re-check shortly rather than trusting a stale day for
 * another 24 hours.
 */
export function useToday() {
  const { timezone } = useSettings()
  const [today, setToday] = useState(() => gymDayKey(new Date(), timezone))

  useEffect(() => {
    let timer = null

    const arm = () => {
      const current = gymDayKey(new Date(), timezone)
      if (current !== today) {
        setToday(current)
      }
      // Inclusive `end` is the last millisecond of the current gym-local day.
      const { end } = gymDayBoundsUtc(current, timezone)
      const untilNextMidnight = new Date(end).getTime() + 1 - Date.now()
      timer = setTimeout(arm, Math.max(untilNextMidnight, 1000))
    }

    arm()
    return () => clearTimeout(timer)
    // `today` is intentionally omitted: re-arming is driven by the timer, and
    // depending on it would tear down and rebuild the timer on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone])

  return today
}