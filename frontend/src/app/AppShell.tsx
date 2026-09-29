import { Suspense, useEffect, useMemo, useState } from 'react'
import { Badge, Breadcrumb, Button, Dropdown, Grid, Layout, Menu, Progress, Skeleton, Space, Tooltip } from 'antd'
import {
  DesktopOutlined,
  DownOutlined,
  ExportOutlined,
  KeyOutlined,
  MenuOutlined,
  MoonOutlined,
  SettingOutlined,
  SunOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useActiveJob, useReady, useStats } from '@/api/hooks'
import { ApiKeyDialog, useApiKeyNeeded } from '@/components/ApiKeyButton'
import { DocumentDrawerProvider } from '@/components/DocumentDrawer'
import { JOB_LABELS, jobPercent } from '@/components/JobProgress'
import { CONSOLES, STORAGE_KEYS } from '@/config'
import { fmtInt } from '@/lib/format'
import { useAppearance } from '@/theme/AppearanceProvider'
import { LOGO } from '@/theme/tokens'
import { ErrorBoundary } from './ErrorBoundary'
import { NAV_GROUPS, NAV_ITEMS, selectedKeyFor, trailFor } from './navigation'

const { Header, Sider, Content } = Layout

function Logo() {
  return (
    <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden>
      <g transform="translate(32 32)">
        <ellipse rx="26" ry="11" fill="none" stroke={LOGO.ring} strokeWidth="4" transform="rotate(-28)" />
        <ellipse rx="26" ry="11" fill="none" stroke={LOGO.ring} strokeWidth="4" opacity="0.5" transform="rotate(52)" />
        <circle r="11" fill={LOGO.core} />
        <circle cx="23" cy="-12.2" r="4" fill={LOGO.spark} />
      </g>
    </svg>
  )
}

function Readiness() {
  const { data, isError } = useReady()
  const checks: Record<string, boolean> = data?.checks ?? {}
  const ok = !!data?.ok && !isError
  const title = isError
    ? 'API unreachable'
    : Object.entries(checks)
        .map(([name, up]) => `${name}: ${up ? 'up' : 'down'}`)
        .join(', ') || 'Checking the stores'
  return (
    <Tooltip title={title}>
      <Badge
        status={data || isError ? (ok ? 'success' : 'error') : 'processing'}
        text={<span className="hide-mobile">{ok ? 'Ready' : data || isError ? 'Degraded' : 'Checking'}</span>}
      />
    </Tooltip>
  )
}

/** A running job, visible from every page and one click from where it is detailed. */
function JobPill() {
  const job = useActiveJob()
  const navigate = useNavigate()
  if (!job) return null
  const percent = jobPercent(job)
  const target = job.kind === 'import' ? '/import' : '/operations'
  return (
    <Tooltip title={`${JOB_LABELS[job.kind]}: ${job.status === 'queued' ? 'queued' : job.phase}. Open for details.`}>
      <button type="button" className="nu-jobpill" onClick={() => navigate(target)} aria-label={`${JOB_LABELS[job.kind]} running, ${percent}%`}>
        <span className="nu-jobpill-label">{JOB_LABELS[job.kind]}</span>
        <Progress percent={percent} size="small" showInfo={false} status="active" aria-label={`${JOB_LABELS[job.kind]} progress`} />
        <span>{percent}%</span>
      </button>
    </Tooltip>
  )
}

function SiderFoot() {
  const { data } = useStats()
  if (!data) return null
  return (
    <div className="nu-sider-foot" aria-label="Corpus at a glance">
      <div className="nu-sider-foot-row">
        <span>Documents</span>
        <strong>{fmtInt(data.documents)}</strong>
      </div>
      <div className="nu-sider-foot-row">
        <span>Communities</span>
        <strong>{fmtInt(data.communities)}</strong>
      </div>
      <div className="nu-sider-foot-row">
        <span>Similarity edges</span>
        <strong>{fmtInt(data.edges)}</strong>
      </div>
    </div>
  )
}

/** Stores that disagree are worth saying on every page, with the way to repair them. */
function ConsistencyBand() {
  const { data } = useStats()
  const navigate = useNavigate()
  if (!data || data.consistent || data.jobs_active) return null
  return (
    <div className="nu-band" role="status">
      <WarningOutlined />
      <span>
        Stores disagree on the document count — Elasticsearch {fmtInt(data.stores.elasticsearch.documents)}, Qdrant{' '}
        {fmtInt(data.stores.qdrant.points)}, Neo4j {fmtInt(data.stores.neo4j.nodes)}.
      </span>
      <Button onClick={() => navigate('/operations')}>Reconcile under Operations</Button>
    </div>
  )
}

/**
 * The application shell, after the Nucleus template: a dark sidebar grouped by
 * intent, a header with the trail and the global controls, and full-width
 * content. Below `lg` the sidebar becomes a drawer instead of a rail.
 */
export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const screens = Grid.useBreakpoint()
  const { mode, appearance, density, setAppearance, setDensity } = useAppearance()
  const activeJob = useActiveJob()
  const keyNeeded = useApiKeyNeeded()
  const [keyOpen, setKeyOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const isMobile = screens.lg === false

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === 'true'
    } catch {
      return false
    }
  })
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(collapsed))
    } catch {
      // storage disabled
    }
  }, [collapsed])

  // Close the mobile drawer on navigation — leaving it over the new page is the classic drawer bug.
  useEffect(() => setDrawerOpen(false), [location.pathname])

  const selected = selectedKeyFor(location.pathname)
  const showLabels = isMobile || !collapsed
  const current = NAV_ITEMS.find((item) => item.key === selected)

  useEffect(() => {
    document.title = `${current?.title ?? 'Semantic Leiden'} · Semantic Leiden Explorer`
  }, [current])

  const menuItems = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        key: group.key,
        label: showLabels ? group.label : '',
        type: 'group' as const,
        children: group.items.map((item) => {
          const busy = activeJob && ((item.key === '/import' && activeJob.kind === 'import') || (item.key === '/operations' && activeJob.kind !== 'import'))
          return {
            key: item.key,
            icon: item.icon,
            label: busy ? (
              <span className="nu-nav-item">
                <span>{item.label}</span>
                <Badge status="processing" />
              </span>
            ) : (
              item.label
            ),
          }
        }),
      })),
    [showLabels, activeJob],
  )

  return (
    <Layout className="nu-shell">
      {/* First in the tab order, so a keyboard reader can pass the navigation in one key. */}
      <a className="nu-skip-link" href="#nu-main">
        Skip to content
      </a>
      {isMobile && drawerOpen && <div className="nu-scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

      <Sider
        className={`nu-sider${isMobile ? ' nu-sider--mobile' : ''}${isMobile && drawerOpen ? ' nu-sider--open' : ''}`}
        theme="dark"
        collapsible={!isMobile}
        collapsed={!isMobile && collapsed}
        onCollapse={setCollapsed}
        width={248}
        collapsedWidth={isMobile ? 0 : 56}
      >
        <Link className="nu-logo" to="/" aria-label="Semantic Leiden Explorer, dashboard">
          <Logo />
          {showLabels && (
            <span>
              <strong>Semantic Leiden</strong>
              <small>Explorer · v0.4</small>
            </span>
          )}
        </Link>
        <Menu theme="dark" mode="inline" selectedKeys={[selected]} items={menuItems} onClick={(event) => navigate(event.key)} />
        {showLabels && <SiderFoot />}
      </Sider>

      <Layout>
        <Header className="nu-header">
          <Space size={8}>
            {isMobile && <Button type="text" icon={<MenuOutlined />} aria-label="Open navigation" onClick={() => setDrawerOpen(true)} />}
            {!isMobile && (
              <Breadcrumb
                className="nu-breadcrumb"
                items={trailFor(location.pathname).map((crumb) => ({ title: <Link to={crumb.key}>{crumb.label}</Link> }))}
              />
            )}
          </Space>
          <div className="nu-header-spacer" />
          <Space size={isMobile ? 4 : 10} align="center">
            <JobPill />
            <Readiness />
            <Dropdown
              menu={{
                items: CONSOLES.map((c) => ({
                  key: c.key,
                  label: (
                    <a href={c.href} target="_blank" rel="noreferrer noopener">
                      {c.label} <ExportOutlined style={{ fontSize: 11, marginLeft: 4 }} />
                    </a>
                  ),
                })),
              }}
            >
              <Button icon={isMobile ? <ExportOutlined /> : undefined} aria-label="Operator consoles">
                {!isMobile && (
                  <>
                    Consoles <DownOutlined style={{ fontSize: 10 }} />
                  </>
                )}
              </Button>
            </Dropdown>
            <Tooltip title={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}>
              <Button
                shape="circle"
                aria-label={mode === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
                icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={() => setAppearance(mode === 'dark' ? 'light' : 'dark')}
              />
            </Tooltip>
            <Dropdown
              trigger={['click']}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              menu={{
                selectable: true,
                selectedKeys: [`appearance:${appearance}`, `density:${density}`],
                items: [
                  {
                    type: 'group',
                    label: 'Appearance',
                    children: (['light', 'dark', 'system'] as const).map((value) => ({
                      key: `appearance:${value}`,
                      icon: value === 'light' ? <SunOutlined /> : value === 'dark' ? <MoonOutlined /> : <DesktopOutlined />,
                      label: value[0].toUpperCase() + value.slice(1),
                      onClick: () => setAppearance(value),
                    })),
                  },
                  {
                    type: 'group',
                    label: 'Density',
                    children: (['compact', 'middle', 'comfortable'] as const).map((value) => ({
                      key: `density:${value}`,
                      label: value === 'middle' ? 'Standard' : value[0].toUpperCase() + value.slice(1),
                      onClick: () => setDensity(value),
                    })),
                  },
                  { type: 'divider' },
                  {
                    key: 'api-key',
                    icon: <KeyOutlined />,
                    label: keyNeeded ? 'API key… (required)' : 'API key…',
                    danger: keyNeeded,
                    onClick: () => setKeyOpen(true),
                  },
                ],
              }}
            >
              {/* No tooltip over the open menu it names. */}
              <Tooltip title={keyNeeded ? 'Settings — an API key is required for write actions' : 'Settings'} open={settingsOpen ? false : undefined}>
                <Badge dot={keyNeeded} offset={[-4, 4]}>
                  <Button shape="circle" icon={<SettingOutlined />} aria-label={keyNeeded ? 'Settings (API key required)' : 'Settings'} />
                </Badge>
              </Tooltip>
            </Dropdown>
          </Space>
        </Header>

        <ConsistencyBand />

        <Content className="nu-content">
          <div id="nu-main" tabIndex={-1}>
            <DocumentDrawerProvider>
              <ErrorBoundary resetKey={location.pathname}>
                <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </DocumentDrawerProvider>
          </div>
        </Content>
      </Layout>
      <ApiKeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} />
    </Layout>
  )
}
