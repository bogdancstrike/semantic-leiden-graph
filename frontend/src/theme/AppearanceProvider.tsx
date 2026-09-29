/**
 * Appearance (light / dark / system) and density, applied to AntD and to the
 * stylesheet at once — a density switch that only reached the table would leave
 * the toolbar above it at a different height.
 *
 * Stored in localStorage so a reload does not flash the wrong theme.
 */

import { ConfigProvider } from 'antd'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { STORAGE_KEYS } from '@/config'
import { buildTheme, cssVariables, resolveAppearance, type Appearance } from './antd'
import { buildChartTheme, type ChartTheme } from './echarts'
import { LAYOUT, type Density } from './tokens'

interface AppearanceContextValue {
  appearance: Appearance
  /** What `system` currently resolves to. */
  mode: 'light' | 'dark'
  density: Density
  setAppearance: (next: Appearance) => void
  setDensity: (next: Density) => void
  chartTheme: ChartTheme
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

function read<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const stored = window.localStorage.getItem(key)
    return stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // private mode: the choice just does not persist
  }
}

const HANDHELD = `(max-width: ${LAYOUT.breakpoints.mobile - 1}px)`

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(() =>
    read(STORAGE_KEYS.appearance, 'system', ['light', 'dark', 'system'] as const),
  )
  const [density, setDensityState] = useState<Density>(() =>
    read(STORAGE_KEYS.density, 'middle', ['compact', 'middle', 'comfortable'] as const),
  )
  const [systemMode, setSystemMode] = useState<'light' | 'dark'>(() => resolveAppearance('system'))
  const [handheld, setHandheld] = useState(() => !!window.matchMedia?.(HANDHELD).matches)

  // Keep following the OS while the setting is `system`.
  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent) => setSystemMode(event.matches ? 'dark' : 'light')
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia(HANDHELD)
    const listener = (event: MediaQueryListEvent) => setHandheld(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  const mode = appearance === 'system' ? systemMode : appearance
  // Compact is a mouse setting: 28px controls miss the 24px touch minimum on a phone.
  const rendered: Density = handheld && density === 'compact' ? 'middle' : density

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next)
    write(STORAGE_KEYS.appearance, next)
  }, [])

  const setDensity = useCallback((next: Density) => {
    setDensityState(next)
    write(STORAGE_KEYS.density, next)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    for (const [name, value] of Object.entries(cssVariables(mode, rendered))) root.style.setProperty(name, value)
    root.dataset.theme = mode
    root.dataset.density = rendered
    root.style.colorScheme = mode
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#0e0f14' : '#ffffff')
  }, [rendered, mode])

  const theme = useMemo(() => buildTheme(mode, rendered), [mode, rendered])
  const chartTheme = useMemo(() => buildChartTheme(mode, rendered), [mode, rendered])
  const value = useMemo(
    () => ({ appearance, mode, density, setAppearance, setDensity, chartTheme }),
    [appearance, mode, density, setAppearance, setDensity, chartTheme],
  )

  return (
    <AppearanceContext.Provider value={value}>
      <ConfigProvider theme={theme} componentSize={rendered === 'compact' ? 'small' : 'middle'}>
        {children}
      </ConfigProvider>
    </AppearanceContext.Provider>
  )
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext)
  if (!value) throw new Error('useAppearance must be used inside <AppearanceProvider>')
  return value
}
