/**
 * Theme-aware tooltip styling for recharts charts.
 *
 * recharts renders each tooltip row with its own default `color: #333`, so the
 * wrapper color alone is not enough — contentStyle, itemStyle and labelStyle
 * must all carry the theme colors to stay readable in light and dark themes.
 */
export function getTooltipThemeStyle(theme) {
  const dark = theme === 'dark'
  return {
    contentStyle: {
      background: dark ? '#0f172a' : '#ffffff',
      border: dark ? '1px solid #334155' : '1px solid #e2e8f0',
      borderRadius: 10,
      color: dark ? '#f1f5f9' : '#0f172a',
      boxShadow: dark ? '0 4px 14px rgba(0, 0, 0, 0.45)' : '0 4px 14px rgba(15, 23, 42, 0.12)',
      fontSize: 13,
    },
    itemStyle: { color: dark ? '#f1f5f9' : '#0f172a' },
    labelStyle: { color: dark ? '#f1f5f9' : '#0f172a' },
  }
}
