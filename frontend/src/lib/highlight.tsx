import { Fragment, type ReactNode } from 'react'

// Elasticsearch is asked to wrap matches in U+0002 / U+0003 instead of HTML tags.
// Splitting on control characters lets React render <mark> nodes with zero innerHTML,
// so document text can never inject markup into the page.
export const HL_PRE = '\u0002'
export const HL_POST = '\u0003'

export interface Segment {
  text: string
  marked: boolean
}

export function parseHighlight(fragment: string): Segment[] {
  const segments: Segment[] = []
  let rest = fragment
  // Elasticsearch trims each fragment with Java's String.trim(), which also strips
  // control characters: a fragment that *starts* inside a match loses its opening
  // marker. A closing marker before any opening one means exactly that.
  const firstPost = rest.indexOf(HL_POST)
  const firstPre = rest.indexOf(HL_PRE)
  if (firstPost !== -1 && (firstPre === -1 || firstPost < firstPre)) {
    segments.push({ text: rest.slice(0, firstPost), marked: true })
    rest = rest.slice(firstPost + 1)
  }
  while (rest.length > 0) {
    const start = rest.indexOf(HL_PRE)
    if (start === -1) {
      segments.push({ text: rest, marked: false })
      break
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), marked: false })
    const end = rest.indexOf(HL_POST, start + 1)
    if (end === -1) {
      segments.push({ text: rest.slice(start + 1), marked: true })
      break
    }
    segments.push({ text: rest.slice(start + 1, end), marked: true })
    rest = rest.slice(end + 1)
  }
  return segments.filter((s) => s.text.length > 0)
}

export function Highlighted({ fragment }: { fragment: string }): ReactNode {
  return (
    <>
      {parseHighlight(fragment).map((segment, i) =>
        segment.marked ? <mark key={i}>{segment.text}</mark> : <Fragment key={i}>{segment.text}</Fragment>,
      )}
    </>
  )
}

export function stripMarkers(fragment: string): string {
  return fragment.replaceAll(HL_PRE, '').replaceAll(HL_POST, '')
}
