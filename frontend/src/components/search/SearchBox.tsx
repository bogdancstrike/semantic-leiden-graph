/**
 * One search box with what you asked before (after the template's SimpleSearch).
 *
 * Recent searches are the only suggestion offered: "the thing I looked for on
 * Tuesday" is recognised instantly, whereas a guess drawn from a prefix is
 * worse than no guess. A term joins the history when it is submitted.
 */

import { forwardRef, useMemo } from 'react'
import { AutoComplete, Button, Input, Space, Tooltip, Typography } from 'antd'
import type { InputRef } from 'antd'
import { CloseOutlined, HistoryOutlined, SearchOutlined } from '@ant-design/icons'
import { useRecentSearches } from '@/hooks/useRecentSearches'

export interface SearchBoxProps {
  /** Each page keeps its own history. */
  scope: string
  value: string
  placeholder: string
  onChange: (term: string) => void
  /** Enter, or a history pick. */
  onSubmit: (term: string) => void
  loading?: boolean
}

export const SearchBox = forwardRef<InputRef, SearchBoxProps>(function SearchBox(
  { scope, value, placeholder, onChange, onSubmit, loading },
  ref,
) {
  const recent = useRecentSearches(scope)
  const options = useMemo(() => {
    const needle = value.trim().toLowerCase()
    const terms = recent.terms.filter((term) => term !== value && term.toLowerCase().includes(needle))
    if (!terms.length) return []
    return [
      {
        label: (
          <div className="nu-recent-heading">
            <Typography.Text type="secondary">Recent searches</Typography.Text>
            <button type="button" className="nu-link-button" style={{ fontSize: 12, fontWeight: 500 }} onMouseDown={(e) => e.preventDefault()} onClick={() => recent.clear()}>
              Clear
            </button>
          </div>
        ),
        options: terms.map((term) => ({
          value: term,
          label: (
            <div className="nu-recent-option">
              <Space size={6}>
                <HistoryOutlined />
                <span>{term}</span>
              </Space>
              <Tooltip title="Forget this search">
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  aria-label={`Forget ${term}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation()
                    recent.forget(term)
                  }}
                />
              </Tooltip>
            </div>
          ),
        })),
      },
    ]
  }, [recent, value])

  return (
    <AutoComplete
      className="nu-simple-search"
      value={value}
      options={options}
      filterOption={false}
      onChange={onChange}
      onSelect={(term: string) => {
        onChange(term)
        recent.remember(term)
        onSubmit(term)
      }}
    >
      <Input
        ref={ref}
        allowClear
        prefix={<SearchOutlined />}
        suffix={loading ? <span className="ant-typography ant-typography-secondary" style={{ fontSize: 12 }}>searching…</span> : <kbd style={{ fontSize: 11, opacity: 0.6 }}>/</kbd>}
        placeholder={placeholder}
        aria-label={placeholder}
        onPressEnter={() => {
          recent.remember(value)
          onSubmit(value)
        }}
      />
    </AutoComplete>
  )
})
