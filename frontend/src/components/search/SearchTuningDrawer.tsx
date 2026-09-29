import type { ReactNode } from 'react'
import { Button, Collapse, Drawer, InputNumber, Segmented, Select, Slider, Space, Switch, Tooltip, Typography } from 'antd'
import { QuestionCircleOutlined, UndoOutlined } from '@ant-design/icons'
import { useCommunities } from '@/api/hooks'
import type { SearchMode } from '@/api/types'
import { CommunityKey } from '@/components/CommunityKey'
import { DEFAULT_TUNING, type SearchTuning } from './defaults'

function Field({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
        {label}
        {hint && (
          <Tooltip title={hint}>
            <QuestionCircleOutlined style={{ marginLeft: 6 }} aria-label={hint} />
          </Tooltip>
        )}
      </Typography.Text>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
      <Switch size="small" checked={checked} disabled={disabled} onChange={onChange} />
      {children}
    </label>
  )
}

/**
 * How ranked search behaves: routing, fusion, diversification and keyword
 * matching. What documents are *eligible* lives in the conditions; this drawer
 * only changes how the eligible ones are ordered.
 */
export function SearchTuningDrawer({
  open,
  onClose,
  mode,
  tuning,
  onChange,
}: {
  open: boolean
  onClose: () => void
  mode: SearchMode
  tuning: SearchTuning
  onChange: (next: SearchTuning) => void
}) {
  const { data: communities = [] } = useCommunities()
  const set = <K extends keyof SearchTuning>(key: K, value: SearchTuning[K]) => onChange({ ...tuning, [key]: value })
  const communityOptions = communities.map((c) => ({
    value: c.community_id,
    label: <CommunityKey id={c.community_id} label={`C${c.community_id} (${c.size})`} />,
    searchText: `C${c.community_id}`,
  }))

  const routing = (
    <>
      <Toggle checked={tuning.autoRoute} onChange={(autoRoute) => set('autoRoute', autoRoute)}>
        Route to the best communities automatically
      </Toggle>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Anchor documents nearest to the query vote for communities; only the winners are searched. Overrides the community filter in
        the toolbar.
      </Typography.Paragraph>
      {tuning.autoRoute && (
        <>
          <Field
            label="Routing strategy"
            hint="top1: nearest document's community (v0.2). sum, mean, max and softmax aggregate votes from several anchors, which is more robust at community boundaries."
          >
            <Select
              aria-label="Routing strategy"
              style={{ width: '100%' }}
              value={tuning.routing.strategy}
              onChange={(strategy) => set('routing', { ...tuning.routing, strategy })}
              options={[
                { value: 'sum', label: 'Sum of similarities' },
                { value: 'softmax', label: 'Softmax vote' },
                { value: 'mean', label: 'Mean similarity' },
                { value: 'max', label: 'Best anchor' },
                { value: 'top1', label: 'Nearest document (v0.2)' },
              ]}
            />
          </Field>
          <Space.Compact block style={{ marginBottom: 14 }}>
            <InputNumber
              style={{ width: '50%' }}
              min={1}
              max={200}
              addonBefore="Anchors"
              aria-label="Anchor documents"
              value={tuning.routing.anchors}
              onChange={(v) => set('routing', { ...tuning.routing, anchors: v ?? 20 })}
            />
            <InputNumber
              style={{ width: '50%' }}
              min={1}
              max={10}
              addonBefore="Top"
              aria-label="Communities to search"
              value={tuning.routing.communities}
              onChange={(v) => set('routing', { ...tuning.routing, communities: v ?? 1 })}
            />
          </Space.Compact>
          {tuning.routing.strategy === 'softmax' && (
            <Field label={`Temperature ${tuning.routing.temperature}`} hint="Low behaves like best anchor; high behaves like counting anchors.">
              <Slider
                ariaLabelForHandle="Softmax temperature"
                min={0.01}
                max={1}
                step={0.01}
                value={tuning.routing.temperature}
                onChange={(temperature) => set('routing', { ...tuning.routing, temperature })}
              />
            </Field>
          )}
        </>
      )}
      <Field label="Never search these communities">
        <Select
          aria-label="Never search these communities"
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder="None excluded"
          value={tuning.excludeCommunities}
          options={communityOptions}
          showSearch
          optionFilterProp="searchText"
          onChange={(ids) => set('excludeCommunities', ids)}
        />
      </Field>
    </>
  )

  const ranking = (
    <>
      {mode === 'hybrid' && (
        <>
          <Field label="Fusion" hint="RRF uses ranks only (robust default). DBSF normalises score distributions, so a very strong keyword match can dominate.">
            <Segmented
              block
              value={tuning.fusion.method}
              options={[
                { label: 'RRF', value: 'rrf' },
                { label: 'DBSF', value: 'dbsf' },
              ]}
              onChange={(method) => set('fusion', { ...tuning.fusion, method: method as 'rrf' | 'dbsf' })}
            />
          </Field>
          <Field label={`Balance: ${Math.round((1 - tuning.fusion.alpha) * 100)}% keyword, ${Math.round(tuning.fusion.alpha * 100)}% semantic`}>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={tuning.fusion.alpha}
              tooltip={{ open: false }}
              onChange={(alpha) => set('fusion', { ...tuning.fusion, alpha })}
              ariaLabelForHandle="Keyword to semantic balance"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--nu-text-secondary)', marginTop: -6 }}>
              <span>Keyword</span>
              <span>Semantic</span>
            </div>
          </Field>
        </>
      )}
      {mode !== 'keyword' && (
        <Field label="Minimum cosine similarity" hint="Drops semantic candidates below this similarity. Leave empty to keep all.">
          <InputNumber
            aria-label="Minimum cosine similarity"
            style={{ width: '100%' }}
            min={-1}
            max={1}
            step={0.05}
            placeholder="No floor"
            value={tuning.min_score}
            onChange={(v) => set('min_score', v ?? undefined)}
          />
        </Field>
      )}
      <Toggle checked={tuning.mmr.enabled} onChange={(enabled) => set('mmr', { ...tuning.mmr, enabled })}>
        Diversify results (MMR)
        <Tooltip title="Maximal Marginal Relevance trades a little relevance for less redundancy: near-duplicate stories stop crowding the list.">
          <QuestionCircleOutlined />
        </Tooltip>
      </Toggle>
      {tuning.mmr.enabled && (
        <Field label={`Relevance weight ${tuning.mmr.lambda}`}>
          <Slider ariaLabelForHandle="MMR relevance weight" min={0} max={1} step={0.05} value={tuning.mmr.lambda} onChange={(lambda) => set('mmr', { ...tuning.mmr, lambda })} />
        </Field>
      )}
    </>
  )

  const keyword = (
    <>
      <Field
        label="Query syntax"
        hint='Advanced enables "exact phrase", -exclude, a | b, prefix* and fuzzy~ (Elasticsearch simple_query_string, which never errors on bad syntax).'
      >
        <Segmented
          block
          value={tuning.lexical.syntax}
          options={[
            { label: 'Plain', value: 'plain' },
            { label: 'Advanced', value: 'advanced' },
          ]}
          onChange={(syntax) => set('lexical', { ...tuning.lexical, syntax: syntax as 'plain' | 'advanced' })}
        />
      </Field>
      <Field label="Terms must match">
        <Segmented
          block
          value={tuning.lexical.operator}
          options={[
            { label: 'Any term', value: 'or' },
            { label: 'All terms', value: 'and' },
          ]}
          onChange={(operator) => set('lexical', { ...tuning.lexical, operator: operator as 'or' | 'and' })}
        />
      </Field>
      <Toggle checked={tuning.lexical.fuzzy} disabled={tuning.lexical.syntax === 'advanced'} onChange={(fuzzy) => set('lexical', { ...tuning.lexical, fuzzy })}>
        Typo tolerance
      </Toggle>
      <Toggle checked={tuning.lexical.phrase_boost} onChange={(phrase_boost) => set('lexical', { ...tuning.lexical, phrase_boost })}>
        Boost exact phrases
      </Toggle>
    </>
  )

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={400}
      title="Ranking options"
      extra={
        <Button icon={<UndoOutlined />} onClick={() => onChange(DEFAULT_TUNING)}>
          Reset
        </Button>
      }
    >
      <Toggle checked={tuning.liveSearch} onChange={(liveSearch) => set('liveSearch', liveSearch)}>
        Search as you type
      </Toggle>
      <Collapse
        ghost
        size="small"
        defaultActiveKey={['ranking', 'routing', 'keyword']}
        items={[
          { key: 'ranking', label: <strong>Ranking</strong>, children: ranking },
          { key: 'routing', label: <strong>Community routing</strong>, children: routing },
          ...(mode !== 'semantic' ? [{ key: 'keyword', label: <strong>Keyword matching</strong>, children: keyword }] : []),
        ]}
      />
    </Drawer>
  )
}
