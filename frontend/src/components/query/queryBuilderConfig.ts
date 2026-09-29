/**
 * The bridge between a field catalogue and react-awesome-query-builder.
 *
 * Two kinds of catalogue feed it: the server's (`GET /explore/fields`, compiled
 * to Elasticsearch by `app/search/conditions.py`) and small client-side ones
 * (graph nodes, community metrics) evaluated in the browser by `evaluate.ts`.
 * Either way a field offers exactly the operators its evaluator honours — an
 * operator the builder shows is an operator that will run.
 *
 * Adapted from the Nucleus template's explorer configuration.
 */

import { Tooltip } from 'antd'
import { createElement, type ReactElement } from 'react'
import { AntdConfig } from '@react-awesome-query-builder/antd'
import type { Config, Operators, Type, Types, Widgets } from '@react-awesome-query-builder/antd'
import type { ExploreFieldKind } from '@/api/types'

/** A field the builder can edit, whichever catalogue it came from. */
export interface BuilderField {
  name: string
  label: string
  kind: ExploreFieldKind | 'boolean'
  operators: string[]
  choices?: { value: string | number; label: string; count?: number }[]
  group?: string
  description?: string
  min?: number
  max?: number
  step?: number
}

const BUILDER_TYPE: Record<BuilderField['kind'], string> = {
  fulltext: 'text',
  keyword: 'text',
  enum: 'select',
  community: 'select',
  metadata: 'select',
  number: 'number',
  datetime: 'datetime',
  boolean: 'boolean',
}

/** Full-text operators the library does not ship; Elasticsearch has all three. */
export const FULLTEXT_OPERATORS = {
  any_words: { label: 'has any of the words', labelForFormat: 'ANY', cardinality: 1 },
  phrase: { label: 'has the exact phrase', labelForFormat: 'PHRASE', cardinality: 1 },
  query_syntax: { label: 'matches query syntax', labelForFormat: 'QUERY', cardinality: 1 },
}

/** The words the operator dropdown shows — the same vocabulary the inspector reads back. */
const OPERATOR_LABEL: Record<string, string> = {
  equal: '=',
  not_equal: '≠',
  select_equals: 'is',
  select_not_equals: 'is not',
  less: '<',
  less_or_equal: '≤',
  greater: '>',
  greater_or_equal: '≥',
  like: 'contains',
  not_like: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  between: 'between',
  not_between: 'not between',
  select_any_in: 'is one of',
  select_not_any_in: 'is none of',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  is_null: 'is empty',
  is_not_null: 'is not empty',
}

function operatorDefinitions(): Operators {
  const base = Object.fromEntries(
    Object.entries(AntdConfig.operators).map(([name, definition]) => [
      name,
      name in OPERATOR_LABEL ? { ...definition, label: OPERATOR_LABEL[name] } : definition,
    ]),
  )
  return { ...base, ...FULLTEXT_OPERATORS } as Operators
}

function builderTypes(): Types {
  const types = AntdConfig.types
  const text = types.text as Type
  return {
    ...types,
    text: {
      ...text,
      widgets: {
        ...text.widgets,
        text: {
          ...text.widgets?.text,
          operators: [...(text.widgets?.text?.operators ?? []), ...Object.keys(FULLTEXT_OPERATORS)],
        },
      },
    },
  }
}

function builderWidgets(): Widgets {
  const widgets = AntdConfig.widgets
  // Every value control carries a name; the library renders bare inputs otherwise,
  // which a screen reader announces as "edit text" with nothing to say what for.
  const labelled = Object.fromEntries(
    Object.entries(widgets).map(([name, widget]) => [
      name,
      { ...widget, customProps: { ...(widget as { customProps?: object }).customProps, 'aria-label': 'Value' } },
    ]),
  )
  return {
    ...labelled,
    // Elasticsearch's default date parser wants the ISO "T", not a space.
    datetime: { ...labelled.datetime, valueFormat: 'YYYY-MM-DDTHH:mm:ss' },
  } as Widgets
}

function fieldSettings(field: BuilderField): Record<string, unknown> {
  if (BUILDER_TYPE[field.kind] === 'select') {
    return {
      listValues: (field.choices ?? []).map((choice) => ({
        value: choice.value,
        title: choice.count !== undefined ? `${choice.label} · ${choice.count.toLocaleString()}` : choice.label,
      })),
      // A long tail of values is not all in the catalogue; typing one must still work.
      allowCustomValues: field.kind !== 'community',
      showSearch: true,
    }
  }
  if (field.kind === 'number') return { min: field.min, max: field.max, step: field.step }
  return {}
}

const BUTTON_HELP: Record<string, { title: string; name: string }> = {
  addRule: { title: 'One condition — a field, a comparison and a value', name: 'Add a rule' },
  addGroup: { title: 'A bracket: rules inside it are answered together, then combined with the rest', name: 'Add a group' },
  addSubRule: { title: 'A condition inside this group', name: 'Add a rule here' },
  addSubRuleSimple: { title: 'A condition inside this group', name: 'Add a rule here' },
  addSubGroup: { title: 'A bracket inside this one', name: 'Add a group here' },
  delRule: { title: 'Remove this rule', name: 'Remove this rule' },
  delGroup: { title: 'Remove this group and everything in it', name: 'Remove this group' },
  delRuleGroup: { title: 'Remove this group and everything in it', name: 'Remove this group' },
}

type ButtonFactory = NonNullable<typeof AntdConfig.settings.renderButton>

/** The library's icon buttons carry no name; wrapping gives each a label and a tooltip. */
const renderLabelledButton = ((props, ctx) => {
  const type = String(props.type ?? '')
  const help = BUTTON_HELP[type]
  const original = AntdConfig.settings.renderButton as ButtonFactory
  const button = original({ ...props, ...(help ? { 'aria-label': help.name } : {}) }, ctx)
  return help ? (createElement(Tooltip, { title: help.title, key: type }, button) as ReactElement) : button
}) as ButtonFactory

export function queryBuilderConfig(fields: BuilderField[]): Config {
  return {
    ...AntdConfig,
    types: builderTypes(),
    operators: operatorDefinitions(),
    widgets: builderWidgets(),
    settings: {
      ...AntdConfig.settings,
      showNot: true,
      canReorder: true,
      canRegroup: true,
      maxNesting: 12,
      maxNumberOfRules: 200,
      renderSize: 'small',
      // A half-built rule is the normal state of an editor in use; the server
      // and the client evaluator both skip it. Dropping it on load would make
      // "Add rule" appear to do nothing.
      removeEmptyRulesOnLoad: false,
      removeIncompleteRulesOnLoad: false,
      removeEmptyGroupsOnLoad: false,
      valueSourcesInfo: { value: { label: 'Value' } },
      fieldSources: ['field'],
      renderButton: renderLabelledButton,
      customFieldSelectProps: { 'aria-label': 'Field', showSearch: true },
      customOperatorSelectProps: { 'aria-label': 'Comparison' },
      addRuleLabel: 'Rule',
      addGroupLabel: 'Group',
      notLabel: 'Not',
      fieldPlaceholder: 'Choose a field',
      operatorPlaceholder: 'Comparison',
      valuePlaceholder: 'Value',
    },
    fields: Object.fromEntries(
      fields.map((field) => [
        field.name,
        {
          label: field.label,
          type: BUILDER_TYPE[field.kind],
          operators: field.operators,
          valueSources: ['value'],
          fieldSettings: fieldSettings(field),
          ...(field.description ? { tooltip: field.description } : {}),
        },
      ]),
    ),
  } as Config
}
