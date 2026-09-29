/**
 * Saved searches, per page, kept in this browser.
 *
 * A saved search is the page's address: every question on these pages lives in
 * the URL, so saving one is naming a URL and opening one is navigating to it.
 * Nothing is stored server-side — the moment searches need to be shared between
 * people they belong in an API, not in localStorage.
 */

import { useState } from 'react'
import { App, Button, Drawer, Form, Input, List, Modal, Popconfirm, Space, Tooltip, Typography } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, LinkOutlined, SaveOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import { STORAGE_KEYS } from '@/config'
import { useSticky } from '@/hooks/useSticky'
import { fmtRelative } from '@/lib/format'
import { EmptyState } from './EmptyState'
import { ListMeta } from './ListMeta'

interface SavedSearch {
  id: string
  name: string
  path: string
  search: string
  summary: string
  created_at: string
}

export function useSavedSearches() {
  return useSticky<SavedSearch[]>(STORAGE_KEYS.savedSearches, [])
}

/** The two header buttons (open the list, save the current question) with their drawer and modal. */
export function SavedSearchButtons({ summary, disabled }: { summary: string; disabled?: boolean }) {
  const [saved, setSaved] = useSavedSearches()
  const [listOpen, setListOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm<{ name: string }>()
  const here = saved.filter((s) => s.path === location.pathname)

  return (
    <>
      <Button icon={<FolderOpenOutlined />} onClick={() => setListOpen(true)}>
        Saved{here.length ? ` (${here.length})` : ''}
      </Button>
      <Tooltip title={disabled ? 'Ask a question first — there is nothing to save yet' : 'Save this question under a name'}>
        <Button
          icon={<SaveOutlined />}
          disabled={disabled}
          onClick={() => {
            form.setFieldsValue({ name: summary.slice(0, 60) })
            setSaveOpen(true)
          }}
        >
          Save search
        </Button>
      </Tooltip>

      <Drawer open={listOpen} onClose={() => setListOpen(false)} width={440} title="Saved searches">
        {here.length === 0 ? (
          <EmptyState title="No saved searches on this page" hint="Ask a question, then use Save search to keep it here." />
        ) : (
          <List
            dataSource={here}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Tooltip key="copy" title="Copy a link to this search">
                    <Button
                      type="text"
                      icon={<LinkOutlined />}
                      aria-label={`Copy link to ${item.name}`}
                      onClick={async () => {
                        await navigator.clipboard?.writeText(`${window.location.origin}${item.path}${item.search}`)
                        message.success('Link copied')
                      }}
                    />
                  </Tooltip>,
                  <Popconfirm key="delete" title={`Delete “${item.name}”?`} okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => setSaved(saved.filter((s) => s.id !== item.id))}>
                    <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${item.name}`} />
                  </Popconfirm>,
                ]}
              >
                <ListMeta
                  title={
                    <button
                      type="button"
                      className="nu-link-button"
                      onClick={() => {
                        navigate(`${item.path}${item.search}`)
                        setListOpen(false)
                      }}
                    >
                      {item.name}
                    </button>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {item.summary}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        saved {fmtRelative(item.created_at)}
                      </Typography.Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>

      <Modal
        open={saveOpen}
        title="Save this search"
        okText="Save"
        onCancel={() => setSaveOpen(false)}
        destroyOnHidden
        onOk={async () => {
          const { name } = await form.validateFields()
          setSaved([
            { id: crypto.randomUUID?.() ?? String(Date.now()), name: name.trim(), path: location.pathname, search: location.search, summary, created_at: new Date().toISOString() },
            ...saved,
          ].slice(0, 100))
          setSaveOpen(false)
          message.success(`Saved “${name.trim()}”`)
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, message: 'Give the search a name' }]}>
            <Input autoFocus maxLength={80} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {summary}
          </Typography.Text>
        </Form>
      </Modal>
    </>
  )
}
