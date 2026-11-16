import assert from 'node:assert/strict'
import test from 'node:test'
import {decodeHighlight, decodePage, decodeRows, encodePage, encodeHighlight, isPageRow, type PageRow} from './rowCodec'
import type {HighlightRecord, PageRecord} from './types'

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    url: 'https://example.com/a',
    title: '标题',
    createdAtSec: 100,
    highlights: [record()],
    ...overrides
  }
}

function record(): HighlightRecord {
  return {id: 7, text: '原文', prev: '前文', next: '后文', createdAtSec: 50}
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
  assert.deepEqual(decoded, {url: 'https://x/y', title: '', createdAtSec: 0, highlights: []})
})

test('decodePage：`u` 归一到 `pageKey`，与存储键一致', () => {
  const decoded = decodePage({u: 'HTTPS://X.test:443/a/../b#frag', t: '', c: 0, h: []})
  assert.equal(decoded.url, 'https://x.test/b')
})

test('未知字段：解码收进 extra，编码原样写回', () => {
  const row = {
    u: 'https://x.test/a',
    t: '标题',
    c: 1,
    h: [{i: 1, x: '原文', p: '', q: '', c: 1, future: 'removed-by-old-version'}],
    // 旧版本不认识的页面级字段
    folder: '笔记'
  } as unknown as PageRow

  const page = decodePage(row)
  assert.deepEqual(page.extra, {folder: '笔记'})
  assert.deepEqual(page.highlights[0]?.extra, {future: 'removed-by-old-version'})
  // 编码回去时未知键排前面、已知键覆盖，所以真实字段不会被 extra 里的同名键篡改。
  assert.deepEqual(encodePage(page), row)
})

test('未知字段：没有未知键时不写 `extra`（不往对象里塞空壳）', () => {
  const page = decodePage({u: 'https://x.test/a', t: '', c: 0, h: [{i: 1, x: 'x', p: '', q: '', c: 0}]})
  assert.equal('extra' in page, false)
  assert.equal('extra' in (page.highlights[0] ?? {}), false)
  // 恒等映射不受影响
  assert.deepEqual(decodePage(encodePage(page)), page)
})

test('encodeHighlight：只写定位三元组与时间', () => {
  assert.deepEqual(encodeHighlight(record()), {
    i: 7,
    x: '原文',
    p: '前文',
    q: '后文',
    c: 50
  })
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
  // 解码会补上路径为 `/` 的规范形式，与存储键一致。
  assert.deepEqual(decodeRows(rows).map((item) => item.url), ['https://a/', 'https://b/'])
})
