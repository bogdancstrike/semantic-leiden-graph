/**
 * The ECharts theme, from the same tokens as everything else: a chart themed
 * independently has grid lines a slightly different grey from the table beside it.
 */

import { DENSITY, FONT, INK, NEUTRAL, PAPER, SERIES, type Density } from './tokens'

export function buildChartTheme(mode: 'light' | 'dark', density: Density) {
  const dark = mode === 'dark'
  const text = dark ? INK[300] : NEUTRAL[600]
  const axis = dark ? INK[650] : NEUTRAL[200]
  const scale = DENSITY[density]

  return {
    color: [...SERIES],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT.family, fontSize: scale.fontSize - 1, color: text },
    grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    axis,
    text,
    strong: dark ? INK[100] : NEUTRAL[900],
    surface: dark ? INK[800] : PAPER,
    tooltip: {
      backgroundColor: dark ? INK[750] : PAPER,
      borderColor: axis,
      borderWidth: 1,
      textStyle: { color: dark ? INK[100] : NEUTRAL[900], fontSize: scale.fontSize },
    },
  }
}

export type ChartTheme = ReturnType<typeof buildChartTheme>
