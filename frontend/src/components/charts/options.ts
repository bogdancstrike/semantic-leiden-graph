/**
 * Option builders for the few chart shapes the app uses. The card is chrome;
 * these are data. Every builder takes the theme so grid lines, labels and the
 * tooltip match the table beside the chart in both appearances.
 */

import type { ChartTheme } from '@/theme/echarts'

type Formatter = (value: number) => string

/** Axis ticks in thousands read at a glance and never collide: 15k, not 15,000. */
export const compact: Formatter = (value) =>
  Math.abs(value) >= 1_000_000
    ? `${+(value / 1_000_000).toFixed(1)}M`
    : Math.abs(value) >= 1_000
      ? `${+(value / 1_000).toFixed(1)}k`
      : String(+value.toFixed(3))

const axisBase = (theme: ChartTheme) => ({
  axisLine: { lineStyle: { color: theme.axis } },
  axisTick: { show: false },
  axisLabel: { color: theme.text, fontSize: 11 },
  splitLine: { lineStyle: { color: theme.axis, type: 'dashed' as const } },
})

const base = (theme: ChartTheme) => ({
  backgroundColor: 'transparent',
  textStyle: theme.textStyle,
  color: theme.color,
  tooltip: { ...theme.tooltip, confine: true },
  grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
  aria: { enabled: true },
  animation: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
})

export function barOption(
  theme: ChartTheme,
  {
    categories,
    values,
    colors,
    horizontal = false,
    name = 'Count',
    format,
  }: { categories: string[]; values: number[]; colors?: string[]; horizontal?: boolean; name?: string; format?: Formatter },
) {
  const category = { type: 'category' as const, data: categories, ...axisBase(theme), splitLine: { show: false } }
  const value = { type: 'value' as const, ...axisBase(theme), axisLine: { show: false }, axisLabel: { ...axisBase(theme).axisLabel, formatter: format ?? compact } }
  return {
    ...base(theme),
    tooltip: { ...base(theme).tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: format },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? { ...category, inverse: true } : value,
    dataZoom: categories.length > 40 && !horizontal ? [{ type: 'inside', start: 0, end: Math.min(100, (40 / categories.length) * 100) }] : undefined,
    series: [
      {
        type: 'bar',
        name,
        data: values.map((v, i) => (colors ? { value: v, itemStyle: { color: colors[i] } } : v)),
        barMaxWidth: 28,
        itemStyle: { borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
      },
    ],
  }
}

export function lineBarOption(
  theme: ChartTheme,
  {
    categories,
    line,
    bars,
  }: { categories: string[]; line: { name: string; values: number[]; format?: Formatter }; bars?: { name: string; values: number[] } },
) {
  return {
    ...base(theme),
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    tooltip: { ...base(theme).tooltip, trigger: 'axis' },
    legend: { top: 0, textStyle: { color: theme.text }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    xAxis: { type: 'category', data: categories, ...axisBase(theme), splitLine: { show: false } },
    yAxis: [
      { type: 'value', name: '', ...axisBase(theme), axisLine: { show: false }, axisLabel: { ...axisBase(theme).axisLabel, formatter: line.format ?? compact } },
      ...(bars ? [{ type: 'value', ...axisBase(theme), axisLine: { show: false }, splitLine: { show: false }, axisLabel: { ...axisBase(theme).axisLabel, formatter: compact } }] : []),
    ],
    series: [
      ...(bars ? [{ type: 'bar', name: bars.name, data: bars.values, yAxisIndex: 1, barMaxWidth: 22, itemStyle: { opacity: 0.35, borderRadius: [3, 3, 0, 0] } }] : []),
      { type: 'line', name: line.name, data: line.values, symbolSize: 6, lineStyle: { width: 2 }, tooltip: { valueFormatter: line.format } },
    ],
  }
}

export function scatterOption(
  theme: ChartTheme,
  {
    points,
    xName,
    yName,
  }: { points: { name: string; x: number; y: number; size: number; color: string }[]; xName: string; yName: string },
) {
  const maxSize = Math.max(1, ...points.map((p) => p.size))
  return {
    ...base(theme),
    grid: { left: 8, right: 24, top: 28, bottom: 24, containLabel: true },
    tooltip: {
      ...base(theme).tooltip,
      trigger: 'item',
      formatter: (p: { data: { name: string; value: number[] } }) =>
        `<b>${p.data.name}</b><br/>${xName}: ${p.data.value[0].toFixed(3)}<br/>${yName}: ${p.data.value[1].toFixed(3)}<br/>Size: ${p.data.value[2]}`,
    },
    xAxis: { type: 'value', name: xName, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: theme.text }, scale: true, ...axisBase(theme) },
    // Left-aligned from the axis, so the name is not cut off by the card's edge.
    yAxis: { type: 'value', name: yName, nameTextStyle: { color: theme.text, align: 'left' }, scale: true, ...axisBase(theme) },
    series: [
      {
        type: 'scatter',
        data: points.map((p) => ({
          name: p.name,
          value: [p.x, p.y, p.size],
          symbolSize: 6 + Math.sqrt(p.size / maxSize) * 26,
          itemStyle: { color: p.color, opacity: 0.8, borderColor: theme.surface, borderWidth: 1 },
        })),
      },
    ],
  }
}

export function pieOption(theme: ChartTheme, { slices }: { slices: { name: string; value: number; color?: string }[] }) {
  return {
    ...base(theme),
    tooltip: { ...base(theme).tooltip, trigger: 'item' },
    legend: { type: 'scroll', bottom: 0, textStyle: { color: theme.text }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    series: [
      {
        type: 'pie',
        radius: ['45%', '72%'],
        center: ['50%', '45%'],
        itemStyle: { borderColor: theme.surface, borderWidth: 2 },
        // Names live in the legend; a name on every slice is cut off beside a thin one.
        label: { color: theme.text, formatter: '{d}%' },
        minShowLabelAngle: 4,
        data: slices.map((s) => ({ name: s.name, value: s.value, ...(s.color ? { itemStyle: { color: s.color } } : {}) })),
      },
    ],
  }
}
