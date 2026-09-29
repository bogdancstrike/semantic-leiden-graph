/**
 * The AntD theme and the CSS custom properties, both derived from `tokens.ts`.
 * Nothing here invents a value, so re-theming is one edit, not a hunt for hex codes.
 */

import { theme, type ThemeConfig } from 'antd'
import {
  ACCENT,
  DENSITY,
  FONT,
  INK,
  NEUTRAL,
  PAPER,
  RADIUS,
  SEMANTIC,
  SEMANTIC_INK,
  SHADOW,
  SHADOW_DARK,
  type Density,
} from './tokens'

export type Appearance = 'light' | 'dark' | 'system'

export function resolveAppearance(appearance: Appearance): 'light' | 'dark' {
  if (appearance !== 'system') return appearance
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function buildTheme(mode: 'light' | 'dark', density: Density): ThemeConfig {
  const scale = DENSITY[density]
  const dark = mode === 'dark'

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    cssVar: { key: 'sl' },
    token: {
      colorPrimary: dark ? ACCENT[400] : ACCENT[500],
      colorLink: dark ? ACCENT[300] : ACCENT[500],
      colorLinkHover: dark ? ACCENT[200] : ACCENT[600],
      colorLinkActive: dark ? ACCENT[400] : ACCENT[700],
      colorInfo: SEMANTIC.info,
      colorSuccess: SEMANTIC.success,
      colorWarning: SEMANTIC.warning,
      colorError: SEMANTIC.danger,

      colorBgLayout: dark ? INK[900] : NEUTRAL[100],
      colorBgContainer: dark ? INK[800] : PAPER,
      colorBgElevated: dark ? INK[750] : PAPER,
      colorBorder: dark ? INK[600] : NEUTRAL[200],
      colorBorderSecondary: dark ? INK[650] : NEUTRAL[100],
      colorText: dark ? INK[100] : NEUTRAL[900],
      colorTextSecondary: dark ? INK[300] : NEUTRAL[600],
      colorTextTertiary: dark ? INK[400] : NEUTRAL[500],
      // Named rather than derived: AntD's derivations land just under 4.5:1 for
      // secondary text and far under it (1.83:1) for placeholders.
      colorTextDescription: dark ? INK[300] : NEUTRAL[600],
      colorTextPlaceholder: dark ? INK[400] : NEUTRAL[500],
      colorSuccessText: SEMANTIC_INK[mode].success,
      colorWarningText: SEMANTIC_INK[mode].warning,
      colorErrorText: SEMANTIC_INK[mode].danger,
      colorInfoText: SEMANTIC_INK[mode].info,

      fontFamily: FONT.family,
      fontFamilyCode: FONT.mono,
      fontSize: scale.fontSize,
      borderRadius: RADIUS.control,
      borderRadiusLG: RADIUS.card,
      borderRadiusSM: RADIUS.control,
      controlHeight: scale.controlHeight,
      boxShadow: dark ? SHADOW_DARK.md : SHADOW.md,
      boxShadowSecondary: dark ? SHADOW_DARK.lg : SHADOW.lg,
      lineHeight: 1.5,
      wireframe: false,
    },
    components: {
      Layout: {
        headerBg: dark ? INK[850] : PAPER,
        headerHeight: 56,
        headerPadding: '0 16px',
        siderBg: NEUTRAL[900],
        bodyBg: dark ? INK[900] : NEUTRAL[100],
      },
      Menu: {
        itemHeight: scale.controlHeight + 4,
        itemMarginInline: 8,
        itemBorderRadius: RADIUS.control,
        subMenuItemBg: 'transparent',
        darkItemBg: 'transparent',
        darkItemSelectedBg: ACCENT[500],
      },
      Table: {
        cellPaddingBlock: (scale.rowHeight - scale.fontSize * 1.5) / 2,
        cellPaddingInline: scale.padding,
        headerBg: dark ? INK[750] : NEUTRAL[50],
        headerSplitColor: 'transparent',
        rowHoverBg: dark ? INK[700] : ACCENT[50],
        borderColor: dark ? INK[650] : NEUTRAL[200],
      },
      // White on the derived indigo is 4.45:1; the token one step darker is 5.37:1.
      Button: { colorPrimary: ACCENT[500], colorError: SEMANTIC.danger, primaryShadow: 'none', defaultShadow: 'none' },
      Card: { paddingLG: scale.padding + 4 },
      Descriptions: { itemPaddingBottom: scale.padding },
      Tabs: {
        horizontalMargin: '0 0 12px 0',
        itemSelectedColor: dark ? ACCENT[300] : ACCENT[500],
        itemHoverColor: dark ? ACCENT[200] : ACCENT[600],
        inkBarColor: dark ? ACCENT[300] : ACCENT[500],
      },
      Tooltip: { colorBgSpotlight: dark ? INK[700] : NEUTRAL[800] },
      // The selected item of a dropdown takes the primary as its ink; derived in dark
      // mode it measured 2.69:1 on its own tint. Named, it is 6.3:1.
      Dropdown: dark ? { colorPrimary: ACCENT[200] } : {},
      Select: dark ? { optionSelectedColor: INK[100] } : {},
      Modal: { borderRadiusLG: RADIUS.modal },
      Drawer: { paddingLG: 16 },
    },
  }
}

/** Everything styled outside an AntD component reads these, so it cannot drift. */
export function cssVariables(mode: 'light' | 'dark', density: Density): Record<string, string> {
  const scale = DENSITY[density]
  const dark = mode === 'dark'

  return {
    '--nu-accent': dark ? ACCENT[400] : ACCENT[500],
    '--nu-accent-ink': dark ? ACCENT[300] : ACCENT[700],
    '--nu-accent-soft': dark ? 'rgba(124, 124, 245, 0.16)' : ACCENT[50],
    '--nu-bg': dark ? INK[900] : NEUTRAL[100],
    '--nu-surface': dark ? INK[800] : PAPER,
    '--nu-surface-raised': dark ? INK[750] : PAPER,
    '--nu-border': dark ? INK[650] : NEUTRAL[200],
    '--nu-border-subtle': dark ? INK[700] : NEUTRAL[100],
    '--nu-border-strong': dark ? INK[600] : NEUTRAL[300],
    '--nu-hover': dark ? INK[700] : NEUTRAL[100],
    '--nu-text': dark ? INK[100] : NEUTRAL[900],
    '--nu-text-secondary': dark ? INK[300] : NEUTRAL[600],
    '--nu-text-tertiary': dark ? INK[400] : NEUTRAL[500],
    '--nu-success': SEMANTIC.success,
    '--nu-warning': SEMANTIC.warning,
    '--nu-danger': SEMANTIC.danger,
    '--nu-info': SEMANTIC.info,
    '--nu-success-ink': SEMANTIC_INK[mode].success,
    // The tint of what is kept (import preview columns); text on it keeps its contrast.
    '--nu-success-soft': dark ? 'rgba(74, 222, 128, 0.12)' : 'rgba(22, 163, 74, 0.10)',
    '--nu-warning-ink': SEMANTIC_INK[mode].warning,
    '--nu-danger-ink': SEMANTIC_INK[mode].danger,
    '--nu-info-ink': SEMANTIC_INK[mode].info,
    '--nu-row-height': `${scale.rowHeight}px`,
    '--nu-control-height': `${scale.controlHeight}px`,
    '--nu-font-size': `${scale.fontSize}px`,
    '--nu-padding': `${scale.padding}px`,
    '--nu-font': FONT.family,
    '--nu-font-mono': FONT.mono,
    '--nu-radius-control': `${RADIUS.control}px`,
    '--nu-radius-card': `${RADIUS.card}px`,
    '--nu-shadow-sm': dark ? SHADOW_DARK.sm : SHADOW.sm,
    '--nu-shadow-md': dark ? SHADOW_DARK.md : SHADOW.md,
    '--nu-shadow-lg': dark ? SHADOW_DARK.lg : SHADOW.lg,
    // The graph canvas paints these directly.
    '--nu-canvas': dark ? INK[950] : NEUTRAL[50],
    '--nu-canvas-grid': dark ? 'rgba(154, 162, 177, 0.06)' : 'rgba(71, 85, 105, 0.07)',
  }
}
