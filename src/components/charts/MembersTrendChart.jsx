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
import { ChartFrame } from './ChartFrame'

export function MembersTrendChart({ data }) {
  const { theme } = useTheme()
  const tooltipStyle = getTooltipThemeStyle(theme)

  return (
    <ChartFrame
      title="New members per month, last 6 months"
      description="Count of members whose join date falls in each of the last six months."
      columns={['Month', 'New members']}
      rows={data.map((d) => ({ Month: d.label, 'New members': d.newMembers }))}
    >
      <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} width={30} />
        <Tooltip {...tooltipStyle} />
        <Line type="monotone" dataKey="newMembers" name="New members" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
