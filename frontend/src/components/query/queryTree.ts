/**
 * Plain-JSON operations on a query-builder tree.
 *
 * The builder's own state is an Immutable.js structure, but the tree that
 * travels — into the URL, into a saved search, into the request body — is the
 * JSON one. Working here keeps those operations testable without React and
 * without depending on the library beyond `children1` and `properties`.
 */

import type { QueryNode } from '@/api/types'

export type { QueryNode }

export interface SimpleRule {
  field: string
  operator: string
  /** RAQB's value list: one entry per operand (two for `between`); multiselect is `[[a, b]]`. */
  value: unknown[]
}

/** A fresh, empty root group — an AND of nothing, which matches everything. */
export function emptyTree(): QueryNode {
  return { id: newId(), type: 'group', children1: {}, properties: { conjunction: 'AND', not: false } }
}

/** A tree of AND-ed rules, for deep links ("documents of community 4") and presets. */
export function treeFromRules(rules: SimpleRule[], conjunction: 'AND' | 'OR' = 'AND'): QueryNode {
  const children: Record<string, QueryNode> = {}
  for (const rule of rules) {
    const id = newId()
    children[id] = {
      id,
      type: 'rule',
      properties: {
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        valueSrc: rule.value.map(() => 'value'),
      },
    }
  }
  return { id: newId(), type: 'group', children1: children, properties: { conjunction, not: false } }
}

/** Append rules to an existing tree (or start one), keeping what is already there. */
export function withRules(tree: QueryNode | null | undefined, rules: SimpleRule[]): QueryNode {
  if (!tree || isEmptyTree(tree)) return treeFromRules(rules)
  const added = treeFromRules(rules)
  const conjunction = String(tree.properties?.conjunction ?? 'AND')
  if (conjunction === 'AND' && !tree.properties?.not) {
    return { ...tree, children1: { ...childMap(tree), ...childMap(added) } }
  }
  // An OR or negated root keeps its meaning by becoming a child of a new AND root.
  const root = treeFromRules([])
  const wrapped = { ...tree, id: tree.id ?? newId() }
  return { ...root, children1: { [wrapped.id as string]: wrapped, ...childMap(added) } }
}

/** A root group holding one blank rule: an empty editor shows the field picker, not just buttons. */
export function starterTree(): QueryNode {
  const id = newId()
  return {
    ...emptyTree(),
    children1: { [id]: { id, type: 'rule', properties: { field: null, operator: null, value: [], valueSrc: [] } } },
  }
}

const VALUELESS = new Set(['is_empty', 'is_not_empty', 'is_null', 'is_not_null'])

/** A rule the server and the browser evaluator would actually run. */
export function isCompleteRule(node: QueryNode): boolean {
  const p = node.properties ?? {}
  if (!p.field || !p.operator) return false
  if (VALUELESS.has(String(p.operator))) return true
  const values = (Array.isArray(p.value) ? p.value : [p.value])
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== null && v !== undefined && v !== '')
  return String(p.operator).includes('between') ? values.length >= 2 : values.length > 0
}

/** The tree without unfinished rules and the groups they leave empty; `null` if nothing is left. */
export function pruneTree(tree: QueryNode | null | undefined): QueryNode | null {
  if (!tree) return null
  if ((tree.type ?? 'group') === 'rule') return isCompleteRule(tree) ? tree : null
  const kept = childrenOf(tree)
    .map((child) => pruneTree(child))
    .filter((child): child is QueryNode => child !== null)
  if (!kept.length) return null
  return { ...tree, children1: Object.fromEntries(kept.map((child, i) => [child.id ?? `n${i}`, child] as const)) }
}

/** True when the tree carries no rules at all, however deeply nested. */
export function isEmptyTree(tree: QueryNode | null | undefined): boolean {
  return countRules(tree) === 0
}

/** How many rules the tree holds, complete or not. */
export function countRules(tree: QueryNode | null | undefined): number {
  if (!tree) return 0
  if (tree.type === 'rule') return 1
  return childrenOf(tree).reduce((total, child) => total + countRules(child), 0)
}

/** The rules of a tree, flattened — for the "active conditions" chips. */
export function flattenRules(tree: QueryNode | null | undefined): SimpleRule[] {
  if (!tree) return []
  if (tree.type === 'rule') {
    const p = tree.properties ?? {}
    return p.field ? [{ field: String(p.field), operator: String(p.operator ?? ''), value: (p.value as unknown[]) ?? [] }] : []
  }
  return childrenOf(tree).flatMap(flattenRules)
}

/**
 * Insert a copy of the node at `path` directly after it. Every id in the copy is
 * regenerated: two nodes sharing an id makes the builder edit both at once.
 * Returns null when the path no longer resolves (the tree changed under the click).
 */
export function duplicateNode(tree: QueryNode, path: readonly string[]): QueryNode | null {
  const trail = path.slice(1)
  if (trail.length === 0) return null
  const copy = structuredClone(tree)
  let parent: QueryNode = copy
  for (const id of trail.slice(0, -1)) {
    const next = childMap(parent)[id]
    if (!next) return null
    parent = next
  }
  const targetId = trail[trail.length - 1]
  const children = childMap(parent)
  const original = children[targetId]
  if (!original) return null
  const rebuilt: Record<string, QueryNode> = {}
  for (const [id, child] of Object.entries(children)) {
    rebuilt[id] = child
    if (id === targetId) {
      const clone = withFreshIds(structuredClone(original))
      rebuilt[clone.id as string] = clone
    }
  }
  parent.children1 = rebuilt
  return copy
}

export function childMap(node: QueryNode): Record<string, QueryNode> {
  const children = node.children1
  if (!children) return {}
  if (Array.isArray(children)) return Object.fromEntries(children.map((child, index) => [child.id ?? String(index), child] as const))
  return children
}

export function childrenOf(node: QueryNode): QueryNode[] {
  return Object.values(childMap(node))
}

function withFreshIds(node: QueryNode): QueryNode {
  node.id = newId()
  if (node.children1) {
    node.children1 = Object.fromEntries(
      childrenOf(node)
        .map((child) => withFreshIds(child))
        .map((child) => [child.id as string, child] as const),
    )
  }
  return node
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `n${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
