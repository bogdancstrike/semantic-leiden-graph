/**
 * The advanced-conditions workspace, after the Nucleus explorer's drawer.
 *
 * The condition being edited is a *draft*. The page behind keeps showing the
 * last question that was applied, and the draft becomes that question only on
 * **Apply** — closing the drawer leaves the results exactly as they were. That
 * split gives a live match count while editing without the page underneath
 * churning through every half-built rule.
 *
 * Each page supplies its own preview (a server count for documents, an
 * in-browser count for graph nodes and communities), so one drawer serves all.
 */

import { Suspense, useState, type ReactNode } from 'react'
import { lazyPage } from '@/lib/lazyPage'
import { Alert, Button, Card, Collapse, Drawer, Skeleton, Space, Statistic, Tooltip, Typography } from 'antd'
import { ApartmentOutlined, ClearOutlined, FilterOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useSticky } from '@/hooks/useSticky'
import { Chip, FilterChip } from '@/components/Chip'
import type { BuilderField } from './queryBuilderConfig'
import { countRules, pruneTree, starterTree, type QueryNode } from './queryTree'

const { Text, Paragraph } = Typography

// The query-builder library is the largest dependency in the app; it is fetched
// the first time a drawer opens, not with the pages that merely offer one.
const AdvancedQueryBuilder = lazyPage(() => import('./AdvancedQueryBuilder').then((m) => ({ default: m.AdvancedQueryBuilder })))

export interface PreviewState {
  count: number | null
  /** The draft read back as text (the server's inspector text, or a local one). */
  text?: string
  loading?: boolean
  error?: string | null
}

export interface ConditionPreset {
  label: string
  tree: QueryNode
  hint?: string
}

export interface AdvancedConditionsDrawerProps {
  open: boolean
  title?: string
  /** What is being matched, plural: "documents", "nodes", "communities". */
  noun: string
  fields: BuilderField[]
  value: QueryNode | null
  onClose: () => void
  onApply: (tree: QueryNode | null) => void
  /** Called with the debounced draft; may use hooks, and must call the same ones every render. */
  usePreview: (draft: QueryNode | null) => PreviewState
  presets?: ConditionPreset[]
  /** Where the conditions run, for the lesson ("Elasticsearch", "your browser"). */
  engine: string
  extraHelp?: ReactNode
}

export function AdvancedConditionsDrawer(props: AdvancedConditionsDrawerProps) {
  return (
    <Drawer
      open={props.open}
      width="min(1120px, 96vw)"
      title={
        <Space>
          <ApartmentOutlined />
          {props.title ?? 'Advanced conditions'}
        </Space>
      }
      onClose={props.onClose}
      // Discarding the component discards the draft: what was not applied was not asked.
      destroyOnHidden
      styles={{ body: { display: 'flex', flexDirection: 'column' } }}
    >
      {props.open && <DrawerBody {...props} />}
    </Drawer>
  )
}

function DrawerBody({ noun, fields, value, onClose, onApply, usePreview, presets, engine, extraHelp }: AdvancedConditionsDrawerProps) {
  const [draft, setDraft] = useState<QueryNode | null>(() => (countRules(value) ? (value ?? null) : starterTree()))
  const debounced = useDebouncedValue(draft, 280)
  const preview = usePreview(debounced)
  const [helpOpen, setHelpOpen] = useSticky<boolean>('semantic-leiden.conditions.help', true)

  // Only finished rules count: the blank starter rule is an invitation, not a condition.
  const rules = countRules(pruneTree(draft))
  const settling = preview.loading || debounced !== draft
  const applied = JSON.stringify(pruneTree(value) ?? null) === JSON.stringify(pruneTree(draft) ?? null)

  return (
    <div className="nu-advanced-search">
      <Collapse
        ghost
        size="small"
        activeKey={helpOpen ? ['how'] : []}
        onChange={(keys) => setHelpOpen(keys.length > 0)}
        items={[
          {
            key: 'how',
            label: (
              <Space size={6}>
                <QuestionCircleOutlined />
                <Text strong>How this works</Text>
              </Space>
            ),
            children: (
              <div className="nu-advanced-lesson">
                <div>
                  <Text strong>A rule</Text>
                  <Paragraph type="secondary">
                    One comparison: a field, how to compare it, and a value — <Text code>Length &gt; 200</Text>. Rules you have not
                    finished are ignored while you work.
                  </Paragraph>
                </div>
                <div>
                  <Text strong>A group</Text>
                  <Paragraph type="secondary">
                    A bracket around rules, answered together and then combined with the rest — how{' '}
                    <Text code>A and (B or C)</Text> is said.
                  </Paragraph>
                </div>
                <div>
                  <Text strong>And · Or · Not</Text>
                  <Paragraph type="secondary">
                    <Text strong>And</Text> narrows, <Text strong>Or</Text> widens, <Text strong>Not</Text> inverts the whole group.
                  </Paragraph>
                </div>
                <div>
                  <Text strong>Nothing runs until you apply</Text>
                  <Paragraph type="secondary">
                    The count below previews this draft against the real {noun}, evaluated by {engine}. {extraHelp}
                  </Paragraph>
                </div>
              </div>
            ),
          },
        ]}
      />

      {presets && presets.length > 0 && (
        <div className="nu-presets" role="group" aria-label="Start from a preset">
          <Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>
            Start from:
          </Text>
          {presets.map((preset) => (
            <Tooltip key={preset.label} title={preset.hint}>
              <Chip icon={<FilterOutlined />} onClick={() => setDraft(preset.tree)}>
                {preset.label}
              </Chip>
            </Tooltip>
          ))}
        </div>
      )}

      <Suspense fallback={<Skeleton active paragraph={{ rows: 4 }} />}>
        <AdvancedQueryBuilder fields={fields} value={draft} onChange={setDraft} />
      </Suspense>

      <Card size="small" title="What this asks" className="nu-query-inspector">
        <pre>{preview.text?.trim() || `All ${noun}`}</pre>
      </Card>

      {preview.error && <Alert type="error" showIcon message="This condition could not be previewed" description={preview.error} />}

      <div className="nu-advanced-actions">
        <Statistic
          className="nu-advanced-count"
          title={settling ? 'Previewing…' : rules === 1 ? '1 rule · matching' : `${rules} rules · matching`}
          value={preview.count ?? 0}
          suffix={noun}
          valueStyle={{ fontSize: 20 }}
        />
        <Space wrap>
          <Tooltip title="Empty the tree and start again. Nothing behind the drawer changes.">
            <Button icon={<ClearOutlined />} disabled={rules === 0} onClick={() => setDraft(starterTree())}>
              Clear
            </Button>
          </Tooltip>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            icon={<FilterOutlined />}
            onClick={() => {
              onApply(pruneTree(draft))
              onClose()
            }}
          >
            {applied ? 'Apply' : `Apply · ${(preview.count ?? 0).toLocaleString()} ${noun}`}
          </Button>
        </Space>
      </div>
    </div>
  )
}

/** The applied conditions, read back in the toolbar with the way to change them. */
export function ActiveConditions({
  text,
  rules,
  onEdit,
  onClear,
  children,
}: {
  text: string
  rules: number
  onEdit: () => void
  onClear: () => void
  children?: ReactNode
}) {
  if (!rules && !children) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  return (
    <div className="nu-conditions" role="group" aria-label="Active filters">
      <span className="nu-conditions-label">Filtered by</span>
      {children}
      {rules > 0 && (
        <Tooltip title={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{text}</pre>}>
          <FilterChip tone="accent" icon={<ApartmentOutlined />} name={rules === 1 ? 'the condition' : 'the conditions'} onEdit={onEdit} onRemove={onClear}>
            {rules === 1 ? '1 condition' : `${rules} conditions`}: {flat.length > 90 ? `${flat.slice(0, 90)}…` : flat}
          </FilterChip>
        </Tooltip>
      )}
    </div>
  )
}
