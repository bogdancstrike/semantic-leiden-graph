import { useState } from 'react'
import { App, Form, Input, Modal, Typography } from 'antd'
import { apiKeyStore } from '@/api/client'
import { useConfig } from '@/api/hooks'

/** Whether write actions will be refused for want of a key. */
export function useApiKeyNeeded(): boolean {
  const { data: config } = useConfig()
  return !!config?.auth_required && !apiKeyStore.get()
}

/** Set or clear the API key the write endpoints need. Opened from the header's Settings menu. */
export function ApiKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: config } = useConfig()
  const { message } = App.useApp()
  const [value, setValue] = useState(apiKeyStore.get() ?? '')

  const save = (next: string | null) => {
    apiKeyStore.set(next)
    setValue(next ?? '')
    message.success(next ? 'API key saved for this tab' : 'API key cleared')
    onClose()
  }

  return (
    <Modal
      open={open}
      title="API key"
      okText="Save"
      onOk={() => save(value.trim() || null)}
      onCancel={onClose}
      cancelText="Close"
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          {apiKeyStore.get() && (
            <button type="button" className="nu-link-button" style={{ float: 'left', fontWeight: 500, lineHeight: '32px' }} onClick={() => save(null)}>
              Clear the stored key
            </button>
          )}
          <CancelBtn />
          <OkBtn />
        </>
      )}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        {config?.auth_required
          ? 'The API requires a key for imports, clustering and deletes. It is kept in this browser tab only (sessionStorage) and sent as X-API-Key.'
          : 'The API does not require a key right now. Set API_KEY on the server to protect the write endpoints.'}
      </Typography.Paragraph>
      <Form layout="vertical" onFinish={() => save(value.trim() || null)}>
        <Form.Item label="X-API-Key" htmlFor="api-key-input" style={{ marginBottom: 0 }}>
          <Input.Password id="api-key-input" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  )
}
