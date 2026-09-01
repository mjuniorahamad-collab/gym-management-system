import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTheme } from '@/hooks/useTheme'
import { getTooltipThemeStyle } from './tooltipTheme'

/**
 * Simple weight-progress line chart.
 *
 * `data` is an array of { label, weight } rows in chronological order (label
 * is a short date marker, weight in kg). Dates on the X axis, weight on the
 * Y axis. Reuses the app-wide recharts theme helper so it reads correctly in
 * both light and dark themes, and ResponsiveContainer keeps it fluid on
 * desktop and mobile.
 */
export function WeightProgressChart({ data }) {
  const { theme } = useTheme()
  const tooltipStyle = getTooltipThemeStyle(theme)

  if (!data || data.length === 0) return null

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: '#94a3b8' }}
          axisLine={false}
          tickLine={false}
          width={34}
          domain={['dataMin - 1', 'dataMax + 1']}
          unit=" kg"
        />
        <Tooltip {...tooltipStyle} />
        <Line type="monotone" dataKey="weight" name="Weight" stroke="#4f46e5" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}
