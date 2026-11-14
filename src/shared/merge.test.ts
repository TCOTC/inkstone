/**
 * 合并规则。这里锁的是「跨设备不能丢线、也不能复活已删的线」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {highlightSignature, mergePage} from './merge'
import type {HighlightRecord, PageRecord} from './types'

function highlight(id: number, text: string, prev = '', next = ''): HighlightRecord {
  return {id, text, prev, next, createdAt: id}
}

function page(highlights: HighlightRecord[], title = '标题'): PageRecord {
  return {url: 'https://example.com/a', title, createdAt: 1, highlights}
}

test('签名只看正文三元组，且忽略空白差异', () => {
  const a = highlight(1, '核心 文字', '前文', '后文')
  const b = highlight(9, '核心\n文字', ' 前文 ', '后文\t')
  assert.equal(highlightSignature(a), highlightSignature(b))
  assert.notEqual(highlightSignature(a), highlightSignature(highlight(1, '核心 文字', '前文', '别的后文')))
})

test('签名是 16 位十六进制（两个 32 位哈希拼起来）', () => {
  assert.match(highlightSignature(highlight(1, '任意文字')), /^[0-9a-f]{16}$/)
})

test('合并：远端多出来的接在后面，本机的 id 与顺序都不动', () => {
  const local = page([highlight(1, '甲'), highlight(2, '乙')])
  const remote = page([highlight(1, '乙'), highlight(2, '丙')])

  const {page: merged, added} = mergePage(local, remote, new Set())

  assert.equal(added, 1)
  assert.deepEqual(
    merged.highlights.map((item) => [item.id, item.text]),
    [
      [1, '甲'],
      [2, '乙'],
      [3, '丙']
    ]
  )
})

test('合并：同一段文字在两台设备上不会变成两条', () => {
  const local = page([highlight(1, '甲')])
  const remote = page([highlight(7, '甲')])

  const {page: merged, added} = mergePage(local, remote, new Set())

  assert.equal(added, 0)
  assert.deepEqual(merged.highlights.map((item) => item.id), [1])
})

test('合并：本机没有改动时结果与本地完全相同（同步不会产生无意义的写盘）', () => {
  const local = page([highlight(1, '甲'), highlight(2, '乙')])
  const remote = page([highlight(5, '甲')])

  const {page: merged} = mergePage(local, remote, new Set())
  assert.equal(JSON.stringify(merged), JSON.stringify(local))
})

test('墓碑：本机删掉的线不会被远端副本复活', () => {
  const local = page([highlight(1, '甲')])
  const remote = page([highlight(1, '甲'), highlight(2, '乙')])
  const deleted = new Set([highlightSignature(highlight(1, '甲'))])

  const {page: merged, dropped} = mergePage(local, remote, deleted)

  assert.deepEqual(merged.highlights.map((item) => item.text), ['乙'])
  // 本机那条与远端那条都算被墓碑挡住。
  assert.equal(dropped, 2)
})

test('合并：远端为 null 时原样返回本地', () => {
  const local = page([highlight(1, '甲')])
  const {page: merged, added} = mergePage(local, null, new Set())
  assert.equal(merged, local)
  assert.equal(added, 0)
})

test('合并：标题以本地为准，本地为空才用远端', () => {
  assert.equal(mergePage(page([], '本机标题'), page([], '远端标题'), new Set()).page.title, '本机标题')
  assert.equal(mergePage(page([], ''), page([], '远端标题'), new Set()).page.title, '远端标题')
})

test('合并：本机可以有多条同内容（历史数据），合并不会把它们压成一条', () => {
  const local = page([highlight(1, '甲'), highlight(2, '甲')])
  const remote = page([highlight(1, '甲')])

  const {page: merged} = mergePage(local, remote, new Set())
  assert.equal(merged.highlights.length, 2)
})
