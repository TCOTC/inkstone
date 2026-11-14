/**
 * 导航顺序的纯规则：按正文先后排、跳过量不到的、标出近似命中。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {buildMarkerEntries, type MeasuredBox} from './markerEntries'
import {FUZZY_MODE, type RelocateResult} from '../shared/relocate'
import type {HighlightRecord} from '../shared/types'

function highlight(id: number, text = `第${id}条`): HighlightRecord {
  return {id, text, prev: '', next: '', createdAt: 1}
}

function result(mode: number, nodeIndex: number, start = 0): RelocateResult {
  return {errCode: 0, mode, spans: [{nodeIndex, start, end: start + 2}]}
}

function measured(...ids: number[]): Map<number, MeasuredBox> {
  const map = new Map<number, MeasuredBox>()
  for (const id of ids) map.set(id, {rectTop: id * 10, rectHeight: 5, element: null})
  return map
}

test('按正文先后排序，而不是存储顺序', () => {
  const items = [
    {highlight: highlight(1), result: result(2, 5)},
    {highlight: highlight(2), result: result(2, 1)},
    {highlight: highlight(3), result: result(2, 3)}
  ]
  const entries = buildMarkerEntries(items, measured(1, 2, 3))
  assert.deepEqual(entries.map((entry) => entry.id), [2, 3, 1])
})

test('同一节点内按 start 排', () => {
  const items = [
    {highlight: highlight(1), result: result(2, 0, 40)},
    {highlight: highlight(2), result: result(2, 0, 10)}
  ]
  const entries = buildMarkerEntries(items, measured(1, 2))
  assert.deepEqual(entries.map((entry) => entry.id), [2, 1])
})

test('量不到位置的条目跳过（列出来点了也没反应）', () => {
  const items = [
    {highlight: highlight(1), result: result(2, 0)},
    {highlight: highlight(2), result: result(2, 1)}
  ]
  const entries = buildMarkerEntries(items, measured(2))
  assert.deepEqual(entries.map((entry) => entry.id), [2])
})

test('近似命中带 approximate 标记，精确命中不带', () => {
  const items = [
    {highlight: highlight(1), result: result(2, 0)},
    {highlight: highlight(2), result: result(FUZZY_MODE, 1)}
  ]
  const entries = buildMarkerEntries(items, measured(1, 2))
  assert.equal(entries[0]?.approximate, false)
  assert.equal(entries[1]?.approximate, true)
})

test('没有 span 的条目排到最后，不打断其它顺序', () => {
  const items = [
    {highlight: highlight(1), result: {errCode: 0, mode: 2, spans: []} as RelocateResult},
    {highlight: highlight(2), result: result(2, 7)}
  ]
  const entries = buildMarkerEntries(items, measured(1, 2))
  assert.deepEqual(entries.map((entry) => entry.id), [2, 1])
})

test('正文里的空白被 trim，颜色统一取 ACCENT_COLOR', () => {
  const entries = buildMarkerEntries(
    [{highlight: highlight(1, '  原文  '), result: result(2, 0)}],
    measured(1)
  )
  assert.equal(entries[0]?.text, '原文')
  assert.match(entries[0]?.color ?? '', /^#/)
})
