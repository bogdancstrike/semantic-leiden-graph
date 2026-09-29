import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { App, Button, Descriptions, Drawer, Grid, Popconfirm, Skeleton, Space, Tabs, Tag, Tooltip, Typography } from 'antd'
import { ApartmentOutlined, ArrowLeftOutlined, ClusterOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useDeleteDocument, useDocument, useSimilar } from '@/api/hooks'
import { fmtInt, fmtRelative, fmtScore } from '@/lib/format'
import { links } from '@/lib/links'
import { CommunityKey } from './CommunityKey'
import { EmptyState } from './EmptyState'

interface DrawerApi {
  open: (id: string) => void
}

const DrawerContext = createContext<DrawerApi>({ open: () => undefined })

export const useDocumentDrawer = () => useContext(DrawerContext)

const SIMILAR_TABS = [
  { key: 'semantic', label: 'Semantic', help: 'Nearest vectors in Qdrant (meaning, cross-lingual).' },
  { key: 'keyword', label: 'Keyword', help: 'Elasticsearch more-like-this (shared distinctive terms).' },
  { key: 'graph', label: 'Graph', help: 'SIMILAR_TO neighbours stored in Neo4j (what Leiden saw).' },
] as const

function SimilarList({ id, method, onOpen }: { id: string; method: 'semantic' | 'keyword' | 'graph'; onOpen: (id: string) => void }) {
  const { data, isLoading } = useSimilar(id, method)
  if (isLoading) return <Skeleton active paragraph={{ rows: 4 }} />
  if (!data?.results.length) return <EmptyState compact title="No neighbours" />
  return (
    <ul className="neighbour-list">
      {data.results.map((doc) => (
        <li key={doc.id}>
          <button type="button" className="neighbour-item" onClick={() => onOpen(doc.id)}>
            <span className="sl-result-meta">
              <CommunityKey id={doc.community_id} />
              <span className="mono">{doc.external_id}</span>
              <span>score {fmtScore(doc.score)}</span>
            </span>
            <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: '4px 0 0' }}>
              {doc.text}
            </Typography.Paragraph>
          </button>
        </li>
      ))}
    </ul>
  )
}

function DocumentBody({ id, onOpen, onClose }: { id: string; onOpen: (id: string) => void; onClose: () => void }) {
  const { data: doc, isLoading, error } = useDocument(id)
  const remove = useDeleteDocument()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [tab, setTab] = useState<string>('semantic')

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />
  if (error || !doc) return <EmptyState title="Document not found" hint="It may have been deleted." />

  const go = (to: string) => {
    navigate(to)
    onClose()
  }
  const metadata = Object.entries(doc.metadata ?? {})
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Paragraph style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }} copyable={{ text: doc.text }}>
        {doc.text}
      </Typography.Paragraph>

      <Space wrap>
        <Tooltip title="Open the similarity graph around this document">
          <Button icon={<ApartmentOutlined />} onClick={() => go(links.graph({ focus: doc.id }))}>
            Show in graph
          </Button>
        </Tooltip>
        <Tooltip title="Semantic search using this document's text as the query">
          <Button icon={<SearchOutlined />} onClick={() => go(links.explore({ q: doc.text.slice(0, 300), mode: 'semantic' }))}>
            Find similar
          </Button>
        </Tooltip>
        {doc.community_id !== null && doc.community_id !== undefined && (
          <Button icon={<ClusterOutlined />} onClick={() => go(links.communities({ selected: doc.community_id! }))}>
            Community C{doc.community_id}
          </Button>
        )}
        <Popconfirm
          title="Delete this document?"
          description="Removes it from Elasticsearch, Qdrant and Neo4j."
          okText="Delete"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(doc.id)
              message.success('Document deleted')
              onClose()
            } catch (e) {
              message.error((e as Error).message)
            }
          }}
        >
          <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>
            Delete
          </Button>
        </Popconfirm>
      </Space>

      <Descriptions
        size="small"
        column={1}
        bordered
        items={[
          { key: 'ext', label: 'External ID', children: <Typography.Text className="mono" copyable>{doc.external_id}</Typography.Text> },
          { key: 'id', label: 'Internal ID', children: <Typography.Text className="mono" copyable>{doc.id}</Typography.Text> },
          {
            key: 'c',
            label: 'Community',
            children: (
              <Space>
                <CommunityKey id={doc.community_id} />
                {doc.community_version ? <Tag bordered={false}>run v{doc.community_version}</Tag> : null}
              </Space>
            ),
          },
          { key: 'src', label: 'Source', children: doc.source ?? '—' },
          { key: 'len', label: 'Length', children: `${fmtInt(doc.length)} characters` },
          { key: 'upd', label: 'Updated', children: fmtRelative(doc.updated_at) },
          ...(metadata.length
            ? [
                {
                  key: 'meta',
                  label: 'Metadata',
                  children: (
                    <Space wrap size={[4, 4]}>
                      {metadata.map(([k, v]) => (
                        <Tag key={k} bordered={false}>
                          {k}: {String(v)}
                        </Tag>
                      ))}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <div>
        {/* h2: the drawer sits under the page's h1, and skipping levels breaks heading navigation. */}
        <h2 className="nu-section-title">Neighbours by engine</h2>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          destroyOnHidden
          items={SIMILAR_TABS.map((t) => ({
            key: t.key,
            label: t.label,
            children: (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.help}
                </Typography.Text>
                <SimilarList id={doc.id} method={t.key} onOpen={onOpen} />
              </>
            ),
          }))}
        />
      </div>
    </Space>
  )
}

/** One document drawer for the whole app; opening from inside it stacks, with Back. */
export function DocumentDrawerProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<string[]>([])
  const screens = Grid.useBreakpoint()
  const open = useCallback((id: string) => setStack((s) => (s[s.length - 1] === id ? s : [...s, id])), [])
  const close = useCallback(() => setStack([]), [])
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const api = useMemo(() => ({ open }), [open])
  const current = stack[stack.length - 1] ?? null

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <Drawer
        open={!!current}
        onClose={close}
        width={screens.md ? 600 : '100%'}
        title="Document"
        extra={
          stack.length > 1 ? (
            <Button icon={<ArrowLeftOutlined />} onClick={back}>
              Back
            </Button>
          ) : null
        }
        destroyOnHidden
      >
        {current && <DocumentBody key={current} id={current} onOpen={open} onClose={close} />}
      </Drawer>
    </DrawerContext.Provider>
  )
}
