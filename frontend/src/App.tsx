import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from '@/app/AppShell'
import { lazyPage } from '@/lib/lazyPage'
import { EmptyState } from '@/components/EmptyState'
import { Button } from 'antd'

// Route-level code splitting: the graph (d3), import (papaparse), charts (echarts)
// and the query builder are only downloaded by the pages that use them.
// `lazyPage` reloads once when a deploy has replaced the chunks this tab expects.
const OverviewPage = lazyPage(() => import('@/pages/OverviewPage'))
const ExplorePage = lazyPage(() => import('@/pages/ExplorePage'))
const GraphPage = lazyPage(() => import('@/pages/GraphPage'))
const CommunitiesPage = lazyPage(() => import('@/pages/CommunitiesPage'))
const ImportPage = lazyPage(() => import('@/pages/ImportPage'))
const OperationsPage = lazyPage(() => import('@/pages/OperationsPage'))

/**
 * v0.3 kept the view in `?tab=`; those links are rewritten to the path-based
 * routes so bookmarks and shared URLs keep working.
 */
const LEGACY_TABS: Record<string, string> = {
  search: '/documents',
  documents: '/documents',
  graph: '/graph',
  communities: '/communities',
  import: '/import',
  operations: '/operations',
}

function Home() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const tab = params.get('tab')
  if (tab && LEGACY_TABS[tab]) {
    params.delete('tab')
    if (tab === 'search' && params.get('q') && !params.get('mode')) params.set('mode', 'hybrid')
    if (tab === 'graph' && params.get('focus')) params.set('view', 'focus')
    const rest = params.toString()
    return <Navigate to={`${LEGACY_TABS[tab]}${rest ? `?${rest}` : ''}`} replace />
  }
  return <OverviewPage />
}

function NotFound() {
  const navigate = useNavigate()
  return (
    <EmptyState
      title="There is no page at this address"
      hint="It may have moved in the v0.4 navigation."
      action={
        <Button type="primary" onClick={() => navigate('/')}>
          Go to the dashboard
        </Button>
      }
    />
  )
}

export default function App() {
  // Warm the most likely next chunks after first paint.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
    idle(() => {
      // A warm-up only: a failure here is handled when the page is really opened.
      import('@/pages/ExplorePage').catch(() => undefined)
      import('@/pages/GraphPage').catch(() => undefined)
    })
  }, [])

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="documents" element={<ExplorePage />} />
        <Route path="explore" element={<Navigate to="/documents" replace />} />
        <Route path="search" element={<Navigate to="/documents" replace />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="communities" element={<CommunitiesPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
