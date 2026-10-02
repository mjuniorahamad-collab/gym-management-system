import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { formatCurrency } from '@/utils/formatters'
import { useTheme } from '@/hooks/useTheme'
import { getTooltipThemeStyle } from './tooltipTheme'
import { ChartFrame } from './ChartFrame'

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

export function CategoryPie({ data }) {
  const { theme } = useTheme()
  const tooltipStyle = getTooltipThemeStyle(theme)

  return (
    <ChartFrame
      title="Expenses by category, last 6 months"
      description="Total spend per expense category over the last six months."
      columns={['Category', 'Amount']}
      rows={data.map((d) => ({ Category: d.name, Amount: d.value }))}
    >
      <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={55}
          outerRadius={90}
          paddingAngle={2}
        >
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(value, name) => [formatCurrency(value), name]} {...tooltipStyle} />
      </PieChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
