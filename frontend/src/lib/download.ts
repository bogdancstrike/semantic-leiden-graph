/** Client-side file downloads: CSV and JSON of what is already on screen. */

export function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  // RFC 4180 quoting, plus a leading apostrophe against spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  return [columns.map((c) => cell(c.label)).join(','), ...rows.map((row) => columns.map((c) => cell(row[c.key])).join(','))].join('\n')
}
