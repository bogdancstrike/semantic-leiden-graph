import { Tooltip } from 'antd'

export interface PageDocEntry {
  /** Three or four words each. */
  what: string
  flow: string
  tech: string
  why: string
  how: string
  /** Longer explanations, shown on hover. */
  details?: Partial<Record<'what' | 'flow' | 'tech' | 'why' | 'how', string>>
}

const LABELS = [
  ['what', 'What'],
  ['flow', 'Flow'],
  ['tech', 'Tech'],
  ['why', 'Why'],
  ['how', 'How'],
] as const

/**
 * The page's own documentation, in its footer: what it does, how data flows,
 * which technologies answer, why it exists and how to use it — a few words
 * each, with the longer sentence on hover.
 */
export function PageDoc({ doc }: { doc: PageDocEntry }) {
  return (
    <footer className="nu-pagedoc" aria-label="About this page">
      {LABELS.map(([key, label]) => {
        const body = (
          <span className="nu-pagedoc-item">
            <span className="nu-pagedoc-key">{label}</span>
            <span className="nu-pagedoc-value">{doc[key]}</span>
          </span>
        )
        const detail = doc.details?.[key]
        return detail ? (
          <Tooltip key={key} title={detail}>
            {body}
          </Tooltip>
        ) : (
          <span key={key}>{body}</span>
        )
      })}
    </footer>
  )
}
