import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * `useState` whose initial value is what this reader last chose. A preference,
 * not a source of truth: a browser that refuses storage gets the fallback and a
 * page that works. Anything an address should describe belongs in the URL.
 */
export function useSticky<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readSticky(key, fallback))
  const loaded = useRef(key)
  useEffect(() => {
    if (loaded.current === key) return
    loaded.current = key
    setValue(readSticky(key, fallback))
    // `fallback` is passed inline by callers; depending on it would re-read every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? (next as (c: T) => T)(current) : next
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          // quota or privacy mode: keep in memory only
        }
        return resolved
      })
    },
    [key],
  )
  return [value, set]
}

function readSticky<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
