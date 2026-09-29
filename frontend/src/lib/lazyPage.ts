import { lazy, type ComponentType } from 'react'

/**
 * Code-split chunks after a deploy.
 *
 * Every build renames its chunks (content hashes) and the new container no longer
 * serves the old ones. A tab opened before the deploy still runs the old entry file,
 * so the next lazy page it opens asks for a chunk that is gone: "Failed to fetch
 * dynamically imported module". React.lazy caches that rejection, so no retry inside
 * the page can help — only loading the new entry file (`index.html` is served
 * `no-cache`) does. The page is therefore reloaded once; a second failure within
 * `RELOAD_GUARD_MS` is a real outage and reaches the error boundary instead of looping.
 */

const RELOAD_KEY = 'semantic-leiden.chunk-reload-at'
const RELOAD_GUARD_MS = 30_000

/** Chrome, Firefox and Safari word the failure differently; Vite's preload helper too. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i.test(
    message,
  )
}

/** Reload once to pick up the new build; false when a reload just happened (or storage is off). */
export function reloadForNewBuild(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (now - last < RELOAD_GUARD_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    return false // without storage there is no loop guard; let the error boundary explain
  }
  window.location.reload()
  return true
}

/** `React.lazy` that recovers from a chunk removed by a deploy. */
export function lazyPage<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory().catch((error: unknown) => {
      // Never settles when reloading: the page is about to be replaced anyway.
      if (isChunkLoadError(error) && reloadForNewBuild()) return new Promise<{ default: T }>(() => undefined)
      throw error
    }),
  )
}
