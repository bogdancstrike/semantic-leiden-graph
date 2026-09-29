/**
 * The nested condition editor — `RULE AND (RULE OR …)` — on react-awesome-query-builder.
 *
 * **The tree is owned locally while it is being edited.** The page keeps the
 * question in the URL, so every change comes straight back as a new `value`.
 * Re-loading the editor from that echo made "Add rule" appear to do nothing:
 * an empty rule is discarded when a tree is loaded. So an incoming `value` is
 * compared with what was last emitted, and only reloads when somebody else —
 * a saved search, the back button, a preset — changed it.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Builder,
  Query,
  Utils as QbUtils,
  type ImmutableTree,
  type ItemBuilderProps,
  type JsonTree,
} from '@react-awesome-query-builder/antd'
import { Button, Tooltip } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import '@react-awesome-query-builder/antd/css/styles.css'
import { queryBuilderConfig, type BuilderField } from './queryBuilderConfig'
import { duplicateNode, emptyTree, type QueryNode } from './queryTree'

export interface AdvancedQueryBuilderProps {
  fields: BuilderField[]
  value: QueryNode | null
  onChange: (tree: QueryNode) => void
}

export function AdvancedQueryBuilder({ fields, value, onChange }: AdvancedQueryBuilderProps) {
  const config = useMemo(() => queryBuilderConfig(fields), [fields])
  const [tree, setTree] = useState<ImmutableTree>(() => load(value))
  const emitted = useRef(serialise(value))

  useEffect(() => {
    const incoming = serialise(value)
    if (incoming === emitted.current) return
    emitted.current = incoming
    setTree(load(value))
  }, [value])

  const publish = (next: ImmutableTree) => {
    setTree(next)
    const json = QbUtils.getTree(next) as unknown as QueryNode
    emitted.current = serialise(json)
    onChange(json)
  }

  const duplicate = (path: readonly string[]) => {
    const current = QbUtils.getTree(tree) as unknown as QueryNode
    const next = duplicateNode(current, path)
    if (next) publish(QbUtils.loadTree(next as unknown as JsonTree))
  }

  return (
    <div className="nu-query-builder" aria-label="Condition builder">
      <Query
        {...config}
        settings={{
          ...config.settings,
          renderItem: (props: ItemBuilderProps) => <QueryItem {...props} onDuplicate={duplicate} />,
        }}
        value={tree}
        onChange={publish}
        // The library's stylesheet is scoped under `.query-builder`.
        renderBuilder={(props) => (
          <div className="query-builder">
            <Builder {...props} />
          </div>
        )}
      />
    </div>
  )
}

/** One rule or group, plus a duplicate action beside the library's own. */
function QueryItem({
  itemComponent: Item,
  onDuplicate,
  ...props
}: ItemBuilderProps & { onDuplicate: (path: readonly string[]) => void }) {
  const path: string[] = props.path?.toJS?.() ?? []
  const isRoot = path.length <= 1
  return (
    <Fragment>
      {Item(props)}
      {!isRoot && (
        <Tooltip title="Duplicate">
          <Button
            className="nu-query-duplicate"
            type="text"
            size="small"
            icon={<CopyOutlined />}
            aria-label={`Duplicate this ${props.type === 'group' ? 'group' : 'rule'}`}
            onClick={() => onDuplicate(path)}
          />
        </Tooltip>
      )}
    </Fragment>
  )
}

function load(value: QueryNode | null): ImmutableTree {
  return QbUtils.loadTree((value ?? emptyTree()) as unknown as JsonTree)
}

function serialise(value: QueryNode | null | undefined): string {
  return JSON.stringify(value ?? null)
}
