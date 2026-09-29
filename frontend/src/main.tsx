import '@fontsource-variable/inter'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { reloadForNewBuild } from '@/lib/lazyPage'
import { AppearanceProvider } from '@/theme/AppearanceProvider'
import App from './App'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      // Don't hammer the API with retries for client errors (4xx) -- they won't fix themselves.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
})

// Vite reports a failed preload of a code-split chunk (JS or CSS) here; after a deploy
// that means this tab runs the previous build. Reload once (guarded in lazyPage.ts).
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppearanceProvider>
        <AntApp notification={{ maxCount: 3, placement: 'bottomRight' }}>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <App />
          </BrowserRouter>
        </AntApp>
      </AppearanceProvider>
    </QueryClientProvider>
  </StrictMode>,
)
