import type { ReactNode } from 'react'
import {
  ApartmentOutlined,
  ClusterOutlined,
  ControlOutlined,
  DashboardOutlined,
  ImportOutlined,
  SearchOutlined,
} from '@ant-design/icons'

/** Navigation grouped by what somebody came to do, not by the data model. */
export interface NavItem {
  key: string
  label: string
  icon: ReactNode
  /** Shown in the breadcrumb and the document title. */
  title: string
}

export interface NavGroup {
  key: string
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'overview',
    label: 'Overview',
    items: [{ key: '/', label: 'Dashboard', icon: <DashboardOutlined />, title: 'Dashboard' }],
  },
  {
    key: 'explore',
    label: 'Explore',
    items: [
      { key: '/documents', label: 'Documents', icon: <SearchOutlined />, title: 'Explore documents' },
      { key: '/graph', label: 'Similarity graph', icon: <ApartmentOutlined />, title: 'Similarity graph' },
      { key: '/communities', label: 'Communities', icon: <ClusterOutlined />, title: 'Communities' },
    ],
  },
  {
    key: 'data',
    label: 'Data',
    items: [
      { key: '/import', label: 'Import', icon: <ImportOutlined />, title: 'Import' },
      { key: '/operations', label: 'Operations', icon: <ControlOutlined />, title: 'Operations' },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/** The item a path belongs to — the longest matching key. */
export function selectedKeyFor(pathname: string): string {
  let best = '/'
  for (const item of NAV_ITEMS) {
    if (item.key !== '/' && (pathname === item.key || pathname.startsWith(`${item.key}/`)) && item.key.length > best.length) {
      best = item.key
    }
  }
  return best
}

export function trailFor(pathname: string): { label: string; key: string }[] {
  const selected = selectedKeyFor(pathname)
  for (const group of NAV_GROUPS) {
    const item = group.items.find((candidate) => candidate.key === selected)
    if (item) {
      return group.key === 'overview'
        ? [{ label: item.title, key: item.key }]
        : [
            { label: group.label, key: group.items[0].key },
            { label: item.title, key: item.key },
          ]
    }
  }
  return [{ label: 'Semantic Leiden', key: '/' }]
}
