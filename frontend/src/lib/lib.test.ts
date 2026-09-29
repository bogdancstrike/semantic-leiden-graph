import { describe, expect, it } from 'vitest'
import {
  binaryKind,
  carryMapping,
  checkMapping,
  defaultMapping,
  detectEncoding,
  guessDelimiter,
  parseHead,
  previewCsv,
  suggestColumns,
  uniqueHeaders,
  uploadFields,
} from './csv'
import { fmtBytes, fmtMs } from './format'
import { communityColor, UNASSIGNED_COLOR } from './palette'
import { parseHighlight, stripMarkers } from './highlight'
import { toCsv } from './download'
import { matchesTree, describeTreeLocally } from '../components/query/evaluate'
import { countRules, emptyTree, flattenRules, pruneTree, starterTree, treeFromRules, withRules } from '../components/query/queryTree'
import { similarityBand } from '../hooks/useUrlState'
import { isChunkLoadError } from './lazyPage'

describe('parseHighlight', () => {
  it('splits control-character markers into segments', () => {
    expect(parseHighlight('a \u0002rail\u0003 way')).toEqual([
      { text: 'a ', marked: false },
      { text: 'rail', marked: true },
      { text: ' way', marked: false },
    ])
  })
  it('never interprets HTML', () => {
    const segments = parseHighlight('<img onerror=x> \u0002ok\u0003')
    expect(segments[0].text).toBe('<img onerror=x> ')
  })
  it('recovers a fragment that starts inside a match (opening marker trimmed by ES)', () => {
    expect(parseHighlight('Romania\u0003 plans \u0002rail\u0003')).toEqual([
      { text: 'Romania', marked: true },
      { text: ' plans ', marked: false },
      { text: 'rail', marked: true },
    ])
  })
  it('tolerates an unterminated marker', () => {
    expect(parseHighlight('\u0002open')).toEqual([{ text: 'open', marked: true }])
    expect(stripMarkers('\u0002a\u0003b')).toBe('ab')
  })
})

describe('csv reading', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  it('names columns like the server: blank, repeated and BOM-prefixed headers', () => {
    expect(uniqueHeaders(['﻿name', '', 'Name', 'text', ' name ', '  a \n b '])).toEqual(['name', 'column_2', 'Name_2', 'text', 'name_3', 'a b'])
  })

  it('detects the encoding from the bytes', () => {
    expect(detectEncoding(bytes('id,text\n1,Căi ferate\n'))).toBe('utf-8')
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8')
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe('utf-16le')
    expect(detectEncoding(new Uint8Array([0x61, 0x00, 0x2c, 0x00, 0x62, 0x00, 0x0a, 0x00]))).toBe('utf-16le')
    expect(detectEncoding(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe('windows-1252') // "café" in Windows-1252
  })

  it('names binary files instead of parsing them', () => {
    expect(binaryKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toMatch(/Excel workbook/)
    expect(binaryKind(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toMatch(/PDF/)
    expect(binaryKind(new Uint8Array([0x61, 0x00, 0x00, 0x00, 0x62, 0x07, 0x00, 0x00]))).toBe('binary data')
    expect(binaryKind(bytes('a,b\n'))).toBeNull()
  })

  it('guesses the separator that splits rows most consistently', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `r${i};"a, b, c ${i}";x`).join('\n')
    expect(guessDelimiter(`id;text;tag\n${rows}`)).toBe(';')
    expect(guessDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(guessDelimiter('just one column\nof text\n')).toBe(',')
  })

  it('uses and skips an Excel sep= line, and numbers the columns of a file without a header', () => {
    const withSep = parseHead('sep=;\nkey;body\nk1;"one; two"\n', { hasHeader: true }, true)
    expect(withSep).toMatchObject({ delimiter: ';', sepLine: true, columns: ['key', 'body'], rows: [['k1', 'one; two']] })
    const bare = parseHead('7\tfirst text\tnews\n8\tsecond\n', { hasHeader: false }, true)
    expect(bare.columns).toEqual(['column_1', 'column_2', 'column_3'])
    expect(bare.rows).toHaveLength(2)
  })

  it('previews a Windows-1252 file end to end, and re-reads it with a chosen encoding', async () => {
    const latin = new Uint8Array([...bytes('Title;Body\nx;caf'), 0xe9, ...bytes(' cr'), 0xe8, ...bytes('me\n')])
    const file = new File([latin], 'export.dat')
    const preview = await previewCsv(file)
    expect(preview.detected).toMatchObject({ encoding: 'windows-1252', delimiter: ';' })
    expect(preview.columns).toEqual(['Title', 'Body'])
    expect(preview.rows[0].Body).toBe('café crème')
    expect(preview.undecodable).toBe(0)
    const forced = await previewCsv(file, { encoding: 'utf-8' }, preview.head)
    expect(forced.undecodable).toBeGreaterThan(0)
    await expect(previewCsv(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'book.csv'))).rejects.toThrow(/Excel workbook/)
  })
})

describe('csv mapping', () => {
  const rows = [
    { key: 'a-1', title: 'Rail', body: 'A long body of text about railways and stations', year: '2021' },
    { key: 'a-2', title: 'Goal', body: 'Another long body about a football match', year: '2022' },
  ]
  const preview = async () => {
    const csv = ['key,title,body,year', ...rows.map((r) => `${r.key},${r.title},${r.body},${r.year}`)].join('\n')
    return previewCsv(new File([csv], 'x.csv'))
  }

  it('suggests the prose column to analyse and a unique id column', async () => {
    const p = await preview()
    expect(suggestColumns(p.columns, p.stats)).toEqual({ text: 'body', id: 'key' })
    expect(defaultMapping(p.columns, p.stats, 20)).toEqual({ textColumn: 'body', idColumn: 'key', metadataColumns: ['title', 'year'] })
    expect(defaultMapping(p.columns, p.stats, 1).metadataColumns).toEqual(['title'])
  })

  it('prefers the much longer column over a short one named like prose', async () => {
    const csv = 'summary,details\n' + Array.from({ length: 5 }, (_, i) => `ok ${i},"${'a long paragraph of real words '.repeat(4)}${i}"`).join('\n')
    const p = await previewCsv(new File([csv], 's.csv'))
    expect(suggestColumns(p.columns, p.stats).text).toBe('details')
  })

  it('blocks without a column to analyse and warns about the sample', async () => {
    const p = await preview()
    expect(checkMapping({ textColumn: null, idColumn: null, metadataColumns: [] }, p, 20).missing).toEqual(['Choose the column to analyse.'])
    expect(checkMapping({ textColumn: 'body', idColumn: null, metadataColumns: ['title', 'year'] }, p, 1).missing[0]).toMatch(/at most 1/)
    const numbers = checkMapping({ textColumn: 'year', idColumn: 'key', metadataColumns: [] }, p, 20)
    expect(numbers.missing).toEqual([])
    expect(numbers.problems[0]).toMatch(/mostly numbers/)
    expect(checkMapping({ textColumn: 'title', idColumn: null, metadataColumns: [] }, p, 20).problems[0]).toMatch(/short values/)
  })

  it('keeps the mapping across a re-parse where its columns survive', async () => {
    const p = await preview()
    const kept = carryMapping({ textColumn: 'body', idColumn: 'gone', metadataColumns: ['year', 'gone'] }, p.columns, p.stats, 20)
    expect(kept).toEqual({ textColumn: 'body', idColumn: null, metadataColumns: ['year'] })
    expect(carryMapping({ textColumn: 'gone', idColumn: null, metadataColumns: [] }, p.columns, p.stats, 20).textColumn).toBe('body')
  })

  it('sends the mapping and the format; the encoding only when chosen', () => {
    const mapping = { textColumn: 'body', idColumn: null, metadataColumns: ['year'] }
    const format = { delimiter: ';', encoding: 'windows-1250', hasHeader: false }
    expect(uploadFields(mapping, format, false)).toEqual({
      textColumn: 'body',
      idColumn: undefined,
      generateIds: true,
      metadataColumns: ['year'],
      delimiter: ';',
      hasHeader: false,
      encoding: undefined,
    })
    expect(uploadFields({ ...mapping, idColumn: 'key' }, format, true)).toMatchObject({ idColumn: 'key', generateIds: false, encoding: 'windows-1250' })
  })
})

describe('condition trees', () => {
  const tree = treeFromRules([
    { field: 'community_id', operator: 'select_any_in', value: [[1, 2]] },
    { field: 'text', operator: 'like', value: ['cai ferate'] },
  ])
  it('evaluates rules in the browser, accent-insensitively', () => {
    expect(matchesTree(tree, { community_id: 2, text: 'Investiții în căi ferate' })).toBe(true)
    expect(matchesTree(tree, { community_id: 3, text: 'căi ferate' })).toBe(false)
  })
  it('treats empty and unfinished trees as match-all', () => {
    expect(matchesTree(null, {})).toBe(true)
    expect(matchesTree(emptyTree(), { a: 1 })).toBe(true)
    expect(matchesTree(treeFromRules([{ field: 'size', operator: 'greater', value: [] }]), { size: 1 })).toBe(true)
  })
  it('honours OR, NOT and ranges', () => {
    const or = { ...treeFromRules([
      { field: 'size', operator: 'between', value: [10, 20] },
      { field: 'conductance', operator: 'less', value: [0.1] },
    ], 'OR') }
    expect(matchesTree(or, { size: 5, conductance: 0.05 })).toBe(true)
    expect(matchesTree({ ...or, properties: { conjunction: 'OR', not: true } }, { size: 5, conductance: 0.05 })).toBe(false)
  })
  it('prunes unfinished rules and the groups they empty', () => {
    expect(pruneTree(starterTree())).toBeNull()
    const mixed = withRules(tree, [{ field: 'length', operator: 'between', value: [10] }])
    expect(countRules(pruneTree(mixed))).toBe(2)
    expect(countRules(pruneTree(treeFromRules([{ field: 'community_id', operator: 'is_null', value: [] }])))).toBe(1)
  })
  it('merges rules into an existing tree and reads it back', () => {
    const merged = withRules(tree, [{ field: 'length', operator: 'greater', value: [100] }])
    expect(countRules(merged)).toBe(3)
    expect(flattenRules(merged).map((r) => r.field)).toEqual(['community_id', 'text', 'length'])
    expect(describeTreeLocally(merged, { length: 'Length' })).toContain('Length > 100')
  })
})

describe('formatting, colour and export', () => {
  it('formats durations and sizes', () => {
    expect(fmtMs(0.2)).toBe('<1 ms')
    expect(fmtMs(1500)).toBe('1.50 s')
    expect(fmtBytes(2048)).toBe('2.0 KB')
  })
  it('colours are stable per community and grey for unassigned', () => {
    expect(communityColor(7)).toBe(communityColor(7))
    expect(communityColor(null)).toBe(UNASSIGNED_COLOR)
  })
  it('writes RFC 4180 CSV and defuses formulas', () => {
    expect(toCsv([{ a: 'x,y', b: '=1+1' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }])).toBe('A,B\n"x,y",\'=1+1')
  })
})

describe('similarityBand', () => {
  it('defaults to the full band', () => {
    expect(similarityBand(null, null)).toEqual([0, 1])
    expect(similarityBand('', 'abc')).toEqual([0, 1])
  })
  it('reads and clamps both bounds', () => {
    expect(similarityBand('0.6', '0.85')).toEqual([0.6, 0.85])
    expect(similarityBand('-2', '7')).toEqual([0, 1])
    expect(similarityBand('0', '0')).toEqual([0, 0])
  })
  it('reads crossed bounds as the band between them', () => {
    expect(similarityBand('0.9', '0.4')).toEqual([0.4, 0.9])
  })
})

describe('chunk load errors after a deploy', () => {
  it('recognises every browser wording, and nothing else', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/ImportPage-DVrSuKv5.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: http://x/a.js'))).toBe(true) // Firefox
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true) // Safari
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true) // Vite
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch')).toBe(false) // an API call, not a chunk
  })
})
