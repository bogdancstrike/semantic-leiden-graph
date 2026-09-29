import Papa from 'papaparse'
import type { UploadOptions } from '@/api/types'

/**
 * Reading any delimited text file in the browser, the way the server will read it.
 *
 * Only the head of the file is read (`HEAD_BYTES`), so a 1 GB file previews at once.
 * Encoding, separator, the Excel `sep=` line, the optional header row and the rule that
 * turns header cells into unique column names all mirror `app/pipeline/csv_reader.py`,
 * so the column the reader picks here is the column the server analyses.
 */

export const HEAD_BYTES = 256 * 1024
/** Rows drawn in the preview table; the checks and statistics use every row of the head. */
export const PREVIEW_ROWS = 10
const SNIFF_RECORDS = 50
const STATS_ROWS = 200

export const DELIMITERS = [',', ';', '\t', '|'] as const

export const DELIMITER_OPTIONS = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' },
]

/** Values the server accepts too (Python codec names or aliases). */
export const ENCODING_OPTIONS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'windows-1252', label: 'Windows-1252 (Western European)' },
  { value: 'windows-1250', label: 'Windows-1250 (Central European, Romanian)' },
  { value: 'iso-8859-2', label: 'ISO-8859-2 (Latin-2)' },
  { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
]

export const delimiterName = (d: string) =>
  DELIMITER_OPTIONS.find((o) => o.value === d)?.label ?? (d === ' ' ? 'Space' : `“${d}”`)
export const encodingName = (e: string) => ENCODING_OPTIONS.find((o) => o.value === e)?.label ?? e

/** How to read the file: what the reader chose, or what was detected. */
export interface CsvFormat {
  delimiter: string
  encoding: string
  hasHeader: boolean
}

export interface ColumnStats {
  /** Non-empty values among the sampled rows. */
  filled: number
  avgLength: number
  /** Every sampled row has a value and no value repeats. */
  unique: boolean
  /** Share of non-empty values that are numbers. */
  numeric: number
}

export interface CsvPreview {
  format: CsvFormat
  detected: { delimiter: string; encoding: string; sepLine: boolean }
  columns: string[]
  /** Data rows of the head (all of them; the table shows the first PREVIEW_ROWS). */
  rows: Record<string, string>[]
  samples: Record<string, string[]>
  stats: Record<string, ColumnStats>
  /** Whole file read, or an estimate from the head's bytes per row. */
  estimatedRows: number
  wholeFile: boolean
  /** Characters the chosen encoding could not decode (U+FFFD) in the head. */
  undecodable: number
  /** Sampled rows with more cells than there are columns. */
  wideRows: number
}

/** What the file's columns become. */
export interface ColumnMapping {
  /** The column whose text is embedded, linked and clustered. */
  textColumn: string | null
  /** null: ids are generated from the text, so re-imports stay idempotent. */
  idColumn: string | null
  /** Kept in Elasticsearch, filterable in Explore, never embedded. */
  metadataColumns: string[]
}

export interface MappingCheck {
  /** Blocking: the import cannot start. */
  missing: string[]
  /** Non-blocking notes about the sampled rows. */
  problems: string[]
}

// ---------------------------------------------------------------------------- bytes

const SIGNATURES: [number[], string][] = [
  [[0x50, 0x4b, 0x03, 0x04], 'an Excel workbook or a ZIP archive (.xlsx, .zip)'],
  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'a legacy Excel or Office file (.xls)'],
  [[0x1f, 0x8b], 'a gzip archive'],
  [[0x25, 0x50, 0x44, 0x46], 'a PDF document'],
  [[0x89, 0x50, 0x4e, 0x47], 'a PNG image'],
  [[0xff, 0xd8, 0xff], 'a JPEG image'],
]

export async function readHead(file: File, bytes = HEAD_BYTES): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer())
}

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b)

function utf16Order(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sample = bytes.subarray(0, 4096)
  const half = Math.max(Math.floor(sample.length / 2), 1)
  let even = 0
  let odd = 0
  sample.forEach((b, i) => {
    if (b === 0) i % 2 ? (odd += 1) : (even += 1)
  })
  if (odd > half * 0.3 && even < half * 0.05) return 'utf-16le'
  if (even > half * 0.3 && odd < half * 0.05) return 'utf-16be'
  return null
}

/** What a non-text file is, for a message naming it; null for text. */
export function binaryKind(bytes: Uint8Array): string | null {
  for (const [signature, kind] of SIGNATURES) if (startsWith(bytes, signature)) return kind
  const hasBom = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])
  if (!hasBom && bytes.subarray(0, 4096).includes(0) && !utf16Order(bytes)) return 'binary data'
  return null
}

/** The encoding to read the file with: BOM, UTF-16 pattern, valid UTF-8, else Windows-1252. */
export function detectEncoding(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return 'utf-8'
  if (startsWith(bytes, [0xff, 0xfe])) return 'utf-16le'
  if (startsWith(bytes, [0xfe, 0xff])) return 'utf-16be'
  const order = bytes.subarray(0, 4096).includes(0) ? utf16Order(bytes) : null
  if (order) return order
  try {
    // `stream` tolerates a character cut in half at the end of the head.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

// ---------------------------------------------------------------------------- text

/** Header cells as usable, unique column names (mirrors `unique_headers` on the server). */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Set<string>()
  return raw.map((cell, i) => {
    const base = cell.replace(/﻿/g, '').split(/\s+/).filter(Boolean).join(' ') || `column_${i + 1}`
    let name = base
    let n = 2
    while (seen.has(name.toLowerCase())) {
      name = `${base}_${n}`
      n += 1
    }
    seen.add(name.toLowerCase())
    return name
  })
}

const blank = (record: string[]) => !record.some((cell) => cell.trim())

function records(text: string, delimiter: string, limit?: number): string[][] {
  const result = Papa.parse<string[]>(text, { delimiter, header: false, skipEmptyLines: 'greedy', preview: limit ?? 0 })
  return result.data.filter((r) => !blank(r))
}

/** The candidate that splits the first records into the most consistent cell count. */
export function guessDelimiter(text: string): string {
  let best = ','
  let bestScore: [number, number] = [0, 0]
  for (const candidate of DELIMITERS) {
    const sample = records(text, candidate, SNIFF_RECORDS)
    if (!sample.length) continue
    const counts = new Map<number, number>()
    sample.forEach((r) => counts.set(r.length, (counts.get(r.length) ?? 0) + 1))
    const [width, frequency] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]
    const score: [number, number] = width > 1 ? [frequency, width] : [0, 0]
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

const SEP_LINE = /^﻿?sep=(.)\s*$/i

export interface ParsedHead {
  delimiter: string
  guessed: string
  sepLine: boolean
  columns: string[]
  rows: string[][]
}

/** Records of the head: sep= line, separator, header row, unique column names. */
export function parseHead(text: string, options: { delimiter?: string | null; hasHeader: boolean }, wholeFile: boolean): ParsedHead {
  let body = text
  const firstLine = body.split('\n', 1)[0].replace(/\r$/, '')
  const sep = SEP_LINE.exec(firstLine)
  if (sep) body = body.includes('\n') ? body.slice(body.indexOf('\n') + 1) : ''
  const guessed = sep ? sep[1] : guessDelimiter(body)
  const delimiter = options.delimiter || guessed
  let all = records(body, delimiter)
  // The head of a larger file may end inside a record (a quoted cell with line breaks).
  if (!wholeFile && all.length > 1) all = all.slice(0, -1)
  const first = all.slice(0, SNIFF_RECORDS)
  const width = first.reduce((w, r) => Math.max(w, r.length), 0)
  const columns = options.hasHeader ? uniqueHeaders(all[0] ?? []) : uniqueHeaders(Array.from({ length: width }, () => ''))
  return { delimiter, guessed, sepLine: !!sep, columns, rows: options.hasHeader ? all.slice(1) : all }
}

function columnStats(columns: string[], rows: Record<string, string>[]): Record<string, ColumnStats> {
  const sample = rows.slice(0, STATS_ROWS)
  return Object.fromEntries(
    columns.map((c) => {
      const values = sample.map((r) => (r[c] ?? '').trim()).filter(Boolean)
      const numeric = values.filter((v) => /^[-+]?\d[\d.,\s]*$/.test(v)).length
      return [
        c,
        {
          filled: values.length,
          avgLength: values.length ? values.reduce((s, v) => s + v.length, 0) / values.length : 0,
          unique: values.length === sample.length && sample.length > 0 && new Set(values).size === values.length,
          numeric: values.length ? numeric / values.length : 0,
        },
      ]
    }),
  )
}

/**
 * Preview a file. `choice` fields left null are detected; pass the bytes of a previous
 * read to re-parse with another separator, encoding or header setting without re-reading.
 */
export async function previewCsv(
  file: File,
  choice: { delimiter?: string | null; encoding?: string | null; hasHeader?: boolean } = {},
  head?: Uint8Array,
): Promise<CsvPreview & { head: Uint8Array }> {
  const bytes = head ?? (await readHead(file))
  const kind = binaryKind(bytes)
  if (kind) throw new Error(`“${file.name}” is ${kind}, not delimited text. Save or export it as CSV and choose that file.`)
  const detectedEncoding = detectEncoding(bytes)
  const encoding = choice.encoding || detectedEncoding
  const wholeFile = file.size <= bytes.length
  let text = new TextDecoder(encoding).decode(bytes)
  if (!wholeFile && text.includes('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
  if (!text.trim()) throw new Error(`“${file.name}” is empty.`)
  const hasHeader = choice.hasHeader ?? true
  const parsed = parseHead(text, { delimiter: choice.delimiter, hasHeader }, wholeFile)
  const width = parsed.columns.length
  const rows = parsed.rows.map((record) => Object.fromEntries(parsed.columns.map((c, i) => [c, record[i] ?? ''])))
  const dataRows = rows.length
  return {
    head: bytes,
    format: { delimiter: parsed.delimiter, encoding, hasHeader },
    detected: { delimiter: parsed.guessed, encoding: detectedEncoding, sepLine: parsed.sepLine },
    columns: parsed.columns,
    rows,
    samples: Object.fromEntries(parsed.columns.map((c) => [c, rows.map((r) => r[c].trim()).filter(Boolean).slice(0, 3)])),
    stats: columnStats(parsed.columns, rows),
    estimatedRows: wholeFile ? dataRows : Math.round((file.size / bytes.length) * dataRows),
    wholeFile,
    undecodable: (text.match(/�/g) ?? []).length,
    wideRows: parsed.rows.filter((r) => r.length > width).length,
  }
}

// ---------------------------------------------------------------------------- mapping

/** Names that usually hold prose, best first; the fallback is the longest values. */
const TEXT_NAMES = ['text', 'body', 'content', 'abstract', 'description', 'message', 'summary', 'review', 'comment', 'article', 'post', 'tweet', 'notes', 'note']
const ID_NAMES = ['id', 'key', 'uuid', 'guid', 'identifier', 'doc_id', 'document_id', 'record_id']

/** The first guess: the column to analyse and, if one looks like it, the id column. */
export function suggestColumns(columns: string[], stats: Record<string, ColumnStats>): { text: string | null; id: string | null } {
  const byName = (names: string[]) => {
    for (const name of names) {
      const found = columns.find((c) => c.toLowerCase() === name)
      if (found) return found
    }
    return null
  }
  const named = byName(ID_NAMES)
  const id = named && stats[named]?.unique ? named : null
  const prose = columns
    .filter((c) => c !== id && (stats[c]?.numeric ?? 0) < 0.5 && (stats[c]?.filled ?? 0) > 0)
    .sort((a, b) => (stats[b]?.avgLength ?? 0) - (stats[a]?.avgLength ?? 0))
  const namedText = byName(TEXT_NAMES)
  // A column named like prose wins unless another column is much longer (a "summary"
  // of a few words next to a real "body" of paragraphs).
  const longest = prose[0] ?? null
  const text =
    namedText && namedText !== id && (!longest || (stats[namedText]?.avgLength ?? 0) * 3 >= (stats[longest]?.avgLength ?? 0))
      ? namedText
      : (longest ?? columns.find((c) => c !== id) ?? null)
  return { text, id }
}

export function defaultMapping(columns: string[], stats: Record<string, ColumnStats>, metadataMax: number): ColumnMapping {
  const { text, id } = suggestColumns(columns, stats)
  return { textColumn: text, idColumn: id, metadataColumns: columns.filter((c) => c !== text && c !== id).slice(0, metadataMax) }
}

/** The previous mapping, kept where its columns still exist after a re-parse. */
export function carryMapping(previous: ColumnMapping, columns: string[], stats: Record<string, ColumnStats>, metadataMax: number): ColumnMapping {
  if (!previous.textColumn || !columns.includes(previous.textColumn)) return defaultMapping(columns, stats, metadataMax)
  const idColumn = previous.idColumn && columns.includes(previous.idColumn) ? previous.idColumn : null
  return {
    textColumn: previous.textColumn,
    idColumn,
    metadataColumns: previous.metadataColumns.filter((c) => columns.includes(c) && c !== previous.textColumn && c !== idColumn),
  }
}

/** Pure validation of a mapping over the sampled rows; unit-tested apart from File I/O. */
export function checkMapping(mapping: ColumnMapping, preview: Pick<CsvPreview, 'rows' | 'stats'>, metadataMax: number): MappingCheck {
  const { rows, stats } = preview
  const missing: string[] = []
  const problems: string[] = []
  const text = mapping.textColumn
  if (!text) missing.push('Choose the column to analyse.')
  if (mapping.metadataColumns.length > metadataMax) missing.push(`Keep at most ${metadataMax} metadata columns.`)
  const sampled = Math.min(rows.length, STATS_ROWS)
  if (text && sampled) {
    const empty = rows.slice(0, STATS_ROWS).filter((r) => !(r[text] ?? '').trim()).length
    if (empty) problems.push(`${empty} of the first ${sampled} rows have no text in “${text}” and will be skipped.`)
    const s = stats[text]
    if (s && s.filled && s.numeric >= 0.8) problems.push(`“${text}” holds mostly numbers; choose a column with words to analyse.`)
    else if (s && s.filled && s.avgLength < 20)
      problems.push(`“${text}” holds short values (about ${Math.round(s.avgLength)} characters); similarity works best on sentences or paragraphs.`)
  }
  const id = mapping.idColumn
  if (id && sampled) {
    const values = rows.slice(0, STATS_ROWS).map((r) => (r[id] ?? '').trim())
    const empty = values.filter((v) => !v).length
    if (empty) problems.push(`${empty} of the first ${sampled} rows have an empty id and will be skipped.`)
    const repeats = values.filter(Boolean).length - new Set(values.filter(Boolean)).size
    if (repeats) problems.push(`${repeats} ids repeat in the first ${sampled} rows; a later row replaces the earlier one with the same id.`)
  }
  return { missing, problems }
}

/** The upload form fields for a mapping and a format (the encoding only when chosen). */
export function uploadFields(mapping: ColumnMapping, format: CsvFormat, encodingChosen: boolean): Partial<UploadOptions> {
  return {
    textColumn: mapping.textColumn ?? undefined,
    idColumn: mapping.idColumn ?? undefined,
    generateIds: !mapping.idColumn,
    metadataColumns: mapping.metadataColumns,
    delimiter: format.delimiter,
    hasHeader: format.hasHeader,
    // Left to the server when detected: it re-reads a mislabelled "UTF-8" file as
    // Windows-1252 if a byte further down proves it is not UTF-8.
    encoding: encodingChosen ? format.encoding : undefined,
  }
}

export const TEMPLATE_CSV =
  'title;body;desk;published\n' +
  'Rail funding;"The railway operator announced funding for modernization of passenger stations.";transport;2026-03-02\n' +
  'Late winner;"A late goal decided a closely contested football match in Madrid.";sports;2026-03-03\n' +
  'Căi ferate;"Guvernul pregătește investiții noi în infrastructura de căi ferate.";transport;2026-03-04\n'

export function downloadTemplate(): void {
  const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'semantic-leiden-example.csv'
  link.click()
  URL.revokeObjectURL(url)
}
