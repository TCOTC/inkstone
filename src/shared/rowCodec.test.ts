import assert from 'node:assert/strict'
import test from 'node:test'
import {decodeHighlight, decodePage, decodeRows, encodePage, encodeHighlight, isLocalHighlight, isPageRow, type PageRow} from './rowCodec'
import type {HighlightRecord, PageRecord} from './types'

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    url: 'https://example.com/a',
    title: '标题',
    createdAt: 100,
    highlights: [record()],
    ...overrides
  }
}

function record(): HighlightRecord {
  return {id: 7, text: '原文', prev: '前文', next: '后文', createdAt: 50}
}

test('encodePage：键名缩到 1~2 个字母', () => {
  assert.deepEqual(encodePage(page()), {
    u: 'https://example.com/a',
    t: '标题',
    c: 100,
    h: [{i: 7, x: '原文', p: '前文', q: '后文', c: 50}]
  })
})

test('encode → decode 是恒等映射', () => {
  const source = page()
  assert.deepEqual(decodePage(encodePage(source)), source)
})

test('decodePage：缺字段按默认值补齐，不抛异常', () => {
  const decoded = decodePage({u: 'https://x/y'} as PageRow)
  assert.deepEqual(decoded, {url: 'https://x/y', title: '', createdAt: 0, highlights: []})
})

test('isLocalHighlight：只看 local 字段', () => {
  assert.equal(isLocalHighlight({...record(), local: true}), true)
  assert.equal(isLocalHighlight(record()), false)
})

test('encodeHighlight：只有本地线才写 `l` 键', () => {
  assert.deepEqual(encodeHighlight({...record(), local: true}), {
    i: 7,
    x: '原文',
    p: '前文',
    q: '后文',
    c: 50,
    l: 1
  })
  assert.equal('l' in encodeHighlight(record()), false)
})

test('decodeHighlight：`i` 必须是正整数，否则补 0', () => {
  const base = {x: '原文', p: '', q: '', c: 1}
  assert.equal(decodeHighlight({...base, i: 3} as PageRow['h'][number]).id, 3)
  assert.equal(decodeHighlight({...base, i: '3'} as unknown as PageRow['h'][number]).id, 0)
  assert.equal(decodeHighlight({...base, i: 0} as PageRow['h'][number]).id, 0)
  assert.equal(decodeHighlight({...base, i: -2} as PageRow['h'][number]).id, 0)
})

test('isPageRow：没有 url 的记录不算页面（没有键可写）', () => {
  assert.equal(isPageRow({u: 'https://x'}), true)
  assert.equal(isPageRow({u: ''}), false)
  assert.equal(isPageRow({t: '只'}), false)
  assert.equal(isPageRow(null), false)
  assert.equal(isPageRow('not a row'), false)
})

test('decodeRows：丢掉坏记录，保留好记录', () => {
  const rows = [encodePage(page({url: 'https://a'})), {n: 'oops'}, {u: 'https://b'}]
  assert.deepEqual(decodeRows(rows).map((item) => item.url), ['https://a', 'https://b'])
})
