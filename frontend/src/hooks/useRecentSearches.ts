/**
 * The last few things this person searched for, per page. Kept in the browser:
 * a recent search is a convenience for one person at one desk.
 */

import { useCallback, useEffect, useState } from 'react'
import { STORAGE_KEYS } from '@/config'

export const MAX_RECENT = 10

export interface RecentSearches {
  terms: string[]
  remember: (term: string) => void
  forget: (term: string) => void
  clear: () => void
}

export function useRecentSearches(scope: string): RecentSearches {
  const key = `${STORAGE_KEYS.recentSearches}.${scope}`
  const [terms, setTerms] = useState<string[]>(() => read(key))
  useEffect(() => setTerms(read(key)), [key])

  const persist = useCallback(
    (next: string[]) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // private browsing: the app still works
      }
      return next
    },
    [key],
  )

  // A term joins the history when it is submitted, not as it is typed, or every
  // prefix of every search becomes a suggestion.
  const remember = useCallback(
    (term: string) => {
      const value = term.trim()
      if (value.length < 2) return
      setTerms((current) => persist([value, ...current.filter((item) => item !== value)].slice(0, MAX_RECENT)))
    },
    [persist],
  )
  const forget = useCallback((term: string) => setTerms((current) => persist(current.filter((t) => t !== term))), [persist])
  const clear = useCallback(() => setTerms(persist([])), [persist])

  return { terms, remember, forget, clear }
}

function read(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}
