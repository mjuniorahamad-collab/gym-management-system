import { describe, expect, it } from 'vitest'
import { getTooltipThemeStyle } from '@/components/charts/tooltipTheme'

describe('getTooltipThemeStyle', () => {
  it('returns theme-aware styles for light and dark themes', () => {
    const light = getTooltipThemeStyle('light')
    const dark = getTooltipThemeStyle('dark')

    expect(light.contentStyle.background).toBe('#ffffff')
    expect(dark.contentStyle.background).toBe('#0f172a')
    expect(light.contentStyle).not.toEqual(dark.contentStyle)
  })

  it('uses dark text on a light background in light theme', () => {
    const style = getTooltipThemeStyle('light')
    expect(style.contentStyle.color).toBe('#0f172a')
    expect(style.itemStyle.color).toBe('#0f172a')
    expect(style.labelStyle.color).toBe('#0f172a')
  })

  it('uses light text on a dark background in dark theme', () => {
    const style = getTooltipThemeStyle('dark')
    expect(style.contentStyle.color).toBe('#f1f5f9')
    expect(style.itemStyle.color).toBe('#f1f5f9')
    expect(style.labelStyle.color).toBe('#f1f5f9')
  })

  it('always sets content, item and label styles (recharts item default would be unreadable otherwise)', () => {
    for (const theme of ['light', 'dark']) {
      const style = getTooltipThemeStyle(theme)
      expect(style.contentStyle).toBeDefined()
      expect(style.itemStyle).toBeDefined()
      expect(style.labelStyle).toBeDefined()
    }
  })
})
