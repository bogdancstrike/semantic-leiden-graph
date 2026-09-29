/**
 * Evaluate a query-builder tree against one record, in the browser.
 *
 * For the questions whose data is already on screen — the nodes of the graph,
 * the metrics of the communities — a round trip would only add latency. The
 * semantics mirror the server compiler for the operators both support:
 * incomplete rules are skipped (they neither match nor exclude), text matching
 * is case- and accent-insensitive, and an empty tree matches everything.
 */

import type { QueryNode } from '@/api/types'
import { childrenOf } from './queryTree'

export type RecordValue = string | number | boolean | null | undefined
export type EvalRecord = Record<string, RecordValue>

const VALUELESS = new Set(['is_empty', 'is_not_empty', 'is_null', 'is_not_null'])

const fold = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

const words = (value: unknown) => fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

function flatten(raw: unknown): unknown[] {
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((item) => (Array.isArray(item) ? item : [item])).filter((v) => v !== null && v !== undefined && v !== '')
}

/** True / false for a complete rule; `null` for one still being written. */
function evaluateRule(node: QueryNode, record: EvalRecord): boolean | null {
  const p = node.properties ?? {}
  const field = p.field ? String(p.field) : ''
  const operator = String(p.operator ?? '')
  if (!field || !operator) return null
  const values = flatten(p.value)
  if (!values.length && !VALUELESS.has(operator)) return null
  const actual = record[field]
  const first = values[0]
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))
  const present = actual !== null && actual !== undefined && actual !== ''

  switch (operator) {
    case 'is_empty':
    case 'is_null':
      return !present
    case 'is_not_empty':
    case 'is_not_null':
      return present
    case 'equal':
    case 'select_equals':
      return typeof actual === 'number' ? actual === num(first) : fold(actual) === fold(first)
    case 'not_equal':
    case 'select_not_equals':
      return typeof actual === 'number' ? actual !== num(first) : fold(actual) !== fold(first)
    case 'select_any_in':
      return values.some((v) => (typeof actual === 'number' ? actual === num(v) : fold(actual) === fold(v)))
    case 'select_not_any_in':
      return !values.some((v) => (typeof actual === 'number' ? actual === num(v) : fold(actual) === fold(v)))
    case 'less':
      return present && num(actual) < num(first)
    case 'less_or_equal':
      return present && num(actual) <= num(first)
    case 'greater':
      return present && num(actual) > num(first)
    case 'greater_or_equal':
      return present && num(actual) >= num(first)
    case 'between':
      return values.length < 2 ? null : present && num(actual) >= num(values[0]) && num(actual) <= num(values[1])
    case 'not_between':
      return values.length < 2 ? null : !(present && num(actual) >= num(values[0]) && num(actual) <= num(values[1]))
    case 'like': {
      // Every word of the value, anywhere — the same reading as the server's full-text "contains".
      const hay = fold(actual)
      return words(first).every((w) => hay.includes(w))
    }
    case 'not_like': {
      const hay = fold(actual)
      return !words(first).every((w) => hay.includes(w))
    }
    case 'any_words': {
      const hay = fold(actual)
      return words(first).some((w) => hay.includes(w))
    }
    case 'phrase':
      return fold(actual).includes(fold(first))
    case 'starts_with':
      return fold(actual).startsWith(fold(first))
    case 'ends_with':
      return fold(actual).endsWith(fold(first))
    default:
      return null
  }
}

function evaluateNode(node: QueryNode, record: EvalRecord, depth: number): boolean | null {
  if (depth > 12) return null
  if ((node.type ?? 'group') === 'rule') return evaluateRule(node, record)
  const conjunction = String(node.properties?.conjunction ?? 'AND').toUpperCase()
  const results = childrenOf(node)
    .map((child) => evaluateNode(child, record, depth + 1))
    .filter((r): r is boolean => r !== null)
  if (!results.length) return null
  const combined = conjunction === 'OR' ? results.some(Boolean) : results.every(Boolean)
  return node.properties?.not ? !combined : combined
}

/** Whether the record satisfies the tree. An empty or unfinished tree matches everything. */
export function matchesTree(tree: QueryNode | null | undefined, record: EvalRecord): boolean {
  if (!tree) return true
  return evaluateNode(tree, record, 0) ?? true
}

/** A plain-language reading of a tree, for chips and captions. */
export function describeTreeLocally(tree: QueryNode | null | undefined, labels: Record<string, string> = {}): string {
  if (!tree) return ''
  const walk = (node: QueryNode, depth: number): string => {
    if ((node.type ?? 'group') === 'rule') {
      const p = node.properties ?? {}
      if (!p.field || !p.operator) return ''
      const values = flatten(p.value)
      const op = String(p.operator)
      const label = labels[String(p.field)] ?? String(p.field)
      const words: Record<string, string> = {
        equal: '=', not_equal: '≠', select_equals: 'is', select_not_equals: 'is not', less: '<', less_or_equal: '≤',
        greater: '>', greater_or_equal: '≥', like: 'contains', not_like: 'does not contain', any_words: 'has any of',
        phrase: 'has phrase', starts_with: 'starts with', ends_with: 'ends with', select_any_in: 'is one of',
        select_not_any_in: 'is none of', between: 'between', not_between: 'not between', is_empty: 'is empty',
        is_not_empty: 'is not empty', is_null: 'is empty', is_not_null: 'is not empty', query_syntax: 'matches',
      }
      if (VALUELESS.has(op)) return `${label} ${words[op] ?? op}`
      if (!values.length) return ''
      const shown = op.includes('between') ? values.slice(0, 2).join(' and ') : values.join(', ')
      return `${label} ${words[op] ?? op} ${shown}`
    }
    const parts = childrenOf(node).map((c) => walk(c, depth + 1)).filter(Boolean)
    if (!parts.length) return ''
    const joined = parts.join(` ${String(node.properties?.conjunction ?? 'AND').toLowerCase()} `)
    const body = depth > 0 && parts.length > 1 ? `(${joined})` : joined
    return node.properties?.not ? `not ${depth > 0 || parts.length === 1 ? body : `(${body})`}` : body
  }
  return walk(tree, 0)
}
