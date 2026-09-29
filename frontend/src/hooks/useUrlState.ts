import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * URL-as-state: a page's question lives in its address, so any view can be
 * bookmarked or shared and Back/Forward work.
 *
 * `set` is built from the *current* parameters rather than the ones this render
 * captured: two handlers firing in one tick would otherwise have the second
 * write back the state the first had just replaced.
 */
export function useUrlState() {
  const [params, setParams] = useSearchParams()
  const set = useCallback(
    (changes: Record<string, string | number | null | undefined>, options: { push?: boolean } = {}) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === undefined || value === '') next.delete(key)
            else next.set(key, String(value))
          }
          return next
        },
        { replace: !options.push },
      )
    },
    [setParams],
  )
  return [params, set] as const
}

export function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
}

export function parseIds(raw: string | null): number[] {
  // `Number('')` is 0, so empty segments must go before the conversion.
  return (raw ?? '')
    .split(',')
    .filter((v) => v.trim() !== '')
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v))
}

/**
 * A similarity band `[min, max]` from `?min=` and `?max=`: each clamped to 0..1, missing or
 * invalid values fall back to the full band, and crossed bounds are read as the band
 * between them (the API rejects max < min).
 */
export function similarityBand(rawMin: string | null, rawMax: string | null): [number, number] {
  const read = (raw: string | null, fallback: number) => {
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw)
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
  }
  const low = read(rawMin, 0)
  const high = read(rawMax, 1)
  return low <= high ? [low, high] : [high, low]
}
