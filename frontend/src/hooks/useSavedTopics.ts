import { useSyncExternalStore } from 'react'

const KEY = 'semantic-leiden.topics.saved'
const EVENT = 'semantic-leiden.topics.saved.changed'
const snapshot = () => { try { return localStorage.getItem(KEY) ?? '[]' } catch { return '[]' } }
const subscribe = (listener: () => void) => {
  window.addEventListener('storage', listener)
  window.addEventListener(EVENT, listener)
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(EVENT, listener) }
}

export function useSavedTopics() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => '[]')
  let ids: string[] = []
  try { const parsed: unknown = JSON.parse(raw); if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string') } catch { /* invalid local preference */ }
  return { ids, has: (id: string) => ids.includes(id), toggle: (id: string) => {
    const next = ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id].slice(-100)
    try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event(EVENT)) } catch { /* storage is unavailable */ }
  } }
}
