const integer = new Intl.NumberFormat('en-US')

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : integer.format(n))

export const fmtScore = (n: number | null | undefined, digits = 3) =>
  n === null || n === undefined ? '—' : n.toFixed(digits)

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return relative.format(seconds, 'second')
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour')
  return relative.format(Math.round(seconds / 86400), 'day')
}

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)
